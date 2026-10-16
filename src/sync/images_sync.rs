//! AKDP image asset sync — port of TS `sync/imagesSync.ts`.
//!
//! Discovers `images-*` Releases, rebuilds a generation from baseline shard
//! zips (or the fast path: prior generation + newer deltas only), verifies
//! every synced variant's sha256 against the index, and atomically activates
//! `.releases/<generation>/` with the images meta pointer. Tag-isolated
//! discovery: images releases cannot use `/releases/latest`; version strings
//! are fixed-width so lexicographic order is chronological (created_at is
//! never trusted for chain order).

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde_json::Value;
use sha2::{Digest, Sha256};

use super::activation::{safe_extract_zip, with_archive_activation_lock, LockTiming};
use super::discovery::{
    asset_url, latest_release_by_prefix, list_releases, list_releases_paginated,
};
use super::images_meta::{
    active_generation, generation_meta, load_meta, parse_index, save_meta, version_hash,
    ImagesIndex, IMAGES_META,
};
use super::primitives::{prune_old_trees, random_suffix};
use super::transport::Transport;
use super::types::SyncError;
use super::types::{SyncResult, SyncStatus};

pub const IMAGES_REPO_OWNER: &str = "3aKHP";
pub const IMAGES_REPO: &str = "arknights-data-pipeline";

const DELTA_PREFIX: &str = "images-";
const BASELINE_PREFIX: &str = "images-baseline-";
const DELTA_ASSET_PREFIX: &str = "images-delta-";

pub const DEFAULT_SHARD_KEYS: [&str; 4] = [
    "chararts-large",
    "chararts-preview",
    "skinpack-large",
    "skinpack-preview",
];
pub const ORIGINAL_SHARD_KEYS: [&str; 2] = ["chararts-original", "skinpack-original"];
const IMAGES_LOCK: &str = ".images.lock";

pub fn needed_shard_keys(include_original: bool) -> Vec<String> {
    if include_original {
        DEFAULT_SHARD_KEYS
            .iter()
            .chain(ORIGINAL_SHARD_KEYS.iter())
            .map(|s| s.to_string())
            .collect()
    } else {
        DEFAULT_SHARD_KEYS.iter().map(|s| s.to_string()).collect()
    }
}

fn images_tag_version(tag: &str) -> Option<String> {
    if let Some(rest) = tag.strip_prefix(BASELINE_PREFIX) {
        return Some(rest.to_string());
    }
    tag.strip_prefix(DELTA_PREFIX).map(str::to_string)
}

/// `enumerateDeltaChain`: deltas with baseline < v <= current; duplicates
/// fail closed (None). Fixed-width versions make lexicographic comparison
/// chronological.
pub fn enumerate_delta_chain(
    releases: &[Value],
    baseline_version: &str,
    current_version: &str,
) -> Option<Vec<(String, Value)>> {
    let mut chain: Vec<(String, Value)> = Vec::new();
    for release in releases {
        let Some(tag) = release.get("tag_name").and_then(|t| t.as_str()) else {
            continue;
        };
        if tag.starts_with(BASELINE_PREFIX) {
            continue;
        }
        let Some(version) = images_tag_version(tag) else {
            continue;
        };
        if baseline_version < version.as_str() && version.as_str() <= current_version {
            chain.push((version, release.clone()));
        }
    }
    let unique: BTreeSet<&String> = chain.iter().map(|(v, _)| v).collect();
    if unique.len() != chain.len() {
        return None;
    }
    chain.sort_by(|a, b| a.0.cmp(&b.0));
    Some(chain)
}

fn release_download_url(tag: &str, asset_name: &str) -> String {
    format!(
        "https://github.com/{IMAGES_REPO_OWNER}/{IMAGES_REPO}/releases/download/{tag}/{asset_name}"
    )
}

fn shard_variant_names(shard_keys: &[String]) -> BTreeSet<String> {
    shard_keys
        .iter()
        .map(|k| k.rsplit('-').next().unwrap_or("").to_string())
        .collect()
}

