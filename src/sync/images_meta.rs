//! Images generation-filesystem store (read side) + index parsing — port of
//! TS `sync/generationStore.ts` read half and `data/images.ts:parseIndex`.
//!
//! P2 scope (docs/07): the shared file-publish primitives (atomic meta
//! writes, locks, staging) plus this minimal index-parse case. The full
//! baseline/delta sync chain is P6.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::primitives::atomic_write_json;
use super::types::SyncError;

pub const SCHEMA_VERSION: &str = "akdp-images/v1";
pub const IMAGES_META: &str = ".images_meta.json";
pub const RETENTION_MS: u64 = 24 * 60 * 60 * 1000;

pub fn meta_path(root: &Path) -> PathBuf {
    root.join(IMAGES_META)
}

/// `loadMeta`: object root or None.
pub fn load_meta(root: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(meta_path(root)).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    if value.is_object() {
        Some(value)
    } else {
        None
    }
}

pub fn save_meta(root: &Path, meta: &Value) -> Result<(), SyncError> {
    atomic_write_json(&meta_path(root), meta)
}

/// `activeGeneration`: `generation_root` containment + the generation must be
/// a directory carrying index.json.
pub fn active_generation(image_dir: &Path) -> Option<PathBuf> {
    let meta = load_meta(image_dir)?;
    let rel = meta.get("generation_root")?.as_str()?;
    if rel.is_empty() {
        return None;
    }
    let base = std::path::absolute(image_dir).ok()?;
    let gen = base.join(rel);
    if !gen.starts_with(&base) {
        return None;
    }
    if !gen.is_dir() {
        return None;
    }
    if !gen.join("index.json").is_file() {
        return None;
    }
    Some(gen)
}

/// `versionHash`: sha256(version) hex, first 16 chars.
pub fn version_hash(version: &str) -> String {
    use sha2::Digest;
    let digest = format!("{:x}", sha2::Sha256::digest(version.as_bytes()));
    digest[..16].to_string()
}

/// The generation-meta fields written inside a generation dir (no
/// generation_root) and, with `generation_root`, at the images root.
pub fn generation_meta(
    baseline_version: &str,
    current_version: &str,
    shard_keys: &[String],
) -> Value {
    json!({
        "schemaVersion": SCHEMA_VERSION,
        "baselineVersion": baseline_version,
        "currentVersion": current_version,
        "shardsSynced": shard_keys,
    })
}

