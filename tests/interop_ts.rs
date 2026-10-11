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