/// Verify each synced variant PNG matches its index sha256 (#100); a wanted
/// variant file that is absent counts as a mismatch (incomplete shard).
async fn verify_variant_hashes(
    staging: &Path,
    index: &ImagesIndex,
    shard_keys: &[String],
) -> Result<(), String> {
    let wanted = shard_variant_names(shard_keys);
    let mut checked = 0usize;
    let mut mismatches = 0usize;
    for entry in index.artworks.values() {
        for (vname, variant) in &entry.variants {
            if !wanted.contains(vname) {
                continue;
            }
            let png_path = staging.join(&variant.file);
            let actual = match tokio::fs::read(&png_path).await {
                Ok(bytes) => {
                    let digest = format!("{:x}", Sha256::digest(&bytes));
                    checked += 1;
                    digest
                }
                Err(_) => {
                    mismatches += 1;
                    checked += 1;
                    continue;
                }
            };
            if actual != variant.sha256 {
                mismatches += 1;
            }
        }
    }
    if mismatches > 0 {
        return Err(format!(
            "images sha256 verification failed: {mismatches} of {checked} variants mismatch"
        ));
    }
    Ok(())
}

fn offline_or_no_data(image_dir: &Path, error: &str) -> SyncResult {
    if active_generation(image_dir).is_some() {
        let ver = load_meta(image_dir).and_then(|m| {
            m.get("currentVersion")
                .and_then(|v| v.as_str())
                .map(str::to_string)
        });
        SyncResult::new(SyncStatus::OfflineFallback, ver, Some(error.to_string()))
    } else {
        SyncResult::new(SyncStatus::NoData, None, Some(error.to_string()))
    }
}

async fn releases_dir(image_dir: &Path) -> Result<PathBuf, SyncError> {
    let dir = image_dir.join(".releases");
    tokio::fs::create_dir_all(&dir).await?;
    Ok(dir)
}

/// `syncImages`: `.images.lock` around the whole rebuild + activate.
pub struct ImagesSyncOpts {
    pub include_original: bool,
    pub force_check: bool,
}

pub async fn sync_images(
    image_dir: &Path,
    transport: &dyn Transport,
    opts: ImagesSyncOpts,
) -> SyncResult {
    if let Err(err) = tokio::fs::create_dir_all(image_dir).await {
        return offline_or_no_data(image_dir, &err.to_string());
    }
    let shard_keys = needed_shard_keys(opts.include_original);
    let lock_dir = image_dir.to_path_buf();
    let locked =
        with_archive_activation_lock(&lock_dir, IMAGES_LOCK, LockTiming::default(), || async {
            sync_images_locked(image_dir, transport, &shard_keys, opts.force_check).await
        })
        .await;
    match locked {
        Ok(result) => result,
        Err(err) => offline_or_no_data(image_dir, &err.to_string()),
    }
}

