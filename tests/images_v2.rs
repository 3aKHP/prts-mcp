use async_trait::async_trait;
use prts_mcp_rust::sync::{
    images_meta::active_generation,
    images_sync::{sync_images, ImagesSyncOpts},
    transport::{DownloadStats, Transport, TransportError},
    types::SyncStatus,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};
fn hash(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
}
fn zip(name: &str, data: &[u8]) -> Vec<u8> {
    let mut output = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    output
        .start_file(name, zip::write::SimpleFileOptions::default())
        .unwrap();
    output.write_all(data).unwrap();
    output.finish().unwrap().into_inner()
}
struct World {
    releases: Vec<Value>,
    files: HashMap<String, Vec<u8>>,
    downloads: Mutex<Vec<String>>,
}
impl World {
    fn new() -> Self {
        Self {
            releases: vec![],
            files: HashMap::new(),
            downloads: Mutex::new(vec![]),
        }
    }
    fn add(&mut self, version: &str, previous: Option<&Value>, data: &[u8]) -> Value {
        let archive = zip("a.png", data);
        let file = format!("{version}.zip");
        let part = json!({"file":file,"bytes":archive.len(),"sha256":hash(&archive),"group":"chararts-large","members":{"a.png":{"bytes":data.len(),"sha256":hash(data),"group":"chararts-large"}}});
        let index = json!({"schemaVersion":"akdp-images/v2", "currentVersion":version,
            "baselineVersion": previous.map(|p| p["baselineVersion"].clone()).unwrap_or(json!(version)),
            "previousVersion":previous.map(|p| p["currentVersion"].clone()),
            "baselineParts":previous.map(|p|p["baselineParts"].clone()).unwrap_or(json!([part.clone()])),
            "deltaParts":if previous.is_some() {json!([part])} else {json!([])},
            "artworks":{"a":{"kind":"base","shard":"chararts","large":{"file":"a.png","w":1,"h":1,"bytes":data.len(),"sha256":hash(data)}}}});
        let tag = format!("images2-{version}");
        self.releases
            .push(json!({"tag_name":tag,"assets":[{"name":"index.json"}]}));
        self.files.insert(
            format!("{tag}/index.json"),
            serde_json::to_vec(&index).unwrap(),
        );
        let archive_tag = if previous.is_some() {
            tag
        } else {
            format!("images2-baseline-{version}")
        };
        self.files.insert(format!("{archive_tag}/{file}"), archive);
        index
    }
}
#[async_trait]
impl Transport for World {
    async fn fetch_json(&self, _: &str, _: u64) -> Result<Value, TransportError> {
        Ok(json!(self.releases))
    }
    async fn download(
        &self,
        url: &str,
        dest: &Path,
        _: u64,
    ) -> Result<DownloadStats, TransportError> {
        let key = url.split("/download/").nth(1).unwrap();
        self.downloads.lock().unwrap().push(key.into());
        let bytes = self
            .files
            .get(key)
            .ok_or_else(|| TransportError::Network("missing fixture".into()))?;
        std::fs::write(dest, bytes).unwrap();
        Ok(DownloadStats {
            bytes: bytes.len() as u64,
            sha256: hash(bytes),
        })
    }
    fn mirrors(&self) -> Vec<String> {
        vec![]
    }
    fn github_headers(&self) -> Vec<(String, String)> {
        vec![]
    }
}
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!("images-v2-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        Self(p)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn opts() -> ImagesSyncOpts {
    ImagesSyncOpts {
        include_original: false,
        force_check: true,
    }
}

#[tokio::test]
async fn changed_existing_image_uses_only_new_delta() {
    let root = Temp::new();
    let mut w = World::new();
    let p = w.add("26-01-01", None, b"first");
    assert_eq!(
        sync_images(&root.0, &w, opts()).await.status,
        SyncStatus::Updated
    );
    w.downloads.lock().unwrap().clear();
    w.add("26-01-02", Some(&p), b"changed");
    let result = sync_images(&root.0, &w, opts()).await;
    assert_eq!(result.status, SyncStatus::Updated, "{:?}", result.error);
    let got = w.downloads.lock().unwrap().clone();
    assert_eq!(
        got,
        vec![
            "images2-26-01-02/index.json",
            "images2-26-01-02/26-01-02.zip"
        ]
    );
    assert_eq!(
        std::fs::read(active_generation(&root.0).unwrap().join("a.png")).unwrap(),
        b"changed"
    );
    assert_eq!(
        sync_images(&root.0, &w, opts()).await.status,
        SyncStatus::UpToDate
    );
}

