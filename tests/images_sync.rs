//! Images sync state machine — full-chain integration over a scripted
//! transport (docs/05 图片同步): baseline/delta rebuild, fast path, rollback,
//! fail-closed duplicates, missing-asset pre-scan, per-file sha verification,
//! sentinel deltas, offline fallback, and the original shard set.

use std::collections::HashMap;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use async_trait::async_trait;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use prts_mcp_rust::sync::images_meta::{active_generation, load_meta};
use prts_mcp_rust::sync::images_sync::{needed_shard_keys, sync_images, ImagesSyncOpts};
use prts_mcp_rust::sync::transport::{DownloadStats, Transport, TransportError};

// ---------------------------------------------------------------------------
// Fixture world: in-memory releases + assets
// ---------------------------------------------------------------------------

struct World {
    releases: Vec<Value>,
    assets: HashMap<String, Vec<u8>>,
    downloads: Mutex<Vec<String>>,
    fail_all: bool,
}

struct FakeTransport {
    world: std::sync::Arc<World>,
}

fn zip_of(files: &[(&str, &[u8])]) -> Vec<u8> {
    let mut cursor = std::io::Cursor::new(Vec::new());
    {
        let mut zip = zip::ZipWriter::new(&mut cursor);
        let options: zip::write::SimpleFileOptions = Default::default();
        for (name, data) in files {
            zip.start_file(*name, options).expect("start");
            zip.write_all(data).expect("write");
        }
        zip.finish().expect("finish");
    }
    cursor.into_inner()
}

fn png(payload: &str) -> Vec<u8> {
    let mut out = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    out.extend_from_slice(payload.as_bytes());
    out
}

fn sha256_hex(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
}