async fn sync_images_locked(
    image_dir: &Path,
    transport: &dyn Transport,
    shard_keys: &[String],
    _force_check: bool,
) -> SyncResult {
    let Some(mut releases) = list_releases(transport, IMAGES_REPO_OWNER, IMAGES_REPO, 10_000).await
    else {
        return offline_or_no_data(image_dir, "Network unavailable");
    };

    let Some(delta_release) =
        latest_release_by_prefix(&releases, DELTA_PREFIX, Some(BASELINE_PREFIX))
    else {
        return offline_or_no_data(image_dir, "No images delta release found");
    };
    let delta_tag = delta_release
        .get("tag_name")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .to_string();
    let Some(tag_version) = images_tag_version(&delta_tag) else {
        return offline_or_no_data(image_dir, "No images delta release found");
    };

    let meta = load_meta(image_dir);
    let gen_dir = active_generation(image_dir);
    let synced_set: Option<BTreeSet<String>> = meta
        .as_ref()
        .and_then(|m| m.get("shardsSynced"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect()
        });
    let same_shards = synced_set.as_ref().is_some_and(|set| {
        shard_keys.len() == set.len() && shard_keys.iter().all(|k| set.contains(k))
    });

    // Tag-level shortcut: same currentVersion + shard set → skip the index
    // download entirely (baseline cannot change without a new delta tag).
    if meta
        .as_ref()
        .and_then(|m| m.get("currentVersion"))
        .and_then(|v| v.as_str())
        == Some(tag_version.as_str())
        && gen_dir.is_some()
        && same_shards
    {
        return SyncResult::new(SyncStatus::UpToDate, Some(tag_version), None);
    }

    // Tag differs (or first sync) → download index.json and rebuild.
    let Some(index_url) = asset_url(&delta_release, "index.json") else {
        return offline_or_no_data(image_dir, "Failed to download index.json");
    };
    let rel_dir = match releases_dir(image_dir).await {
        Ok(dir) => dir,
        Err(err) => return offline_or_no_data(image_dir, &err.to_string()),
    };
    let index_tmp = rel_dir.join(format!(".index.{}.tmp", random_suffix()));
    let index_bytes: Vec<u8> = match transport.download(&index_url, &index_tmp, 30_000).await {
        Ok(_) => match tokio::fs::read(&index_tmp).await {
            Ok(bytes) => {
                let _ = tokio::fs::remove_file(&index_tmp).await;
                bytes
            }
            Err(err) => {
                let _ = tokio::fs::remove_file(&index_tmp).await;
                return offline_or_no_data(image_dir, &err.to_string());
            }
        },
        Err(_) => {
            let _ = tokio::fs::remove_file(&index_tmp).await;
            return offline_or_no_data(image_dir, "Failed to download index.json");
        }
    };
    let index_data: Value = match serde_json::from_slice(&index_bytes) {
        Ok(v) => v,
        Err(_) => {
            return SyncResult::new(
                SyncStatus::NoData,
                None,
                Some("index.json is unreadable".to_string()),
            )
        }
    };
    let Some(index) = parse_index(&index_data) else {
        return SyncResult::new(
            SyncStatus::NoData,
            None,
            Some("index.json schema mismatch".to_string()),
        );
    };

    let baseline_version = index.baseline_version.clone();
    // The index is authoritative for currentVersion; drift vs the discovery
    // tag would pick the wrong chain endpoint — fail closed (#179).
    let current_version = index.current_version.clone();
    if current_version.is_empty() || current_version != tag_version {
        return offline_or_no_data(
            image_dir,
            "index.json currentVersion does not match the latest images delta tag",
        );
    }

    // Fast path: prior generation on the same baseline, same shards, and not
    // ahead of the authoritative index. A rollback rebuilds from baseline.
    let prior_current = meta
        .as_ref()
        .and_then(|m| m.get("currentVersion"))
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let baseline_unchanged = meta.is_some()
        && gen_dir.is_some()
        && meta
            .as_ref()
            .and_then(|m| m.get("baselineVersion"))
            .and_then(|v| v.as_str())
            == Some(baseline_version.as_str())
        && same_shards
        && prior_current
            .as_ref()
            .is_some_and(|p| p.as_str() <= current_version.as_str());
    let apply_after = match (&baseline_unchanged, &prior_current) {
        (true, Some(prior)) => prior.clone(),
        _ => baseline_version.clone(),
    };

    // Delta-chain enumeration must see every images release back to
    // applyAfter; the newest-100 page may not reach that far (#179).
    let covers_chain_start = |release: &Value| -> bool {
        images_tag_version(
            release
                .get("tag_name")
                .and_then(|t| t.as_str())
                .unwrap_or(""),
        )
        .is_some_and(|v| v.as_str() <= apply_after.as_str())
    };
    if !releases.iter().any(|r| {
        let tag = r.get("tag_name").and_then(|t| t.as_str()).unwrap_or("");
        images_tag_version(tag).is_some_and(|v| v.as_str() <= apply_after.as_str())
    }) {
        match list_releases_paginated(
            transport,
            IMAGES_REPO_OWNER,
            IMAGES_REPO,
            covers_chain_start,
        )
        .await
        {
            Some(paged) => releases = paged,
            None => {
                return offline_or_no_data(
                    image_dir,
                    "Release history does not cover the images baseline",
                )
            }
        }
    }

    let Some(chain) = enumerate_delta_chain(&releases, &baseline_version, &current_version) else {
        return offline_or_no_data(image_dir, "images delta chain has duplicate versions");
    };

    let pending: Vec<(String, Value)> = chain
        .into_iter()
        .filter(|(version, _)| version.as_str() > apply_after.as_str())
        .collect();
    // Fail fast on a missing delta asset BEFORE the baseline download, so a
    // broken chain never burns the transfer budget (#179).
    for (chain_version, chain_release) in &pending {
        if asset_url(chain_release, &delta_asset_name(chain_version)).is_none() {
            return offline_or_no_data(
                image_dir,
                &format!(
                    "images delta asset missing: {}",
                    delta_asset_name(chain_version)
                ),
            );
        }
    }

    // --- Rebuild a new generation ---------------------------------------
    let generation = format!("{}-{}", version_hash(&current_version), random_suffix());
    let staging = rel_dir.join(format!(".{generation}.tmp"));
    let activated = rel_dir.join(&generation);
    let mut staging_exists = false;
    let result = async {
        tokio::fs::create_dir_all(&staging).await?;
        staging_exists = true;

        if baseline_unchanged {
            let Some(prior) = gen_dir.as_ref() else {
                unreachable!("baseline_unchanged implies a prior generation");
            };
            copy_tree(prior, &staging).await?;
            let _ = tokio::fs::remove_file(staging.join("index.json")).await;
            let _ = tokio::fs::remove_file(staging.join(IMAGES_META)).await;
        } else {
            let baseline_tag = format!("{BASELINE_PREFIX}{baseline_version}");
            for shard_key in shard_keys {
                let Some(shard_file) = index.shards.get(shard_key) else {
                    continue;
                };
                if shard_file.is_empty() {
                    continue;
                }
                let shard_zip = staging.join(format!(".{shard_key}.zip"));
                transport
                    .download(
                        &release_download_url(&baseline_tag, shard_file),
                        &shard_zip,
                        30_000,
                    )
                    .await
                    .map_err(|e| SyncError::Message(format!("{e} downloading {shard_file}")))?;
                safe_extract_zip(&shard_zip, &staging)?;
                let _ = tokio::fs::remove_file(&shard_zip).await;
            }
        }

        // Delta overlay in version order; failures propagate so a
        // half-applied chain never activates.
        for (chain_version, chain_release) in &pending {
            let Some(delta_url) = asset_url(chain_release, &delta_asset_name(chain_version)) else {
                return Err(SyncError::Message(format!(
                    "images delta asset missing: {}",
                    delta_asset_name(chain_version)
                )));
            };
            let delta_zip = staging.join(".delta.zip");
            transport
                .download(&delta_url, &delta_zip, 30_000)
                .await
                .map_err(|e| {
                    SyncError::Message(format!(
                        "{e} downloading {}",
                        delta_asset_name(chain_version)
                    ))
                })?;
            safe_extract_zip(&delta_zip, &staging)?;
            let _ = tokio::fs::remove_file(&delta_zip).await;
        }

        verify_variant_hashes(&staging, &index, shard_keys)
            .await
            .map_err(SyncError::Message)?;

        // Authoritative index.json bytes + generation meta.
        tokio::fs::write(staging.join("index.json"), &index_bytes).await?;
        let gen_meta = generation_meta(&baseline_version, &current_version, shard_keys);
        save_meta(&staging, &gen_meta)?;

        // Atomic activation.
        let _ = tokio::fs::remove_dir_all(&activated).await;
        tokio::fs::rename(&staging, &activated).await?;
        staging_exists = false;

        // Top-level meta points at the active generation.
        let mut top_meta = gen_meta;
        top_meta["generation_root"] =
            Value::String(pathdiff_rel(image_dir, &activated).unwrap_or_else(|| ".".to_string()));
        save_meta(image_dir, &top_meta)?;

        // pruneGenerations: keep the active tree, 24h retention, skip hidden.
        prune_old_trees(
            &rel_dir,
            &std::collections::HashSet::from([activated.clone()]),
            super::images_meta::RETENTION_MS as u128,
            true,
        );

        Ok(SyncResult::new(
            SyncStatus::Updated,
            Some(current_version.clone()),
            None,
        ))
    }
    .await;

    match result {
        Ok(r) => r,
        Err(err) => {
            if staging_exists {
                let _ = tokio::fs::remove_dir_all(&staging).await;
            }
            offline_or_no_data(image_dir, &err.to_string())
        }
    }
}