#[tokio::test]
async fn new_baseline_reuses_matching_file_without_fetching_part() {
    let root = Temp::new();
    let mut w = World::new();
    w.add("26-01-01", None, b"same");
    sync_images(&root.0, &w, opts()).await;
    w.downloads.lock().unwrap().clear();
    w.add("26-04-01", None, b"same");
    assert_eq!(
        sync_images(&root.0, &w, opts()).await.status,
        SyncStatus::Updated
    );
    assert_eq!(
        *w.downloads.lock().unwrap(),
        vec!["images2-26-04-01/index.json"]
    );
}

#[tokio::test]
async fn corrupt_part_preserves_previous_generation_and_v2_never_downgrades_to_v1() {
    let root = Temp::new();
    let mut w = World::new();
    let p = w.add("26-01-01", None, b"old");
    sync_images(&root.0, &w, opts()).await;
    let before = active_generation(&root.0).unwrap();
    w.add("26-01-02", Some(&p), b"new");
    w.files
        .insert("images2-26-01-02/26-01-02.zip".into(), b"bad".to_vec());
    assert_eq!(
        sync_images(&root.0, &w, opts()).await.status,
        SyncStatus::OfflineFallback
    );
    assert_eq!(active_generation(&root.0).unwrap(), before);
    w.releases = vec![json!({"tag_name":"images-26-07-01","assets":[]})];
    assert_eq!(
        sync_images(&root.0, &w, opts()).await.status,
        SyncStatus::OfflineFallback
    );
    assert_eq!(active_generation(&root.0).unwrap(), before);
}

#[tokio::test]
async fn deletion_and_empty_delta_are_consistent() {
    let root = Temp::new();
    let mut world = World::new();
    let baseline = world.add("26-01-01", None, b"keep");
    sync_images(&root.0, &world, opts()).await;
    let mut empty = world.add("26-01-02", Some(&baseline), b"unused");
    empty["artworks"] = json!({});
    empty["deltaParts"] = json!([]);
    world.files.insert(
        "images2-26-01-02/index.json".into(),
        serde_json::to_vec(&empty).unwrap(),
    );
    world.downloads.lock().unwrap().clear();
    assert_eq!(
        sync_images(&root.0, &world, opts()).await.status,
        SyncStatus::Updated
    );
    assert!(!active_generation(&root.0).unwrap().join("a.png").exists());
    assert_eq!(
        *world.downloads.lock().unwrap(),
        vec!["images2-26-01-02/index.json"]
    );
}

#[test]
fn typed_parser_rejects_bad_parts_paths_and_variants() {
    let mut world = World::new();
    let valid = world.add("26-01-01", None, b"png");
    assert!(prts_mcp_rust::sync::images_v2::parse(&valid).is_ok());
    for (pointer, bad) in [
        ("/baselineParts/0/file", json!("../escape.zip")),
        ("/baselineParts/0/bytes", json!(2147483648u64)),
        ("/baselineParts/0/sha256", json!("bad")),
        ("/baselineParts/0/members/a.png/group", json!("wrong")),
        ("/artworks/a/large/bytes", json!(-1)),
        ("/artworks/a/large/w", json!(0)),
        ("/previousVersion", json!("26-01-01")),
    ] {
        let mut invalid = valid.clone();
        *invalid.pointer_mut(pointer).unwrap() = bad;
        assert!(
            prts_mcp_rust::sync::images_v2::parse(&invalid).is_err(),
            "{pointer}"
        );
    }
    let mut invalid = valid.clone();
    invalid["artworks"]["a"]["original"] = json!({"file": "bad"});
    assert!(prts_mcp_rust::sync::images_v2::parse(&invalid).is_err());
}