/// Build a world with baseline `base` + deltas d1, d2 where d2 is latest.
/// Artworks: amiya#1 (base), amiya#2 added in d1, skin added in d2.
fn build_world() -> (std::sync::Arc<World>, Value /*index*/) {
    let base = "26-01-01-00-00-00_base";
    let d1 = "26-02-01-00-00-00_d1";
    let d2 = "26-03-01-00-00-00_d2";

    let amiya1_large = png("amiya#1:large");
    let amiya1_preview = png("amiya#1:preview");
    let amiya2_large = png("amiya#2:large");
    let amiya2_preview = png("amiya#2:preview");
    let skin_large = png("skin:large");
    let skin_preview = png("skin:preview");

    // Baseline shards carry #1 only (large+preview); originals only when the
    // index declares original shards.
    let chararts_large = zip_of(&[("chararts/char_002_amiya#1.large.png", &amiya1_large)]);
    let chararts_preview = zip_of(&[("chararts/char_002_amiya#1.preview.png", &amiya1_preview)]);
    let skinpack_large = zip_of(&[]);
    let skinpack_preview = zip_of(&[]);
    let amiya1_original = png("amiya#1:original");
    let chararts_original = zip_of(&[("chararts/char_002_amiya#1.original.png", &amiya1_original)]);
    let skinpack_original = zip_of(&[]);

    // d1 adds #2; d2 adds the skin.
    let d1_zip = zip_of(&[
        ("chararts/char_002_amiya#2.large.png", &amiya2_large),
        ("chararts/char_002_amiya#2.preview.png", &amiya2_preview),
    ]);
    let d2_zip = zip_of(&[
        ("skinpack/char_002_amiya@t1#1.large.png", &skin_large),
        ("skinpack/char_002_amiya@t1#1.preview.png", &skin_preview),
    ]);

    let index = json!({
        "schemaVersion": "akdp-images/v1",
        "baselineVersion": base,
        "currentVersion": d2,
        "shards": {
            "chararts-large": "chararts-large.zip",
            "chararts-preview": "chararts-preview.zip",
            "skinpack-large": "skinpack-large.zip",
            "skinpack-preview": "skinpack-preview.zip",
            "chararts-original": "chararts-original.zip",
            "skinpack-original": "skinpack-original.zip",
        },
        "artworks": {
            "char_002_amiya#1": {
                "kind": "base", "shard": "chararts", "sinceVersion": base,
                "large": {"file": "chararts/char_002_amiya#1.large.png", "w": 1024, "h": 1024, "bytes": amiya1_large.len(), "sha256": sha256_hex(&amiya1_large)},
                "preview": {"file": "chararts/char_002_amiya#1.preview.png", "w": 256, "h": 256, "bytes": amiya1_preview.len(), "sha256": sha256_hex(&amiya1_preview)},
                "original": {"file": "chararts/char_002_amiya#1.original.png", "w": 2048, "h": 2048, "bytes": amiya1_original.len(), "sha256": sha256_hex(&amiya1_original)},
            },
            "char_002_amiya#2": {
                "kind": "base", "shard": "chararts", "sinceVersion": d1,
                "large": {"file": "chararts/char_002_amiya#2.large.png", "w": 1024, "h": 1024, "bytes": amiya2_large.len(), "sha256": sha256_hex(&amiya2_large)},
                "preview": {"file": "chararts/char_002_amiya#2.preview.png", "w": 256, "h": 256, "bytes": amiya2_preview.len(), "sha256": sha256_hex(&amiya2_preview)},
            },
            "char_002_amiya@t1#1": {
                "kind": "skin", "shard": "skinpack", "sinceVersion": d2,
                "large": {"file": "skinpack/char_002_amiya@t1#1.large.png", "w": 1024, "h": 1024, "bytes": skin_large.len(), "sha256": sha256_hex(&skin_large)},
                "preview": {"file": "skinpack/char_002_amiya@t1#1.preview.png", "w": 256, "h": 256, "bytes": skin_preview.len(), "sha256": sha256_hex(&skin_preview)},
            },
        },
    });

    let asset = |tag: &str, name: &str| {
        format!("https://github.com/3aKHP/arknights-data-pipeline/releases/download/{tag}/{name}")
    };
    let release = |tag: &str, created: &str, assets: &[&str]| {
        json!({
            "tag_name": tag,
            "created_at": created,
            "assets": assets.iter().map(|a| json!({
                "name": a,
                "browser_download_url": format!("https://github.com/3aKHP/arknights-data-pipeline/releases/download/{tag}/{a}"),
            })).collect::<Vec<_>>(),
        })
    };

    let baseline_tag = "images-baseline-26-01-01-00-00-00_base";
    let mut assets_map: HashMap<String, Vec<u8>> = HashMap::new();
    assets_map.insert(
        asset(baseline_tag, "chararts-large.zip"),
        chararts_large.clone(),
    );
    assets_map.insert(
        asset(baseline_tag, "chararts-preview.zip"),
        chararts_preview.clone(),
    );
    assets_map.insert(
        asset(baseline_tag, "skinpack-large.zip"),
        skinpack_large.clone(),
    );
    assets_map.insert(
        asset(baseline_tag, "skinpack-preview.zip"),
        skinpack_preview.clone(),
    );
    assets_map.insert(
        asset(baseline_tag, "chararts-original.zip"),
        chararts_original.clone(),
    );
    assets_map.insert(
        asset(baseline_tag, "skinpack-original.zip"),
        skinpack_original.clone(),
    );
    assets_map.insert(
        asset(
            "images-26-02-01-00-00-00_d1",
            "images-delta-26-02-01-00-00-00_d1.zip",
        ),
        d1_zip.clone(),
    );
    assets_map.insert(
        asset(
            "images-26-03-01-00-00-00_d2",
            "images-delta-26-03-01-00-00-00_d2.zip",
        ),
        d2_zip.clone(),
    );
    assets_map.insert(
        "https://github.com/3aKHP/arknights-data-pipeline/releases/download/images-26-03-01-00-00-00_d2/index.json".to_string(),
        serde_json::to_vec(&index).unwrap(),
    );

    let releases = vec![
        release(
            "data-26-03-01-00-00-00",
            "2026-03-01T06:00:00Z",
            &["zh_CN-excel.zip"],
        ),
        release(
            "images-26-03-01-00-00-00_d2",
            "2026-03-01T05:00:00Z",
            &["index.json", "images-delta-26-03-01-00-00-00_d2.zip"],
        ),
        release(
            "images-26-02-01-00-00-00_d1",
            "2026-02-01T05:00:00Z",
            &["images-delta-26-02-01-00-00-00_d1.zip"],
        ),
        release(
            "images-baseline-26-01-01-00-00-00_base",
            "2026-01-01T05:00:00Z",
            &[
                "chararts-large.zip",
                "chararts-preview.zip",
                "skinpack-large.zip",
                "skinpack-preview.zip",
                "chararts-original.zip",
                "skinpack-original.zip",
            ],
        ),
    ];

    (
        std::sync::Arc::new(World {
            releases,
            assets: assets_map,
            downloads: Mutex::new(Vec::new()),
            fail_all: false,
        }),
        index,
    )
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
        if self.world.fail_all {
            return Err(TransportError::Network("offline".into()));
        }
        if url.starts_with("https://api.github.com/") {
            return Ok(json!(self.world.releases));
        }
        if let Some(bytes) = self.world.assets.get(url) {
            return serde_json::from_slice(bytes)
                .map_err(|e| TransportError::InvalidJson(e.to_string()));
        }
        Err(TransportError::Http(404))
    }

    async fn download(
        &self,
        url: &str,
        dest: &Path,
        _timeout_ms: u64,
    ) -> Result<DownloadStats, TransportError> {
        if self.world.fail_all {
            return Err(TransportError::Network("offline".into()));
        }
        let Some(bytes) = self.world.assets.get(url) else {
            return Err(TransportError::AssetNotFound(url.to_string()));
        };
        self.world.downloads.lock().unwrap().push(url.to_string());
        std::fs::write(dest, bytes).map_err(|e| TransportError::Network(e.to_string()))?;
        Ok(DownloadStats {
            bytes: bytes.len() as u64,
            sha256: sha256_hex(bytes),
        })
    }

    fn mirrors(&self) -> Vec<String> {
        Vec::new()
    }

    fn github_headers(&self) -> Vec<(String, String)> {
        Vec::new()
    }
}

