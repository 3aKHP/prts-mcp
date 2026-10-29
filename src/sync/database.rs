//! SQLite-only game data discovery, transfer, validation and activation.
use super::{
    database_io as io, database_manifest::DatabaseManifest, discovery, transport::Transport,
};
use crate::{
    config::{DataSource, RuntimeConfig, ValidationMode},
    storage::database,
};
use std::{fs::OpenOptions, path::Path, sync::Arc, time::Duration};

pub async fn sync(transport: &dyn Transport, root: &Path) -> Result<bool, String> {
    sync_with_mode(transport, root, ValidationMode::Normal).await
}

/// Sync using the process startup validation policy.
pub async fn sync_with_mode(
    transport: &dyn Transport,
    root: &Path,
    mode: ValidationMode,
) -> Result<bool, String> {
    sync_with_source(transport, root, mode, &DataSource::default()).await
}

pub async fn sync_with_source(
    transport: &dyn Transport,
    root: &Path,
    mode: ValidationMode,
    source: &DataSource,
) -> Result<bool, String> {
    super::source_guard::ensure(root, source)?;
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(root.join("sync.lock"))
        .map_err(|e| e.to_string())?;
    lock.try_lock()
        .map_err(|e| format!("SQLite sync locked: {e}"))?;
    let lock = Arc::new(lock);
    super::source_guard::ensure(root, source)?;
    io::clean_staging(root);
    let releases = discovery::list_releases(transport, source.owner(), source.repo(), 30_000)
        .await
        .ok_or("SQLite release discovery failed")?;
    let release = discovery::latest_data_release(&releases)
        .map_err(|e| e.to_string())?
        .ok_or("No data release")?;
    let tag = release["tag_name"]
        .as_str()
        .ok_or("Missing data release tag")?;
    let version = discovery::parse_data_tag(tag).ok_or("Invalid data release tag")?;
    let manifest_url =
        discovery::asset_url(&release, "manifest.json").ok_or("SQLite release has no manifest")?;
    let value = transport
        .fetch_json(&manifest_url, 30_000)
        .await
        .map_err(|e| e.to_string())?;
    let manifest = DatabaseManifest::from_release(&value, &version.version_id, version.revision)?;
    let check_root = root.to_owned();
    let check_manifest = manifest.clone();
    let check_lock = Arc::clone(&lock);
    match tokio::task::spawn_blocking(move || {
        let _lock = check_lock;
        prepare(&check_root, &check_manifest, mode)
    })
    .await
    .map_err(|e| e.to_string())??
    {
        Prepared::Ready(updated) => return Ok(updated),
        Prepared::Download => (),
    };
    let stage = io::Staging(root.join(format!(".stage-{}", uuid::Uuid::new_v4().simple())));
    std::fs::create_dir(&stage.0).map_err(|e| e.to_string())?;
    let compressed = stage.0.join("data.sqlite.gz");
    let url =
        discovery::asset_url(&release, &manifest.asset).ok_or("SQLite release asset missing")?;
    let stats = tokio::time::timeout(
        Duration::from_secs(600),
        transport.download_limited(&url, &compressed, 600_000, manifest.compressed_size),
    )
    .await
    .map_err(|_| "SQLite download timed out")?
    .map_err(|e| e.to_string())?;
    if stats.bytes != manifest.compressed_size || stats.sha256 != manifest.compressed_sha256 {
        return Err("SQLite compressed download size/SHA-256 mismatch".into());
    }

    // The worker owns the stage and cross-process lock. Dropping the async
    // request cannot remove its input or permit a second publisher mid-commit.
    let root = root.to_owned();
    tokio::task::spawn_blocking(move || {
        let _lock = lock;
        let stage = stage;
        let decoded = stage.0.join("data.sqlite");
        io::decode(&stage.0.join("data.sqlite.gz"), &decoded, &manifest)?;
        let current = io::publish(&root, &decoded, &manifest, mode)?;
        io::prune(&root, &current);
        Ok::<_, String>(())
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(true)
}

enum Prepared {
    Ready(bool),
    Download,
}

fn prepare(
    root: &Path,
    manifest: &DatabaseManifest,
    mode: ValidationMode,
) -> Result<Prepared, String> {
    let (previous, repair_active) = match database::active(root) {
        Ok(pointer) => (pointer, false),
        Err(error) => {
            crate::log_warn(&format!("Repairing invalid SQLite pointer: {error}"));
            let previous = std::fs::read_to_string(root.join("previous"))
                .ok()
                .and_then(|text| database::ActiveDatabase::parse(&text).ok());
            (previous, true)
        }
    };
    if let Some(previous) = &previous {
        let local = (previous.source_version.as_str(), previous.revision);
        if local > manifest.generation() {
            return Err("SQLite release downgrade rejected".into());
        }
        if local == manifest.generation() && previous.sha256 != manifest.sha256 {
            return Err(
                "same SQLite generation has a different digest; publish a new revision".into(),
            );
        }
        if previous.sha256 == manifest.sha256
            && io::verify(&previous.path(root), manifest, mode, false).is_ok()
        {
            if repair_active {
                io::activate(root, previous)?;
            }
            io::prune(root, previous);
            return Ok(Prepared::Ready(repair_active));
        }
    }
    if let Some(path) = io::cached(root, manifest, mode) {
        let pointer = database::ActiveDatabase {
            file_name: path
                .file_name()
                .and_then(|p| p.to_str())
                .ok_or("Invalid cache path")?
                .into(),
            source_version: manifest.source_version.clone(),
            revision: manifest.publication_revision,
            sha256: manifest.sha256.clone(),
        };
        io::activate(root, &pointer)?;
        io::prune(root, &pointer);
        return Ok(Prepared::Ready(true));
    }
    Ok(Prepared::Download)
}

pub fn start(config: Arc<RuntimeConfig>, transport: Arc<dyn Transport>) {
    if config.data_backend != crate::config::DataBackend::Sqlite {
        return;
    }
    if config.custom_database.is_some() {
        crate::log_info("PRTS_DATA_DB is set; game database auto-sync disabled.");
        return;
    }
    tokio::spawn(async move {
        loop {
            for delay in [0, 30_000, 120_000, 600_000] {
                if delay > 0 {
                    tokio::time::sleep(Duration::from_millis(delay)).await;
                }
                match sync_with_source(
                    transport.as_ref(),
                    &config.database_dir,
                    config.validation_mode,
                    &config.data_source,
                )
                .await
                {
                    Ok(updated) => {
                        crate::log_info(if updated {
                            "SQLite dataset updated."
                        } else {
                            "SQLite dataset is up to date."
                        });
                        break;
                    }
                    Err(error) => crate::log_warn(&format!(
                        "SQLite sync failed; keeping cached/bundled data: {error}"
                    )),
                }
            }
            if config.auto_sync_interval_ms == 0 {
                return;
            }
            tokio::time::sleep(Duration::from_millis(config.auto_sync_interval_ms)).await;
        }
    });
}
