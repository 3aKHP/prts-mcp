//! Release-archive activation: cross-process lock + generation tree + staging.
//!
//! Port of TS `sync/releaseActivation.ts`. The directory-owner lease protocol
//! (mkdir lock dir, owner file, heartbeat utimes, stale quarantine, release
//! only while still owner) is the cross-process interop contract shared with
//! the TS implementation — do not replace it with flock-style locks.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use super::primitives::{atomic_write_json, mtime_ms, now_ms, prune_old_trees, random_suffix};
use super::types::{ReleaseArchiveSpec, SyncError};

pub const ACTIVATION_LOCK_TIMEOUT_MS: u64 = 120_000;
pub const ACTIVATION_LOCK_STALE_MS: u64 = 30 * 60_000;
pub const ACTIVATION_LOCK_OWNER_GRACE_MS: u64 = 10_000;
pub const ACTIVATION_LOCK_HEARTBEAT_MS: u64 = 60_000;
pub const RELEASE_RETENTION_MS: u64 = 24 * 60 * 60_000;
const LOCK_POLL_MS: u64 = 50;

#[derive(Debug, Clone, Copy)]
pub struct LockTiming {
    pub timeout_ms: u64,
    pub stale_ms: u64,
    pub owner_grace_ms: u64,
    pub heartbeat_ms: u64,
}

impl Default for LockTiming {
    fn default() -> Self {
        Self {
            timeout_ms: ACTIVATION_LOCK_TIMEOUT_MS,
            stale_ms: ACTIVATION_LOCK_STALE_MS,
            owner_grace_ms: ACTIVATION_LOCK_OWNER_GRACE_MS,
            heartbeat_ms: ACTIVATION_LOCK_HEARTBEAT_MS,
        }
    }
}

/// Activation lock not acquired within the wait budget.
#[derive(Debug, thiserror::Error)]
#[error("Timed out waiting for archive activation lock: {0}")]
pub struct ActivationLockTimeoutError(pub String);

fn lock_age_ms(lock_path: &Path) -> std::io::Result<u128> {
    // Lease clock: the owner file when present, else the lock dir itself.
    let owner_path = lock_path.join("owner");
    let lease = match std::fs::symlink_metadata(&owner_path) {
        Ok(info) => info,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            std::fs::symlink_metadata(lock_path)?
        }
        Err(err) => return Err(err),
    };
    Ok(mtime_ms(lease.modified()?))
}

