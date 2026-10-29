//! GameData pair state machine: archive extract-and-activate + pair
//! coordination — port of TS `sync/gamedataPair.ts`.
//!
//! Carries both idempotency guards (#152/#155): the archive-layer
//! "already at activationSha" short-circuit and the pair-layer no-op-write
//! short-circuit. Lock order (docs/05): pair → excel activation → excel
//! release, release excel, then levels activation → levels release.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::activation::{
    archive_files_present, load_extract_meta, prune_release_trees, releases_path,
    save_extract_meta, stage_release_tree, with_archive_activation_lock, LockTiming, StagedTree,
};
use super::primitives::{atomic_write_json, now_ms};
use super::release::sync_release;
use super::transport::Transport;
use super::types::{ReleaseArchiveSpec, SyncError, SyncResult, SyncStatus};
use crate::sync::validation::validate_archive_zip;

const GAMEDATA_PAIR_META: &str = ".gamedata_pair.json";

fn parents(path: &Path) -> PathBuf {
    let resolved = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    resolved.parent().map(Path::to_path_buf).unwrap_or(resolved)
}

/// Sync-side pair path: the roots MUST share one parent.
fn gamedata_pair_path(
    excel_spec: &ReleaseArchiveSpec,
    levels_spec: &ReleaseArchiveSpec,
) -> Result<PathBuf, SyncError> {
    let excel_parent = parents(&excel_spec.local_root);
    let levels_parent = parents(&levels_spec.local_root);
    if excel_parent != levels_parent {
        return Err(SyncError::Message(
            "GameData excel and levels roots must share one parent".to_string(),
        ));
    }
    Ok(excel_parent.join(GAMEDATA_PAIR_META))
}

struct GamedataPairMeta {
    commit_sha: String,
    excel_root: PathBuf,
    levels_root: PathBuf,
}

/// `loadGamedataPair`: strict validation — realpath containment on both
/// roots plus required files present in both.
fn load_gamedata_pair(
    excel_spec: &ReleaseArchiveSpec,
    levels_spec: &ReleaseArchiveSpec,
) -> Result<Option<GamedataPairMeta>, SyncError> {
    let result = (|| -> Option<GamedataPairMeta> {
        let path = gamedata_pair_path(excel_spec, levels_spec).ok()?;
        let info = std::fs::symlink_metadata(&path).ok()?;
        if !info.is_file() {
            return None;
        }
        let value: Value = serde_json::from_str(&std::fs::read_to_string(&path).ok()?).ok()?;
        let commit_sha = value.get("commit_sha")?.as_str()?;
        if commit_sha.is_empty() {
            return None;
        }
        let excel_data_root = value.get("excel_data_root")?.as_str()?;
        if excel_data_root.is_empty() {
            return None;
        }
        let levels_data_root = value.get("levels_data_root")?.as_str()?;
        if levels_data_root.is_empty() {
            return None;
        }
        let excel_base = std::fs::canonicalize(&excel_spec.local_root).ok()?;
        let levels_base = std::fs::canonicalize(&levels_spec.local_root).ok()?;
        let excel_root = std::fs::canonicalize(excel_base.join(excel_data_root)).ok()?;
        let levels_root = std::fs::canonicalize(levels_base.join(levels_data_root)).ok()?;
        if !excel_root.starts_with(&excel_base) || !levels_root.starts_with(&levels_base) {
            return None;
        }
        if !archive_files_present(excel_spec, &excel_root) {
            return None;
        }
        if !archive_files_present(levels_spec, &levels_root) {
            return None;
        }
        Some(GamedataPairMeta {
            commit_sha: commit_sha.to_string(),
            excel_root,
            levels_root,
        })
    })();
    Ok(result)
}

