//! Bounded decoding, immutable generation publication and lease-aware cleanup.
use super::database_manifest::DatabaseManifest;
use crate::storage::{
    database::{lease_path, ActiveDatabase},
    sqlite::GameDb,
    validation::{self, Observation},
};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub fn hash(path: &Path) -> Result<String, String> {
    let mut input = File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let count = input.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

pub fn verify(path: &Path, manifest: &DatabaseManifest) -> Result<(), String> {
    let descriptor = serde_json::to_string(manifest).map_err(|e| e.to_string())?;
    if validation::contains(path, Some(&descriptor)) {
        return Ok(());
    }
    let observed = Observation::begin(path)?;
    if fs::metadata(path).map_err(|e| e.to_string())?.len() != manifest.size
        || hash(path)? != manifest.sha256
    {
        return Err("SQLite file size/SHA-256 mismatch".into());
    }
    let db = GameDb::for_verification(path)?;
    db.verify()?;
    for (key, wanted) in [
        ("source_version", manifest.source_version.clone()),
        (
            "publication_revision",
            manifest.publication_revision.to_string(),
        ),
        ("compiler_version", manifest.compiler_version.clone()),
    ] {
        if db.metadata(key)?.as_deref() != Some(&wanted) {
            return Err(format!("SQLite metadata mismatch: {key}"));
        }
    }
    validation::remember(observed, descriptor)
}

pub fn decode(input: &Path, output: &Path, manifest: &DatabaseManifest) -> Result<(), String> {
    let mut input =
        flate2::read::MultiGzDecoder::new(File::open(input).map_err(|e| e.to_string())?);
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(output)
        .map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 65536];
    let mut bytes = 0u64;
    loop {
        let count = input.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        bytes = bytes
            .checked_add(count as u64)
            .ok_or("SQLite size overflow")?;
        if bytes > manifest.size {
            return Err("decoded SQLite exceeds declared length".into());
        }
        output
            .write_all(&buffer[..count])
            .map_err(|e| e.to_string())?;
        hasher.update(&buffer[..count]);
    }
    if bytes != manifest.size || format!("{:x}", hasher.finalize()) != manifest.sha256 {
        return Err("decoded SQLite length/SHA-256 mismatch".into());
    }
    output.sync_all().map_err(|e| e.to_string())
}

pub struct Staging(pub PathBuf);
impl Drop for Staging {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub fn publish(
    root: &Path,
    path: &Path,
    manifest: &DatabaseManifest,
) -> Result<ActiveDatabase, String> {
    let file_name = format!(
        "{}-{}.sqlite",
        manifest.sha256,
        uuid::Uuid::new_v4().simple()
    );
    let destination = root.join(&file_name);
    let lease = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(lease_path(&destination))
        .map_err(|e| e.to_string())?;
    lease.sync_all().map_err(|e| e.to_string())?;
    fs::rename(path, &destination).map_err(|e| e.to_string())?;
    // The unique final path is not a runtime candidate until activation. Check
    // it here so the receipt remains valid across first runtime admission.
    if let Err(error) = verify(&destination, manifest) {
        drop(lease);
        let _ = fs::remove_file(&destination);
        let _ = fs::remove_file(lease_path(&destination));
        return Err(error);
    }
    let pointer = ActiveDatabase {
        file_name,
        source_version: manifest.source_version.clone(),
        revision: manifest.publication_revision,
        sha256: manifest.sha256.clone(),
    };
    activate(root, &pointer)?;
    Ok(pointer)
}

pub fn activate(root: &Path, pointer: &ActiveDatabase) -> Result<(), String> {
    if let Ok(Some(old)) = crate::storage::database::active(root) {
        if old.file_name != pointer.file_name
            && old.sha256 != pointer.sha256
            && hash(&old.path(root)).ok().as_deref() == Some(old.sha256.as_str())
        {
            write_pointer(root, "previous", &old)?;
        }
    }
    write_pointer(root, "active", pointer)
}

fn write_pointer(root: &Path, name: &str, pointer: &ActiveDatabase) -> Result<(), String> {
    let temporary = root.join(format!(".active-{}", uuid::Uuid::new_v4().simple()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|e| e.to_string())?;
    file.write_all(pointer.encode()?.as_bytes())
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    drop(file);
    if let Err(error) = fs::rename(&temporary, root.join(name)) {
        let _ = fs::remove_file(temporary);
        return Err(error.to_string());
    }
    #[cfg(unix)]
    File::open(root)
        .and_then(|f| f.sync_all())
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Called only while owning sync.lock, before creating any new staging files.
pub fn clean_staging(root: &Path) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if [".stage-", ".active-"]
            .iter()
            .any(|prefix| name.strip_prefix(prefix).is_some_and(uuid_suffix))
        {
            if entry.file_type().is_ok_and(|t| t.is_dir()) {
                let _ = fs::remove_dir_all(path);
            } else {
                let _ = fs::remove_file(path);
            }
        }
    }
}

/// Keep current/previous files and every database pinned by another process.
pub fn prune(root: &Path, current: &ActiveDatabase) {
    let retained = fs::read_to_string(root.join("previous"))
        .ok()
        .and_then(|text| ActiveDatabase::parse(&text).ok());
    let previous = retained.as_ref();
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name == current.file_name || previous.is_some_and(|p| name == p.file_name) {
            continue;
        }
        if let Some(database) = name
            .strip_suffix(".lease")
            .filter(|name| owned_database(name))
        {
            if !root.join(database).exists() {
                if let Ok(lease) = OpenOptions::new().read(true).write(true).open(&path) {
                    if lease.try_lock().is_ok() {
                        let _ = fs::remove_file(&path);
                    }
                }
            }
            continue;
        }
        // Only our exact immutable file pattern and an accompanying lease are owned.
        if !owned_database(&name) {
            continue;
        }
        let Ok(lease) = OpenOptions::new()
            .read(true)
            .write(true)
            .open(lease_path(&path))
        else {
            continue;
        };
        // Our obsolete proof must not block our own cleanup. Other processes'
        // receipts and live readers remain visible through their shared lease.
        validation::forget(&path);
        if lease.try_lock().is_err() {
            continue;
        }
        if fs::remove_file(&path).is_ok() {
            // A receipt pins the inode too: release it now so an unlinked
            // generation cannot consume disk until another validation runs.
            validation::forget(&path);
            let _ = fs::remove_file(lease_path(&path));
        }
    }
}

fn uuid_suffix(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn owned_database(value: &str) -> bool {
    let Some(stem) = value.strip_suffix(".sqlite") else {
        return false;
    };
    let Some((sha, uuid)) = stem.split_once('-') else {
        return false;
    };
    sha.len() == 64
        && sha
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        && uuid_suffix(uuid)
}

pub fn cached(root: &Path, manifest: &DatabaseManifest) -> Option<PathBuf> {
    let prefix = format!("{}-", manifest.sha256);
    let mut files: Vec<_> = fs::read_dir(root)
        .ok()?
        .flatten()
        .filter(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            name.starts_with(&prefix) && owned_database(&name)
        })
        .map(|e| e.path())
        .collect();
    files.sort();
    files
        .into_iter()
        .find(|path| verify(path, manifest).is_ok())
}
