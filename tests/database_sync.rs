//! Exercise the real compiler artifact through the production sync state machine.
#[path = "support/sqlite.rs"]
mod sqlite_fixture;
use async_trait::async_trait;
use prts_mcp_rust::{
    storage::{database, sqlite::GameDb},
    sync::{
        database as sync,
        transport::{DownloadStats, Transport, TransportError},
    },
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};
const VERSION: &str = "26-10-08-04-51-28-56071834";
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
struct Fake {
    manifest: Value,
    payload: Vec<u8>,
    requested: Mutex<Vec<String>>,
    pause: Mutex<
        Option<(
            std::sync::Arc<tokio::sync::Notify>,
            std::sync::Arc<tokio::sync::Notify>,
        )>,
    >,
}
#[async_trait]
impl Transport for Fake {
    async fn fetch_json(&self, url: &str, _: u64) -> Result<Value, TransportError> {
        self.requested.lock().unwrap().push(url.into());
        if url.contains("api.github.com") {
            Ok(
                json!([{"tag_name":format!("datarev-{VERSION}-r{}",self.manifest["publicationRevision"].as_u64().unwrap()),"assets":[
                    {"name":"manifest.json","browser_download_url":"https://artifact/manifest.json"},
                    {"name":"zh_CN.sqlite.gz","browser_download_url":"https://artifact/zh_CN.sqlite.gz"},
                    {"name":"zh_CN-excel.zip","browser_download_url":"https://forbidden/raw.zip"}
                ]}]),
            )
        } else {
            Ok(self.manifest.clone())
        }
    }
    async fn download(
        &self,
        url: &str,
        dest: &Path,
        _: u64,
    ) -> Result<DownloadStats, TransportError> {
        self.requested.lock().unwrap().push(url.into());
        assert_eq!(url, "https://artifact/zh_CN.sqlite.gz");
        let pause = self.pause.lock().unwrap().clone();
        if let Some((entered, release)) = pause {
            std::fs::write(dest, b"partial").unwrap();
            entered.notify_one();
            release.notified().await;
        }

        std::fs::write(dest, &self.payload).unwrap();
        Ok(DownloadStats {
            bytes: self.payload.len() as u64,
            sha256: digest(&self.payload),
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
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn artifact() -> (Temp, Fake) {
    let temp = Temp(std::env::temp_dir().join(format!("prts-db-sync-{}", uuid::Uuid::new_v4())));
    std::fs::create_dir_all(&temp.0).unwrap();
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/native-smoke");
    let descriptor = sqlite_fixture::compiler::compile(&sqlite_fixture::compiler::Options {
        input: Some(fixture),
        output: temp.0.join("zh_CN.sqlite"),
        version: VERSION.into(),
        revision: 2,
        allow_incomplete: true,
        ..Default::default()
    })
    .unwrap();
    let payload = std::fs::read(temp.0.join("zh_CN.sqlite.gz")).unwrap();
    let manifest = json!({"contractVersion":"prts-mcp-data/v1","source":{"versionId":VERSION},"publicationRevision":2,
        "assets":{"zh_CN.sqlite.gz":{"sha256":digest(&payload),"size":payload.len()}},"sqlite":descriptor});
    (
        temp,
        Fake {
            manifest,
            payload,
            requested: Mutex::new(vec![]),
            pause: Mutex::new(None),
        },
    )
}
#[tokio::test]
async fn sync_activates_only_valid_database_and_recovers_corrupt_active_file() {
    let (temp, fake) = artifact();
    let root = temp.0.join("runtime");
    assert!(sync::sync(&fake, &root).await.unwrap());
    let active = database::active(&root).unwrap().unwrap();
    let db = GameDb::open(&active.path(&root)).unwrap();
    assert!(db.name_id("character_table", "阿米娅").unwrap().is_some());
    assert!(!sync::sync(&fake, &root).await.unwrap());
    assert_eq!(
        fake.requested
            .lock()
            .unwrap()
            .iter()
            .filter(|url| url.ends_with(".gz"))
            .count(),
        1
    );
    drop(db);
    std::fs::write(active.path(&root), b"broken").unwrap();
    assert!(sync::sync(&fake, &root).await.unwrap());
    let repaired = database::active(&root).unwrap().unwrap();
    assert_ne!(active.file_name, repaired.file_name);
    assert!(GameDb::open(&repaired.path(&root)).unwrap().derived_ready());
    assert!(!root.join("zh_CN-excel.zip").exists());
}
#[tokio::test]
async fn corrupt_transfer_never_replaces_active_pointer() {
    let (temp, mut fake) = artifact();
    let root = temp.0.join("runtime");
    assert!(sync::sync(&fake, &root).await.unwrap());
    let before = std::fs::read(root.join("active")).unwrap();
    // Force repair and then corrupt the transfer without updating its descriptor.
    let active = database::active(&root).unwrap().unwrap();
    std::fs::write(active.path(&root), b"broken").unwrap();
    fake.payload[0] ^= 1;
    assert!(sync::sync(&fake, &root).await.is_err());
    assert_eq!(std::fs::read(root.join("active")).unwrap(), before);
    assert!(!std::fs::read_dir(&root)
        .unwrap()
        .flatten()
        .any(|e| e.file_name().to_string_lossy().starts_with(".stage-")));
}
#[tokio::test]
async fn incompatible_manifest_rejected_before_download() {
    let (temp, mut fake) = artifact();
    for field in [
        "schemaVersion",
        "indexVersion",
        "language",
        "sourceVersion",
        "publicationRevision",
        "sha256",
        "asset",
    ] {
        let original = fake.manifest["sqlite"][field].clone();
        fake.manifest["sqlite"][field] = json!("invalid");
        assert!(
            sync::sync(&fake, &temp.0.join("runtime")).await.is_err(),
            "{field}"
        );
        fake.manifest["sqlite"][field] = original;
    }
    assert!(!fake
        .requested
        .lock()
        .unwrap()
        .iter()
        .any(|url| url.ends_with(".gz")));
}
#[tokio::test]
async fn sync_lock_prevents_two_publishers() {
    let (temp, fake) = artifact();
    let root = temp.0.join("runtime");
    std::fs::create_dir_all(&root).unwrap();
    let lock = std::fs::File::create(root.join("sync.lock")).unwrap();
    lock.lock().unwrap();
    assert!(sync::sync(&fake, &root)
        .await
        .unwrap_err()
        .contains("locked"));
    assert!(fake.requested.lock().unwrap().is_empty());
}

fn refresh(temp: &Temp, fake: &mut Fake, revision: u64) {
    use std::io::Write;
    let raw = std::fs::read(temp.0.join("zh_CN.sqlite")).unwrap();
    let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    gzip.write_all(&raw).unwrap();
    fake.payload = gzip.finish().unwrap();
    fake.manifest["publicationRevision"] = json!(revision);
    fake.manifest["sqlite"]["publicationRevision"] = json!(revision);
    fake.manifest["sqlite"]["size"] = json!(raw.len());
    fake.manifest["sqlite"]["sha256"] = json!(digest(&raw));
    fake.manifest["sqlite"]["compressedSize"] = json!(fake.payload.len());
    fake.manifest["sqlite"]["compressedSha256"] = json!(digest(&fake.payload));
    fake.manifest["assets"]["zh_CN.sqlite.gz"] =
        json!({"size":fake.payload.len(),"sha256":digest(&fake.payload)});
}
fn revision(temp: &Temp, fake: &mut Fake, value: u64) {
    let db = rusqlite::Connection::open(temp.0.join("zh_CN.sqlite")).unwrap();
    db.execute(
        "UPDATE meta SET value=?1 WHERE key='publication_revision'",
        [value.to_string()],
    )
    .unwrap();
    drop(db);
    refresh(temp, fake, value);
}
#[tokio::test]
async fn invalid_database_rejected_after_valid_outer_hashes() {
    let (temp, mut fake) = artifact();
    let root = temp.0.join("runtime");
    let db = rusqlite::Connection::open(temp.0.join("zh_CN.sqlite")).unwrap();
    db.execute_batch("PRAGMA user_version=999").unwrap();
    drop(db);
    refresh(&temp, &mut fake, 2);
    assert!(sync::sync(&fake, &root)
        .await
        .unwrap_err()
        .contains("unsupported"));
    assert!(database::active(&root).unwrap().is_none());
}
#[tokio::test]
async fn decoded_length_and_digest_must_match_the_download() {
    let (temp, mut fake) = artifact();
    let root = temp.0.join("runtime");
    fake.manifest["sqlite"]["size"] = json!(1);
    assert!(sync::sync(&fake, &root)
        .await
        .unwrap_err()
        .contains("length"));
    fake.manifest["sqlite"]["size"] = json!(std::fs::metadata(temp.0.join("zh_CN.sqlite"))
        .unwrap()
        .len());
    fake.manifest["sqlite"]["sha256"] = json!("a".repeat(64));
    assert!(sync::sync(&fake, &root)
        .await
        .unwrap_err()
        .contains("SHA-256"));
    assert!(database::active(&root).unwrap().is_none());
}
#[tokio::test]
async fn orphan_database_and_broken_pointer_recover_without_redownload() {
    let (temp, fake) = artifact();
    let root = temp.0.join("runtime");
    sync::sync(&fake, &root).await.unwrap();
    let first = database::active(&root).unwrap().unwrap();
    std::fs::remove_file(root.join("active")).unwrap();
    assert!(sync::sync(&fake, &root).await.unwrap());
    assert_eq!(database::active(&root).unwrap().unwrap(), first);
    std::fs::write(root.join("active"), b"truncated").unwrap();
    assert!(sync::sync(&fake, &root).await.unwrap());
    assert_eq!(database::active(&root).unwrap().unwrap(), first);
    assert_eq!(
        fake.requested
            .lock()
            .unwrap()
            .iter()
            .filter(|url| url.ends_with(".gz"))
            .count(),
        1
    );
}
#[tokio::test]
async fn broken_active_pointer_is_repaired_when_previous_matches_latest() {
    let (temp, fake) = artifact();
    let root = temp.0.join("runtime");
    assert!(sync::sync(&fake, &root).await.unwrap());
    let first = database::active(&root).unwrap().unwrap();
    let encoded = std::fs::read(root.join("active")).unwrap();
    std::fs::write(root.join("previous"), &encoded).unwrap();
    std::fs::write(root.join("active"), b"truncated").unwrap();

    assert!(sync::sync(&fake, &root).await.unwrap());
    assert_eq!(database::active(&root).unwrap().unwrap(), first);
    assert_eq!(std::fs::read(root.join("previous")).unwrap(), encoded);
    assert!(!sync::sync(&fake, &root).await.unwrap());
    assert_eq!(
        fake.requested
            .lock()
            .unwrap()
            .iter()
            .filter(|url| url.ends_with(".gz"))
            .count(),
        1
    );
}
#[tokio::test]
async fn gc_keeps_previous_across_polls_and_every_pinned_generation() {
    let (temp, mut fake) = artifact();
    let root = temp.0.join("runtime");
    sync::sync(&fake, &root).await.unwrap();
    let oldest = database::active(&root).unwrap().unwrap();
    let pinned = GameDb::open(&oldest.path(&root)).unwrap();
    // The fake release tag follows the changing descriptor revision.
    revision(&temp, &mut fake, 3);
    sync::sync(&fake, &root).await.unwrap();
    let previous = database::active(&root).unwrap().unwrap();
    revision(&temp, &mut fake, 4);
    sync::sync(&fake, &root).await.unwrap();
    assert!(oldest.path(&root).exists());
    assert!(previous.path(&root).exists());
    assert!(!sync::sync(&fake, &root).await.unwrap());
    assert!(previous.path(&root).exists());
    drop(pinned);
    assert!(!sync::sync(&fake, &root).await.unwrap());
    assert!(!oldest.path(&root).exists());
    assert!(previous.path(&root).exists());
}
#[tokio::test]
async fn rollback_and_same_generation_mutation_fail_closed() {
    let (temp, mut fake) = artifact();
    let root = temp.0.join("runtime");
    sync::sync(&fake, &root).await.unwrap();
    let before = std::fs::read(root.join("active")).unwrap();
    let db = rusqlite::Connection::open(temp.0.join("zh_CN.sqlite")).unwrap();
    db.execute("INSERT INTO meta VALUES('changed','1')", [])
        .unwrap();
    drop(db);
    refresh(&temp, &mut fake, 2);
    assert!(sync::sync(&fake, &root)
        .await
        .unwrap_err()
        .contains("different digest"));
    revision(&temp, &mut fake, 1);
    assert!(sync::sync(&fake, &root)
        .await
        .unwrap_err()
        .contains("downgrade"));
    assert_eq!(std::fs::read(root.join("active")).unwrap(), before);
}

#[tokio::test]
async fn cancelled_download_cleans_staging_and_releases_publisher_lock() {
    let (temp, fake) = artifact();
    let root = temp.0.join("runtime");
    let entered = std::sync::Arc::new(tokio::sync::Notify::new());
    let release = std::sync::Arc::new(tokio::sync::Notify::new());
    *fake.pause.lock().unwrap() = Some((entered.clone(), release));
    let fake = std::sync::Arc::new(fake);
    let task_root = root.clone();
    let task_fake = fake.clone();
    let task = tokio::spawn(async move { sync::sync(task_fake.as_ref(), &task_root).await });
    tokio::time::timeout(std::time::Duration::from_secs(5), entered.notified())
        .await
        .unwrap();
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert!(database::active(&root).unwrap().is_none());
    assert!(!std::fs::read_dir(&root)
        .unwrap()
        .flatten()
        .any(|e| e.file_name().to_string_lossy().starts_with(".stage-")));
    // Simulate a killed former publisher. Cleanup owns only exact UUID names.
    let orphan = root.join(format!(".stage-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir(&orphan).unwrap();
    std::fs::write(orphan.join("partial"), b"partial").unwrap();
    let unrelated = root.join(".stage-user");
    std::fs::create_dir(&unrelated).unwrap();
    *fake.pause.lock().unwrap() = None;
    assert!(sync::sync(fake.as_ref(), &root).await.unwrap());
    assert!(!orphan.exists());
    assert!(unrelated.exists());
}

#[tokio::test]
async fn repairing_current_database_preserves_the_healthy_previous_generation() {
    let (temp, mut fake) = artifact();
    let root = temp.0.join("runtime");
    sync::sync(&fake, &root).await.unwrap();
    let previous = database::active(&root).unwrap().unwrap();
    revision(&temp, &mut fake, 3);
    sync::sync(&fake, &root).await.unwrap();
    let broken = database::active(&root).unwrap().unwrap();
    std::fs::write(broken.path(&root), b"broken").unwrap();
    assert!(sync::sync(&fake, &root).await.unwrap());
    let retained =
        database::ActiveDatabase::parse(&std::fs::read_to_string(root.join("previous")).unwrap())
            .unwrap();
    assert_eq!(retained, previous);
    assert!(previous.path(&root).exists());
    assert!(!broken.path(&root).exists());
    let repaired = database::active(&root).unwrap().unwrap();
    std::fs::write(repaired.path(&root), b"broken again").unwrap();
    revision(&temp, &mut fake, 4);
    sync::sync(&fake, &root).await.unwrap();
    let retained =
        database::ActiveDatabase::parse(&std::fs::read_to_string(root.join("previous")).unwrap())
            .unwrap();
    assert_eq!(retained, previous);
    assert!(previous.path(&root).exists());
    assert!(!repaired.path(&root).exists());
}

#[test]
fn invalid_outer_revision_is_not_treated_as_a_missing_legacy_revision() {
    use prts_mcp_rust::sync::database_manifest::DatabaseManifest;
    let (_temp, mut fake) = artifact();
    fake.manifest["sqlite"]["publicationRevision"] = json!(1);
    for value in [json!(-1), json!(false), json!("1"), Value::Null] {
        fake.manifest["publicationRevision"] = value;
        assert!(DatabaseManifest::from_release(&fake.manifest, VERSION, 1).is_err());
    }
    fake.manifest
        .as_object_mut()
        .unwrap()
        .shift_remove("publicationRevision");
    assert!(DatabaseManifest::from_release(&fake.manifest, VERSION, 1).is_ok());
}