fn relative_or_dot(from: &Path, to: &Path) -> String {
    // Activation roots are realpaths. Canonicalize both sides so /var aliases
    // on macOS and Windows extended-length prefixes do not leak absolute paths
    // into otherwise movable, relative generation metadata.
    let from_abs = std::fs::canonicalize(from)
        .or_else(|_| std::path::absolute(from))
        .unwrap_or_else(|_| from.to_path_buf());
    let to_abs = std::fs::canonicalize(to)
        .or_else(|_| std::path::absolute(to))
        .unwrap_or_else(|_| to.to_path_buf());
    if let Ok(rel) = to_abs.strip_prefix(&from_abs) {
        let text = rel.to_string_lossy().replace('\\', "/");
        if text.is_empty() {
            return ".".to_string();
        }
        return text;
    }
    to_abs.to_string_lossy().replace('\\', "/")
}

/// `saveGamedataPair` with the no-op-write short-circuit: an unchanged pair
/// (same sha, same real roots) is not rewritten.
fn save_gamedata_pair(
    excel_spec: &ReleaseArchiveSpec,
    levels_spec: &ReleaseArchiveSpec,
    commit_sha: &str,
    excel_root: &Path,
    levels_root: &Path,
) -> Result<(), SyncError> {
    let path = gamedata_pair_path(excel_spec, levels_spec)?;
    let unchanged = (|| -> Option<bool> {
        let info = std::fs::symlink_metadata(&path).ok()?;
        if !info.is_file() {
            return Some(false);
        }
        let current = load_gamedata_pair(excel_spec, levels_spec).ok().flatten()?;
        let excel_real = std::fs::canonicalize(excel_root).ok()?;
        let levels_real = std::fs::canonicalize(levels_root).ok()?;
        Some(
            current.commit_sha == commit_sha
                && current.excel_root == excel_real
                && current.levels_root == levels_real,
        )
    })()
    .unwrap_or(false);
    if unchanged {
        return Ok(());
    }
    atomic_write_json(
        &path,
        &json!({
            "commit_sha": commit_sha,
            "excel_data_root": relative_or_dot(&excel_spec.local_root, excel_root),
            "levels_data_root": relative_or_dot(&levels_spec.local_root, levels_root),
        }),
    )
}

/// `initializeGamedataPair`: rebuild a missing pair from the extract metas —
/// legacy (both absent) or provably same-generation. Mixed generations are
/// left alone (no pair is written).
fn initialize_gamedata_pair(
    excel_spec: &ReleaseArchiveSpec,
    levels_spec: &ReleaseArchiveSpec,
) -> Result<(), SyncError> {
    if load_gamedata_pair(excel_spec, levels_spec)?.is_some() {
        return Ok(());
    }
    let excel_meta = load_extract_meta(excel_spec);
    let levels_meta = load_extract_meta(levels_spec);
    let (commit_sha, excel_root, levels_root) = match (&excel_meta, &levels_meta) {
        (None, None) => (
            "legacy".to_string(),
            excel_spec.local_root.clone(),
            levels_spec.local_root.clone(),
        ),
        (Some(excel), Some(levels)) if excel.commit_sha == levels.commit_sha => (
            excel.commit_sha.clone(),
            excel.data_root.clone(),
            levels.data_root.clone(),
        ),
        _ => return Ok(()),
    };
    if !archive_files_present(excel_spec, &excel_root) {
        return Ok(());
    }
    if !archive_files_present(levels_spec, &levels_root) {
        return Ok(());
    }
    save_gamedata_pair(
        excel_spec,
        levels_spec,
        &commit_sha,
        &excel_root,
        &levels_root,
    )
}

/// TS `utimes(path, now, now)` — refresh both times; best-effort.
fn touch(path: &Path) {
    let now = filetime::FileTime::from_system_time(std::time::SystemTime::now());
    let _ = filetime::set_file_times(path, now, now);
    let _ = now_ms();
}