/// Acquire the directory lock at `<lock_dir>/<lock_name>` and run `run`
/// under it. Mirrors `withArchiveActivationLock` step for step:
/// mkdir acquisition, ownerless/stale reclaim via rename-to-quarantine,
/// heartbeat lease renewal, and release only when the owner file still names
/// us (a stale-lock successor owns the original path by then).
pub async fn with_archive_activation_lock<T, F, Fut>(
    lock_dir: &Path,
    lock_name: &str,
    timing: LockTiming,
    run: F,
) -> Result<T, SyncError>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = T>,
{
    let lock = lock_dir.join(lock_name);
    let owner = random_suffix();
    let deadline = now_ms() + timing.timeout_ms;
    loop {
        match std::fs::create_dir(&lock) {
            Ok(()) => break,
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
                let info = match std::fs::symlink_metadata(&lock) {
                    Ok(info) => info,
                    Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(err) => return Err(err.into()),
                };
                if !info.is_dir() {
                    return Err(SyncError::Message(format!(
                        "Unsafe activation lock symlink: {}",
                        lock.display()
                    )));
                }
                let ownerless = !lock.join("owner").exists();
                let age = lock_age_ms(&lock)?;
                let age_ms = now_ms().saturating_sub(age as u64) as u128;
                if age_ms > timing.stale_ms as u128
                    || (ownerless && age_ms > timing.owner_grace_ms as u128)
                {
                    let quarantine = lock.with_file_name(format!(
                        "{name}.stale-{suffix}",
                        name = lock
                            .file_name()
                            .map(|n| n.to_string_lossy())
                            .unwrap_or_default(),
                        suffix = random_suffix()
                    ));
                    match std::fs::rename(&lock, &quarantine) {
                        Ok(()) => {
                            let _ = std::fs::remove_dir_all(&quarantine);
                            continue;
                        }
                        Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
                        Err(err) => return Err(err.into()),
                    }
                }
                if now_ms() >= deadline {
                    return Err(SyncError::Message(
                        ActivationLockTimeoutError(lock.display().to_string()).to_string(),
                    ));
                }
                tokio::time::sleep(Duration::from_millis(LOCK_POLL_MS)).await;
            }
            Err(err) => return Err(err.into()),
        }
    }

    let owner_path = lock.join("owner");
    if let Err(err) = std::fs::write(&owner_path, &owner) {
        let _ = std::fs::remove_dir_all(&lock);
        return Err(err.into());
    }

    // Heartbeat: while we still own the lease, refresh the owner file's
    // mtime every heartbeat_ms so contenders do not reclaim mid-run.
    let stop = Arc::new(AtomicBool::new(false));
    let heartbeat = {
        let stop = Arc::clone(&stop);
        let lock = lock.clone();
        let owner = owner.clone();
        let interval = Duration::from_millis(timing.heartbeat_ms.max(1));
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(interval).await;
                if stop.load(Ordering::Relaxed) {
                    break;
                }
                if let Ok(current) = std::fs::read_to_string(lock.join("owner")) {
                    if current == owner {
                        let now =
                            filetime::FileTime::from_system_time(std::time::SystemTime::now());
                        let _ = filetime::set_file_mtime(lock.join("owner"), now);
                    }
                }
            }
        })
    };

    let result = run().await;

    stop.store(true, Ordering::Relaxed);
    heartbeat.abort();
    let _ = heartbeat.await;

    // Release only while still owner — a stale-lock successor owns the
    // original path by now and must not be deleted by the old owner.
    if let Ok(current) = std::fs::read_to_string(&owner_path) {
        if current == owner {
            let _ = std::fs::remove_dir_all(&lock);
        }
    }
    Ok(result)
}

/// `archiveFilesPresent`: every required file exists as a regular file.
pub fn archive_files_present(spec: &ReleaseArchiveSpec, root: &Path) -> bool {
    spec.required_files.iter().all(|f| root.join(f).is_file())
}

pub fn archive_missing_files(spec: &ReleaseArchiveSpec, root: &Path) -> Vec<String> {
    spec.required_files
        .iter()
        .filter(|f| !root.join(f).is_file())
        .cloned()
        .collect()
}

pub fn extract_meta_path(spec: &ReleaseArchiveSpec) -> PathBuf {
    spec.archives_dir().join("extract_meta.json")
}

pub struct ExtractMeta {
    pub commit_sha: String,
    pub data_root: PathBuf,
}

/// `loadExtractMeta`: commit_sha + data_root, realpath containment, target
/// must be an existing directory. Any failure → None.
pub fn load_extract_meta(spec: &ReleaseArchiveSpec) -> Option<ExtractMeta> {
    let text = std::fs::read_to_string(extract_meta_path(spec)).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    let commit_sha = value.get("commit_sha")?.as_str()?;
    if commit_sha.is_empty() {
        return None;
    }
    let data_root = value.get("data_root")?.as_str()?;
    if data_root.is_empty() {
        return None;
    }
    let base = std::fs::canonicalize(&spec.local_root).ok()?;
    let target = std::fs::canonicalize(base.join(data_root)).ok()?;
    if !target.starts_with(&base) {
        return None;
    }
    if !target.is_dir() {
        return None;
    }
    Some(ExtractMeta {
        commit_sha: commit_sha.to_string(),
        data_root: target,
    })
}

pub fn save_extract_meta(
    spec: &ReleaseArchiveSpec,
    commit_sha: &str,
    data_root: &Path,
) -> Result<(), SyncError> {
    let relative = pathdiff_lite(&spec.local_root, data_root);
    atomic_write_json(
        &extract_meta_path(spec),
        &json!({
            "commit_sha": commit_sha,
            "data_root": relative,
        }),
    )
}

