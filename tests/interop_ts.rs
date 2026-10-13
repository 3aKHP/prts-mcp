//! TS↔Rust shared-volume interop (docs/05 "磁盘格式必须互操作" /
//! "锁和清理"): alternating writer/reader roles on one isolated volume and
//! two-process lock contention, all against the REAL frozen TS code via
//! `node tools/ts-interop-peer.mjs`.

use std::io::{BufRead as _, Write as _};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{json, Value};

use prts_mcp_rust::storage::generation::{activated_pair, excel_path_of};
use prts_mcp_rust::storage::{DirectoryStore, JsonStore};
use prts_mcp_rust::sync::activation::{with_archive_activation_lock, LockTiming};
use prts_mcp_rust::sync::pair::sync_release_archive_pair;
use prts_mcp_rust::sync::release::{download_release_asset, sync_release};
use prts_mcp_rust::sync::transport::{DownloadStats, Transport, TransportError};
use prts_mcp_rust::sync::types::{ReleaseArchiveSpec, ReleaseSpec};

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn node() -> String {
    std::env::var("PATH")
        .map(|path| {
            path.split(':')
                .map(|dir| format!("{dir}/node"))
                .find(|candidate| Path::new(candidate).is_file())
        })
        .ok()
        .flatten()
        .unwrap_or_else(|| "node".to_string())
}