#[tokio::test]
async fn original_toggle_fetches_only_missing_group_and_removes_disabled_files() {
    let root = Temp::new();
    let mut world = World::new();
    let mut index = world.add("26-01-01", None, b"large");
    let bytes = b"original";
    let archive = zip("o.png", bytes);
    index["artworks"]["a"]["original"] =
        json!({"file":"o.png","w":2,"h":2,"bytes":bytes.len(),"sha256":hash(bytes)});
    index["baselineParts"].as_array_mut().unwrap().push(json!({"file":"original.zip","bytes":archive.len(),"sha256":hash(&archive),"group":"chararts-original","members":{"o.png":{"bytes":bytes.len(),"sha256":hash(bytes),"group":"chararts-original"}}}));
    world.files.insert(
        "images2-26-01-01/index.json".into(),
        serde_json::to_vec(&index).unwrap(),
    );
    world
        .files
        .insert("images2-baseline-26-01-01/original.zip".into(), archive);
    sync_images(&root.0, &world, opts()).await;
    assert!(!active_generation(&root.0).unwrap().join("o.png").exists());
    assert!(!world
        .downloads
        .lock()
        .unwrap()
        .iter()
        .any(|name| name.ends_with("original.zip")));
    world.downloads.lock().unwrap().clear();
    let result = sync_images(
        &root.0,
        &world,
        ImagesSyncOpts {
            include_original: true,
            force_check: true,
        },
    )
    .await;
    assert_eq!(result.status, SyncStatus::Updated, "{:?}", result.error);
    assert_eq!(
        *world.downloads.lock().unwrap(),
        vec![
            "images2-26-01-01/index.json",
            "images2-baseline-26-01-01/original.zip"
        ]
    );
    assert!(active_generation(&root.0).unwrap().join("o.png").is_file());
    world.downloads.lock().unwrap().clear();
    assert_eq!(
        sync_images(&root.0, &world, opts()).await.status,
        SyncStatus::Updated
    );
    assert!(!active_generation(&root.0).unwrap().join("o.png").exists());
    assert_eq!(
        *world.downloads.lock().unwrap(),
        vec!["images2-26-01-01/index.json"]
    );
}

#[tokio::test]
async fn verified_part_cache_is_reused_after_failed_activation() {
    let root = Temp::new();
    std::fs::create_dir(root.0.join(".v2-cache")).unwrap();
    std::fs::write(
        root.0.join(".v2-cache/obsolete.tmp"),
        b"old interrupted version",
    )
    .unwrap();
    let mut world = World::new();
    let mut index = world.add("26-01-01", None, b"first");
    let data = b"second";
    let archive = zip("b.png", data);
    index["artworks"]["b"] = json!({"shard":"chararts","large":{"file":"b.png","w":1,"h":1,"bytes":data.len(),"sha256":hash(data)}});
    index["baselineParts"].as_array_mut().unwrap().push(json!({"file":"second.zip","bytes":archive.len(),"sha256":hash(&archive),"group":"chararts-large","members":{"b.png":{"bytes":data.len(),"sha256":hash(data),"group":"chararts-large"}}}));
    world.files.insert(
        "images2-26-01-01/index.json".into(),
        serde_json::to_vec(&index).unwrap(),
    );
    world.files.insert(
        "images2-baseline-26-01-01/second.zip".into(),
        b"bad".to_vec(),
    );
    assert_eq!(
        sync_images(&root.0, &world, opts()).await.status,
        SyncStatus::NoData
    );
    assert!(active_generation(&root.0).is_none());
    assert!(!root.0.join(".v2-cache/obsolete.tmp").exists());
    world
        .files
        .insert("images2-baseline-26-01-01/second.zip".into(), archive);
    world.downloads.lock().unwrap().clear();
    assert_eq!(
        sync_images(&root.0, &world, opts()).await.status,
        SyncStatus::Updated
    );
    assert_eq!(
        *world.downloads.lock().unwrap(),
        vec![
            "images2-26-01-01/index.json",
            "images2-baseline-26-01-01/second.zip"
        ]
    );
    assert!(!root.0.join(".v2-cache").exists());
}
