//! Blocking file work and candidate recovery for v2 image synchronization.
use super::{images_meta, images_v2::Part};
use sha2::{Digest, Sha256};
#[cfg(test)]
use std::sync::Mutex;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    sync::Arc,
};

/// Owns an unpublished directory and keeps its writer lease through cancellation cleanup.
pub(super) struct Candidate(
    pub(super) Option<std::path::PathBuf>,
    pub(super) Arc<std::fs::File>,
);
impl Candidate {
    pub(super) fn cleanup(&mut self) {
        if let Some(path) = self.0.take() {
            remove_candidate(path);
        }
    }
}
fn remove_candidate(path: std::path::PathBuf) {
    if let Err(e) = std::fs::remove_dir_all(path) {
        crate::log_warn(&format!("Image candidate cleanup: {e}"));
    }
}
impl Drop for Candidate {
    fn drop(&mut self) {
        let Some(path) = self.0.take() else { return };
        let lease = Arc::clone(&self.1);
        // Cancellation can drop the last owner while awaiting the network.
        // The cleanup owns the lease so another writer cannot race its removal.
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn_blocking(move || {
                let _lease = lease;
                remove_candidate(path);
            });
        } else {
            remove_candidate(path);
        }
    }
}

pub(super) async fn blocking<T: Send + 'static>(
    lease: &Arc<std::fs::File>,
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let lease = Arc::clone(lease);
    tokio::task::spawn_blocking(move || {
        let _lease = lease;
        f()
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Stream a regular file once, optionally copying it; a failed copy is removed.
pub(super) fn checked(path: &Path, bytes: u64, sha: &str, copy: Option<&Path>) -> bool {
    use std::io::{Read, Write};
    if !std::fs::symlink_metadata(path).is_ok_and(|meta| meta.is_file() && meta.len() == bytes) {
        return false;
    }
    let matched = (|| {
        let mut f = std::fs::File::open(path)?;
        let mut out = copy.map(std::fs::File::create).transpose()?;
        let mut h = Sha256::new();
        let mut total = 0;
        let mut buf = [0u8; 65536];
        loop {
            let n = f.read(&mut buf)?;
            if n == 0 {
                break;
            }
            total += n as u64;
            h.update(&buf[..n]);
            if let Some(out) = &mut out {
                out.write_all(&buf[..n])?;
            }
        }
        std::io::Result::Ok(total == bytes && format!("{:x}", h.finalize()) == sha)
    })()
    .unwrap_or(false);
    if let Some(copy) = copy.filter(|_| !matched) {
        let _ = std::fs::remove_file(copy);
    }
    matched
}
pub(super) fn extract(
    archive: &Path,
    part: &Part,
    stage: &Path,
    expected: &BTreeMap<String, (u64, String)>,
    preserved: &BTreeSet<String>,
) -> Result<BTreeMap<String, (u64, String)>, String> {
    let mut written = BTreeMap::new();
    let mut zip = zip::ZipArchive::new(std::fs::File::open(archive).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let mut seen = BTreeSet::new();
    for i in 0..zip.len() {
        use std::io::Read;
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().to_owned();
        let member = part.members.get(&name).ok_or("unexpected ZIP member")?;
        if !seen.insert(name.clone()) {
            return Err("duplicate ZIP member".into());
        }
        let mut hash = Sha256::new();
        let mut count = 0u64;
        let mut buf = [0u8; 65536];
        let mut out = if preserved.contains(&name) || !expected.contains_key(&name) {
            None
        } else {
            Some(std::fs::File::create(stage.join(&name)).map_err(|e| e.to_string())?)
        };
        loop {
            let n = entry.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            count = count
                .checked_add(n as u64)
                .filter(|n| *n <= member.bytes)
                .ok_or("member exceeds declared length")?;
            hash.update(&buf[..n]);
            if let Some(f) = &mut out {
                use std::io::Write;
                f.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            }
        }
        if count != member.bytes || format!("{:x}", hash.finalize()) != member.sha256 {
            return Err("member digest mismatch".into());
        }
        if out.is_some() {
            written.insert(name, (member.bytes, member.sha256.clone()));
        }
    }
    if seen.len() != part.members.len() {
        return Err("missing ZIP member".into());
    }
    Ok(written)
}
pub(super) fn cleanup_old(root: &Path) {
    let Some(active) = images_meta::active_generation(root) else {
        return;
    };
    let Ok(active) = active.canonicalize() else {
        return;
    };
    let Ok(releases) = root.join(".releases").canonicalize() else {
        return;
    };
    if active.parent() != Some(releases.as_path()) {
        return;
    }
    let Ok(entries) = std::fs::read_dir(&releases) else {
        return;
    };
    let cutoff = super::primitives::now_ms().saturating_sub(images_meta::RETENTION_MS) as u128;
    for entry in entries.flatten() {
        let path = entry.path();
        if !entry.file_name().to_string_lossy().starts_with("v2-") || path == active {
            continue;
        }
        if entry.file_type().is_ok_and(|t| t.is_dir())
            && entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .is_some_and(|t| super::primitives::mtime_ms(t) < cutoff)
        {
            if let Err(e) = std::fs::remove_dir_all(path) {
                crate::log_warn(&format!("Image orphan cleanup: {e}"));
            }
        }
    }
}

pub(super) fn cleanup_staging(root: &Path) -> Result<(), String> {
    if !root.exists() {
        return Ok(());
    }
    for item in std::fs::read_dir(root).map_err(|e| e.to_string())? {
        let item = item.map_err(|e| e.to_string())?;
        let name = item.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(".v2-") && name.ends_with(".tmp") {
            if !item.file_type().map_err(|e| e.to_string())?.is_dir() {
                crate::log_warn(&format!(
                    "Images v2 staging cleanup: skipping non-directory {}",
                    item.path().display()
                ));
                continue;
            }
            std::fs::remove_dir_all(item.path()).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    #[test]
    fn extraction_never_writes_excess_and_checks_discarded_members() {
        use super::*;
        use std::io::Write;
        let root = std::env::temp_dir().join(format!("extract-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let archive = root.join("part.zip");
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&archive).unwrap());
        zip.start_file("a.png", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(&vec![0; 200_000]).unwrap();
        zip.finish().unwrap();
        let part = Part {
            file: "part.zip".into(),
            bytes: 1,
            sha256: String::new(),
            group: "chararts-large".into(),
            members: BTreeMap::from([(
                "a.png".into(),
                super::super::images_v2::Member {
                    bytes: 70_000,
                    sha256: "0".repeat(64),
                    group: "chararts-large".into(),
                },
            )]),
        };
        for selected in [true, false] {
            let stage = root.join(if selected { "selected" } else { "discarded" });
            std::fs::create_dir(&stage).unwrap();
            let expected = if selected {
                BTreeMap::from([("a.png".into(), (70_000, "0".repeat(64)))])
            } else {
                BTreeMap::new()
            };
            assert_eq!(
                extract(&archive, &part, &stage, &expected, &BTreeSet::new()).unwrap_err(),
                "member exceeds declared length"
            );
            assert!(
                std::fs::metadata(stage.join("a.png"))
                    .map(|m| m.len())
                    .unwrap_or(0)
                    <= 70_000
            );
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unknown_active_pointer_does_not_prune_formal_generations() {
        use super::*;
        let root = std::env::temp_dir().join(format!("orphan-{}", uuid::Uuid::new_v4()));
        let orphan = root.join(".releases/v2-old");
        std::fs::create_dir_all(&orphan).unwrap();
        filetime::set_file_mtime(&orphan, filetime::FileTime::from_unix_time(0, 0)).unwrap();
        cleanup_old(&root);
        assert!(orphan.exists());
        std::fs::write(root.join(".images_meta.json"), b"broken").unwrap();
        cleanup_old(&root);
        assert!(orphan.exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cancellation_between_workers_queues_cleanup_and_retains_lease() {
        use super::*;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .max_blocking_threads(1)
            .build()
            .unwrap();
        runtime.block_on(async {
            let root =
                std::env::temp_dir().join(format!("cancel-between-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&root).unwrap();
            let stage = root.join("stage");
            std::fs::create_dir(&stage).unwrap();
            std::fs::write(stage.join("reused.png"), b"reused").unwrap();
            let lock_path = root.join("lease");
            let lease = Arc::new(std::fs::File::create(&lock_path).unwrap());
            lease.try_lock().unwrap();
            // Hold the only blocking slot so queued cleanup cannot finish before assertions.
            let (occupied_tx, occupied_rx) = tokio::sync::oneshot::channel();
            let (release_tx, release_rx) = std::sync::mpsc::channel();
            let blocker = tokio::task::spawn_blocking(move || {
                occupied_tx.send(()).unwrap();
                release_rx.recv().unwrap();
            });
            occupied_rx.await.unwrap();
            let candidate = Candidate(Some(stage.clone()), lease);
            let (waiting_tx, waiting_rx) = tokio::sync::oneshot::channel();
            let task = tokio::spawn(async move {
                let _candidate = candidate;
                waiting_tx.send(()).unwrap();
                // Same ownership boundary as a pending network transfer after file reuse.
                std::future::pending::<()>().await;
            });
            waiting_rx.await.unwrap();
            task.abort();
            assert!(task.await.unwrap_err().is_cancelled());
            assert!(stage.join("reused.png").exists());
            let contender = std::fs::File::options()
                .read(true)
                .write(true)
                .open(&lock_path)
                .unwrap();
            assert!(matches!(
                contender.try_lock(),
                Err(std::fs::TryLockError::WouldBlock)
            ));
            release_tx.send(()).unwrap();
            blocker.await.unwrap();
            tokio::time::timeout(std::time::Duration::from_secs(5), async {
                loop {
                    if contender.try_lock().is_ok() {
                        break;
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            assert!(!stage.exists());
            drop(contender);
            std::fs::remove_dir_all(root).unwrap();
        });
    }

    #[tokio::test(flavor = "current_thread")]
    async fn cancelled_waiter_keeps_worker_lease_and_candidate_alive() {
        use super::*;
        let root = std::env::temp_dir().join(format!("worker-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let stage = root.join("stage");
        std::fs::create_dir(&stage).unwrap();
        let lock_path = root.join("lease");
        let lock = std::fs::File::create(&lock_path).unwrap();
        lock.try_lock().unwrap();
        let lease = Arc::new(lock);
        let candidate = Arc::new(Mutex::new(Candidate(
            Some(stage.clone()),
            Arc::clone(&lease),
        )));
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            blocking(&lease, move || {
                let _candidate = candidate;
                started_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                drop(_candidate);
                done_tx.send(()).unwrap();
                Ok(())
            })
            .await
        });
        started_rx.await.unwrap();
        // Reaching here on the sole async worker proves the file worker yielded execution.
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert!(stage.exists());
        let contender = std::fs::File::options()
            .read(true)
            .write(true)
            .open(&lock_path)
            .unwrap();
        assert!(matches!(
            contender.try_lock(),
            Err(std::fs::TryLockError::WouldBlock)
        ));
        release_tx.send(()).unwrap();
        done_rx.await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if contender.try_lock().is_ok() {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(!stage.exists());
        drop(contender);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn abandoned_staging_cleanup_is_owned_and_repeatable() {
        let root = std::env::temp_dir().join(format!(
            "sharding-cleanup-{}",
            crate::sync::primitives::random_suffix()
        ));
        for name in [".v2-abandoned.tmp", "v2-active", ".other.tmp"] {
            std::fs::create_dir_all(root.join(name)).unwrap();
        }
        super::cleanup_staging(&root).unwrap();
        super::cleanup_staging(&root).unwrap();
        assert!(!root.join(".v2-abandoned.tmp").exists());
        assert!(root.join("v2-active").exists());
        assert!(root.join(".other.tmp").exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}
