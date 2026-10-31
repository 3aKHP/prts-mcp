//! v2 image synchronization with verified reuse and atomic generation activation.
use super::{images_meta, transport::Transport};
use crate::config::DataSource;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use super::images_meta::ImagesIndex;
use super::images_v2::{flat, Manifest as Index, Part};
/// Stream a regular file once, optionally copying it; a failed copy is removed.
fn checked(path: &Path, bytes: u64, sha: &str, copy: Option<&Path>) -> bool {
    use std::io::{Read, Write};
    if !std::fs::symlink_metadata(path).is_ok_and(|meta| meta.is_file()) {
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
/// Mirror cascading and per-candidate timeouts live in the transport.
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
) -> Result<super::types::SyncResult, String> {
    super::source_guard::ensure(root, source)?;
    cleanup_staging(&root.join(".releases"))?;
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
    let result = async {
        let mut preserved = BTreeSet::new();
        if let Some(prior) = &active {
            for (name, (bytes, hash)) in &expected {
                if checked(&prior.join(name), *bytes, hash, Some(&stage.join(name))) {
                    preserved.insert(name.clone());
                }
            }
        }
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
                if !checked(&archive, part.bytes, &part.sha256, None) {
                    let tmp = cache.join(format!("{}.tmp", part.sha256));
                    fetch(t, &source.download_url(&tag, &part.file), &tmp).await?;
                    if !checked(&tmp, part.bytes, &part.sha256, None) {
                        return Err("ZIP digest mismatch".into());
                    }
                    std::fs::rename(tmp, &archive).map_err(|e| e.to_string())?;
                }
                let mut zip =
                    zip::ZipArchive::new(std::fs::File::open(&archive).map_err(|e| e.to_string())?)
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
                    let mut count = 0;
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
                        hash.update(&buf[..n]);
                        count += n as u64;
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
            }
        }
        for (name, target) in &expected {
            if !preserved.contains(name) && written.get(name) != Some(target) {
                return Err(format!("target mismatch: {name}"));
            }
        }
        std::fs::write(
            stage.join("index.json"),
            serde_json::to_vec(&value).unwrap(),
        )
        .map_err(|e| e.to_string())?;
        let mut meta =
            images_meta::generation_meta(&index.baseline_version, &index.current_version, &keys);
        meta["schemaVersion"] = json!(super::images_v2::SCHEMA);
        meta["sourceRepo"] = json!(source.slug());
        images_meta::save_meta(&stage, &meta).map_err(|e| e.to_string())?;
        std::fs::rename(&stage, rel.join(&name)).map_err(|e| e.to_string())?;
        let mut meta = meta;
        meta["generation_root"] = json!(format!(".releases/{name}"));
        images_meta::save_meta(root, &meta).map_err(|e| e.to_string())?;
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
    }
    .await;
    if stage.exists() {
        let _ = std::fs::remove_dir_all(stage);
    }
    result
}

fn cleanup_staging(root: &Path) -> Result<(), String> {
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
