//! Sync control tests use real filesystem locks and never contact public services.
use prts_mcp_rust::{
    config::RuntimeConfig,
    sync::{
        control::Control,
        once,
        transport::{DownloadStats, Transport, TransportError},
    },
};
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicUsize, Ordering},
    time::Duration,
};
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!("prts-cli-sync-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&p).unwrap();
        Self(p)
    }
    fn cfg(&self, backend: &str) -> RuntimeConfig {
        RuntimeConfig::from_lookup(|k| match k {
            "XDG_DATA_HOME" | "LOCALAPPDATA" => Some(self.0.display().to_string()),
            "PRTS_DATA_DIR" => Some(self.0.join("database").display().to_string()),
            "PRTS_DATA_BACKEND" => Some(backend.into()),
            _ => None,
        })
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
#[derive(Default)]
struct Offline {
    calls: AtomicUsize,
    pending: bool,
}
#[async_trait::async_trait]
impl Transport for Offline {
    async fn fetch_json(&self, _: &str, _: u64) -> Result<Value, TransportError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if self.pending {
            std::future::pending().await
        } else {
            Err(TransportError::Network("private-secret-needle".into()))
        }
    }
    async fn download(&self, _: &str, _: &Path, _: u64) -> Result<DownloadStats, TransportError> {
        panic!("download not expected")
    }
    async fn download_file_limited(
        &self,
        _: &str,
        _: &Path,
        _: u64,
        _: u64,
    ) -> Result<u64, TransportError> {
        panic!("download not expected")
    }
    fn mirrors(&self) -> Vec<String> {
        vec![]
    }
    fn github_headers(&self) -> Vec<(String, String)> {
        vec![]
    }
}
#[tokio::test]
async fn held_database_lock_exhausts_budget_without_network() {
    let f = Fixture::new();
    let cfg = f.cfg("sqlite");
    std::fs::create_dir(&cfg.database_dir).unwrap();
    let file = std::fs::File::create(cfg.database_dir.join("sync.lock")).unwrap();
    file.lock().unwrap();
    let t = Offline::default();
    let control = Control::new(Duration::from_millis(30));
    let start = std::time::Instant::now();
    let result = once::run(&cfg, "game", &t, control.clone()).await.unwrap();
    assert_eq!(result.exit_code(), 3);
    assert_eq!(control.exit_code(), Some(3));
    assert_eq!(t.calls.load(Ordering::SeqCst), 0);
    assert!(start.elapsed() < Duration::from_secs(2));
}
#[tokio::test]
async fn cancelled_network_unwinds_and_releases_sqlite_lock() {
    let f = Fixture::new();
    let cfg = f.cfg("sqlite");
    let t = Offline {
        pending: true,
        ..Default::default()
    };
    let c = Control::new(Duration::from_secs(1));
    let cancel = c.clone();
    let task = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(30)).await;
        cancel.cancel(130);
    });
    let result = tokio::time::timeout(
        Duration::from_secs(2),
        once::run(&cfg, "game", &t, c.clone()),
    )
    .await
    .unwrap()
    .unwrap();
    task.await.unwrap();
    assert!(result.cancelled);
    assert_eq!(c.exit_code(), Some(130));
    assert!(!result.ok);
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(cfg.database_dir.join("sync.lock"))
        .unwrap();
    file.try_lock().expect("publisher released lock");
}
#[tokio::test]
async fn shared_budget_counts_lock_waits_not_transfer_time() {
    let f = Fixture::new();
    let path = f.0.join("lease");
    let owner = std::fs::File::create(&path).unwrap();
    owner.lock().unwrap();
    let c = Control::new(Duration::from_millis(1000));
    let waiter = std::fs::File::open(&path).unwrap();
    let task = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(30)).await;
        drop(owner);
    });
    c.scope(async {
        prts_mcp_rust::sync::control::lock_async(&waiter, Duration::ZERO)
            .await
            .unwrap();
        waiter.unlock().unwrap();
        tokio::time::sleep(Duration::from_millis(1100)).await;
        let owner = std::fs::File::open(&path).unwrap();
        owner.lock().unwrap();
        let task = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            drop(owner);
        });
        prts_mcp_rust::sync::control::lock_async(&waiter, Duration::ZERO)
            .await
            .unwrap();
        task.await.unwrap();
    })
    .await;
    task.await.unwrap();
    assert_eq!(c.exit_code(), None);
}
#[tokio::test]
async fn archive_lock_obeys_zero_budget_and_preserves_other_owner() {
    let f = Fixture::new();
    let cfg = f.cfg("json");
    let parent = cfg.gamedata_path.parent().unwrap();
    std::fs::create_dir_all(parent).unwrap();
    let lock = parent.join(".gamedata-pair.lock");
    std::fs::create_dir(&lock).unwrap();
    std::fs::write(lock.join("owner"), "other-owner").unwrap();
    let t = Offline::default();
    let c = Control::new(Duration::ZERO);
    let r = once::run(&cfg, "game", &t, c).await.unwrap();
    assert_eq!(r.exit_code(), 3);
    assert_eq!(t.calls.load(Ordering::SeqCst), 0);
    assert_eq!(
        std::fs::read_to_string(lock.join("owner")).unwrap(),
        "other-owner"
    );
}
#[tokio::test]
async fn empty_sync_selection_fails_before_creating_directories() {
    let f = Fixture::new();
    let mut cfg = f.cfg("sqlite");
    cfg.custom_database = Some(f.0.join("readonly.sqlite"));
    let c = Control::new(Duration::ZERO);
    assert!(once::run(&cfg, "game", &Offline::default(), c)
        .await
        .is_err());
    assert!(!cfg.database_dir.exists());
}
#[tokio::test]
async fn failed_cycle_is_nonzero_and_does_not_expose_transport_secrets() {
    let f = Fixture::new();
    let cfg = f.cfg("sqlite");
    let report = once::run(
        &cfg,
        "game",
        &Offline::default(),
        Control::new(Duration::ZERO),
    )
    .await
    .unwrap();
    assert_eq!(report.exit_code(), 1);
    assert!(!serde_json::to_string(&report)
        .unwrap()
        .contains("private-secret-needle"));
}