// ---------------------------------------------------------------------------
// index.json parsing (minimal P2 case; the schema is frozen akdp-images/v1)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct VariantMeta {
    pub file: String,
    pub width: f64,
    pub height: f64,
    pub bytes: f64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ArtworkEntry {
    pub skin_id: String,
    pub kind: String,
    pub shard: String,
    pub since_version: String,
    pub variants: BTreeMap<String, VariantMeta>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ImagesIndex {
    pub baseline_version: String,
    pub current_version: String,
    pub shards: BTreeMap<String, String>,
    pub artworks: BTreeMap<String, ArtworkEntry>,
}

pub const VARIANT_ORDER: [&str; 3] = ["original", "large", "preview"];

fn parse_variant(raw: Option<&Value>) -> Option<VariantMeta> {
    let v = raw?;
    if !v.is_object() {
        return None;
    }
    // TS typeof checks: w/h/bytes must be numbers, file/sha256 strings.
    let w = v.get("w")?.as_f64()?;
    let h = v.get("h")?.as_f64()?;
    let bytes = v.get("bytes")?.as_f64()?;
    Some(VariantMeta {
        file: v.get("file")?.as_str()?.to_string(),
        width: w,
        height: h,
        bytes,
        sha256: v.get("sha256")?.as_str()?.to_string(),
    })
}

/// Read v1 or validated v2 artwork metadata; unfamiliar schemas are rejected.
pub fn parse_index(data: &Value) -> Option<ImagesIndex> {
    match data.get("schemaVersion")?.as_str()? {
        SCHEMA_VERSION => parse_contents(data),
        super::images_v2::SCHEMA => super::images_v2::parse(data).ok().map(|(_, view)| view),
        _ => None,
    }
}

/// Shared artwork projection; protocol-specific validation stays in each parser.
pub(super) fn parse_contents(data: &Value) -> Option<ImagesIndex> {
    if !data.is_object() {
        return None;
    }
    let mut artworks = BTreeMap::new();
    if let Some(raw) = data.get("artworks").filter(|v| v.is_object()) {
        for (skin_id, entry) in raw.as_object().unwrap() {
            let Some(entry) = entry.as_object() else {
                continue;
            };
            let mut variants = BTreeMap::new();
            for vname in VARIANT_ORDER {
                if let Some(parsed) = parse_variant(entry.get(vname)) {
                    variants.insert(vname.to_string(), parsed);
                }
            }
            if variants.is_empty() {
                continue;
            }
            artworks.insert(
                skin_id.clone(),
                ArtworkEntry {
                    skin_id: skin_id.clone(),
                    kind: entry
                        .get("kind")
                        .and_then(|v| v.as_str())
                        .unwrap_or("base")
                        .to_string(),
                    shard: entry
                        .get("shard")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    since_version: entry
                        .get("sinceVersion")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    variants,
                },
            );
        }
    }
    let mut shards = BTreeMap::new();
    if let Some(raw) = data.get("shards").filter(|v| v.is_object()) {
        for (key, value) in raw.as_object().unwrap() {
            if let Some(file) = value.as_str() {
                shards.insert(key.clone(), file.to_string());
            }
        }
    }
    Some(ImagesIndex {
        baseline_version: data
            .get("baselineVersion")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        current_version: data
            .get("currentVersion")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        shards,
        artworks,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_index() -> Value {
        json!({
            "schemaVersion": "akdp-images/v1",
            "baselineVersion": "26-01-01-00-00-00_aaaa",
            "currentVersion": "26-10-08-04-51-28-56071834",
            "shards": {
                "chararts-large": "chararts-large.zip",
                "skinpack-large": "skinpack-large.zip",
                "broken": 5,
            },
            "artworks": {
                "char_002_amiya": {
                    "kind": "base",
                    "shard": "chararts",
                    "sinceVersion": "26-01-01-00-00-00_aaaa",
                    "large": {"file": "chararts/char_002_amiya.large.png", "w": 1024, "h": 1024, "bytes": 12345, "sha256": "abc"},
                    "preview": {"file": "chararts/char_002_amiya.preview.png", "w": 256, "h": 256, "bytes": 1234, "sha256": "def"},
                },
                "char_002_amiya#1": {
                    "kind": "skin",
                    "shard": "skinpack",
                    "large": {"file": "x.png", "w": 1, "h": 1, "bytes": 1, "sha256": "ff"},
                    "broken-variant": {"file": 1},
                },
                "no_variants": {"kind": "base"},
                "not_an_object": 7,
            },
        })
    }

    #[test]
    fn parse_index_minimal_case() {
        let index = parse_index(&sample_index()).expect("index parses");
        assert_eq!(index.baseline_version, "26-01-01-00-00-00_aaaa");
        assert_eq!(index.current_version, "26-10-08-04-51-28-56071834");
        assert_eq!(
            index.shards,
            BTreeMap::from([
                (
                    "chararts-large".to_string(),
                    "chararts-large.zip".to_string()
                ),
                (
                    "skinpack-large".to_string(),
                    "skinpack-large.zip".to_string()
                ),
            ])
        );
        // Entries without at least one valid variant are dropped; broken
        // variant shapes are skipped individually.
        assert_eq!(index.artworks.len(), 2);
        let amiya = &index.artworks["char_002_amiya"];
        assert_eq!(amiya.kind, "base");
        assert_eq!(amiya.shard, "chararts");
        assert_eq!(amiya.variants.len(), 2);
        assert_eq!(
            amiya.variants["large"].file,
            "chararts/char_002_amiya.large.png"
        );
        assert_eq!(amiya.variants["large"].width, 1024.0);
        let skin = &index.artworks["char_002_amiya#1"];
        assert_eq!(skin.kind, "skin");
        assert_eq!(skin.variants.len(), 1);
        assert!(skin.variants.contains_key("large"));

        // Unfamiliar schema version is rejected.
        let mut future = sample_index();
        future["schemaVersion"] = Value::String("akdp-images/v2".into());
        assert!(parse_index(&future).is_none());
        assert!(parse_index(&Value::Null).is_none());
    }

    #[test]
    fn pinned_upstream_index_parses() {
        let path = Path::new(".runtime/data/images-26-10-08-04-51-28-56071834/index.json");
        if !path.is_file() {
            return; // data snapshot not fetched in this checkout
        }
        let raw: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let index = parse_index(&raw).expect("pinned index parses");
        assert!(!index.current_version.is_empty());
        assert!(!index.shards.is_empty());
        assert!(!index.artworks.is_empty());
        // Default shard keys the pipeline publishes.
        for key in [
            "chararts-large",
            "chararts-preview",
            "skinpack-large",
            "skinpack-preview",
        ] {
            assert!(index.shards.contains_key(key), "missing shard {key}");
        }
    }

    #[test]
    fn meta_pointer_round_trip_and_containment() {
        let dir = std::env::temp_dir().join(format!("prts-imgmeta-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(active_generation(&dir), None);

        let gen = dir.join(".releases/gen-1");
        std::fs::create_dir_all(&gen).unwrap();
        std::fs::write(gen.join("index.json"), "{}").unwrap();
        save_meta(
            &dir,
            &json!({
                "schemaVersion": SCHEMA_VERSION,
                "baselineVersion": "b",
                "currentVersion": "c",
                "shardsSynced": ["chararts-large"],
                "generation_root": ".releases/gen-1",
            }),
        )
        .unwrap();
        assert_eq!(
            active_generation(&dir),
            Some(std::path::absolute(&gen).unwrap())
        );

        // Escaping pointer is rejected.
        save_meta(&dir, &json!({"generation_root": "../elsewhere"})).unwrap();
        assert_eq!(active_generation(&dir), None);
        // A generation without index.json is not active.
        save_meta(&dir, &json!({"generation_root": ".releases/none"})).unwrap();
        assert_eq!(active_generation(&dir), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn version_hash_is_sixteen_hex_chars() {
        assert_eq!(version_hash("abc").len(), 16);
        assert!(version_hash("abc").chars().all(|c| c.is_ascii_hexdigit()));
    }
}
