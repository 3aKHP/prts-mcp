//! Directory ownership prevents accidental reuse across GitHub sources.
//! This is a local consistency guard, not an authenticity mechanism.
use super::primitives::atomic_write_json;
use crate::config::{DataBackend, DataSource, RuntimeConfig};
use serde_json::json;
use std::{
    fs::{self, OpenOptions},
    path::{Path, PathBuf},
};

const MARKER: &str = ".prts-data-source.json";
const LOCK: &str = ".prts-data-source.lock";

fn check_marker(root: &Path, source: &DataSource) -> Result<bool, String> {
    let path = root.join(MARKER);
    match fs::symlink_metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e.to_string()),
        Ok(meta) if !meta.is_file() => return Err("source marker is not a regular file".into()),
        Ok(_) => (),
    }
    let value: serde_json::Value =
        serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
            .map_err(|e| format!("invalid source marker: {e}"))?;
    if value != json!({"schemaVersion": 1, "repo": source.slug()}) {
        return Err(
            "data directory belongs to another source or has an invalid source marker".into(),
        );
    }
    Ok(true)
}

/// Bind empty custom-source directories; never adopt existing unmarked data.
/// Default-source legacy volumes remain byte-for-byte unchanged.
pub fn ensure(root: &Path, source: &DataSource) -> Result<(), String> {
    let result = (|| {
        if source.is_default() {
            check_marker(root, source)?;
            return Ok(());
        }
        fs::create_dir_all(root).map_err(|e| e.to_string())?;
        // Keep the lock inode: unlinking it would allow two independent locks.
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(root.join(LOCK))
            .map_err(|e| e.to_string())?;
        lock.lock().map_err(|e| e.to_string())?;
        if check_marker(root, source)? {
            return Ok(());
        }
        for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if entry.file_name() != LOCK {
                return Err(
                    "custom source requires an empty directory or a matching source marker".into(),
                );
            }
        }
        atomic_write_json(
            &root.join(MARKER),
            &json!({"schemaVersion": 1, "repo": source.slug()}),
        )
        .map_err(|e| e.to_string())
    })();
    result.map_err(|error| {
        format!(
            "{}: {error}; use a separate data directory for {}",
            root.display(),
            source.slug()
        )
    })
}

fn data_roots(config: &RuntimeConfig) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    match config.data_backend {
        DataBackend::Json => {
            if !config.is_custom_gamedata {
                roots.extend([config.gamedata_path.clone(), config.levels_path.clone()]);
            }
            if config.story_sync_enabled {
                roots.push(
                    config
                        .storyjson_zip
                        .parent()
                        .unwrap_or(Path::new("."))
                        .into(),
                );
            }
        }
        DataBackend::Sqlite if config.custom_database.is_none() => {
            roots.push(config.database_dir.clone())
        }
        DataBackend::Sqlite => (),
    }
    roots.sort();
    roots.dedup();
    roots
}

pub fn sync_roots(config: &RuntimeConfig) -> Vec<PathBuf> {
    let mut roots = data_roots(config);
    if config.images_enabled && config.local_image {
        roots.push(config.images_path.clone());
    }
    roots.sort();
    roots.dedup();
    roots
}

/// Read-only check: readers must never claim or initialize a directory.
/// A marker is written before any custom-source data, and never replaced.
pub fn verify(root: &Path, source: &DataSource) -> Result<(), String> {
    match check_marker(root, source) {
        Ok(true) => Ok(()),
        Ok(false) if source.is_default() => Ok(()),
        Ok(false) => Err(format!(
            "{}: custom data source marker missing",
            root.display()
        )),
        Err(error) => Err(format!("{}: {error}", root.display())),
    }
}

pub fn verify_data(config: &RuntimeConfig) -> Result<(), String> {
    for root in data_roots(config) {
        verify(&root, &config.data_source)?;
    }
    Ok(())
}

/// Run before initializing readers, and again before scheduled writes.
pub fn prepare(config: &RuntimeConfig) -> Result<(), String> {
    for root in sync_roots(config) {
        ensure(&root, &config.data_source)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("prts-source-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&root).unwrap();
            Self(root)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn rejects_legacy_and_other_sources_without_modifying_data() {
        let dir = Temp::new();
        let root = dir.path();
        let a = DataSource::parse(Some("a/data")).unwrap();
        fs::write(root.join("old.zip"), b"old").unwrap();
        assert!(ensure(root, &a).is_err());
        assert_eq!(fs::read(root.join("old.zip")).unwrap(), b"old");
        fs::remove_file(root.join("old.zip")).unwrap();
        ensure(root, &a).unwrap();
        fs::write(root.join("new.zip"), b"new").unwrap();
        ensure(root, &a).unwrap();
        assert!(ensure(root, &DataSource::parse(Some("b/data")).unwrap()).is_err());
        assert!(ensure(root, &DataSource::default()).is_err());
        fs::write(root.join(MARKER), b"broken").unwrap();
        assert!(ensure(root, &a).is_err());
    }
    #[test]
    fn default_source_does_not_create_files() {
        let dir = Temp::new();
        ensure(dir.path(), &DataSource::default()).unwrap();
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
        ensure(&dir.path().join("absent"), &DataSource::default()).unwrap();
        assert!(!dir.path().join("absent").exists());
    }
    #[test]
    fn concurrent_binding_has_one_owner() {
        let dir = Temp::new();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let threads: Vec<_> = ["a/data", "b/data"]
            .into_iter()
            .map(|slug| {
                let root = dir.path().to_owned();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    ensure(&root, &DataSource::parse(Some(slug)).unwrap()).is_ok()
                })
            })
            .collect();
        assert_eq!(
            threads
                .into_iter()
                .map(|t| usize::from(t.join().unwrap()))
                .sum::<usize>(),
            1
        );
    }
}
