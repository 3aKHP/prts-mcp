//! Typed v2 physical parts and the shared artwork read projection.
use super::images_meta::{parse_contents, ImagesIndex};
use serde::Deserialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

pub const SCHEMA: &str = "akdp-images/v2";

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Member {
    pub bytes: u64,
    pub sha256: String,
    pub group: String,
}
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Part {
    pub file: String,
    pub bytes: u64,
    pub sha256: String,
    pub group: String,
    pub members: BTreeMap<String, Member>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub schema_version: String,
    pub baseline_version: String,
    pub current_version: String,
    pub previous_version: Option<String>,
    pub baseline_parts: Vec<Part>,
    pub delta_parts: Vec<Part>,
}

pub(super) fn flat(name: &str) -> Result<(), String> {
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\', '\0', ':']) {
        return Err("unsafe v2 filename".into());
    }
    Ok(())
}
fn digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

pub fn parse(value: &Value) -> Result<(Manifest, ImagesIndex), String> {
    let index: Manifest = serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
    if index.schema_version != SCHEMA {
        return Err("unsupported image schema".into());
    }
    flat(&index.current_version)?;
    flat(&index.baseline_version)?;
    if index.baseline_version > index.current_version {
        return Err("baseline after current version".into());
    }
    if index.current_version == index.baseline_version {
        if index.previous_version.is_some() || !index.delta_parts.is_empty() {
            return Err("baseline must not carry a predecessor or delta parts".into());
        }
    } else {
        let prior = index
            .previous_version
            .as_deref()
            .ok_or("missing predecessor")?;
        flat(prior)?;
        if prior < index.baseline_version.as_str() || prior >= index.current_version.as_str() {
            return Err("invalid predecessor order".into());
        }
    }
    for parts in [&index.baseline_parts, &index.delta_parts] {
        if parts.len() > 997 {
            return Err("too many release parts".into());
        }
        let mut files = BTreeSet::new();
        let mut members = BTreeSet::new();
        for part in parts {
            flat(&part.file)?;
            if !files.insert(&part.file)
                || part.bytes == 0
                || part.bytes >= 2 * 1024u64.pow(3)
                || !digest(&part.sha256)
                || part.members.is_empty()
            {
                return Err("invalid or duplicate physical part".into());
            }
            for (name, member) in &part.members {
                flat(name)?;
                if !members.insert(name)
                    || !digest(&member.sha256)
                    || member.bytes == 0
                    || member.group != part.group
                {
                    return Err("invalid or duplicate part member".into());
                }
            }
        }
    }
    let view = parse_contents(value).ok_or("missing artwork projection")?;
    let raw = value
        .get("artworks")
        .and_then(Value::as_object)
        .ok_or("missing artworks")?;
    if raw.len() != view.artworks.len() {
        return Err("invalid artwork entries".into());
    }
    let mut names = BTreeSet::new();
    for entry in view.artworks.values() {
        for tier in super::images_meta::VARIANT_ORDER {
            if raw[&entry.skin_id].get(tier).is_some() && !entry.variants.contains_key(tier) {
                return Err("invalid declared artwork variant".into());
            }
        }
        for (tier, variant) in &entry.variants {
            flat(&variant.file)?;
            if !names.insert(&variant.file)
                || !digest(&variant.sha256)
                || !variant.bytes.is_finite()
                || variant.bytes <= 0.0
                || variant.bytes.fract() != 0.0
                || variant.width <= 0.0
                || variant.height <= 0.0
            {
                return Err("invalid artwork variant".into());
            }
            if !super::images_sync::needed_shard_keys(true)
                .contains(&format!("{}-{tier}", entry.shard))
            {
                return Err("unsupported artwork group".into());
            }
        }
    }
    Ok((index, view))
}