/// TS `relative(from, to).replaceAll("\\", "/")` — both paths live under the
/// same root here, so a prefix-strip suffices.
fn pathdiff_lite(from: &Path, to: &Path) -> String {
    let from_abs = std::path::absolute(from).unwrap_or_else(|_| from.to_path_buf());
    let to_abs = std::path::absolute(to).unwrap_or_else(|_| to.to_path_buf());
    if let Ok(rel) = to_abs.strip_prefix(&from_abs) {
        let text = rel.to_string_lossy().replace('\\', "/");
        if text.is_empty() {
            return ".".to_string();
        }
        return text;
    }
    to_abs.to_string_lossy().replace('\\', "/")
}

/// Lexical containment used by the extract path: normalize `root.join(name)`
/// the way Node's `resolve` does (absolute `name` resets to the name), then
/// require the result to stay inside `root`.
fn resolve_inside_lexical(root: &Path, name: &str) -> Option<PathBuf> {
    let name = name.replace('\\', "/");
    let root_abs = std::path::absolute(root).ok()?;
    let joined: PathBuf = if name.starts_with('/') {
        PathBuf::from(name)
    } else {
        root_abs.join(&name)
    };
    let mut resolved = PathBuf::new();
    for component in joined.components() {
        match component {
            std::path::Component::Prefix(prefix) => resolved.push(prefix.as_os_str()),
            std::path::Component::RootDir => resolved.push(component.as_os_str()),
            std::path::Component::CurDir => {}
            // A ".." that pops above the root means the path escapes.
            std::path::Component::ParentDir => {
                if !resolved.pop() {
                    return None;
                }
            }
            std::path::Component::Normal(part) => resolved.push(part),
        }
    }
    if resolved.strip_prefix(&root_abs).is_ok() {
        Some(resolved)
    } else {
        None
    }
}

/// `safeExtractZip`: extract entries (central-directory order) with lexical
/// containment, tmp-file-then-rename per entry, and leftover-tmp cleanup on
/// failure. Unsafe member paths abort the extraction.
pub fn safe_extract_zip(zip_path: &Path, local_root: &Path) -> Result<(), SyncError> {
    let root = std::path::absolute(local_root).unwrap_or_else(|_| local_root.to_path_buf());
    let file = std::fs::File::open(zip_path)?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| SyncError::Message(e.to_string()))?;
    let mut tmp_paths: Vec<PathBuf> = Vec::new();
    let result = (|| -> Result<(), SyncError> {
        for index in 0..zip.len() {
            let mut entry = zip
                .by_index(index)
                .map_err(|e| SyncError::Message(e.to_string()))?;
            if entry.is_dir() {
                continue;
            }
            let name = entry.name().to_string();
            let dest = resolve_inside_lexical(&root, &name)
                .ok_or_else(|| SyncError::Message(format!("Unsafe zip member path: {name}")))?;
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent)?;
            }
            // `${dest}.tmp` — exact suffix append, no extension surgery.
            let mut tmp_name = dest.as_os_str().to_os_string();
            tmp_name.push(".tmp");
            let tmp = PathBuf::from(tmp_name);
            let mut out = std::fs::File::create(&tmp)?;
            std::io::copy(&mut entry, &mut out)?;
            tmp_paths.push(tmp.clone());
            std::fs::rename(&tmp, &dest)?;
            tmp_paths.pop();
        }
        Ok(())
    })();
    if result.is_err() {
        for tmp in &tmp_paths {
            let _ = std::fs::remove_file(tmp);
        }
    }
    result
}