fn delta_asset_name(version: &str) -> String {
    format!("{DELTA_ASSET_PREFIX}{version}.zip")
}

fn pathdiff_rel(from: &Path, to: &Path) -> Option<String> {
    let abs_from = std::fs::canonicalize(from).ok()?;
    let abs_to = std::fs::canonicalize(to).ok()?;
    let rel = pathdiff_rel_impl(&abs_from, &abs_to)?;
    Some(rel.replace('\\', "/"))
}

/// Minimal `path.relative` for two absolute paths.
fn pathdiff_rel_impl(from: &Path, to: &Path) -> Option<String> {
    let f: Vec<_> = from.components().collect();
    let t: Vec<_> = to.components().collect();
    let mut common = 0;
    while common < f.len() && common < t.len() && f[common] == t[common] {
        common += 1;
    }
    let mut parts: Vec<String> = Vec::new();
    for _ in common..f.len() {
        parts.push("..".to_string());
    }
    for c in &t[common..] {
        parts.push(c.as_os_str().to_string_lossy().into_owned());
    }
    if parts.is_empty() {
        return Some(".".to_string());
    }
    Some(parts.join("/"))
}

/// `cp(src, dst, {recursive: true})` — full-tree copy of the prior
/// generation into staging (fast path). Async recursion is boxed per level.
async fn copy_tree(src: &Path, dst: &Path) -> std::io::Result<()> {
    tokio::fs::create_dir_all(dst).await?;
    let mut entries = tokio::fs::read_dir(src).await?;
    while let Some(entry) = entries.next_entry().await? {
        let file_type = entry.file_type().await?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if file_type.is_dir() {
            Box::pin(copy_tree(&from, &to)).await?;
        } else {
            tokio::fs::copy(&from, &to).await?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn release(tag: &str, created: &str) -> Value {
        json!({ "tag_name": tag, "created_at": created })
    }

    #[test]
    fn tag_versions_and_shards() {
        assert_eq!(
            images_tag_version("images-baseline-26-01-01-00-00-00_a"),
            Some("26-01-01-00-00-00_a".to_string())
        );
        assert_eq!(
            images_tag_version("images-26-10-08-04-51-28_b"),
            Some("26-10-08-04-51-28_b".to_string())
        );
        assert_eq!(images_tag_version("data-26-10-08"), None);
        assert_eq!(needed_shard_keys(false).len(), 4);
        assert_eq!(needed_shard_keys(true).len(), 6);
        assert!(needed_shard_keys(true).contains(&"chararts-original".to_string()));
    }

    #[test]
    fn latest_by_prefix_excludes_baseline() {
        let releases = vec![
            release(
                "images-baseline-26-01-01-00-00-00_a",
                "2026-10-01T00:00:00Z",
            ),
            release("images-26-10-08-04-51-28_b", "2026-10-08T05:00:00Z"),
            release("images-26-10-09-04-51-28_c", "2026-10-09T05:00:00Z"),
            release("data-26-10-09-00-00-00", "2026-10-09T06:00:00Z"),
        ];
        let latest = latest_release_by_prefix(&releases, "images-", Some("images-baseline-"))
            .expect("found");
        assert_eq!(
            latest.get("tag_name").and_then(|t| t.as_str()),
            Some("images-26-10-09-04-51-28_c")
        );
        assert!(latest_release_by_prefix(&releases, "nope-", None).is_none());
    }

    #[test]
    fn delta_chain_enumeration_and_duplicates() {
        let releases = vec![
            release("images-baseline-26-01-01-00-00-00_a", "t0"),
            release("images-26-06-01-00-00-00_m", "t1"),
            release("images-26-07-01-00-00-00_n", "t2"),
            release("images-26-12-01-00-00-00_z", "t3"), // > current: excluded
        ];
        let chain = enumerate_delta_chain(&releases, "26-01-01-00-00-00_a", "26-07-01-00-00-00_n")
            .expect("chain");
        assert_eq!(chain.len(), 2);
        assert_eq!(chain[0].0, "26-06-01-00-00-00_m");

        // Duplicate versions fail closed.
        let dup = vec![
            release("images-26-06-01-00-00-00_m", "t1"),
            release("images-26-06-01-00-00-00_m", "t2"),
        ];
        assert!(
            enumerate_delta_chain(&dup, "26-01-01-00-00-00_a", "26-07-01-00-00-00_n").is_none()
        );
    }

    #[test]
    fn pathdiff_relative_like_ts() {
        let base = Path::new("/data/images");
        let gen = Path::new("/data/images/.releases/abcd-1234");
        assert_eq!(pathdiff_rel_impl(base, gen).unwrap(), ".releases/abcd-1234");
        assert_eq!(pathdiff_rel_impl(base, base).unwrap(), ".");
    }
}
