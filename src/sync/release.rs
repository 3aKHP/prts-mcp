//! Release sync: zip download + manifest verify + the release state machine.
//!
//! Port of TS `sync/release.rs`. Owns the persisted release cache
//! (`release_meta.json`), the download-and-validate pipeline, and the
//! up-to-date / offline-fallback / anti-downgrade decision tree. All archive
//! mutations run under the `.release.lock` directory lease in the archives
//! directory.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::activation::{with_archive_activation_lock, LockTiming};
use super::discovery::{check_latest_release, parse_release_suffix, tag_suffix};
use super::primitives::{atomic_write_json, now_iso, now_ms, parse_iso_ms, random_suffix};
use super::transport::Transport;
use super::types::{ReleaseSpec, SyncError, SyncResult, SyncStatus, CACHE_TTL_SECONDS};
use crate::sync::transport::TransportError;

const DEFAULT_ASSET_TIMEOUT_MS: u64 = 120_000;
const DISCOVERY_TIMEOUT_MS: u64 = 10_000;

#[derive(Clone)]
struct CacheMeta {
    repo: String,
    branch: String,
    commit_sha: String,
    fetched_at: String,
    files: Vec<String>,
}

fn release_cache_path(spec: &ReleaseSpec) -> PathBuf {
    spec.local_zip
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("release_meta.json")
}

/// `loadReleaseMeta`: accepts the snake_case wire format and the camelCase
/// historical fields; any missing/invalid field rejects the whole cache.
fn load_release_meta(spec: &ReleaseSpec) -> Option<CacheMeta> {
    let text = std::fs::read_to_string(release_cache_path(spec)).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    let repo = value.get("repo")?.as_str()?.to_string();
    let branch = value.get("branch")?.as_str()?.to_string();
    let commit_sha = value
        .get("commit_sha")
        .or_else(|| value.get("commitSha"))?
        .as_str()?
        .to_string();
    let fetched_at = value
        .get("fetched_at")
        .or_else(|| value.get("fetchedAt"))?
        .as_str()?
        .to_string();
    if repo.is_empty() || branch.is_empty() || commit_sha.is_empty() || fetched_at.is_empty() {
        return None;
    }
    let files = value
        .get("files")?
        .as_array()?
        .iter()
        .filter_map(|f| f.as_str().map(str::to_string))
        .collect();
    Some(CacheMeta {
        repo,
        branch,
        commit_sha,
        fetched_at,
        files,
    })
}

fn save_release_meta(spec: &ReleaseSpec, meta: &CacheMeta) -> Result<(), SyncError> {
    atomic_write_json(
        &release_cache_path(spec),
        &json!({
            "repo": meta.repo,
            "branch": meta.branch,
            "commit_sha": meta.commit_sha,
            "fetched_at": meta.fetched_at,
            "files": meta.files,
        }),
    )
}

fn cache_is_fresh(cache: &CacheMeta) -> bool {
    match parse_iso_ms(&cache.fetched_at) {
        Some(fetched) => (now_ms() as i128 - fetched) < (CACHE_TTL_SECONDS as i128 * 1000),
        None => false,
    }
}

/// `releaseUpToDate`: tuple-aware comparison. Newer upstream means stale;
/// equal or older upstream means up to date (an older upstream is refused
/// loudly). Either side unparseable → plain string equality.
fn release_up_to_date(local_sha: &str, upstream_sha: &str) -> bool {
    let local = parse_release_suffix(local_sha);
    let upstream = parse_release_suffix(upstream_sha);
    match (local, upstream) {
        (Some(local), Some(upstream)) => {
            if local.version_id != upstream.version_id {
                if upstream.version_id > local.version_id {
                    return false;
                }
                eprintln!(
                    "[sync] upstream {upstream_sha} is not newer than installed {local_sha}; refusing downgrade"
                );
                return true;
            }
            if upstream.revision > local.revision {
                return false;
            }
            if upstream.revision < local.revision {
                eprintln!(
                    "[sync] upstream {upstream_sha} is not newer than installed {local_sha}; refusing downgrade"
                );
            }
            true
        }
        _ => local_sha == upstream_sha,
    }
}