/// `releasesPath`: the `.releases` tree under `local_root` — rejects symlinks
/// and anything that escapes the root.
pub fn releases_path(spec: &ReleaseArchiveSpec) -> Result<PathBuf, SyncError> {
    let releases = spec.local_root.join(".releases");
    match std::fs::symlink_metadata(&releases) {
        Ok(info) => {
            if info.file_type().is_symlink() {
                return Err(SyncError::Message(format!(
                    "Unsafe release directory symlink: {}",
                    releases.display()
                )));
            }
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(err.into()),
    }
    // A non-directory at this path fails with a raw mkdir error, like TS.
    std::fs::create_dir_all(&releases)?;
    let info = std::fs::symlink_metadata(&releases)?;
    let root_abs =
        std::path::absolute(&spec.local_root).unwrap_or_else(|_| spec.local_root.clone());
    let releases_abs = std::path::absolute(&releases).unwrap_or_else(|_| releases.clone());
    if !info.is_dir() || !releases_abs.starts_with(&root_abs) {
        return Err(SyncError::Message(format!(
            "Unsafe release directory: {}",
            releases.display()
        )));
    }
    Ok(releases)
}

/// `stageReleaseTree`: extract the archive into a fresh hidden staging dir
/// named `.<generation>.tmp`; the caller renames it to the final generation
/// after validation. `generation` = sha256(commitSha)[0..16] + uuid.
pub fn stage_release_tree(
    spec: &ReleaseArchiveSpec,
    commit_sha: &str,
) -> Result<StagedTree, SyncError> {
    let releases = releases_path(spec)?;
    let release_key = {
        use sha2::Digest;
        let digest = format!("{:x}", sha2::Sha256::digest(commit_sha.as_bytes()));
        digest[..16].to_string()
    };
    let generation = format!("{release_key}-{}", random_suffix());
    let staging = releases.join(format!(".{generation}.tmp"));
    let activated = releases.join(&generation);
    let result = (|| -> Result<(), SyncError> {
        safe_extract_zip(&spec.local_zip, &staging)?;
        let missing = archive_missing_files(spec, &staging);
        if !missing.is_empty() {
            let preview: Vec<String> = missing.iter().take(10).cloned().collect();
            return Err(SyncError::Message(format!(
                "Archive extraction missing required files: {}",
                preview.join("; ")
            )));
        }
        Ok(())
    })();
    match result {
        Ok(()) => Ok(StagedTree { staging, activated }),
        Err(err) => {
            let _ = std::fs::remove_dir_all(&staging);
            Err(err)
        }
    }
}

#[derive(Debug)]
pub struct StagedTree {
    pub staging: PathBuf,
    pub activated: PathBuf,
}

/// `archiveActivationSha`: the release commitSha when known, else
/// `local-<sha256 of the zip file>` (streamed, not buffered).
pub fn archive_activation_sha(spec: &ReleaseArchiveSpec, release_sha: Option<&str>) -> String {
    if let Some(sha) = release_sha {
        return sha.to_string();
    }
    use sha2::Digest;
    let mut file = std::fs::File::open(&spec.local_zip).expect("zip exists (checked by caller)");
    let mut hasher = sha2::Sha256::new();
    std::io::copy(&mut file, &mut hasher).expect("zip readable");
    format!("local-{:x}", hasher.finalize())
}

/// `pruneReleaseTrees`: best-effort retention cleanup that never rolls back
/// an activated release.
pub fn prune_release_trees(spec: &ReleaseArchiveSpec, keep: &HashSet<PathBuf>) {
    if let Ok(releases) = releases_path(spec) {
        prune_old_trees(&releases, keep, RELEASE_RETENTION_MS as u128, false);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::write_zip_entries;

    fn temp_spec(name: &str) -> (PathBuf, ReleaseArchiveSpec) {
        let dir = std::env::temp_dir().join(format!("prts-act-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let spec = ReleaseArchiveSpec {
            owner: "3aKHP".into(),
            repo: "arknights-data-pipeline".into(),
            asset_name: "zh_CN-levels.zip".into(),
            local_zip: dir.join("gamedata-levels/archives/zh_CN-levels.zip"),
            local_root: dir.join("gamedata-levels"),
            required_files: vec!["zh_CN/gamedata/levels/enemydata/enemy_database.json".into()],
            verify_manifest: false,
        };
        (dir, spec)
    }

    fn write_levels_zip(spec: &ReleaseArchiveSpec, content: &[u8]) {
        write_zip_entries(
            &spec.local_zip,
            &[(
                "zh_CN/gamedata/levels/enemydata/enemy_database.json",
                content,
            )],
        )
        .unwrap();
    }

    #[tokio::test]
    async fn lock_serializes_concurrent_runs() {
        let (dir, spec) = temp_spec("lock");
        std::fs::create_dir_all(spec.archives_dir()).unwrap();
        let lock_dir = spec.archives_dir();
        let counter = Arc::new(std::sync::Mutex::new(0));
        let max_seen = Arc::new(std::sync::Mutex::new(0));
        let mut handles = Vec::new();
        for _ in 0..4 {
            let lock_dir = lock_dir.clone();
            let counter = Arc::clone(&counter);
            let max_seen = Arc::clone(&max_seen);
            handles.push(tokio::spawn(async move {
                with_archive_activation_lock(
                    &lock_dir,
                    ".activation.lock",
                    LockTiming::default(),
                    || {
                        let counter = Arc::clone(&counter);
                        let max_seen = Arc::clone(&max_seen);
                        async move {
                            let now_active = {
                                let mut active = counter.lock().unwrap();
                                *active += 1;
                                *active
                            };
                            {
                                let mut max = max_seen.lock().unwrap();
                                *max = (*max).max(now_active);
                            }
                            tokio::time::sleep(Duration::from_millis(30)).await;
                            *counter.lock().unwrap() -= 1;
                        }
                    },
                )
                .await
                .unwrap();
            }));
        }
        for handle in handles {
            handle.await.unwrap();
        }
        assert_eq!(*max_seen.lock().unwrap(), 1);
        assert!(!lock_dir.join(".activation.lock").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn lock_timeout_leaves_live_lock_alone() {
        let (dir, spec) = temp_spec("lock-timeout");
        std::fs::create_dir_all(spec.archives_dir()).unwrap();
        let lock_dir = spec.archives_dir();

        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel::<()>();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
        let holder_dir = lock_dir.clone();
        let first = tokio::spawn(async move {
            with_archive_activation_lock(
                &holder_dir,
                ".activation.lock",
                LockTiming {
                    timeout_ms: 60_000,
                    stale_ms: 60_000,
                    owner_grace_ms: 60_000,
                    heartbeat_ms: 1_000,
                },
                move || async move {
                    let _ = entered_tx.send(());
                    // Hold the lock until the test signals release.
                    let _ = release_rx.await;
                },
            )
            .await
            .unwrap();
        });
        entered_rx.await.unwrap();
        let timeout = with_archive_activation_lock(
            &lock_dir,
            ".activation.lock",
            LockTiming {
                timeout_ms: 0,
                stale_ms: 60_000,
                owner_grace_ms: 60_000,
                heartbeat_ms: 1_000,
            },
            || async {},
        )
        .await;
        let err = timeout.unwrap_err().to_string();
        assert!(
            err.contains("Timed out waiting for archive activation lock"),
            "{err}"
        );
        // The contender must not have reclaimed or removed the live lock.
        assert!(lock_dir.join(".activation.lock").exists());
        release_tx.send(()).unwrap();
        first.await.unwrap();
        assert!(!lock_dir.join(".activation.lock").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn abandoned_ownerless_lock_is_reclaimed() {
        let (dir, spec) = temp_spec("lock-stale");
        std::fs::create_dir_all(spec.archives_dir()).unwrap();
        let lock_dir = spec.archives_dir();
        let lock = lock_dir.join(".activation.lock");
        std::fs::create_dir(&lock).unwrap();
        // 11 seconds ago (FileTime takes seconds, now_ms is milliseconds).
        let abandoned = filetime::FileTime::from_unix_time(((now_ms() - 11_000) / 1000) as i64, 0);
        filetime::set_file_mtime(&lock, abandoned).unwrap();

        with_archive_activation_lock(
            &lock_dir,
            ".activation.lock",
            LockTiming::default(),
            || async { 7 },
        )
        .await
        .unwrap();
        assert!(!lock.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn heartbeat_keeps_a_held_lease_fresh() {
        // With a tiny stale window, only the heartbeat's mtime refresh can
        // keep a contender from reclaiming the lock mid-run.
        let (dir, spec) = temp_spec("lock-heartbeat");
        std::fs::create_dir_all(spec.archives_dir()).unwrap();
        let lock_dir = spec.archives_dir();
        let timing = LockTiming {
            timeout_ms: 1_000,
            stale_ms: 200,
            owner_grace_ms: 200,
            heartbeat_ms: 40,
        };
        let started = std::time::Instant::now();
        let value = with_archive_activation_lock(&lock_dir, ".activation.lock", timing, || async {
            // Longer than the stale window: the heartbeat must renew.
            tokio::time::sleep(Duration::from_millis(600)).await;
            42
        })
        .await
        .unwrap();
        assert_eq!(value, 42);
        assert!(started.elapsed() >= Duration::from_millis(500));
        assert!(!lock_dir.join(".activation.lock").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn safe_extract_rejects_escape_and_writes_files() {
        let (dir, spec) = temp_spec("extract");
        write_levels_zip(&spec, b"{\"enemies\":[]}");
        // Path escape entry aborts the whole extraction.
        write_zip_entries(
            &spec.archives_dir().join("evil.zip"),
            &[("ok.json", b"{}"), ("../../../evil.json", b"pwned")],
        )
        .unwrap();
        let err = safe_extract_zip(&spec.archives_dir().join("evil.zip"), &spec.local_root);
        assert!(matches!(&err, Err(SyncError::Message(m)) if m.contains("Unsafe zip member path")));
        assert!(!dir.join("evil.json").exists());

        safe_extract_zip(&spec.local_zip, &spec.local_root).unwrap();
        assert!(spec
            .local_root
            .join("zh_CN/gamedata/levels/enemydata/enemy_database.json")
            .is_file());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn extract_meta_round_trip_and_containment() {
        let (dir, spec) = temp_spec("meta");
        std::fs::create_dir_all(spec.local_root.join(".releases/g1")).unwrap();
        save_extract_meta(&spec, "sha-1", &spec.local_root.join(".releases/g1")).unwrap();
        let text = std::fs::read_to_string(extract_meta_path(&spec)).unwrap();
        assert!(text.contains("\"data_root\": \".releases/g1\""));
        let meta = load_extract_meta(&spec).unwrap();
        assert_eq!(meta.commit_sha, "sha-1");
        assert!(meta.data_root.ends_with(".releases/g1"));

        // Escape is rejected.
        save_extract_meta(&spec, "sha-2", &dir).unwrap();
        assert!(load_extract_meta(&spec).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stage_release_tree_names_and_validates() {
        let (dir, spec) = temp_spec("stage");
        write_levels_zip(&spec, b"{}");
        let staged = stage_release_tree(&spec, "commit-sha-1").unwrap();
        assert!(staged
            .staging
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with('.'));
        assert!(staged.staging.to_string_lossy().ends_with(".tmp"));
        // generation = sha256(commitSha) hex prefix + uuid suffix.
        use sha2::Digest;
        let expected_prefix =
            format!("{:x}", sha2::Sha256::digest(b"commit-sha-1"))[..16].to_string();
        assert!(staged
            .activated
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with(&expected_prefix));
        assert!(staged
            .staging
            .join("zh_CN/gamedata/levels/enemydata/enemy_database.json")
            .is_file());
        // Complete the activation so the first staging dir is not a leftover.
        std::fs::rename(&staged.staging, &staged.activated).unwrap();

        // Missing required files → error + staging removed.
        write_zip_entries(&spec.local_zip, &[("wrong/path.json", b"{}")]).unwrap();
        let err = stage_release_tree(&spec, "commit-sha-2").unwrap_err();
        assert!(err.to_string().contains("missing required files"));
        let releases = spec.local_root.join(".releases");
        let leftovers: Vec<_> = std::fs::read_dir(&releases)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with('.'))
            .collect();
        assert!(leftovers.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn activation_sha_falls_back_to_zip_digest() {
        let (dir, spec) = temp_spec("sha");
        write_levels_zip(&spec, b"content");
        assert_eq!(archive_activation_sha(&spec, Some("vid-1")), "vid-1");
        let local = archive_activation_sha(&spec, None);
        assert!(local.starts_with("local-"));
        assert_ne!(local, "local-content");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
