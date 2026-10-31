//! Kernel lease around the shared legacy image directory lock.
//! A killed 3.2 writer releases the kernel lease, allowing its marked legacy
//! lock to be recovered immediately. Unmarked legacy writers retain their lease.
use super::{
    activation::{with_archive_activation_lock, LockTiming},
    types::SyncError,
};
use std::{
    future::Future,
    path::Path,
    time::{Duration, Instant},
};

pub async fn with_images_lock<T, F, Fut>(root: &Path, run: F) -> Result<T, SyncError>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = T>,
{
    with_images_lease(root, |_| run()).await
}

pub(super) async fn with_images_lease<T, F, Fut>(root: &Path, run: F) -> Result<T, SyncError>
where
    F: FnOnce(std::sync::Arc<std::fs::File>) -> Fut,
    Fut: Future<Output = T>,
{
    let lease = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(root.join(".images-writer.lock"))?;
    let deadline = Instant::now() + Duration::from_millis(LockTiming::default().timeout_ms);
    loop {
        match lease.try_lock() {
            Ok(()) => break,
            Err(std::fs::TryLockError::WouldBlock) if Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            Err(error) => return Err(SyncError::Message(format!("image writer lease: {error}"))),
        }
    }
    let lease = std::sync::Arc::new(lease);
    let lock = root.join(".images.lock");
    let marker = lock.join("kernel-owner");
    if lock.symlink_metadata().is_ok_and(|meta| meta.is_dir()) && marker.is_file() {
        // No participating writer is alive: we own its never-unlinked lease inode.
        std::fs::remove_dir_all(&lock)?;
    }
    let result =
        with_archive_activation_lock(root, ".images.lock", LockTiming::default(), || async {
            if let Err(error) = std::fs::write(marker, b"prts-mcp-images-kernel-lease/v1") {
                return Err(SyncError::from(error));
            }
            Ok(run(std::sync::Arc::clone(&lease)).await)
        })
        .await??;
    drop(lease);
    Ok(result)
}
