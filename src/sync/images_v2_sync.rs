//! v2 image synchronization with verified reuse and atomic generation activation.
use super::{images_meta, transport::Transport};
use crate::config::DataSource;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::{Arc, Mutex};

use super::images_meta::ImagesIndex;
use super::images_v2::{flat, Manifest as Index, Part};
use super::images_v2_io::{blocking, checked, cleanup_old, cleanup_staging, extract, Candidate};
/// Mirror cascading lives in the transport; failed rounds retry on the sync schedule.
async fn fetch(t: &dyn Transport, url: &str, path: &Path) -> Result<(), String> {
    t.download_file(url, path, 900_000)
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}
async fn read_index(
    t: &dyn Transport,
    source: &DataSource,
    tag: &str,
    root: &Path,
) -> Result<(Value, Index, ImagesIndex), String> {
    flat(tag)?;
    let tmp = root.join(".index.tmp");
    fetch(t, &source.download_url(tag, "index.json"), &tmp).await?;
    let value: Value = serde_json::from_slice(&std::fs::read(&tmp).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let (index, view) = super::images_v2::parse(&value)?;
    if tag != format!("images2-{}", index.current_version) {
        return Err("v2 index identity mismatch".into());
    }
    Ok((value, index, view))
}
/// Delta parts collected from the target version back towards the baseline.
struct Chain {
    deltas: Vec<(String, Vec<Part>)>,
    previous: Option<String>,
    newer: String,
}
impl Chain {
    fn new(index: &Index) -> Self {
        Self {
            deltas: vec![(index.current_version.clone(), index.delta_parts.clone())],
            previous: index.previous_version.clone(),
            newer: index.current_version.clone(),
        }
    }
    /// Walk to the baseline, or stop before fetching `stop`; a stopped walk can resume.
    async fn walk(
        &mut self,
        t: &dyn Transport,
        source: &DataSource,
        root: &Path,
        index: &Index,
        stop: Option<&str>,
    ) -> Result<(), String> {
        while self.newer != index.baseline_version {
            let version = self.previous.clone().ok_or("broken predecessor chain")?;
            if version >= self.newer || version < index.baseline_version {
                return Err("invalid predecessor order".into());
            }
            if stop == Some(version.as_str()) {
                return Ok(());
            }
            let (_, prior, _) = read_index(t, source, &format!("images2-{version}"), root).await?;
            if prior.baseline_version != index.baseline_version
                || prior.baseline_parts != index.baseline_parts
            {
                return Err("baseline drift".into());
            }
            self.deltas.push((version.clone(), prior.delta_parts));
            self.previous = prior.previous_version;
            self.newer = version;
        }
        Ok(())
    }
}
/// Caller holds the shared v1/v2 image activation lock.
pub(super) async fn run_selected(
    root: &Path,
    t: &dyn Transport,
    source: &DataSource,
    original: bool,
    latest: &str,
    lease: Arc<std::fs::File>,
) -> Result<super::types::SyncResult, String> {
    super::source_guard::ensure(root, source)?;
    let cleanup_root = root.to_owned();
    blocking(&lease, move || {
        cleanup_staging(&cleanup_root.join(".releases"))?;
        cleanup_old(&cleanup_root);
        Ok(())
    })
    .await?;
    let keys = super::images_sync::needed_shard_keys(original);
    let active = images_meta::active_generation(root);
    let active_meta = images_meta::load_meta(root);
    let same_source = active_meta
        .as_ref()
        .is_some_and(|meta| meta["sourceRepo"].as_str() == Some(source.slug().as_str()));
    let same_groups = active_meta.as_ref().is_some_and(|meta| {
        meta["shardsSynced"].as_array().is_some_and(|groups| {
            groups.len() == keys.len()
                && keys.iter().all(|key| {
                    groups
                        .iter()
                        .any(|group| group.as_str() == Some(key.as_str()))
                })
        })
    });
    // Like v1: an activated generation is immutable, so an unchanged tag skips the index.
    if active.is_some()
        && same_source
        && same_groups
        && active_meta.as_ref().is_some_and(|meta| {
            meta["schemaVersion"] == super::images_v2::SCHEMA
                && meta["currentVersion"].as_str() == latest.strip_prefix("images2-")
        })
    {
        return Ok(super::types::SyncResult::new(
            super::types::SyncStatus::UpToDate,
            latest.strip_prefix("images2-").map(str::to_owned),
            None,
        ));
    }
    let (value, index, target) = read_index(t, source, latest, root).await?;
    let mut expected = BTreeMap::new();
    for entry in target.artworks.values() {
        for (tier, v) in &entry.variants {
            if original || tier != "original" {
                expected.insert(v.file.clone(), (v.bytes as u64, v.sha256.clone()));
            }
        }
    }
    let expected = Arc::new(expected);
    let prior = active
        .as_ref()
        .and_then(|path| std::fs::read(path.join("index.json")).ok())
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|value| super::images_v2::parse(&value).ok())
        .map(|(prior, _)| prior);
    if same_source
        && prior
            .as_ref()
            .is_some_and(|prior| prior.current_version > index.current_version)
    {
        return Err("refusing image version downgrade".into());
    }
    let incremental_from = prior
        .filter(|prior| {
            same_source
                && same_groups
                && prior.baseline_version == index.baseline_version
                && prior.baseline_parts == index.baseline_parts
                && prior.current_version < index.current_version
        })
        .map(|prior| prior.current_version);
    let mut chain = Chain::new(&index);
    if let Some(stop) = incremental_from.as_deref() {
        chain.walk(t, source, root, &index, Some(stop)).await?;
    }
    let rel = root.join(".releases");
    std::fs::create_dir_all(&rel).map_err(|e| e.to_string())?;
    let name = format!("v2-{}", super::primitives::random_suffix());
    let stage = rel.join(format!(".{name}.tmp"));
    std::fs::create_dir(&stage).map_err(|e| e.to_string())?;
    let candidate = Arc::new(Mutex::new(Candidate(
        Some(stage.clone()),
        Arc::clone(&lease),
    )));
    let result = async {
        let reuse_active = active.clone();
        let reuse_expected = expected.clone();
        let reuse_stage = stage.clone();
        let reuse_candidate = Arc::clone(&candidate);
        let preserved = blocking(&lease, move || {
            let _candidate = reuse_candidate;
            let active = reuse_active;
            let expected = reuse_expected;
            let stage = reuse_stage;
            let mut preserved = BTreeSet::new();
            if let Some(prior) = &active {
                for (name, (bytes, hash)) in expected.iter() {
                    if checked(&prior.join(name), *bytes, hash, Some(&stage.join(name))) {
                        preserved.insert(name.clone());
                    }
                }
            }
            Ok(preserved)
        })
        .await?;
        let preserved = Arc::new(preserved);
        // Deltas since the active version suffice only if every other target was reused.
        let produced: BTreeSet<&String> = chain
            .deltas
            .iter()
            .flat_map(|(_, parts)| parts)
            .filter(|part| keys.contains(&part.group))
            .flat_map(|part| part.members.keys())
            .collect();
        let incremental = incremental_from.is_some()
            && expected
                .keys()
                .all(|name| preserved.contains(name) || produced.contains(name));
        if !incremental {
            chain.walk(t, source, root, &index, None).await?;
        }
        let cache = root.join(".v2-cache");
        std::fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
        let mut work = Vec::new();
        if !incremental {
            work.push((
                format!("images2-baseline-{}", index.baseline_version),
                index.baseline_parts.clone(),
            ));
        }
        for (version, parts) in chain.deltas.into_iter().rev() {
            work.push((format!("images2-{version}"), parts));
        }
        // Keep only archives needed by this candidate; failed obsolete versions must not accumulate.
        let wanted: BTreeSet<&str> = work
            .iter()
            .flat_map(|(_, parts)| parts.iter())
            .filter(|part| {
                keys.contains(&part.group)
                    && part
                        .members
                        .keys()
                        .any(|name| expected.contains_key(name) && !preserved.contains(name))
            })
            .map(|part| part.sha256.as_str())
            .collect();
        for entry in std::fs::read_dir(&cache).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if entry.file_type().map_err(|e| e.to_string())?.is_file()
                && !wanted.contains(name.strip_suffix(".tmp").unwrap_or(&name))
            {
                std::fs::remove_file(entry.path()).map_err(|e| e.to_string())?;
            }
        }
        // Last verified member written per target name; later deltas overwrite earlier parts.
        let mut written = BTreeMap::new();
        for (tag, parts) in work {
            for part in parts {
                if !keys.contains(&part.group) {
                    continue;
                }
                if part
                    .members
                    .keys()
                    .all(|n| preserved.contains(n) || !expected.contains_key(n))
                {
                    continue;
                }
                let archive = cache.join(&part.sha256);
                let check_archive = archive.clone();
                let check_part = part.clone();
                if !blocking(&lease, move || {
                    Ok(checked(
                        &check_archive,
                        check_part.bytes,
                        &check_part.sha256,
                        None,
                    ))
                })
                .await?
                {
                    let tmp = cache.join(format!("{}.tmp", part.sha256));
                    if let Err(error) = t
                        .download_file_limited(
                            &source.download_url(&tag, &part.file),
                            &tmp,
                            900_000,
                            part.bytes,
                        )
                        .await
                    {
                        let _ = tokio::fs::remove_file(&tmp).await;
                        return Err(error.to_string());
                    }
                    let check_part = part.clone();
                    let check_archive = archive.clone();
                    blocking(&lease, move || {
                        if !checked(&tmp, check_part.bytes, &check_part.sha256, None) {
                            let _ = std::fs::remove_file(&tmp);
                            return Err("ZIP digest mismatch".into());
                        }
                        std::fs::rename(tmp, check_archive).map_err(|e| e.to_string())
                    })
                    .await?;
                }
                let extract_stage = stage.clone();
                let extract_expected = expected.clone();
                let extract_preserved = preserved.clone();
                let extract_candidate = Arc::clone(&candidate);
                let extracted = blocking(&lease, move || {
                    let _candidate = extract_candidate;
                    let stage = extract_stage;
                    let expected = extract_expected;
                    let preserved = extract_preserved;
                    extract(&archive, &part, &stage, &expected, &preserved)
                })
                .await?;
                written.extend(extracted);
            }
        }
        for (name, target) in expected.iter() {
            if !preserved.contains(name) && written.get(name) != Some(target) {
                return Err(format!("target mismatch: {name}"));
            }
        }
        let root = root.to_owned();
        let source = source.clone();
        let candidate = Arc::clone(&candidate);
        blocking(&lease, move || {
            std::fs::write(
                stage.join("index.json"),
                serde_json::to_vec(&value).unwrap(),
            )
            .map_err(|e| e.to_string())?;
            let mut meta = images_meta::generation_meta(
                &index.baseline_version,
                &index.current_version,
                &keys,
            );
            meta["schemaVersion"] = json!(super::images_v2::SCHEMA);
            meta["sourceRepo"] = json!(source.slug());
            images_meta::save_meta(&stage, &meta).map_err(|e| e.to_string())?;
            std::fs::rename(&stage, rel.join(&name)).map_err(|e| e.to_string())?;
            candidate.lock().unwrap().0 = Some(rel.join(&name));
            let mut meta = meta;
            meta["generation_root"] = json!(format!(".releases/{name}"));
            images_meta::save_meta(&root, &meta).map_err(|e| e.to_string())?;
            candidate.lock().unwrap().0 = None;
            // Keep failed-transfer cache for resume, release it only after activation.
            if let Err(error) = std::fs::remove_dir_all(&cache) {
                eprintln!("Images v2 cache cleanup: {error}");
            }
            super::primitives::prune_old_trees(
                &rel,
                &std::collections::HashSet::from([rel.join(&name)]),
                images_meta::RETENTION_MS as u128,
                true,
            );
            Ok(super::types::SyncResult::new(
                super::types::SyncStatus::Updated,
                Some(index.current_version.clone()),
                None,
            ))
        })
        .await
    }
    .await;
    blocking(&lease, move || {
        candidate.lock().unwrap().cleanup();
        drop(candidate);
        Ok(())
    })
    .await?;
    result
}