/// `syncReleaseArchiveLocked` — download (under .release.lock), then decide
/// extraction, staging, activation, pointer publication and pruning.
async fn sync_release_archive_locked(
    transport: &dyn Transport,
    spec: &ReleaseArchiveSpec,
    force_check: bool,
) -> Result<SyncResult, SyncError> {
    let release_result = sync_release(transport, &spec.release_spec(), force_check).await;

    let extract_meta = load_extract_meta(spec);
    let active_root = extract_meta
        .as_ref()
        .map(|m| m.data_root.clone())
        .unwrap_or_else(|| spec.local_root.clone());
    prune_release_trees(spec, &HashSet::from([active_root.clone()]));
    let files_ok = archive_files_present(spec, &active_root);
    if release_result.status == SyncStatus::NoData {
        let commit_sha = release_result.commit_sha.clone();
        let error = release_result.error.clone();
        return Ok(if files_ok {
            SyncResult::new(SyncStatus::OfflineFallback, commit_sha, error)
        } else {
            SyncResult::new(SyncStatus::NoData, commit_sha, error)
        });
    }

    let extracted_sha = extract_meta.as_ref().map(|m| m.commit_sha.clone());
    let should_extract = release_result.status == SyncStatus::Updated
        || !files_ok
        || extracted_sha.is_none()
        || release_result
            .commit_sha
            .as_ref()
            .is_some_and(|sha| extracted_sha.as_deref() != Some(sha.as_str()));

    if should_extract {
        let result = extract_and_activate(transport, spec, &release_result).await;
        return match result {
            Ok(result) => Ok(result),
            Err(err) => {
                let files_ok_now = archive_files_present(spec, &active_root);
                let commit_sha = release_result.commit_sha.clone();
                Ok(if files_ok_now {
                    SyncResult::new(
                        SyncStatus::OfflineFallback,
                        commit_sha,
                        Some(err.to_string()),
                    )
                } else {
                    SyncResult::new(SyncStatus::NoData, commit_sha, Some(err.to_string()))
                })
            }
        };
    }

    Ok(release_result)
}

async fn extract_and_activate(
    transport: &dyn Transport,
    spec: &ReleaseArchiveSpec,
    release_result: &SyncResult,
) -> Result<SyncResult, SyncError> {
    let _ = transport; // validation is local; downloads happened in sync_release
    let activation_sha =
        super::activation::archive_activation_sha(spec, release_result.commit_sha.as_deref());
    let staged: StagedTree = stage_release_tree(spec, &activation_sha)?;
    let staging = staged.staging.clone();
    let result = async {
        let current_meta = load_extract_meta(spec);
        let current_root = current_meta
            .as_ref()
            .map(|m| m.data_root.clone())
            .unwrap_or_else(|| spec.local_root.clone());
        if current_meta
            .as_ref()
            .is_some_and(|m| m.commit_sha == activation_sha)
            && archive_files_present(spec, &current_root)
        {
            // #152 idempotency guard: already at this activation sha.
            let _ = std::fs::remove_dir_all(&staging);
            return Ok(SyncResult::new(
                SyncStatus::UpToDate,
                Some(activation_sha),
                None,
            ));
        }
        std::fs::rename(&staging, &staged.activated)?;
        if let Ok(releases) = releases_path(spec) {
            if current_root.parent() == Some(releases.as_path()) {
                touch(&current_root);
            }
        }
        save_extract_meta(spec, &activation_sha, &staged.activated)?;
        prune_release_trees(
            spec,
            &HashSet::from([current_root, staged.activated.clone()]),
        );
        Ok(SyncResult::new(
            SyncStatus::Updated,
            Some(activation_sha),
            None,
        ))
    }
    .await;
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    result
}

/// `syncReleaseArchive`: publish and activate one release archive under the
/// archives-directory `.activation.lock`.
pub async fn sync_release_archive(
    transport: &dyn Transport,
    spec: &ReleaseArchiveSpec,
    force_check: bool,
) -> SyncResult {
    let source =
        match crate::config::DataSource::parse(Some(&format!("{}/{}", spec.owner, spec.repo))) {
            Ok(source) => source,
            Err(error) => return SyncResult::new(SyncStatus::NoData, None, Some(error)),
        };
    if let Err(error) = super::source_guard::ensure(&spec.local_root, &source) {
        return SyncResult::new(SyncStatus::NoData, None, Some(error));
    }
    let result = async {
        std::fs::create_dir_all(spec.archives_dir())?;
        with_archive_activation_lock(
            &spec.archives_dir(),
            ".activation.lock",
            LockTiming::default(),
            || async {
                if let Err(error) = super::source_guard::ensure(&spec.local_root, &source) {
                    return Ok(SyncResult::new(SyncStatus::NoData, None, Some(error)));
                }
                sync_release_archive_locked(transport, spec, force_check).await
            },
        )
        .await
        .and_then(|inner| inner)
    }
    .await;
    match result {
        Ok(result) => result,
        Err(err) => {
            let active = load_extract_meta(spec);
            let root = active
                .as_ref()
                .map(|m| m.data_root.clone())
                .unwrap_or_else(|| spec.local_root.clone());
            let status = if archive_files_present(spec, &root) {
                SyncStatus::OfflineFallback
            } else {
                SyncStatus::NoData
            };
            SyncResult::new(status, None, Some(err.to_string()))
        }
    }
}