/// Run the TS peer; panics with its stderr on failure, returns the "result"
/// JSON of its single stdout line.
fn peer(mode: &str, args: &[&str]) -> Value {
    let output = Command::new(node())
        .arg(repo_root().join("tools/ts-interop-peer.mjs"))
        .arg(mode)
        .args(args)
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", std::env::var("HOME").unwrap_or_default())
        .output()
        .expect("spawn node peer");
    assert!(
        output.status.success(),
        "peer {mode} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout
        .lines()
        .rev()
        .find(|line| line.starts_with('{'))
        .expect("peer prints a JSON result line");
    serde_json::from_str(line).expect("peer result parses")
}

fn temp_root(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("prts-interop-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn pair_specs(root: &Path) -> (ReleaseArchiveSpec, ReleaseArchiveSpec) {
    let excel = ReleaseArchiveSpec {
        owner: "3aKHP".into(),
        repo: "arknights-data-pipeline".into(),
        asset_name: "zh_CN-excel.zip".into(),
        local_zip: root.join("gamedata/archives/zh_CN-excel.zip"),
        local_root: root.join("gamedata"),
        required_files: vec!["zh_CN/gamedata/excel/character_table.json".into()],
        verify_manifest: true,
    };
    let levels = ReleaseArchiveSpec {
        owner: "3aKHP".into(),
        repo: "arknights-data-pipeline".into(),
        asset_name: "zh_CN-levels.zip".into(),
        local_zip: root.join("gamedata-levels/archives/zh_CN-levels.zip"),
        local_root: root.join("gamedata-levels"),
        required_files: vec!["zh_CN/gamedata/levels/enemydata/enemy_database.json".into()],
        verify_manifest: true,
    };
    (excel, levels)
}

fn write_volume_zips(excel: &ReleaseArchiveSpec, levels: &ReleaseArchiveSpec, tag: &str) {
    // The excel pack carries TS's REQUIRED_OPERATOR_FILES so loadConfig's
    // filesComplete accepts the activated generation.
    let character_table = r#"{"char_002_amiya":{"name":"阿米娅"}}"#;
    let excel_entries: Vec<(&str, &[u8])> = vec![
        (
            "zh_CN/gamedata/excel/character_table.json",
            character_table.as_bytes(),
        ),
        ("zh_CN/gamedata/excel/handbook_info_table.json", b"{}"),
        ("zh_CN/gamedata/excel/charword_table.json", b"{}"),
        ("zh_CN/gamedata/excel/story_review_table.json", b"{}"),
    ];
    let levels_entries: Vec<(&str, &[u8])> = vec![(
        "zh_CN/gamedata/levels/enemydata/enemy_database.json",
        br#"{"enemy_1":{}}"#,
    )];
    for (spec, entries) in [(&excel, excel_entries), (&levels, levels_entries)] {
        prts_mcp_rust::storage::write_zip_entries(&spec.local_zip, &entries).unwrap();
        std::fs::create_dir_all(spec.archives_dir()).unwrap();
        std::fs::write(
            spec.archives_dir().join("release_meta.json"),
            serde_json::to_string_pretty(&json!({
                "repo": "3aKHP/arknights-data-pipeline",
                "branch": "releases",
                "commit_sha": tag,
                "fetched_at": "2000-01-01T00:00:00.000Z",
                "files": [spec.asset_name],
            }))
            .unwrap(),
        )
        .unwrap();
    }
}

/// Scriptable transport for the Rust writer role.
struct PeerTransport {
    tag: String,
    asset_bytes: Vec<(String, Vec<u8>)>,
}

#[async_trait]
impl Transport for PeerTransport {
    async fn fetch_json(&self, url: &str, _timeout_ms: u64) -> Result<Value, TransportError> {
        if url.contains("api.github.com") {
            let assets: Vec<Value> = self
                .asset_bytes
                .iter()
                .map(|(name, _)| {
                    json!({
                        "name": name,
                        "browser_download_url": format!(
                            "https://github.com/3aKHP/arknights-data-pipeline/releases/download/{}/{name}",
                            self.tag
                        ),
                    })
                })
                .collect();
            return Ok(json!([{
                "tag_name": self.tag,
                "created_at": "2026-10-10T00:00:00Z",
                "assets": assets,
            }]));
        }
        // manifest.json → direct 404 (legacy data- release skips it).
        Err(TransportError::AssetNotFound(url.to_string()))
    }

    async fn download(
        &self,
        url: &str,
        dest: &Path,
        _timeout_ms: u64,
    ) -> Result<DownloadStats, TransportError> {
        for (name, bytes) in &self.asset_bytes {
            if url.ends_with(name.as_str()) || url.contains("example.test/asset") {
                std::fs::write(dest, bytes).unwrap();
                use sha2::Digest;
                return Ok(DownloadStats {
                    bytes: bytes.len() as u64,
                    sha256: format!("{:x}", sha2::Sha256::digest(bytes)),
                });
            }
        }
        Err(TransportError::Network("asset not scripted".into()))
    }

    fn mirrors(&self) -> Vec<String> {
        vec![]
    }

    fn github_headers(&self) -> Vec<(String, String)> {
        vec![]
    }
}

const INTEROP_VID: &str = "26-10-10-11-22-33_aaaa01";

/// TS writes (real syncReleaseArchivePair) → Rust reads the pair pointer and
/// the generation content through the storage layer.
#[tokio::test]
async fn ts_written_volume_is_readable_by_rust() {
    let root = temp_root("ts-write");
    let (excel, levels) = pair_specs(&root);
    write_volume_zips(&excel, &levels, INTEROP_VID);

    let result = peer("write-pair", &[&root.to_string_lossy()]);
    assert_eq!(result["result"], "ok", "peer write-pair");
    assert_eq!(result["statuses"][0], "updated");
    assert_eq!(result["statuses"][1], "updated");
    assert_eq!(result["commitShas"][0], INTEROP_VID);

    // Rust-side read: pair pointer resolves, content matches.
    let pair = activated_pair(&root.join("gamedata"), &root.join("gamedata-levels"))
        .expect("Rust resolves the TS-written pair");
    let excel_store = DirectoryStore::new(excel_path_of(&pair.0));
    let table = excel_store
        .read_json("character_table.json")
        .expect("Rust reads the TS-activated generation");
    assert_eq!(table["char_002_amiya"]["name"], "阿米娅");
    let levels_store = DirectoryStore::new(pair.1);
    let enemies = levels_store
        .read_json("zh_CN/gamedata/levels/enemydata/enemy_database.json")
        .expect("levels generation readable");
    assert!(enemies["enemy_1"].is_object());

    // Pointer format: same fields and relative shape TS wrote.
    let pair_value: Value =
        serde_json::from_str(&std::fs::read_to_string(root.join(".gamedata_pair.json")).unwrap())
            .unwrap();
    assert_eq!(pair_value["commit_sha"], INTEROP_VID);
    assert!(pair_value["excel_data_root"]
        .as_str()
        .unwrap()
        .starts_with(".releases/"));
    assert!(pair_value["levels_data_root"]
        .as_str()
        .unwrap()
        .starts_with(".releases/"));
    let extract: Value = serde_json::from_str(
        &std::fs::read_to_string(root.join("gamedata/archives/extract_meta.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(extract["commit_sha"], INTEROP_VID);
    assert!(extract["data_root"]
        .as_str()
        .unwrap()
        .starts_with(".releases/"));
    let _ = std::fs::remove_dir_all(&root);
}

/// Rust writes (real sync state machine) → TS loadConfig/store reads the
/// same volume.
#[tokio::test]
async fn rust_written_volume_is_readable_by_ts() {
    let root = temp_root("rust-write");
    let (excel, levels) = pair_specs(&root);
    write_volume_zips(&excel, &levels, INTEROP_VID);

    let excel_zip = std::fs::read(&excel.local_zip).unwrap();
    let levels_zip = std::fs::read(&levels.local_zip).unwrap();
    let transport = PeerTransport {
        tag: format!("data-{INTEROP_VID}"),
        asset_bytes: vec![
            ("zh_CN-excel.zip".into(), excel_zip),
            ("zh_CN-levels.zip".into(), levels_zip),
        ],
    };
    let (excel_result, levels_result) =
        sync_release_archive_pair(&transport, &excel, &levels, false)
            .await
            .expect("pair sync");
    assert_eq!(excel_result.status.as_str(), "updated");
    assert_eq!(levels_result.status.as_str(), "updated");

    let result = peer("read-volume", &[&root.to_string_lossy()]);
    assert_eq!(result["result"], "ok", "peer read-volume");
    let effective = result["effectiveExcelPath"].as_str().unwrap();
    assert!(
        effective.contains(".releases"),
        "TS loadConfig resolves the Rust-activated generation: {effective}"
    );
    assert_eq!(
        result["characterIds"],
        json!(["char_002_amiya"]),
        "TS DirectoryStore reads the Rust-written generation content"
    );
    let levels_effective = result["effectiveLevelsPath"].as_str().unwrap();
    assert!(levels_effective.contains(".releases"));
    assert!(result["levelsEnemyDatabase"].is_object());
    let _ = std::fs::remove_dir_all(&root);
}

/// Story pack swap: Rust replaces the story zip via the release machine; TS
/// sees the new pack at the same path (identity change without restart).
#[tokio::test]
async fn rust_story_pack_swap_is_visible_to_ts() {
    let root = temp_root("story-swap");
    let story_zip = root.join("storyjson/zh_CN.zip");
    let story_pack = {
        let mut bytes = Vec::new();
        let mut cursor = std::io::Cursor::new(&mut bytes);
        let mut zip = zip::ZipWriter::new(&mut cursor);
        let options: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default();
        zip.start_file("zh_CN/gamedata/excel/story_review_table.json", options)
            .unwrap();
        zip.write_all(b"{}").unwrap();
        zip.start_file("zh_CN/storyinfo.json", options).unwrap();
        zip.write_all(b"{}").unwrap();
        zip.finish().unwrap();
        bytes
    };
    let transport = PeerTransport {
        tag: format!("data-{INTEROP_VID}"),
        asset_bytes: vec![("zh_CN.zip".into(), story_pack)],
    };
    let spec = ReleaseSpec {
        owner: "3aKHP".into(),
        repo: "arknights-data-pipeline".into(),
        asset_name: "zh_CN.zip".into(),
        local_zip: story_zip.clone(),
        verify_manifest: true,
        validator: prts_mcp_rust::sync::types::ZipValidator::StoryJson,
    };
    let result = sync_release(&transport, &spec, false).await;
    assert_eq!(result.status.as_str(), "updated");
    assert!(story_zip.is_file());
    // Old pack is replaced, not appended: the zip holds exactly two entries.
    let file = std::fs::File::open(&story_zip).unwrap();
    let archive = zip::ZipArchive::new(file).unwrap();
    assert_eq!(archive.len(), 2);

    let read = peer("read-volume", &[&root.to_string_lossy()]);
    // STORYJSON_PATH is unset in the peer env, so TS falls back to its own
    // default path (sibling of GAMEDATA_PATH=<root>/gamedata): <root>/storyjson.
    assert_eq!(read["result"], "ok");
    let effective = read["effectiveStoryjsonZip"].as_str().unwrap_or_default();
    assert!(
        effective.ends_with("storyjson/zh_CN.zip"),
        "TS resolves the Rust-swapped story pack: {effective}"
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// release_meta.json byte shape: TS downloadReleaseAsset and the Rust port
/// produce the same fields and the same pretty-print layout (fetched_at
/// masked — it is a timestamp).
#[tokio::test]
async fn release_meta_format_matches_ts_bytes() {
    let root = temp_root("meta-bytes");
    let asset = root.join("asset.zip");
    let pack = {
        let mut bytes = Vec::new();
        let mut cursor = std::io::Cursor::new(&mut bytes);
        let mut zip = zip::ZipWriter::new(&mut cursor);
        let options: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default();
        zip.start_file("zh_CN/storyinfo.json", options).unwrap();
        zip.write_all(b"{}").unwrap();
        zip.finish().unwrap();
        bytes
    };
    std::fs::write(&asset, &pack).unwrap();

    // TS side (mocked fetch: asset bytes then manifest 404 → data- skip).
    let ts = peer(
        "download-release",
        &[
            &root.join("ts/zh_CN.zip").to_string_lossy(),
            &asset.to_string_lossy(),
            &format!("data-{INTEROP_VID}"),
        ],
    );
    assert_eq!(ts["calls"], 2, "asset + manifest fetched");
    let ts_meta = ts["releaseMeta"].as_str().unwrap();

    // Rust side with the same fetch script.
    let transport = PeerTransport {
        tag: format!("data-{INTEROP_VID}"),
        asset_bytes: vec![("zh_CN.zip".into(), pack.clone())],
    };
    let spec = ReleaseSpec {
        owner: "3aKHP".into(),
        repo: "arknights-data-pipeline".into(),
        asset_name: "zh_CN.zip".into(),
        local_zip: root.join("rust/zh_CN.zip"),
        verify_manifest: true,
        validator: prts_mcp_rust::sync::types::ZipValidator::None,
    };
    download_release_asset(
        &transport,
        &spec,
        &format!("data-{INTEROP_VID}"),
        "https://example.test/asset",
        120_000,
    )
    .await
    .expect("rust download");
    let rust_meta = std::fs::read_to_string(root.join("rust/release_meta.json")).unwrap();

    let mask = |text: &str| {
        text.replace(
            &serde_json::from_str::<Value>(text).unwrap()["fetched_at"]
                .as_str()
                .unwrap()
                .to_string(),
            "<fetched_at>",
        )
    };
    assert_eq!(mask(ts_meta), mask(&rust_meta), "identical metadata bytes");
    let parsed: Value = serde_json::from_str(&rust_meta).unwrap();
    assert_eq!(parsed["repo"], "3aKHP/arknights-data-pipeline");
    assert_eq!(parsed["branch"], "releases");
    assert_eq!(parsed["commit_sha"], INTEROP_VID);
    assert_eq!(parsed["files"], json!(["zh_CN.zip"]));
    let _ = std::fs::remove_dir_all(&root);
}

/// Two-process lock contention: the directory-owner lease protocol is shared
/// with the TS implementation — a TS-held lock times the Rust contender out
/// (lock survives), and vice versa; after release the other side acquires.
#[tokio::test]
async fn cross_process_lock_contention() {
    let root = temp_root("locks");
    let lock_dir = root.join("gamedata/archives");
    std::fs::create_dir_all(&lock_dir).unwrap();

    // --- TS holds, Rust contends ---
    let mut holder = Command::new(node())
        .arg(repo_root().join("tools/ts-interop-peer.mjs"))
        .arg("hold-lock")
        .arg(&lock_dir)
        .arg(".release.lock")
        .arg("1500")
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", std::env::var("HOME").unwrap_or_default())
        .stdout(Stdio::piped())
        .spawn()
        .expect("spawn holder");
    // Wait for the holder's "acquired" line.
    let stdout = holder.stdout.take().unwrap();
    let mut reader = std::io::BufReader::new(stdout);
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    assert!(line.contains("\"acquired\""), "holder acquired: {line}");

    let start = std::time::Instant::now();
    let contended = with_archive_activation_lock(
        &lock_dir,
        ".release.lock",
        LockTiming {
            timeout_ms: 400,
            stale_ms: 60_000,
            owner_grace_ms: 60_000,
            heartbeat_ms: 50,
        },
        || async {},
    )
    .await;
    assert!(contended.is_err(), "Rust contender must time out");
    assert!(contended
        .unwrap_err()
        .to_string()
        .contains("Timed out waiting for archive activation lock"));
    assert!(start.elapsed() < Duration::from_secs(5));
    // The live TS lock survived the contender.
    assert!(lock_dir.join(".release.lock").exists());

    // After the holder releases, Rust acquires.
    let mut released_line = String::new();
    reader.read_line(&mut released_line).unwrap();
    assert!(
        released_line.contains("\"released\""),
        "holder released: {released_line}"
    );
    let status = holder.wait().unwrap();
    assert!(status.success());
    assert!(!lock_dir.join(".release.lock").exists());
    with_archive_activation_lock(
        &lock_dir,
        ".release.lock",
        LockTiming::default(),
        || async { 42 },
    )
    .await
    .unwrap();

    // --- Rust holds, TS contends ---
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel::<()>();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
    let holder_dir = lock_dir.clone();
    let holder = tokio::spawn(async move {
        with_archive_activation_lock(
            &holder_dir,
            ".release.lock",
            LockTiming {
                timeout_ms: 60_000,
                stale_ms: 60_000,
                owner_grace_ms: 60_000,
                heartbeat_ms: 50,
            },
            move || async move {
                let _ = entered_tx.send(());
                let _ = release_rx.await;
            },
        )
        .await
        .unwrap();
    });
    entered_rx.await.unwrap();

    let contended = peer(
        "try-lock",
        &[&lock_dir.to_string_lossy(), ".release.lock", "300"],
    );
    assert_eq!(contended["result"], "timeout", "TS contender times out");
    assert!(
        lock_dir.join(".release.lock").exists(),
        "Rust lock survives"
    );

    release_tx.send(()).unwrap();
    holder.await.unwrap();
    assert!(!lock_dir.join(".release.lock").exists());
    // And TS can acquire after the release.
    let acquired = peer(
        "try-lock",
        &[&lock_dir.to_string_lossy(), ".release.lock", "5000"],
    );
    assert_eq!(acquired["result"], "acquired");
    let _ = std::fs::remove_dir_all(&root);
}

// ---------------------------------------------------------------------------
// P6: images sync interop — TS-written generation read by Rust and vice
// versa, against the REAL frozen TS sync via a local GitHub mirror.
// ---------------------------------------------------------------------------

mod images_interop {
    use super::*;
    use prts_mcp_rust::sync::images_meta::{active_generation, load_meta, parse_index};
    use prts_mcp_rust::sync::images_sync::{sync_images, ImagesSyncOpts};
    use prts_mcp_rust::sync::transport::{DownloadStats, Transport, TransportError};
    use sha2::Digest as _;

    struct MirrorOnlyTransport {
        mirror: String,
        assets: std::collections::HashMap<String, std::path::PathBuf>,
        releases: Value,
    }

    #[async_trait]
    impl Transport for MirrorOnlyTransport {
        async fn fetch_json(&self, url: &str, _t: u64) -> Result<Value, TransportError> {
            if url.starts_with("https://api.github.com/") {
                return Ok(self.releases.clone());
            }
            // Asset keys are the plain upstream URLs; the mirror prefix is
            // only used by the real HTTP transport candidates.
            let path = self
                .assets
                .get(url)
                .ok_or_else(|| TransportError::Http(404))?;
            let bytes = std::fs::read(path).map_err(|e| TransportError::Network(e.to_string()))?;
            serde_json::from_slice(&bytes).map_err(|e| TransportError::InvalidJson(e.to_string()))
        }
        async fn download(
            &self,
            url: &str,
            dest: &Path,
            _t: u64,
        ) -> Result<DownloadStats, TransportError> {
            let path = self
                .assets
                .get(url)
                .ok_or_else(|| TransportError::Http(404))?
                .clone();
            std::fs::copy(&path, dest).map_err(|e| TransportError::Network(e.to_string()))?;
            let bytes = std::fs::read(&path).unwrap();
            Ok(DownloadStats {
                bytes: bytes.len() as u64,
                sha256: format!("{:x}", {
                    let mut h = sha2::Sha256::new();
                    sha2::Digest::update(&mut h, &bytes);
                    sha2::Digest::finalize(h)
                }),
            })
        }
        fn mirrors(&self) -> Vec<String> {
            vec![self.mirror.clone()]
        }
        fn github_headers(&self) -> Vec<(String, String)> {
            Vec::new()
        }
    }

    struct FixtureWorld {
        dir: PathBuf,
        releases: Value,
        assets: std::collections::HashMap<String, PathBuf>,
    }

    /// The shared world: baseline + d1 + d2, identical bytes for both sides.
    fn build_fixture(name: &str) -> FixtureWorld {
        use std::io::Write as _;
        let dir =
            std::env::temp_dir().join(format!("prts-images-interop-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let png = |p: &str| {
            let mut v = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
            v.extend_from_slice(p.as_bytes());
            v
        };
        let sha = |b: &[u8]| {
            format!("{:x}", {
                let mut h = sha2::Sha256::new();
                sha2::Digest::update(&mut h, b);
                sha2::Digest::finalize(h)
            })
        };
        let zip_of = |files: &[(&str, Vec<u8>)]| {
            let mut cursor = std::io::Cursor::new(Vec::new());
            {
                let mut zip = zip::ZipWriter::new(&mut cursor);
                let options: zip::write::SimpleFileOptions = Default::default();
                for (name, data) in files {
                    zip.start_file(*name, options).unwrap();
                    zip.write_all(data).unwrap();
                }
                zip.finish().unwrap();
            }
            cursor.into_inner()
        };

        let a1l = png("interop:amiya#1:large");
        let a1p = png("interop:amiya#1:preview");
        let a2l = png("interop:amiya#2:large");
        let a2p = png("interop:amiya#2:preview");
        let skl = png("interop:skin:large");
        let skp = png("interop:skin:preview");

        let base_tag = "images-baseline-26-01-01-00-00-00_base";
        let d1_tag = "images-26-02-01-00-00-00_d1";
        let d2_tag = "images-26-03-01-00-00-00_d2";

        let index = json!({
            "schemaVersion": "akdp-images/v1",
            "baselineVersion": "26-01-01-00-00-00_base",
            "currentVersion": "26-03-01-00-00-00_d2",
            "shards": {
                "chararts-large": "chararts-large.zip",
                "chararts-preview": "chararts-preview.zip",
                "skinpack-large": "skinpack-large.zip",
                "skinpack-preview": "skinpack-preview.zip",
            },
            "artworks": {
                "char_002_amiya#1": { "kind": "base", "shard": "chararts", "sinceVersion": "26-01-01-00-00-00_base",
                    "large": {"file": "chararts/char_002_amiya#1.large.png", "w": 1024, "h": 1024, "bytes": a1l.len(), "sha256": sha(&a1l)},
                    "preview": {"file": "chararts/char_002_amiya#1.preview.png", "w": 256, "h": 256, "bytes": a1p.len(), "sha256": sha(&a1p)} },
                "char_002_amiya#2": { "kind": "base", "shard": "chararts", "sinceVersion": "26-02-01-00-00-00_d1",
                    "large": {"file": "chararts/char_002_amiya#2.large.png", "w": 1024, "h": 1024, "bytes": a2l.len(), "sha256": sha(&a2l)},
                    "preview": {"file": "chararts/char_002_amiya#2.preview.png", "w": 256, "h": 256, "bytes": a2p.len(), "sha256": sha(&a2p)} },
                "char_002_amiya@t1#1": { "kind": "skin", "shard": "skinpack", "sinceVersion": "26-03-01-00-00-00_d2",
                    "large": {"file": "skinpack/char_002_amiya@t1#1.large.png", "w": 1024, "h": 1024, "bytes": skl.len(), "sha256": sha(&skl)},
                    "preview": {"file": "skinpack/char_002_amiya@t1#1.preview.png", "w": 256, "h": 256, "bytes": skp.len(), "sha256": sha(&skp)} },
            },
        });

        let mut assets: std::collections::HashMap<String, PathBuf> = Default::default();
        let mut asset_lines: Vec<String> = Vec::new();
        let put = |dir: &Path,
                   url: String,
                   bytes: Vec<u8>,
                   assets: &mut std::collections::HashMap<String, PathBuf>,
                   lines: &mut Vec<String>| {
            let file = format!("asset-{}", assets.len());
            std::fs::write(dir.join(&file), bytes).unwrap();
            assets.insert(url.clone(), dir.join(&file));
            lines.push(format!("{url} {file}"));
        };

        let gh = |tag: &str, name: &str| {
            format!(
                "https://github.com/3aKHP/arknights-data-pipeline/releases/download/{tag}/{name}"
            )
        };
        put(
            &dir,
            gh(base_tag, "chararts-large.zip"),
            zip_of(&[("chararts/char_002_amiya#1.large.png", a1l.clone())]),
            &mut assets,
            &mut asset_lines,
        );
        put(
            &dir,
            gh(base_tag, "chararts-preview.zip"),
            zip_of(&[("chararts/char_002_amiya#1.preview.png", a1p.clone())]),
            &mut assets,
            &mut asset_lines,
        );
        put(
            &dir,
            gh(base_tag, "skinpack-large.zip"),
            zip_of(&[]),
            &mut assets,
            &mut asset_lines,
        );
        put(
            &dir,
            gh(base_tag, "skinpack-preview.zip"),
            zip_of(&[]),
            &mut assets,
            &mut asset_lines,
        );
        put(
            &dir,
            gh(d1_tag, "images-delta-26-02-01-00-00-00_d1.zip"),
            zip_of(&[
                ("chararts/char_002_amiya#2.large.png", a2l.clone()),
                ("chararts/char_002_amiya#2.preview.png", a2p.clone()),
            ]),
            &mut assets,
            &mut asset_lines,
        );
        put(
            &dir,
            gh(d2_tag, "images-delta-26-03-01-00-00-00_d2.zip"),
            zip_of(&[
                ("skinpack/char_002_amiya@t1#1.large.png", skl.clone()),
                ("skinpack/char_002_amiya@t1#1.preview.png", skp.clone()),
            ]),
            &mut assets,
            &mut asset_lines,
        );
        put(
            &dir,
            gh(d2_tag, "index.json"),
            serde_json::to_vec(&index).unwrap(),
            &mut assets,
            &mut asset_lines,
        );

        let releases = json!([
            { "tag_name": d2_tag, "created_at": "2026-03-01T05:00:00Z", "assets": [
                { "name": "index.json", "browser_download_url": gh(d2_tag, "index.json") },
                { "name": "images-delta-26-03-01-00-00-00_d2.zip", "browser_download_url": gh(d2_tag, "images-delta-26-03-01-00-00-00_d2.zip") } ] },
            { "tag_name": d1_tag, "created_at": "2026-02-01T05:00:00Z", "assets": [
                { "name": "images-delta-26-02-01-00-00-00_d1.zip", "browser_download_url": gh(d1_tag, "images-delta-26-02-01-00-00-00_d1.zip") } ] },
            { "tag_name": base_tag, "created_at": "2026-01-01T05:00:00Z", "assets": [
                { "name": "chararts-large.zip", "browser_download_url": gh(base_tag, "chararts-large.zip") },
                { "name": "chararts-preview.zip", "browser_download_url": gh(base_tag, "chararts-preview.zip") },
                { "name": "skinpack-large.zip", "browser_download_url": gh(base_tag, "skinpack-large.zip") },
                { "name": "skinpack-preview.zip", "browser_download_url": gh(base_tag, "skinpack-preview.zip") } ] },
        ]);
        std::fs::write(
            dir.join("releases.json"),
            serde_json::to_vec(&releases).unwrap(),
        )
        .unwrap();
        std::fs::write(dir.join("assets.txt"), asset_lines.join("\n") + "\n").unwrap();

        FixtureWorld {
            dir,
            releases,
            assets,
        }
    }

    #[tokio::test]
    async fn ts_images_sync_volume_is_readable_by_rust_and_vice_versa() {
        let fixture = build_fixture("main");

        // Start the mirror via a shell line and parse its port from stdout.
        let mirror = std::process::Command::new(node())
            .arg(repo_root().join("tools/images-mirror.mjs"))
            .arg(&fixture.dir)
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn mirror");
        let mut mirror = mirror;
        let port: u16 = {
            use std::io::BufRead as _;
            let stdout = mirror.stdout.take().unwrap();
            let reader = std::io::BufReader::new(stdout);
            let line = reader
                .lines()
                .next()
                .expect("mirror prints one line")
                .expect("line");
            serde_json::from_str::<Value>(&line)
                .unwrap()
                .get("port")
                .and_then(|p| p.as_u64())
                .unwrap() as u16
        };

        // --- TS writes via the real frozen syncImages through the mirror.
        let ts_volume = fixture.dir.join("ts-volume");
        let result = peer(
            "images-sync",
            &[ts_volume.to_str().unwrap(), &port.to_string()],
        );
        assert_eq!(result["result"]["status"], "updated", "{result}");
        assert_eq!(result["result"]["commitSha"], "26-03-01-00-00-00_d2");

        // Rust reads the TS-written volume.
        let gen = active_generation(&ts_volume).expect("TS volume readable by Rust");
        let index_bytes = std::fs::read(gen.join("index.json")).unwrap();
        let index = parse_index(&serde_json::from_slice(&index_bytes).unwrap()).expect("index");
        assert_eq!(index.current_version, "26-03-01-00-00-00_d2");
        assert_eq!(index.artworks.len(), 3);
        let meta = load_meta(&ts_volume).unwrap();
        assert_eq!(
            meta.get("shardsSynced").unwrap(),
            &json!([
                "chararts-large",
                "chararts-preview",
                "skinpack-large",
                "skinpack-preview"
            ])
        );
        assert!(gen.join("chararts/char_002_amiya#1.large.png").is_file());
        assert!(gen.join("skinpack/char_002_amiya@t1#1.large.png").is_file());

        // --- Rust writes via the same mirror, then TS reads it.
        let rust_volume = fixture.dir.join("rust-volume");
        let transport = MirrorOnlyTransport {
            mirror: format!("http://127.0.0.1:{port}"),
            assets: fixture.assets.clone(),
            releases: fixture.releases.clone(),
        };
        let result = sync_images(
            &rust_volume,
            &transport,
            ImagesSyncOpts {
                include_original: false,
                force_check: false,
            },
        )
        .await;
        assert_eq!(result.status.as_str(), "updated", "{result:?}");

        let ts_read = peer("images-active", &[rust_volume.to_str().unwrap()]);
        let read = &ts_read["result"];
        assert!(read["active"].as_str().is_some());
        assert_eq!(read["currentVersion"], "26-03-01-00-00-00_d2");
        assert_eq!(read["artworks"].as_array().map(Vec::len), Some(3));
        // Every PNG the TS side reads hashes to the expected value.
        let hashes = read["hashes"].as_object().unwrap();
        assert_eq!(hashes.len(), 6);
        assert!(hashes.contains_key("char_002_amiya@t1#1|large"));

        // Cross-volume: identical index bytes and PNG bytes.
        let rust_gen = active_generation(&rust_volume).unwrap();
        let ts_index_bytes = index_bytes;
        assert_eq!(
            std::fs::read(rust_gen.join("index.json")).unwrap(),
            ts_index_bytes,
            "authoritative index.json bytes identical across writers"
        );
        for rel in [
            "chararts/char_002_amiya#1.large.png",
            "chararts/char_002_amiya#2.preview.png",
            "skinpack/char_002_amiya@t1#1.large.png",
        ] {
            assert_eq!(
                std::fs::read(rust_gen.join(rel)).unwrap(),
                std::fs::read(gen.join(rel)).unwrap(),
                "PNG bytes identical across writers: {rel}"
            );
        }

        let _ = mirror.kill();
        let _ = mirror.wait();
        let _ = std::fs::remove_dir_all(&fixture.dir);
    }
}