#[tokio::test]
async fn image_kernel_lease_obeys_invocation_budget() {
    let f = Fixture::new();
    let mut cfg = f.cfg("sqlite");
    cfg.images_enabled = true;
    cfg.local_image = true;
    cfg.images_path = f.0.join("images");
    std::fs::create_dir(&cfg.images_path).unwrap();
    let owner = std::fs::File::create(cfg.images_path.join(".images-writer.lock")).unwrap();
    owner.lock().unwrap();
    let t = Offline::default();
    let control = Control::new(Duration::ZERO);
    let result = once::run(&cfg, "images", &t, control).await.unwrap();
    assert_eq!(result.exit_code(), 3);
    assert_eq!(t.calls.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn source_ownership_lock_is_bounded_before_claiming_directory() {
    let f = Fixture::new();
    let cfg = f.cfg("sqlite");
    std::fs::create_dir(&cfg.database_dir).unwrap();
    let owner = std::fs::File::create(cfg.database_dir.join(".prts-data-source.lock")).unwrap();
    owner.lock().unwrap();
    let control = Control::new(Duration::ZERO);
    let source = prts_mcp_rust::config::DataSource::parse(Some("fixture/source")).unwrap();
    let result = control
        .scope(async { prts_mcp_rust::sync::source_guard::ensure(&cfg.database_dir, &source) })
        .await;
    assert!(result.is_err());
    assert_eq!(control.exit_code(), Some(3));
    assert!(!cfg.database_dir.join(".prts-data-source.json").exists());
}

#[tokio::test(flavor = "current_thread")]
async fn source_lock_wait_keeps_current_thread_cancellation_responsive() {
    let f = Fixture::new();
    let mut cfg = f.cfg("sqlite");
    cfg.data_source = prts_mcp_rust::config::DataSource::parse(Some("fixture/source")).unwrap();
    std::fs::create_dir(&cfg.database_dir).unwrap();
    let owner = std::fs::File::create(cfg.database_dir.join(".prts-data-source.lock")).unwrap();
    owner.lock().unwrap();
    let control = Control::new(Duration::from_secs(30));
    let cancellation = control.clone();
    let signal = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(20)).await;
        cancellation.cancel(130)
    });
    let transport = Offline::default();
    let report = tokio::time::timeout(
        Duration::from_secs(2),
        once::run(&cfg, "game", &transport, control.clone()),
    )
    .await
    .expect("cancellation must run while source lock waits")
    .unwrap();
    signal.await.unwrap();
    assert!(report.cancelled);
    assert_eq!(control.exit_code(), Some(130));
    assert_eq!(transport.calls.load(Ordering::SeqCst), 0);
    assert!(!cfg.database_dir.join(".prts-data-source.json").exists());
}

#[tokio::test]
async fn sequential_contention_consumes_one_shared_budget() {
    let f = Fixture::new();
    let first = f.0.join("first.lock");
    let second = f.0.join("second.lock");
    let owner = std::fs::File::create(&first).unwrap();
    owner.lock().unwrap();
    let owner2 = std::fs::File::create(&second).unwrap();
    owner2.lock().unwrap();
    let control = Control::new(Duration::from_millis(500));
    let release = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        drop(owner)
    });
    control
        .scope(async {
            let first = std::fs::File::open(first).unwrap();
            prts_mcp_rust::sync::control::lock_async(&first, Duration::ZERO)
                .await
                .unwrap();
            let second = std::fs::File::open(second).unwrap();
            let started = std::time::Instant::now();
            assert!(
                prts_mcp_rust::sync::control::lock_async(&second, Duration::ZERO)
                    .await
                    .is_err()
            );
            assert!(
                started.elapsed() < Duration::from_millis(400),
                "second lock should have less than a fresh 500 ms budget"
            );
        })
        .await;
    release.await.unwrap();
    assert_eq!(control.exit_code(), Some(3));
}