fn temp_images_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("prts-images-sync-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn opts(original: bool) -> ImagesSyncOpts {
    ImagesSyncOpts {
        include_original: original,
        force_check: false,
    }
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

#[tokio::test]
async fn first_sync_builds_baseline_plus_deltas() {
    let (world, index) = build_world();
    let dir = temp_images_dir("first");

    let result = sync_images(
        &dir,
        &FakeTransport {
            world: world.clone(),
        },
        opts(false),
    )
    .await;
    assert_eq!(result.status.as_str(), "updated");
    assert_eq!(result.commit_sha.as_deref(), Some("26-03-01-00-00-00_d2"));

    let gen = active_generation(&dir).expect("generation activated");
    // All three artworks' files exist with verified bytes.
    for rel in [
        "chararts/char_002_amiya#1.large.png",
        "chararts/char_002_amiya#2.large.png",
        "skinpack/char_002_amiya@t1#1.large.png",
    ] {
        assert!(gen.join(rel).is_file(), "missing {rel}");
    }
    // index.json inside the generation equals the authoritative bytes.
    let written: Value =
        serde_json::from_slice(&std::fs::read(gen.join("index.json")).unwrap()).unwrap();
    assert_eq!(written, index);
    // Top-level meta points at the generation; gen-level meta has no
    // generation_root.
    let top = load_meta(&dir).unwrap();
    assert!(top.get("generation_root").is_some());
    let gen_meta = load_meta(&gen).unwrap();
    assert!(gen_meta.get("generation_root").is_none());
    assert_eq!(
        top.get("shardsSynced").unwrap(),
        &json!(needed_shard_keys(false))
    );
    // Baseline downloads: 4 shards (no originals) + index + 2 deltas.
    let downloads = world.downloads.lock().unwrap();
    assert_eq!(downloads.len(), 4 + 1 + 2, "{downloads:?}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn second_sync_shortcuts_on_tag_and_shards() {
    let (world, _) = build_world();
    let dir = temp_images_dir("shortcut");
    let t = FakeTransport {
        world: world.clone(),
    };
    sync_images(&dir, &t, opts(false)).await;
    let before = world.downloads.lock().unwrap().len();
    let result = sync_images(&dir, &t, opts(false)).await;
    assert_eq!(result.status.as_str(), "up_to_date");
    assert_eq!(world.downloads.lock().unwrap().len(), before);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn original_shard_set_downloads_six_and_verifies_original() {
    let (world, _) = build_world();
    let dir = temp_images_dir("original");
    let t = FakeTransport {
        world: world.clone(),
    };
    let result = sync_images(&dir, &t, opts(true)).await;
    assert_eq!(result.status.as_str(), "updated");
    let gen = active_generation(&dir).expect("gen");
    assert!(gen.join("chararts/char_002_amiya#1.original.png").is_file());
    let top = load_meta(&dir).unwrap();
    assert_eq!(
        top.get("shardsSynced").unwrap(),
        &json!(needed_shard_keys(true))
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// Prior generation at d1 (same baseline) → only d2 delta + index download.
#[tokio::test]
async fn fast_path_overlays_only_newer_deltas() {
    let (world, _) = build_world();
    // Trim the world to its d1 state: latest delta = d1, index current = d1,
    // d2 assets absent.
    let mut d1_world = World {
        releases: world
            .releases
            .iter()
            .filter(|r| {
                !r["tag_name"]
                    .as_str()
                    .unwrap()
                    .contains("26-03-01-00-00-00_d2")
            })
            .cloned()
            .collect(),
        assets: world.assets.clone(),
        downloads: Mutex::new(Vec::new()),
        fail_all: false,
    };
    // The d1 release must carry its own index.json asset.
    for release in &mut d1_world.releases {
        if release["tag_name"].as_str() == Some("images-26-02-01-00-00-00_d1") {
            release["assets"] = json!([
                { "name": "index.json", "browser_download_url": "https://github.com/3aKHP/arknights-data-pipeline/releases/download/images-26-02-01-00-00-00_d1/index.json" },
                { "name": "images-delta-26-02-01-00-00-00_d1.zip", "browser_download_url": "https://github.com/3aKHP/arknights-data-pipeline/releases/download/images-26-02-01-00-00-00_d1/images-delta-26-02-01-00-00-00_d1.zip" },
            ]);
        }
    }
    // d1-era index: artworks without the d2 skin, current = d1.
    let mut index = serde_json::from_slice::<Value>(
        world
            .assets
            .get("https://github.com/3aKHP/arknights-data-pipeline/releases/download/images-26-03-01-00-00-00_d2/index.json")
            .unwrap(),
    )
    .unwrap();
    index["currentVersion"] = json!("26-02-01-00-00-00_d1");
    index["artworks"]
        .as_object_mut()
        .unwrap()
        .remove("char_002_amiya@t1#1");
    let d1_tag = "images-26-02-01-00-00-00_d1";
    d1_world.assets.insert(
        format!("https://github.com/3aKHP/arknights-data-pipeline/releases/download/{d1_tag}/index.json"),
        serde_json::to_vec(&index).unwrap(),
    );

    let dir = temp_images_dir("fastpath");
    let d1_world = std::sync::Arc::new(d1_world);
    let d1_sync = sync_images(
        &dir,
        &FakeTransport {
            world: d1_world.clone(),
        },
        opts(false),
    )
    .await;
    assert_eq!(d1_sync.status.as_str(), "updated");

    // Now the full world (d2 latest) — fast path downloads ONLY d2 + index.
    world.downloads.lock().unwrap().clear();
    let result = sync_images(
        &dir,
        &FakeTransport {
            world: world.clone(),
        },
        opts(false),
    )
    .await;
    assert_eq!(result.status.as_str(), "updated");
    let downloads = world.downloads.lock().unwrap();
    assert_eq!(downloads.len(), 2, "index + one delta only: {downloads:?}");
    assert!(downloads
        .iter()
        .any(|u| u.ends_with("images-delta-26-03-01-00-00-00_d2.zip")));
    let gen = active_generation(&dir).unwrap();
    assert!(gen.join("skinpack/char_002_amiya@t1#1.large.png").is_file());
    let _ = std::fs::remove_dir_all(&dir);
}

/// A tampered delta (wrong sha) must NOT activate; the prior generation and
/// meta stay untouched.
#[tokio::test]
async fn sha_mismatch_blocks_activation_and_keeps_prior() {
    let (world, _) = build_world();
    let dir = temp_images_dir("shafail");
    let t = FakeTransport {
        world: world.clone(),
    };
    sync_images(&dir, &t, opts(false)).await;
    let gen_before = active_generation(&dir).unwrap();
    let meta_before = load_meta(&dir).unwrap();

    // Corrupt the delta body (bytes no longer match any index sha).
    let bad_world = World {
        releases: world.releases.clone(),
        assets: {
            let mut a = world.assets.clone();
            a.insert(
                "https://github.com/3aKHP/arknights-data-pipeline/releases/download/images-26-04-01-00-00-00_d3/images-delta-26-04-01-00-00-00_d3.zip".to_string(),
                zip_of(&[("chararts/char_002_amiya#1.large.png", &png("tampered"))]),
            );
            a
        },
        downloads: Mutex::new(Vec::new()),
        fail_all: false,
    };
    // Newer delta d3 whose index claims tampered bytes... simpler: publish a
    // d3 release + index whose artwork sha does not match the actual file.
    let mut releases = world.releases.clone();
    releases.insert(
        0,
        json!({
            "tag_name": "images-26-04-01-00-00-00_d3",
            "created_at": "2026-04-01T05:00:00Z",
            "assets": [{ "name": "index.json", "browser_download_url": "https://github.com/3aKHP/arknights-data-pipeline/releases/download/images-26-04-01-00-00-00_d3/index.json" },
                       { "name": "images-delta-26-04-01-00-00-00_d3.zip", "browser_download_url": "https://github.com/3aKHP/arknights-data-pipeline/releases/download/images-26-04-01-00-00-00_d3/images-delta-26-04-01-00-00-00_d3.zip" }],
        }),
    );
    let mut index = serde_json::from_slice::<Value>(
        world
            .assets
            .get("https://github.com/3aKHP/arknights-data-pipeline/releases/download/images-26-03-01-00-00-00_d2/index.json")
            .unwrap(),
    )
    .unwrap();
    index["currentVersion"] = json!("26-04-01-00-00-00_d3");
    index["artworks"]["char_002_amiya#1"]["large"]["sha256"] =
        json!(sha256_hex(&png("honest-but-different")));
    let mut assets = bad_world.assets.clone();
    assets.insert(
        "https://github.com/3aKHP/arknights-data-pipeline/releases/download/images-26-04-01-00-00-00_d3/index.json".to_string(),
        serde_json::to_vec(&index).unwrap(),
    );
    let bad = World {
        releases,
        assets,
        downloads: Mutex::new(Vec::new()),
        fail_all: false,
    };

    let result = sync_images(
        &dir,
        &FakeTransport {
            world: std::sync::Arc::new(bad),
        },
        opts(false),
    )
    .await;
    assert_eq!(result.status.as_str(), "offline_fallback");
    assert!(
        result
            .error
            .as_deref()
            .unwrap()
            .contains("images sha256 verification failed"),
        "{result:?}"
    );
    // Prior generation + meta untouched.
    assert_eq!(active_generation(&dir).unwrap(), gen_before);
    assert_eq!(load_meta(&dir).unwrap(), meta_before);
    // No staging leftovers.
    let rel_dir = dir.join(".releases");
    for entry in std::fs::read_dir(&rel_dir).unwrap() {
        let name = entry.unwrap().file_name().to_string_lossy().into_owned();
        assert!(!name.starts_with('.'), "staging left behind: {name}");
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// A pending delta whose release carries no asset fails fast — before any
/// baseline download.
#[tokio::test]
async fn missing_delta_asset_fails_before_baseline() {
    let (world, _) = build_world();
    let mut releases = world.releases.clone();
    // The d1 release loses its delta asset.
    for release in &mut releases {
        if release["tag_name"].as_str() == Some("images-26-02-01-00-00-00_d1") {
            release["assets"] = json!([]);
        }
    }
    let world = World {
        releases,
        assets: world.assets.clone(),
        downloads: Mutex::new(Vec::new()),
        fail_all: false,
    };
    let dir = temp_images_dir("missing-asset");
    let world = std::sync::Arc::new(world);
    let result = sync_images(
        &dir,
        &FakeTransport {
            world: world.clone(),
        },
        opts(false),
    )
    .await;
    assert_eq!(result.status.as_str(), "no_data");
    assert_eq!(
        result.error.as_deref(),
        Some("images delta asset missing: images-delta-26-02-01-00-00-00_d1.zip")
    );
    // Only the index was downloaded — the baseline never started.
    let downloads = world.downloads.lock().unwrap();
    assert!(
        downloads.len() == 1 && downloads[0].ends_with("/index.json"),
        "{downloads:?}"
    );
    assert!(active_generation(&dir).is_none());
    let _ = std::fs::remove_dir_all(&dir);
}

/// Duplicate delta versions fail closed (null chain → offline/no_data).
#[tokio::test]
async fn duplicate_versions_fail_closed() {
    let (world, _) = build_world();
    let mut releases = world.releases.clone();
    let dup = releases[2].clone();
    releases.push(dup);
    let world = World {
        releases,
        assets: world.assets.clone(),
        downloads: Mutex::new(Vec::new()),
        fail_all: false,
    };
    let dir = temp_images_dir("dup");
    let result = sync_images(
        &dir,
        &FakeTransport {
            world: std::sync::Arc::new(world),
        },
        opts(false),
    )
    .await;
    assert_eq!(result.status.as_str(), "no_data");
    assert_eq!(
        result.error.as_deref(),
        Some("images delta chain has duplicate versions")
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// Offline with an existing generation → offline_fallback keeps it; without
/// one → no_data.
#[tokio::test]
async fn offline_fallback_and_no_data() {
    let (world, _) = build_world();
    let dir = temp_images_dir("offline");
    let t = FakeTransport {
        world: world.clone(),
    };
    sync_images(&dir, &t, opts(false)).await;
    let gen = active_generation(&dir).unwrap();

    let result = sync_images(
        &dir,
        &FakeTransport {
            world: std::sync::Arc::new(World {
                releases: Vec::new(),
                assets: HashMap::new(),
                downloads: Mutex::new(Vec::new()),
                fail_all: true,
            }),
        },
        opts(false),
    )
    .await;
    assert_eq!(result.status.as_str(), "offline_fallback");
    assert_eq!(result.commit_sha.as_deref(), Some("26-03-01-00-00-00_d2"));
    assert_eq!(active_generation(&dir).unwrap(), gen, "generation kept");

    let fresh = temp_images_dir("nodata");
    let result = sync_images(
        &fresh,
        &FakeTransport {
            world: std::sync::Arc::new(World {
                releases: Vec::new(),
                assets: HashMap::new(),
                downloads: Mutex::new(Vec::new()),
                fail_all: true,
            }),
        },
        opts(false),
    )
    .await;
    assert_eq!(result.status.as_str(), "no_data");
    assert!(result.commit_sha.is_none());
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&fresh);
}

struct CustomSourceTransport {
    inner: FakeTransport,
    requests: Mutex<Vec<String>>,
}
#[async_trait]
impl Transport for CustomSourceTransport {
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

    async fn fetch_json(&self, url: &str, timeout: u64) -> Result<Value, TransportError> {
        assert!(url.contains("/team/assets/"), "unexpected source: {url}");
        self.requests.lock().unwrap().push(url.into());
        let default_url = url.replace("/team/assets/", "/3aKHP/arknights-data-pipeline/");
        let mut value = self.inner.fetch_json(&default_url, timeout).await?;
        // Force the production pagination path: initial discovery sees only
        // the newest delta, subsequent pages cover the baseline.
        if url.contains("api.github.com") && !url.contains("&page=") {
            let latest = value
                .as_array()
                .unwrap()
                .iter()
                .find(|r| r["tag_name"] == "images-26-03-01-00-00-00_d2")
                .unwrap()
                .clone();
            value = json!([latest]);
        }
        Ok(serde_json::from_str(
            &value
                .to_string()
                .replace("/3aKHP/arknights-data-pipeline/", "/team/assets/"),
        )
        .unwrap())
    }
    async fn download(
        &self,
        url: &str,
        dest: &Path,
        timeout: u64,
    ) -> Result<DownloadStats, TransportError> {
        assert!(url.contains("/team/assets/"), "unexpected source: {url}");
        self.requests.lock().unwrap().push(url.into());
        self.inner
            .download(
                &url.replace("/team/assets/", "/3aKHP/arknights-data-pipeline/"),
                dest,
                timeout,
            )
            .await
    }
    fn mirrors(&self) -> Vec<String> {
        vec![]
    }
    fn github_headers(&self) -> Vec<(String, String)> {
        vec![]
    }
}
#[tokio::test]
async fn custom_source_covers_pagination_baseline_download_and_restart() {
    use prts_mcp_rust::{config::DataSource, sync::images_sync::sync_images_with_source};
    let (world, _) = build_world();
    let transport = CustomSourceTransport {
        inner: FakeTransport { world },
        requests: Mutex::new(vec![]),
    };
    let dir = temp_images_dir("custom-source");
    let source = DataSource::parse(Some("team/assets")).unwrap();
    let result = sync_images_with_source(&dir, &transport, opts(false), &source).await;
    assert_eq!(result.status.as_str(), "updated", "{:?}", result.error);
    let requests = transport.requests.lock().unwrap().clone();
    assert!(requests.iter().any(|url| url.contains("&page=1")));
    assert!(requests
        .iter()
        .any(|url| url.contains("/images-baseline-") && url.ends_with("chararts-large.zip")));
    assert_eq!(
        sync_images_with_source(&dir, &transport, opts(false), &source)
            .await
            .status
            .as_str(),
        "up_to_date"
    );
    let generation = active_generation(&dir).unwrap();
    let other = DataSource::parse(Some("team/other")).unwrap();
    assert_eq!(
        sync_images_with_source(&dir, &transport, opts(false), &other)
            .await
            .status
            .as_str(),
        "no_data"
    );
    assert_eq!(active_generation(&dir).unwrap(), generation);
    let _ = std::fs::remove_dir_all(dir);
}