/// `syncReleaseArchivePair`: activate excel and levels as one cross-process
/// visible generation under `.gamedata-pair.lock` in the common parent.
pub async fn sync_release_archive_pair(
    transport: &dyn Transport,
    excel_spec: &ReleaseArchiveSpec,
    levels_spec: &ReleaseArchiveSpec,
    force_check: bool,
) -> Result<(SyncResult, SyncResult), SyncError> {
    let pair_path = gamedata_pair_path(excel_spec, levels_spec)?;
    if let Some(parent) = pair_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let lock_dir = pair_path.parent().unwrap_or(Path::new(".")).to_path_buf();
    with_archive_activation_lock(
        &lock_dir,
        ".gamedata-pair.lock",
        LockTiming::default(),
        || async {
            for spec in [excel_spec, levels_spec] {
                let source = crate::config::DataSource::parse(Some(&format!(
                    "{}/{}",
                    spec.owner, spec.repo
                )))
                .map_err(SyncError::Message)?;
                super::source_guard::ensure(&spec.local_root, &source)
                    .map_err(SyncError::Message)?;
            }
            initialize_gamedata_pair(excel_spec, levels_spec)?;
            if let Some(current) = load_gamedata_pair(excel_spec, levels_spec)? {
                touch(&current.excel_root);
                touch(&current.levels_root);
            }
            let excel_result = sync_release_archive(transport, excel_spec, force_check).await;
            let levels_result = sync_release_archive(transport, levels_spec, force_check).await;
            let excel_meta = load_extract_meta(excel_spec);
            let levels_meta = load_extract_meta(levels_spec);
            if let (Some(excel_meta), Some(levels_meta)) = (&excel_meta, &levels_meta) {
                if excel_meta.commit_sha == levels_meta.commit_sha
                    && archive_files_present(excel_spec, &excel_meta.data_root)
                    && archive_files_present(levels_spec, &levels_meta.data_root)
                {
                    save_gamedata_pair(
                        excel_spec,
                        levels_spec,
                        &excel_meta.commit_sha,
                        &excel_meta.data_root,
                        &levels_meta.data_root,
                    )?;
                }
            }
            Ok((excel_result, levels_result))
        },
    )
    .await
    .and_then(|inner| inner)
}