fn zip_basename(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// `releaseZipError`: None when the zip is valid; otherwise why it is not.
fn release_zip_error(spec: &ReleaseSpec) -> Option<String> {
    if !spec.local_zip.is_file() {
        return Some("zip file is missing".to_string());
    }
    match crate::sync::validation::zip_missing_entries(&spec.local_zip, &spec.validator) {
        Ok(missing) if missing.is_empty() => None,
        Ok(missing) => Some(
            missing
                .iter()
                .take(10)
                .cloned()
                .collect::<Vec<_>>()
                .join("; "),
        ),
        Err(err) => Some(format!(
            "{} is not a valid zip: {err}",
            zip_basename(&spec.local_zip)
        )),
    }
}

/// `downloadReleaseAsset`: stream to a temp file (incremental sha256),
/// validate entries, optionally verify the factory manifest, then atomically
/// replace the zip and persist release metadata. Failures keep the old zip.
/// `downloadReleaseAsset` — public for interop tests that need the exact
/// writer (zip + release_meta) the state machine uses.
pub async fn download_release_asset(
    transport: &dyn Transport,
    spec: &ReleaseSpec,
    tag: &str,
    asset_url: &str,
    timeout_ms: u64,
) -> Result<(), SyncError> {
    let dir = spec
        .local_zip
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let tmp = dir.join(format!(
        ".{}.{}.tmp",
        zip_basename(&spec.local_zip),
        random_suffix()
    ));
    std::fs::create_dir_all(&dir)?;
    let result = async {
        let stats = transport
            .download(asset_url, &tmp, timeout_ms)
            .await
            .map_err(|e| SyncError::Message(format!("{e} downloading {}", spec.asset_name)))?;
        let missing = crate::sync::validation::zip_missing_entries(&tmp, &spec.validator)?;
        if !missing.is_empty() {
            return Err(SyncError::Message(format!(
                "Downloaded {} is missing required entries: {}",
                spec.asset_name,
                missing.join(", ")
            )));
        }
        if spec.verify_manifest {
            verify_release_manifest(transport, spec, tag, &tmp, stats, timeout_ms).await?;
        }
        std::fs::rename(&tmp, &spec.local_zip)?;
        // Strip the namespace prefix: data-<vid> → <vid>, datarev-<vid>-rN → <vid>-rN.
        save_release_meta(
            spec,
            &CacheMeta {
                repo: spec.repo_slug(),
                branch: "releases".to_string(),
                commit_sha: tag_suffix(tag),
                fetched_at: now_iso(),
                files: vec![spec.asset_name.clone()],
            },
        )?;
        Ok(())
    }
    .await;
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

fn js_display(value: Option<&Value>) -> String {
    // String(value) in the TS mismatch message: numbers print bare, a
    // missing field prints "undefined".
    match value {
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Null) => "null".to_string(),
        None => "undefined".to_string(),
        Some(other) => other.to_string(),
    }
}

async fn verify_release_manifest(
    transport: &dyn Transport,
    spec: &ReleaseSpec,
    tag: &str,
    _asset_path: &Path,
    stats: super::transport::DownloadStats,
    timeout_ms: u64,
) -> Result<(), SyncError> {
    let manifest_url = if tag == "unknown" {
        format!(
            "https://github.com/{}/{}/releases/latest/download/manifest.json",
            spec.owner, spec.repo
        )
    } else {
        format!(
            "https://github.com/{}/{}/releases/download/{tag}/manifest.json",
            spec.owner, spec.repo
        )
    };
    let response = match transport.fetch_json(&manifest_url, timeout_ms).await {
        Ok(value) => value,
        Err(TransportError::AssetNotFound(url)) => {
            // Direct URL confirmed 404 → release predates the manifest asset.
            // datarev releases must always carry one — fail closed (#100).
            if !tag.starts_with("datarev-") {
                return Ok(());
            }
            return Err(SyncError::Message(format!(
                "manifest unavailable for {tag}: HTTP 404: {url}"
            )));
        }
        Err(err) => {
            return Err(SyncError::Message(format!(
                "manifest unavailable for {tag}: {err}"
            )))
        }
    };
    if !response.is_object() {
        return Err(SyncError::Message(format!(
            "manifest for {tag} is invalid: manifest root must be an object"
        )));
    }
    if response.get("contractVersion").and_then(|v| v.as_str())
        != Some(super::types::DATA_CONTRACT_VERSION)
    {
        return Err(SyncError::Message(format!(
            "manifest for {tag} has unsupported contractVersion"
        )));
    }
    if let Some(parsed) = super::discovery::parse_data_tag(tag) {
        if let Some(source) = response.get("source") {
            if source.get("versionId").and_then(|v| v.as_str()) != Some(parsed.version_id.as_str())
            {
                return Err(SyncError::Message(format!(
                    "manifest source version does not match release tag {tag}"
                )));
            }
        }
        if parsed.revision > 1 {
            // datarev releases must declare their revision; a missing field
            // means the manifest was not produced by the revision pipeline.
            if response.get("publicationRevision").and_then(|v| v.as_f64())
                != Some(parsed.revision as f64)
            {
                return Err(SyncError::Message(format!(
                    "manifest for {tag} declares publicationRevision {}, expected {}",
                    js_display(response.get("publicationRevision")),
                    parsed.revision
                )));
            }
        }
    }
    let expected = response.get("assets").and_then(|a| a.get(&spec.asset_name));
    let size = expected
        .and_then(|e| e.get("size"))
        .and_then(|v| v.as_f64());
    let sha = expected
        .and_then(|e| e.get("sha256"))
        .and_then(|v| v.as_str());
    if size.is_none() || sha.is_none() {
        return Err(SyncError::Message(format!(
            "manifest for {tag} has no valid entry for {}",
            spec.asset_name
        )));
    }
    if size.unwrap() != stats.bytes as f64 || sha.unwrap() != stats.sha256 {
        return Err(SyncError::Message(format!(
            "manifest mismatch for {}: expected {}/{}, got {}/{}",
            spec.asset_name,
            size.map(|v| v as u64).unwrap_or_default(),
            sha.unwrap_or_default(),
            stats.bytes,
            stats.sha256
        )));
    }
    // The zip was hashed while streaming; no re-read is needed here.
    Ok(())
}

/// The decision tree, run under `.release.lock`:
/// 1. fresh cache + valid zip → up_to_date (skip the API call)
/// 2. network failure → offline_fallback / no_data (with the blind-download
///    and recorded-release protections)
/// 3. tag unchanged + zip valid → up_to_date (refresh fetchedAt)
/// 4. tag changed or zip missing → download → updated / fallback
async fn sync_release_locked(
    transport: &dyn Transport,
    spec: &ReleaseSpec,
    force_check: bool,
) -> Result<SyncResult, SyncError> {
    let cache = load_release_meta(spec);
    let zip_error = release_zip_error(spec);
    let zip_ok = zip_error.is_none();

    if !force_check {
        if let Some(cache) = &cache {
            if zip_ok && cache_is_fresh(cache) {
                return Ok(SyncResult::new(
                    SyncStatus::UpToDate,
                    Some(cache.commit_sha.clone()),
                    None,
                ));
            }
        }
    }

    let latest = check_latest_release(transport, spec, DISCOVERY_TIMEOUT_MS).await?;

    let Some((tag, url)) = latest else {
        if zip_ok {
            return Ok(SyncResult::new(
                SyncStatus::OfflineFallback,
                cache.as_ref().map(|c| c.commit_sha.clone()),
                Some("Network unavailable".to_string()),
            ));
        }
        // No zip and API unreachable — a recorded, parseable release cannot
        // be blindly replaced by "latest".
        if let Some(cache) = &cache {
            if parse_release_suffix(&cache.commit_sha).is_some() {
                return Ok(SyncResult::new(
                    SyncStatus::NoData,
                    Some(cache.commit_sha.clone()),
                    Some(
                        "Network unavailable; cannot verify replacement of recorded release"
                            .to_string(),
                    ),
                ));
            }
        }
        if !transport.mirrors().is_empty() {
            let blind_url = format!(
                "https://github.com/{}/{}/releases/latest/download/{}",
                spec.owner, spec.repo, spec.asset_name
            );
            return match download_release_asset(
                transport,
                spec,
                "unknown",
                &blind_url,
                DEFAULT_ASSET_TIMEOUT_MS,
            )
            .await
            {
                Ok(()) => Ok(SyncResult::new(
                    SyncStatus::Updated,
                    Some("unknown".to_string()),
                    None,
                )),
                Err(err) => Ok(SyncResult::new(
                    SyncStatus::NoData,
                    None,
                    Some(err.to_string()),
                )),
            };
        }
        let error = if let Some(error) = spec.local_zip.exists().then_some(zip_error).flatten() {
            format!("Network unavailable and no cached zip; cached zip invalid: {error}")
        } else {
            "Network unavailable and no cached zip".to_string()
        };
        return Ok(SyncResult::new(SyncStatus::NoData, None, Some(error)));
    };

    let commit_sha = tag_suffix(&tag);

    // A recorded release outranks a missing zip: refuse the downgrade of the
    // recorded generation while the cached zip is unavailable.
    if let Some(cache) = &cache {
        if !zip_ok {
            let local = parse_release_suffix(&cache.commit_sha);
            let upstream = parse_release_suffix(&commit_sha);
            if let (Some(local), Some(upstream)) = (local, upstream) {
                if local.version_id > upstream.version_id
                    || (local.version_id == upstream.version_id
                        && local.revision > upstream.revision)
                {
                    return Ok(SyncResult::new(
                        SyncStatus::NoData,
                        Some(cache.commit_sha.clone()),
                        Some(
                            "Refusing downgrade of recorded release while cached zip is unavailable"
                                .to_string(),
                        ),
                    ));
                }
            }
        }
    }

    if let Some(cache) = &cache {
        if zip_ok && release_up_to_date(&cache.commit_sha, &commit_sha) {
            save_release_meta(
                spec,
                &CacheMeta {
                    fetched_at: now_iso(),
                    ..cache.clone()
                },
            )?;
            // Report the *installed* sha: this branch also covers refused
            // downgrades, where upstream is older than installed.
            return Ok(SyncResult::new(
                SyncStatus::UpToDate,
                Some(cache.commit_sha.clone()),
                None,
            ));
        }
    }

    match download_release_asset(transport, spec, &tag, &url, DEFAULT_ASSET_TIMEOUT_MS).await {
        Ok(()) => Ok(SyncResult::new(SyncStatus::Updated, Some(commit_sha), None)),
        Err(err) => {
            let error = err.to_string();
            Ok(if zip_ok {
                SyncResult::new(
                    SyncStatus::OfflineFallback,
                    cache.as_ref().map(|c| c.commit_sha.clone()),
                    Some(error),
                )
            } else {
                SyncResult::new(SyncStatus::NoData, None, Some(error))
            })
        }
    }
}

/// `syncRelease`: publish a release ZIP and its metadata as one serialized
/// operation under `.release.lock`.
pub async fn sync_release(
    transport: &dyn Transport,
    spec: &ReleaseSpec,
    force_check: bool,
) -> SyncResult {
    sync_release_guarded(transport, spec, force_check, None).await
}

/// Runtime entry for the plain story ZIP, with source checks under its lock.
pub async fn sync_release_with_source(
    transport: &dyn Transport,
    spec: &ReleaseSpec,
    force_check: bool,
    source: &crate::config::DataSource,
) -> SyncResult {
    let root = spec.local_zip.parent().unwrap_or_else(|| Path::new("."));
    if let Err(error) = super::source_guard::ensure(root, source) {
        return SyncResult::new(SyncStatus::NoData, None, Some(error));
    }
    sync_release_guarded(transport, spec, force_check, Some(source)).await
}

async fn sync_release_guarded(
    transport: &dyn Transport,
    spec: &ReleaseSpec,
    force_check: bool,
    source: Option<&crate::config::DataSource>,
) -> SyncResult {
    let result = async {
        if let Some(dir) = spec.local_zip.parent() {
            std::fs::create_dir_all(dir)?;
        }
        with_archive_activation_lock(
            spec.local_zip.parent().unwrap_or_else(|| Path::new(".")),
            ".release.lock",
            LockTiming::default(),
            || async {
                if let Some(source) = source {
                    let root = spec.local_zip.parent().unwrap_or_else(|| Path::new("."));
                    if let Err(error) = super::source_guard::ensure(root, source) {
                        return Ok(SyncResult::new(SyncStatus::NoData, None, Some(error)));
                    }
                }
                sync_release_locked(transport, spec, force_check).await
            },
        )
        .await
        .and_then(|inner| inner)
    }
    .await;
    match result {
        Ok(result) => result,
        Err(err) => {
            let cache = load_release_meta(spec);
            let status = if release_zip_error(spec).is_none() {
                SyncStatus::OfflineFallback
            } else {
                SyncStatus::NoData
            };
            SyncResult::new(status, cache.map(|c| c.commit_sha), Some(err.to_string()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::write_zip_entries;
    use crate::sync::transport::{DownloadStats, TransportError};
    use crate::sync::types::ZipValidator;
    use async_trait::async_trait;
    use std::collections::VecDeque;
    use std::sync::Mutex;
    use std::time::Duration;

    /// Scriptable transport: a queue of (url substring → outcome).
    struct FakeTransport {
        steps: Mutex<VecDeque<Step>>,
        mirrors: Vec<String>,
    }

    enum Step {
        Json(String, Result<Value, TransportError>),
        Download(String, Result<Vec<u8>, TransportError>),
    }

    impl FakeTransport {
        fn new(mirrors: Vec<String>) -> Self {
            Self {
                steps: Mutex::new(VecDeque::new()),
                mirrors,
            }
        }

        fn push_json(&self, url: &str, result: Result<Value, TransportError>) {
            self.steps
                .lock()
                .unwrap()
                .push_back(Step::Json(url.to_string(), result));
        }

        fn push_download(&self, url: &str, bytes: Result<Vec<u8>, TransportError>) {
            self.steps
                .lock()
                .unwrap()
                .push_back(Step::Download(url.to_string(), bytes));
        }

        fn remaining(&self) -> usize {
            self.steps.lock().unwrap().len()
        }
    }

    #[async_trait]
    impl Transport for FakeTransport {
        async fn download_file_limited(
            &self,
            url: &str,
            dest: &Path,
            timeout_ms: u64,
            limit: u64,
        ) -> Result<u64, TransportError> {
            let _ = (url, dest, timeout_ms, limit);
            Err(TransportError::Network(
                "bounded transfer unsupported by fixture".into(),
            ))
        }

        async fn fetch_json(&self, url: &str, _timeout_ms: u64) -> Result<Value, TransportError> {
            let step = self
                .steps
                .lock()
                .unwrap()
                .pop_front()
                .expect("scripted step for fetch_json");
            match step {
                Step::Json(want, result) => {
                    assert!(
                        url.contains(&want),
                        "fetch_json url {url} does not contain {want}"
                    );
                    result
                }
                Step::Download(..) => panic!("download step scripted for fetch_json"),
            }
        }

        async fn download(
            &self,
            url: &str,
            dest: &Path,
            _timeout_ms: u64,
        ) -> Result<DownloadStats, TransportError> {
            let step = self
                .steps
                .lock()
                .unwrap()
                .pop_front()
                .expect("scripted step for download");
            match step {
                Step::Download(want, result) => {
                    assert!(
                        url.contains(&want),
                        "download url {url} does not contain {want}"
                    );
                    let bytes = result?;
                    std::fs::write(dest, &bytes).unwrap();
                    use sha2::Digest;
                    Ok(DownloadStats {
                        bytes: bytes.len() as u64,
                        sha256: format!("{:x}", sha2::Sha256::digest(&bytes)),
                    })
                }
                Step::Json(..) => panic!("json step scripted for download"),
            }
        }

        fn mirrors(&self) -> Vec<String> {
            self.mirrors.clone()
        }

        fn github_headers(&self) -> Vec<(String, String)> {
            vec![]
        }
    }

    fn temp_spec(name: &str) -> (PathBuf, ReleaseSpec) {
        let (dir, mut spec) = temp_spec_with_validator(name, ZipValidator::StoryJson);
        spec.verify_manifest = false;
        (dir, spec)
    }

    /// TS sync.test.ts `tempSpec()` is a bare spec (no validateZip): the
    /// manifest tests mirror it, so a garbage cached zip still counts as
    /// "ok" for fallback status purposes.
    fn temp_spec_bare(name: &str) -> (PathBuf, ReleaseSpec) {
        temp_spec_with_validator(name, ZipValidator::None)
    }

    fn temp_spec_with_validator(name: &str, validator: ZipValidator) -> (PathBuf, ReleaseSpec) {
        let dir = std::env::temp_dir().join(format!("prts-rel-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let spec = ReleaseSpec {
            owner: "3aKHP".into(),
            repo: "arknights-data-pipeline".into(),
            asset_name: "zh_CN.zip".into(),
            local_zip: dir.join("storyjson/zh_CN.zip"),
            verify_manifest: false,
            validator,
        };
        (dir, spec)
    }

    fn write_story_zip(spec: &ReleaseSpec) {
        write_zip_entries(
            &spec.local_zip,
            &[
                ("zh_CN/gamedata/excel/story_review_table.json", b"{}"),
                ("zh_CN/storyinfo.json", b"{}"),
            ],
        )
        .unwrap();
    }

    fn write_meta(spec: &ReleaseSpec, sha: &str, fetched: &str) {
        std::fs::create_dir_all(spec.local_zip.parent().unwrap()).unwrap();
        std::fs::write(
            spec.local_zip.parent().unwrap().join("release_meta.json"),
            serde_json::to_string_pretty(&json!({
                "repo": "3aKHP/arknights-data-pipeline",
                "branch": "releases",
                "commit_sha": sha,
                "fetched_at": fetched,
                "files": ["zh_CN.zip"],
            }))
            .unwrap(),
        )
        .unwrap();
    }

    #[tokio::test]
    async fn fresh_cache_with_valid_zip_skips_the_network() {
        let (_dir, spec) = temp_spec("fresh");
        write_story_zip(&spec);
        write_meta(&spec, "same-sha", "2099-01-01T00:00:00.000Z");
        let transport = FakeTransport::new(vec![]);
        let result = sync_release(&transport, &spec, false).await;
        assert_eq!(result.status, SyncStatus::UpToDate);
        assert_eq!(result.commit_sha.as_deref(), Some("same-sha"));
        assert_eq!(transport.remaining(), 0);
    }

    #[tokio::test]
    async fn forced_check_refreshes_fetched_at_when_tag_unchanged() {
        let (_dir, spec) = temp_spec("forced");
        write_story_zip(&spec);
        write_meta(
            &spec,
            "26-10-01-11-22-33_aabbcc",
            "2000-01-01T00:00:00.000Z",
        );
        let transport = FakeTransport::new(vec![]);
        transport.push_json(
            "releases?per_page=100",
            Ok(json!([{
                "tag_name": "data-26-10-01-11-22-33_aabbcc",
                "created_at": "2026-10-01T00:00:00Z",
                "assets": [{"name": "zh_CN.zip", "browser_download_url": "https://example.test/asset"}],
            }])),
        );
        let result = sync_release(&transport, &spec, true).await;
        assert_eq!(result.status, SyncStatus::UpToDate);
        assert_eq!(
            result.commit_sha.as_deref(),
            Some("26-10-01-11-22-33_aabbcc")
        );
        let meta =
            std::fs::read_to_string(spec.local_zip.parent().unwrap().join("release_meta.json"))
                .unwrap();
        assert!(meta.contains("26-10-01-11-22-33_aabbcc"));
        assert!(!meta.contains("2000-01-01"));
    }

    #[tokio::test]
    async fn network_failure_with_zip_is_offline_fallback() {
        let (_dir, spec) = temp_spec("offline");
        write_story_zip(&spec);
        let transport = FakeTransport::new(vec![]);
        transport.push_json(
            "releases?per_page=100",
            Err(TransportError::Network("network down".into())),
        );
        let result = sync_release(&transport, &spec, false).await;
        assert_eq!(result.status, SyncStatus::OfflineFallback);
        assert_eq!(result.commit_sha, None);
        assert_eq!(result.error.as_deref(), Some("Network unavailable"));
    }

    #[tokio::test]
    async fn network_failure_without_zip_is_no_data() {
        let (_dir, spec) = temp_spec("nodata");
        let transport = FakeTransport::new(vec![]);
        transport.push_json(
            "releases?per_page=100",
            Err(TransportError::Network("network down".into())),
        );
        let result = sync_release(&transport, &spec, false).await;
        assert_eq!(result.status, SyncStatus::NoData);
        assert_eq!(
            result.error.as_deref(),
            Some("Network unavailable and no cached zip")
        );
    }

    #[tokio::test]
    async fn invalid_cached_zip_converts_offline_to_no_data() {
        let (_dir, spec) = temp_spec("invalid-zip");
        std::fs::create_dir_all(spec.local_zip.parent().unwrap()).unwrap();
        std::fs::write(&spec.local_zip, "cached").unwrap();
        let transport = FakeTransport::new(vec![]);
        transport.push_json(
            "releases?per_page=100",
            Err(TransportError::Network("network down".into())),
        );
        let result = sync_release(&transport, &spec, false).await;
        assert_eq!(result.status, SyncStatus::NoData);
        assert!(result
            .error
            .as_deref()
            .unwrap()
            .starts_with("Network unavailable and no cached zip; cached zip invalid:"));
    }

    #[tokio::test]
    async fn fresh_cache_does_not_mask_invalid_zip() {
        let (_dir, spec) = temp_spec("fresh-invalid");
        std::fs::create_dir_all(spec.local_zip.parent().unwrap()).unwrap();
        std::fs::write(&spec.local_zip, "cached").unwrap();
        write_meta(&spec, "cached-sha", &now_iso());
        let transport = FakeTransport::new(vec![]);
        transport.push_json(
            "releases?per_page=100",
            Err(TransportError::Network("network down".into())),
        );
        let result = sync_release(&transport, &spec, false).await;
        assert_eq!(result.status, SyncStatus::NoData);
        assert_eq!(transport.remaining(), 0); // the API WAS consulted
    }

    #[tokio::test]
    async fn invalid_meta_fields_reject_the_cache() {
        let (_dir, spec) = temp_spec("bad-meta");
        write_story_zip(&spec);
        for fields in [
            json!({"repo": "3aKHP/arknights-data-pipeline", "branch": "releases", "commit_sha": "", "fetched_at": "2099-01-01T00:00:00.000Z", "files": ["zh_CN.zip"]}),
            json!({"repo": "3aKHP/arknights-data-pipeline", "branch": "releases", "commit_sha": "sha", "fetched_at": "", "files": ["zh_CN.zip"]}),
        ] {
            std::fs::write(
                spec.local_zip.parent().unwrap().join("release_meta.json"),
                serde_json::to_string(&fields).unwrap(),
            )
            .unwrap();
            let transport = FakeTransport::new(vec![]);
            transport.push_json(
                "releases?per_page=100",
                Err(TransportError::Network("network down".into())),
            );
            let result = sync_release(&transport, &spec, false).await;
            assert_eq!(result.status, SyncStatus::OfflineFallback, "{fields}");
            assert_eq!(result.commit_sha, None);
        }
    }

    #[tokio::test]
    async fn python_written_snake_case_meta_is_readable_and_fresh() {
        let (_dir, spec) = temp_spec("python-meta");
        write_story_zip(&spec);
        write_meta(&spec, "same-sha", "2099-01-01T00:00:00.000Z");
        let transport = FakeTransport::new(vec![]);
        let result = sync_release(&transport, &spec, false).await;
        assert_eq!(result.status, SyncStatus::UpToDate);
        assert_eq!(result.commit_sha.as_deref(), Some("same-sha"));
        // camelCase historical fields are accepted too.
        std::fs::write(
            spec.local_zip.parent().unwrap().join("release_meta.json"),
            serde_json::to_string(&json!({
                "repo": "3aKHP/arknights-data-pipeline",
                "branch": "releases",
                "commitSha": "camel-sha",
                "fetchedAt": "2099-01-01T00:00:00.000Z",
                "files": ["zh_CN.zip"],
            }))
            .unwrap(),
        )
        .unwrap();
        let result = sync_release(&transport, &spec, false).await;
        assert_eq!(result.status, SyncStatus::UpToDate);
        assert_eq!(result.commit_sha.as_deref(), Some("camel-sha"));
    }

    const VID: &str = "26-09-03-04-06-00_ed95a2";
    const VID_HYPHEN: &str = "26-10-08-04-51-28-56071834";

    #[tokio::test]
    async fn datarev_revision_downloads_and_stores_suffix() {
        let (_dir, spec) = temp_spec("datarev");
        write_story_zip(&spec);
        write_meta(&spec, VID, "2000-01-01T00:00:00.000Z");
        let transport = FakeTransport::new(vec![]);
        transport.push_json(
            "releases?per_page=100",
            Ok(json!([
                {"tag_name": format!("data-{VID}"), "created_at": "2026-09-05T00:00:00Z",
                 "assets": [{"name": "zh_CN.zip", "browser_download_url": "https://example.test/asset"}]},
                {"tag_name": format!("datarev-{VID}-r2"), "created_at": "2026-09-04T00:00:00Z",
                 "assets": [{"name": "zh_CN.zip", "browser_download_url": "https://example.test/asset"}]},
            ])),
        );
        let content = story_zip_bytes();
        transport.push_download("example.test/asset", Ok(content.clone()));
        let result = sync_release(&transport, &spec, true).await;
        assert_eq!(result.status, SyncStatus::Updated);
        assert_eq!(
            result.commit_sha.as_deref(),
            Some(format!("{VID}-r2").as_str())
        );
        assert_eq!(std::fs::read(&spec.local_zip).unwrap(), content);
        let meta =
            std::fs::read_to_string(spec.local_zip.parent().unwrap().join("release_meta.json"))
                .unwrap();
        assert!(meta.contains(&format!("\"commit_sha\": \"{VID}-r2\"")));
    }

    #[tokio::test]
    async fn installed_revision_stays_up_to_date() {
        for vid in [VID, VID_HYPHEN] {
            let (_dir, spec) = temp_spec(&format!("uptodate-{vid}"));
            write_story_zip(&spec);
            write_meta(&spec, &format!("{vid}-r2"), "2000-01-01T00:00:00.000Z");
            let transport = FakeTransport::new(vec![]);
            transport.push_json(
                "releases?per_page=100",
                Ok(json!([
                    {"tag_name": format!("data-{vid}"),
                     "assets": [{"name": "zh_CN.zip", "browser_download_url": "https://example.test/asset"}]},
                    {"tag_name": format!("datarev-{vid}-r2"),
                     "assets": [{"name": "zh_CN.zip", "browser_download_url": "https://example.test/asset"}]},
                ])),
            );
            let before = std::fs::read(&spec.local_zip).unwrap();
            let result = sync_release(&transport, &spec, true).await;
            assert_eq!(result.status, SyncStatus::UpToDate, "{vid}");
            assert_eq!(
                result.commit_sha.as_deref(),
                Some(format!("{vid}-r2").as_str())
            );
            assert_eq!(transport.remaining(), 0);
            assert_eq!(std::fs::read(&spec.local_zip).unwrap(), before);
        }
    }

    fn story_zip_bytes() -> Vec<u8> {
        let mut bytes = Vec::new();
        {
            let mut cursor = std::io::Cursor::new(&mut bytes);
            let mut zip = zip::ZipWriter::new(&mut cursor);
            let options: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default();
            use std::io::Write as _;
            zip.start_file("zh_CN/gamedata/excel/story_review_table.json", options)
                .unwrap();
            zip.write_all(b"{}").unwrap();
            zip.start_file("zh_CN/storyinfo.json", options).unwrap();
            zip.write_all(b"{}").unwrap();
            zip.finish().unwrap();
        }
        bytes
    }

    #[tokio::test]
    async fn refuses_downgrade_to_older_release() {
        for vid in [VID, VID_HYPHEN] {
            let (_dir, spec) = temp_spec(&format!("downgrade-{vid}"));
            write_story_zip(&spec);
            write_meta(&spec, &format!("{vid}-r2"), "2000-01-01T00:00:00.000Z");
            let transport = FakeTransport::new(vec![]);
            transport.push_json(
                "releases?per_page=100",
                Ok(json!([
                    {"tag_name": format!("data-{vid}"),
                     "assets": [{"name": "zh_CN.zip", "browser_download_url": "https://example.test/asset"}]},
                ])),
            );
            let result = sync_release(&transport, &spec, true).await;
            assert_eq!(result.status, SyncStatus::UpToDate, "{vid}");
            assert_eq!(
                result.commit_sha.as_deref(),
                Some(format!("{vid}-r2").as_str())
            );
            assert_eq!(transport.remaining(), 0);
        }
    }

    #[tokio::test]
    async fn recorded_revision_blocks_replacement_without_zip() {
        for vid in [VID, VID_HYPHEN] {
            for upstream in [None, Some(format!("data-{vid}"))] {
                let (_dir, spec) = temp_spec(&format!("recblock-{}-{}", vid, upstream.is_some()));
                // No zip on disk; meta records vid-r2.
                std::fs::create_dir_all(spec.local_zip.parent().unwrap()).unwrap();
                write_meta(&spec, &format!("{vid}-r2"), "2000-01-01T00:00:00.000Z");
                let transport = FakeTransport::new(vec!["https://mirror.test".into()]);
                match &upstream {
                    None => transport.push_json(
                        "releases?per_page=100",
                        Err(TransportError::Network("offline".into())),
                    ),
                    Some(tag) => transport.push_json(
                        "releases?per_page=100",
                        Ok(json!([
                            {"tag_name": tag,
                             "assets": [{"name": "zh_CN.zip", "browser_download_url": "https://example.test/asset"}]},
                        ])),
                    ),
                }
                let result = sync_release(&transport, &spec, true).await;
                assert_eq!(result.status, SyncStatus::NoData, "{vid} {upstream:?}");
                assert_eq!(
                    result.commit_sha.as_deref(),
                    Some(format!("{vid}-r2").as_str())
                );
                assert_eq!(transport.remaining(), 0, "no blind downloads");
            }
        }
    }

    #[tokio::test]
    async fn newer_revision_replaces_missing_zip() {
        let (_dir, spec) = temp_spec("recnewer");
        std::fs::create_dir_all(spec.local_zip.parent().unwrap()).unwrap();
        write_meta(&spec, &format!("{VID}-r2"), "2000-01-01T00:00:00.000Z");
        let transport = FakeTransport::new(vec![]);
        transport.push_json(
            "releases?per_page=100",
            Ok(json!([
                {"tag_name": format!("datarev-{VID}-r3"),
                 "assets": [{"name": "zh_CN.zip", "browser_download_url": "https://example.test/asset"}]},
            ])),
        );
        transport.push_download("example.test/asset", Ok(story_zip_bytes()));
        let result = sync_release(&transport, &spec, true).await;
        assert_eq!(result.status, SyncStatus::Updated);
        assert_eq!(
            result.commit_sha.as_deref(),
            Some(format!("{VID}-r3").as_str())
        );
    }

    #[tokio::test]
    async fn underscore_install_updates_from_hyphen_source() {
        let (_dir, spec) = temp_spec("cross-shape");
        write_story_zip(&spec);
        write_meta(&spec, &format!("{VID}-r2"), "2000-01-01T00:00:00.000Z");
        let transport = FakeTransport::new(vec![]);
        transport.push_json(
            "releases?per_page=100",
            Ok(json!([
                {"tag_name": format!("data-{VID_HYPHEN}"),
                 "assets": [{"name": "zh_CN.zip", "browser_download_url": "https://example.test/asset"}]},
            ])),
        );
        transport.push_download("example.test/asset", Ok(story_zip_bytes()));
        let result = sync_release(&transport, &spec, true).await;
        assert_eq!(result.status, SyncStatus::Updated);
        assert_eq!(result.commit_sha.as_deref(), Some(VID_HYPHEN));
    }

    #[tokio::test]
    async fn duplicate_release_identity_fails_closed_without_blind_download() {
        let (_dir, spec) = temp_spec("duplicate");
        let transport = FakeTransport::new(vec!["https://mirror.test".into()]);
        transport.push_json(
            "releases?per_page=100",
            Ok(json!([
                {"tag_name": format!("data-{VID}"), "assets": []},
                {"tag_name": format!("datarev-{VID}-r1"), "assets": []},
            ])),
        );
        let result = sync_release(&transport, &spec, true).await;
        assert_eq!(result.status, SyncStatus::NoData);
        assert!(result.error.as_deref().unwrap().contains("duplicate"));
        assert_eq!(transport.remaining(), 0);
    }

    #[tokio::test]
    async fn blind_download_via_mirrors_when_api_unreachable() {
        let (_dir, spec) = temp_spec("blind");
        let transport = FakeTransport::new(vec!["https://mirror.test".into()]);
        transport.push_json(
            "releases?per_page=100",
            Err(TransportError::Network("offline".into())),
        );
        transport.push_download("releases/latest/download/zh_CN.zip", Ok(story_zip_bytes()));
        let result = sync_release(&transport, &spec, true).await;
        assert_eq!(result.status, SyncStatus::Updated);
        assert_eq!(result.commit_sha.as_deref(), Some("unknown"));
        assert!(spec.local_zip.is_file());
    }

    #[tokio::test]
    async fn concurrent_release_checks_serialize_on_the_lock() {
        let (_dir, spec) = temp_spec("serialized");
        write_story_zip(&spec);

        // A transport whose fetch_json sleeps: two racing sync_release calls
        // would overlap without the .release.lock serializing them.
        struct SlowTransport {
            active: std::sync::atomic::AtomicUsize,
            max_active: std::sync::atomic::AtomicUsize,
        }
        #[async_trait]
        impl Transport for SlowTransport {
            async fn download_file_limited(
                &self,
                url: &str,
                dest: &Path,
                timeout_ms: u64,
                limit: u64,
            ) -> Result<u64, TransportError> {
                let _ = (url, dest, timeout_ms, limit);
                Err(TransportError::Network(
                    "bounded transfer unsupported by fixture".into(),
                ))
            }

            async fn fetch_json(&self, _url: &str, _t: u64) -> Result<Value, TransportError> {
                let active = self
                    .active
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
                    + 1;
                self.max_active
                    .fetch_max(active, std::sync::atomic::Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(25)).await;
                self.active
                    .fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
                Err(TransportError::Network("network down".into()))
            }
            async fn download(
                &self,
                _u: &str,
                _d: &Path,
                _t: u64,
            ) -> Result<DownloadStats, TransportError> {
                Err(TransportError::Network("unused".into()))
            }
            fn mirrors(&self) -> Vec<String> {
                vec![]
            }
            fn github_headers(&self) -> Vec<(String, String)> {
                vec![]
            }
        }
        let transport = SlowTransport {
            active: std::sync::atomic::AtomicUsize::new(0),
            max_active: std::sync::atomic::AtomicUsize::new(0),
        };
        let spec = std::sync::Arc::new(spec);
        let (ra, rb) = tokio::join!(
            sync_release(&transport, &spec, true),
            sync_release(&transport, &spec, true),
        );
        assert_eq!(ra.status, SyncStatus::OfflineFallback);
        assert_eq!(rb.status, SyncStatus::OfflineFallback);
        assert_eq!(
            transport
                .max_active
                .load(std::sync::atomic::Ordering::SeqCst),
            1,
            "release checks must be serialized"
        );
        assert!(!spec
            .local_zip
            .parent()
            .unwrap()
            .join(".release.lock")
            .exists());
    }

    #[tokio::test]
    async fn manifest_verification_paths() {
        // The download must survive story-zip entry validation before the
        // manifest is even consulted, so serve a valid pack.
        let content = story_zip_bytes();
        use sha2::Digest;
        let sha = format!("{:x}", sha2::Sha256::digest(&content));

        struct Case {
            name: &'static str,
            manifest: Value,
            expect: &'static str,
            zip_kept: bool,
        }
        let cases = vec![
            Case {
                name: "revision mismatch fails closed",
                manifest: json!({
                    "contractVersion": "prts-mcp-data/v1",
                    "source": {"versionId": VID},
                    "publicationRevision": 3,
                    "assets": {"zh_CN.zip": {"size": content.len(), "sha256": sha}},
                }),
                expect: "offline_fallback",
                zip_kept: true,
            },
            Case {
                name: "missing revision fails closed",
                manifest: json!({
                    "contractVersion": "prts-mcp-data/v1",
                    "source": {"versionId": VID},
                    "assets": {"zh_CN.zip": {"size": content.len(), "sha256": sha}},
                }),
                expect: "offline_fallback",
                zip_kept: true,
            },
            Case {
                name: "matching revision updates",
                manifest: json!({
                    "contractVersion": "prts-mcp-data/v1",
                    "source": {"versionId": VID},
                    "publicationRevision": 2,
                    "assets": {"zh_CN.zip": {"size": content.len(), "sha256": sha}},
                }),
                expect: "updated",
                zip_kept: false,
            },
        ];
        for case in cases {
            let (_dir, spec) =
                temp_spec_bare(&format!("manifest-{}", case.name.contains("updates")));
            let spec = spec_verify(&spec, true);
            std::fs::create_dir_all(spec.local_zip.parent().unwrap()).unwrap();
            std::fs::write(&spec.local_zip, "old").unwrap();
            let transport = FakeTransport::new(vec![]);
            transport.push_json(
                "releases?per_page=100",
                Ok(json!([
                    {"tag_name": format!("datarev-{VID}-r2"),
                     "assets": [{"name": "zh_CN.zip", "browser_download_url": "https://example.test/asset"}]},
                ])),
            );
            transport.push_download("example.test/asset", Ok(content.clone()));
            transport.push_json("manifest.json", Ok(case.manifest.clone()));
            let result = sync_release(&transport, &spec, true).await;
            assert_eq!(result.status.as_str(), case.expect, "{}", case.name);
            let zip = std::fs::read_to_string(&spec.local_zip).unwrap_or_default();
            if case.zip_kept {
                assert_eq!(zip, "old", "{}", case.name);
            } else {
                assert_ne!(zip, "old", "{}", case.name);
            }
        }
    }

    fn spec_verify(spec: &ReleaseSpec, verify: bool) -> ReleaseSpec {
        let mut spec = spec.clone();
        spec.verify_manifest = verify;
        spec
    }

    #[tokio::test]
    async fn manifest_404_on_data_release_is_legacy_skip_but_datarev_fails() {
        for (tag, expect) in [
            (format!("data-{VID}"), "updated"), // legacy release: skip
            (format!("datarev-{VID}-r2"), "offline_fallback"), // datarev: fail
        ] {
            let (_dir, spec) = temp_spec("manifest404");
            let spec = spec_verify(&spec, true);
            write_story_zip(&spec);
            let transport = FakeTransport::new(vec![]);
            transport.push_json(
                "releases?per_page=100",
                Ok(json!([
                    {"tag_name": tag,
                     "assets": [{"name": "zh_CN.zip", "browser_download_url": "https://example.test/asset"}]},
                ])),
            );
            transport.push_download("example.test/asset", Ok(story_zip_bytes()));
            transport.push_json(
                "manifest.json",
                Err(TransportError::AssetNotFound(
                    "https://github.com/.../manifest.json".into(),
                )),
            );
            let result = sync_release(&transport, &spec, true).await;
            assert_eq!(result.status.as_str(), expect, "{tag}");
        }
    }

    #[tokio::test]
    async fn manifest_shape_errors_fail_closed() {
        for (name, manifest, needle) in [
            (
                "bad contract",
                json!({"contractVersion": "unknown"}),
                "unsupported contractVersion",
            ),
            (
                "root not object",
                Value::Null,
                "manifest root must be an object",
            ),
            (
                "version mismatch",
                json!({"contractVersion": "prts-mcp-data/v1", "source": {"versionId": "other"}}),
                "does not match release tag",
            ),
            (
                "no asset entry",
                json!({"contractVersion": "prts-mcp-data/v1", "source": {"versionId": VID}, "assets": {}}),
                "no valid entry",
            ),
        ] {
            let (_dir, spec) = temp_spec_bare("manifest-shape");
            let spec = spec_verify(&spec, true);
            std::fs::create_dir_all(spec.local_zip.parent().unwrap()).unwrap();
            std::fs::write(&spec.local_zip, "old").unwrap();
            let transport = FakeTransport::new(vec![]);
            transport.push_json(
                "releases?per_page=100",
                Ok(json!([
                    {"tag_name": format!("data-{VID}"),
                     "assets": [{"name": "zh_CN.zip", "browser_download_url": "https://example.test/asset"}]},
                ])),
            );
            transport.push_download("example.test/asset", Ok(story_zip_bytes()));
            transport.push_json("manifest.json", Ok(manifest));
            let result = sync_release(&transport, &spec, true).await;
            assert_eq!(result.status, SyncStatus::OfflineFallback, "{name}");
            assert!(result.error.unwrap().contains(needle), "{name}");
            assert_eq!(
                std::fs::read_to_string(&spec.local_zip).unwrap(),
                "old",
                "{name}"
            );
        }
    }

    #[tokio::test]
    async fn manifest_size_or_sha_mismatch_keeps_old_zip() {
        let (_dir, spec) = temp_spec_bare("manifest-mismatch");
        let spec = spec_verify(&spec, true);
        std::fs::create_dir_all(spec.local_zip.parent().unwrap()).unwrap();
        std::fs::write(&spec.local_zip, "old").unwrap();
        let transport = FakeTransport::new(vec![]);
        transport.push_json(
            "releases?per_page=100",
            Ok(json!([
                {"tag_name": format!("data-{VID}"),
                 "assets": [{"name": "zh_CN.zip", "browser_download_url": "https://example.test/asset"}]},
            ])),
        );
        transport.push_download("example.test/asset", Ok(story_zip_bytes()));
        transport.push_json(
            "manifest.json",
            Ok(json!({
                "contractVersion": "prts-mcp-data/v1",
                "source": {"versionId": VID},
                "assets": {"zh_CN.zip": {"size": 3, "sha256": "bad"}},
            })),
        );
        let result = sync_release(&transport, &spec, true).await;
        assert_eq!(result.status, SyncStatus::OfflineFallback);
        assert!(result.error.unwrap().contains("manifest mismatch"));
        assert_eq!(std::fs::read_to_string(&spec.local_zip).unwrap(), "old");
    }

    #[tokio::test]
    async fn downloaded_zip_missing_entries_is_rejected() {
        let (_dir, spec) = temp_spec("download-invalid");
        let transport = FakeTransport::new(vec![]);
        transport.push_json(
            "releases?per_page=100",
            Ok(json!([
                {"tag_name": format!("data-{VID}"),
                 "assets": [{"name": "zh_CN.zip", "browser_download_url": "https://example.test/asset"}]},
            ])),
        );
        // Download serves a zip WITHOUT the required story entries.
        let mut bytes = Vec::new();
        {
            use std::io::Write as _;
            let mut cursor = std::io::Cursor::new(&mut bytes);
            let mut zip = zip::ZipWriter::new(&mut cursor);
            let options: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default();
            zip.start_file("wrong/path.json", options).unwrap();
            zip.write_all(b"{}").unwrap();
            zip.finish().unwrap();
        }
        transport.push_download("example.test/asset", Ok(bytes));
        let result = sync_release(&transport, &spec, true).await;
        assert_eq!(result.status, SyncStatus::NoData);
        assert!(result
            .error
            .as_deref()
            .unwrap()
            .contains("missing required entries"));
        assert!(!spec.local_zip.exists());
    }
}