/// The zip validator wiring for archive specs (story packs use the
/// chapter-walking validator inside `sync_release` via story_mode).
pub fn archive_validate_zip(
    zip_path: &Path,
    required_files: &[String],
) -> Result<Vec<String>, SyncError> {
    validate_archive_zip(zip_path, required_files).map_err(SyncError::Message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::write_zip_entries;

    fn pair_specs(name: &str) -> (PathBuf, ReleaseArchiveSpec, ReleaseArchiveSpec) {
        let dir = std::env::temp_dir().join(format!("prts-pair-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let excel = ReleaseArchiveSpec {
            owner: "3aKHP".into(),
            repo: "arknights-data-pipeline".into(),
            asset_name: "zh_CN-excel.zip".into(),
            local_zip: dir.join("gamedata/archives/zh_CN-excel.zip"),
            local_root: dir.join("gamedata"),
            required_files: vec!["zh_CN/gamedata/excel/character_table.json".into()],
            verify_manifest: false,
        };
        let levels = ReleaseArchiveSpec {
            owner: "3aKHP".into(),
            repo: "arknights-data-pipeline".into(),
            asset_name: "zh_CN-levels.zip".into(),
            local_zip: dir.join("gamedata-levels/archives/zh_CN-levels.zip"),
            local_root: dir.join("gamedata-levels"),
            required_files: vec!["zh_CN/gamedata/levels/enemydata/enemy_database.json".into()],
            verify_manifest: false,
        };
        (dir, excel, levels)
    }

    struct DownTransport;
    #[async_trait::async_trait]
    impl Transport for DownTransport {
        async fn fetch_json(
            &self,
            _url: &str,
            _t: u64,
        ) -> Result<Value, crate::sync::transport::TransportError> {
            Err(crate::sync::transport::TransportError::Network(
                "network down".into(),
            ))
        }
        async fn download(
            &self,
            _u: &str,
            _d: &Path,
            _t: u64,
        ) -> Result<crate::sync::transport::DownloadStats, crate::sync::transport::TransportError>
        {
            Err(crate::sync::transport::TransportError::Network(
                "network down".into(),
            ))
        }
        fn mirrors(&self) -> Vec<String> {
            vec![]
        }
        fn github_headers(&self) -> Vec<(String, String)> {
            vec![]
        }
    }

    fn activate_generation(specs: (&ReleaseArchiveSpec, &ReleaseArchiveSpec), generation: &str) {
        for spec in [specs.0, specs.1] {
            let required = &spec.required_files[0];
            let data_root = spec.local_root.join(".releases").join(generation);
            std::fs::create_dir_all(data_root.join(required).parent().unwrap()).unwrap();
            std::fs::write(data_root.join(required), generation).unwrap();
            write_zip_entries(&spec.local_zip, &[(required, generation.as_bytes())]).unwrap();
            let meta = json!({
                "repo": format!("{}/{}", spec.owner, spec.repo),
                "branch": "releases",
                "commit_sha": generation,
                "fetched_at": "2099-01-01T00:00:00.000Z",
                "files": [spec.asset_name],
            });
            std::fs::write(
                spec.archives_dir().join("release_meta.json"),
                serde_json::to_string_pretty(&meta).unwrap(),
            )
            .unwrap();
            let extract =
                json!({"commit_sha": generation, "data_root": format!(".releases/{generation}")});
            std::fs::write(
                spec.archives_dir().join("extract_meta.json"),
                serde_json::to_string_pretty(&extract).unwrap(),
            )
            .unwrap();
        }
    }

    #[tokio::test]
    async fn pair_manifest_is_stable_until_the_generation_changes() {
        let (dir, excel, levels) = pair_specs("stability");
        activate_generation((&excel, &levels), "same");
        let pair_path = dir.join(".gamedata_pair.json");

        let first = sync_release_archive_pair(&DownTransport, &excel, &levels, false)
            .await
            .unwrap();
        assert_eq!(
            (first.0.status, first.1.status),
            (SyncStatus::UpToDate, SyncStatus::UpToDate)
        );
        assert!(pair_path.is_file());
        let before = crate::storage::identity::path_token(&pair_path).unwrap();

        let second = sync_release_archive_pair(&DownTransport, &excel, &levels, false)
            .await
            .unwrap();
        assert_eq!(
            (second.0.status, second.1.status),
            (SyncStatus::UpToDate, SyncStatus::UpToDate)
        );
        let after = crate::storage::identity::path_token(&pair_path).unwrap();
        // Unchanged cycle: identical file identity and timestamps (no rewrite).
        assert_eq!(after, before);

        activate_generation((&excel, &levels), "next");
        sync_release_archive_pair(&DownTransport, &excel, &levels, false)
            .await
            .unwrap();
        let changed = crate::storage::identity::path_token(&pair_path).unwrap();
        let value: Value =
            serde_json::from_str(&std::fs::read_to_string(&pair_path).unwrap()).unwrap();
        assert_eq!(value["commit_sha"], "next");
        assert_ne!(changed, after);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn pair_manifest_is_rebuilt_when_missing_or_invalid() {
        let (dir, excel, levels) = pair_specs("rebuild");
        activate_generation((&excel, &levels), "same");
        let pair_path = dir.join(".gamedata_pair.json");

        sync_release_archive_pair(&DownTransport, &excel, &levels, false)
            .await
            .unwrap();
        std::fs::remove_file(&pair_path).unwrap();
        sync_release_archive_pair(&DownTransport, &excel, &levels, false)
            .await
            .unwrap();
        let value: Value =
            serde_json::from_str(&std::fs::read_to_string(&pair_path).unwrap()).unwrap();
        assert_eq!(value["commit_sha"], "same");

        std::fs::write(&pair_path, "not json").unwrap();
        sync_release_archive_pair(&DownTransport, &excel, &levels, false)
            .await
            .unwrap();
        let value: Value =
            serde_json::from_str(&std::fs::read_to_string(&pair_path).unwrap()).unwrap();
        assert_eq!(value["commit_sha"], "same");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn pair_rebuild_rejects_mixed_generations() {
        let (dir, excel, levels) = pair_specs("mixed");
        activate_generation((&excel, &levels), "old");
        // Excel points at a NEWER generation than levels.
        let excel_root = excel.local_root.join(".releases/new");
        let excel_file = excel_root.join(&excel.required_files[0]);
        std::fs::create_dir_all(excel_file.parent().unwrap()).unwrap();
        std::fs::write(&excel_file, "new").unwrap();
        std::fs::write(
            excel.archives_dir().join("extract_meta.json"),
            serde_json::to_string_pretty(
                &json!({"commit_sha": "new", "data_root": ".releases/new"}),
            )
            .unwrap(),
        )
        .unwrap();
        // No zips → both go offline.
        std::fs::remove_file(&excel.local_zip).unwrap();
        std::fs::remove_file(&levels.local_zip).unwrap();

        let (r, l) = sync_release_archive_pair(&DownTransport, &excel, &levels, false)
            .await
            .unwrap();
        assert_eq!(r.status, SyncStatus::OfflineFallback);
        assert_eq!(l.status, SyncStatus::OfflineFallback);
        assert!(!dir.join(".gamedata_pair.json").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn pair_manifest_remains_readable_after_moving_data_directory() {
        let (dir, excel, levels) = pair_specs("relocate");
        activate_generation((&excel, &levels), "relocate");
        sync_release_archive_pair(&DownTransport, &excel, &levels, false)
            .await
            .unwrap();
        let moved = dir.with_extension("moved");
        let _ = std::fs::remove_dir_all(&moved);
        std::fs::rename(&dir, &moved).unwrap();
        let moved_excel = moved.join(excel.local_root.file_name().unwrap());
        let moved_levels = moved.join(levels.local_root.file_name().unwrap());
        let pair = crate::storage::activated_pair(&moved_excel, &moved_levels)
            .expect("relative generation pointers must survive moving the whole volume");
        assert!(pair.0.join(&excel.required_files[0]).is_file());
        assert!(pair.1.join(&levels.required_files[0]).is_file());
        std::fs::remove_dir_all(&moved).unwrap();
    }

    #[tokio::test]
    async fn pair_switches_only_after_both_archives_share_one_sha() {
        let (dir, excel, levels) = pair_specs("switch");
        for spec in [&excel, &levels] {
            let path = spec.local_root.join(&spec.required_files[0]);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::create_dir_all(spec.archives_dir()).unwrap();
            std::fs::write(&path, "old").unwrap();
            let meta = json!({
                "repo": "3aKHP/arknights-data-pipeline",
                "branch": "releases",
                "commit_sha": "new",
                "fetched_at": "2099-01-01T00:00:00.000Z",
                "files": [spec.asset_name],
            });
            std::fs::write(
                spec.archives_dir().join("release_meta.json"),
                serde_json::to_string_pretty(&meta).unwrap(),
            )
            .unwrap();
        }
        write_zip_entries(&excel.local_zip, &[(&excel.required_files[0], b"new")]).unwrap();
        // Levels zip lacks its required entry → activation fails.
        write_zip_entries(&levels.local_zip, &[("wrong/path.json", b"new")]).unwrap();

        let (_r, l) = sync_release_archive_pair(&DownTransport, &excel, &levels, false)
            .await
            .unwrap();
        assert_eq!(l.status, SyncStatus::OfflineFallback);
        let pair_path = dir.join(".gamedata_pair.json");
        let pair: Value =
            serde_json::from_str(&std::fs::read_to_string(&pair_path).unwrap()).unwrap();
        assert_eq!(pair["commit_sha"], "legacy");
        assert_eq!(pair["excel_data_root"], ".");
        assert_eq!(pair["levels_data_root"], ".");

        // Fix the levels zip → the pair flips to the new generation.
        write_zip_entries(&levels.local_zip, &[(&levels.required_files[0], b"new")]).unwrap();
        sync_release_archive_pair(&DownTransport, &excel, &levels, false)
            .await
            .unwrap();
        let pair: Value =
            serde_json::from_str(&std::fs::read_to_string(&pair_path).unwrap()).unwrap();
        assert_eq!(pair["commit_sha"], "new");
        assert!(pair["excel_data_root"]
            .as_str()
            .unwrap()
            .starts_with(".releases/"));
        assert!(pair["levels_data_root"]
            .as_str()
            .unwrap()
            .starts_with(".releases/"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn legacy_layout_initializes_as_legacy_pair() {
        let (dir, excel, levels) = pair_specs("legacy");
        for spec in [&excel, &levels] {
            let path = spec.local_root.join(&spec.required_files[0]);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, "legacy").unwrap();
        }
        sync_release_archive_pair(&DownTransport, &excel, &levels, false)
            .await
            .unwrap();
        let pair: Value = serde_json::from_str(
            &std::fs::read_to_string(dir.join(".gamedata_pair.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(pair["commit_sha"], "legacy");
        assert_eq!(pair["excel_data_root"], ".");
        assert_eq!(pair["levels_data_root"], ".");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn extraction_failure_retries_and_recovers_without_touching_legacy_root() {
        let (dir, excel, _levels) = pair_specs("recover");
        let spec = &excel;
        write_zip_entries(
            &spec.local_zip,
            &[(&spec.required_files[0], b"{\"version\":\"new\"}")],
        )
        .unwrap();
        std::fs::write(
            spec.archives_dir().join("release_meta.json"),
            serde_json::to_string_pretty(&json!({
                "repo": "3aKHP/arknights-data-pipeline",
                "branch": "releases",
                "commitSha": "abc123",
                "fetchedAt": "2000-01-01T00:00:00.000Z",
                "files": [spec.asset_name],
            }))
            .unwrap(),
        )
        .unwrap();
        let required_path = spec.local_root.join(&spec.required_files[0]);
        std::fs::create_dir_all(required_path.parent().unwrap()).unwrap();
        std::fs::write(&required_path, "{\"version\":\"old\"}").unwrap();
        // Block extraction with a non-directory .releases.
        std::fs::write(spec.local_root.join(".releases"), "not a directory").unwrap();

        let first = sync_release_archive(&DownTransport, spec, false).await;
        assert_eq!(first.status, SyncStatus::OfflineFallback);
        assert!(!spec.archives_dir().join("extract_meta.json").exists());

        std::fs::remove_file(spec.local_root.join(".releases")).unwrap();
        let second = sync_release_archive(&DownTransport, spec, false).await;
        assert_eq!(second.status, SyncStatus::Updated);
        // The legacy root is untouched; the activated tree serves the new data.
        assert_eq!(
            std::fs::read_to_string(&required_path).unwrap(),
            "{\"version\":\"old\"}"
        );
        let meta: Value = serde_json::from_str(
            &std::fs::read_to_string(spec.archives_dir().join("extract_meta.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(meta["commit_sha"], "abc123");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn offline_activation_recovery_reports_updated() {
        let (dir, excel, _levels) = pair_specs("offline-recovery");
        let spec = &excel;
        write_zip_entries(
            &spec.local_zip,
            &[(&spec.required_files[0], b"{\"version\":\"new\"}")],
        )
        .unwrap();
        std::fs::write(
            spec.archives_dir().join("release_meta.json"),
            serde_json::to_string_pretty(&json!({
                "repo": "3aKHP/arknights-data-pipeline",
                "branch": "releases",
                "commitSha": "abc123",
                "fetchedAt": "2000-01-01T00:00:00.000Z",
                "files": [spec.asset_name],
            }))
            .unwrap(),
        )
        .unwrap();
        let required_path = spec.local_root.join(&spec.required_files[0]);
        std::fs::create_dir_all(required_path.parent().unwrap()).unwrap();
        std::fs::write(&required_path, "{\"version\":\"old\"}").unwrap();

        let result = sync_release_archive(&DownTransport, spec, true).await;
        assert_eq!(result.status, SyncStatus::Updated);
        assert_eq!(result.commit_sha.as_deref(), Some("abc123"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn prunes_stale_staging_without_a_new_release() {
        let (dir, excel, _levels) = pair_specs("prune");
        let spec = &excel;
        write_zip_entries(&spec.local_zip, &[(&spec.required_files[0], b"{}")]).unwrap();

        let first = sync_release_archive(&DownTransport, spec, false).await;
        assert_eq!(first.status, SyncStatus::Updated);
        let orphan = spec.local_root.join(".releases/.orphan.tmp");
        std::fs::create_dir_all(&orphan).unwrap();
        let stale = filetime::FileTime::from_unix_time(0, 0);
        filetime::set_file_mtime(&orphan, stale).unwrap();

        let second = sync_release_archive(&DownTransport, spec, false).await;
        assert_eq!(second.status, SyncStatus::OfflineFallback);
        assert!(!orphan.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn concurrent_activation_keeps_the_authoritative_tree() {
        let (dir, excel, _levels) = pair_specs("concurrent");
        let spec = std::sync::Arc::new(excel);
        write_zip_entries(&spec.local_zip, &[(&spec.required_files[0], b"{}")]).unwrap();

        struct SlowTransport;
        #[async_trait::async_trait]
        impl Transport for SlowTransport {
            async fn fetch_json(
                &self,
                _url: &str,
                _t: u64,
            ) -> Result<Value, crate::sync::transport::TransportError> {
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                Err(crate::sync::transport::TransportError::Network(
                    "network down".into(),
                ))
            }
            async fn download(
                &self,
                _u: &str,
                _d: &Path,
                _t: u64,
            ) -> Result<crate::sync::transport::DownloadStats, crate::sync::transport::TransportError>
            {
                Err(crate::sync::transport::TransportError::Network(
                    "network down".into(),
                ))
            }
            fn mirrors(&self) -> Vec<String> {
                vec![]
            }
            fn github_headers(&self) -> Vec<(String, String)> {
                vec![]
            }
        }
        let spec2 = std::sync::Arc::clone(&spec);
        let (a, b) = tokio::join!(
            sync_release_archive(&SlowTransport, &spec, false),
            async move { sync_release_archive(&SlowTransport, &spec2, false).await },
        );
        let statuses = [a.status, b.status];
        assert!(statuses.contains(&SyncStatus::Updated));
        assert!(statuses.contains(&SyncStatus::OfflineFallback));
        let meta: Value = serde_json::from_str(
            &std::fs::read_to_string(spec.archives_dir().join("extract_meta.json")).unwrap(),
        )
        .unwrap();
        let root = spec.local_root.join(meta["data_root"].as_str().unwrap());
        assert!(root.join(&spec.required_files[0]).is_file());
        assert!(!spec.archives_dir().join(".activation.lock").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn symlinked_release_directory_is_rejected() {
        let (dir, excel, _levels) = pair_specs("symlink");
        let spec = &excel;
        write_zip_entries(&spec.local_zip, &[(&spec.required_files[0], b"{}")]).unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        let outside = dir.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::create_dir_all(&spec.local_root).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, spec.local_root.join(".releases")).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(&outside, spec.local_root.join(".releases")).unwrap();

        let result = sync_release_archive(&DownTransport, spec, false).await;
        assert_eq!(result.status, SyncStatus::NoData);
        assert!(result
            .error
            .as_deref()
            .unwrap()
            .contains("Unsafe release directory symlink"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
