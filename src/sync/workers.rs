//! Background timers use the same reservations and snapshots as manual jobs.
use super::{controlled_transport::Controlled, jobs::Coordinator, scheduler};
use crate::config::{DataBackend, RuntimeConfig};
use serde_json::json;
use std::{sync::Arc, time::Duration};

#[derive(Clone, Copy)]
enum Dataset {
    Game,
    Story,
    Database,
    Images,
}
impl Dataset {
    fn name(self) -> &'static str {
        match self {
            Self::Game => "game",
            Self::Story => "story",
            Self::Database => "database",
            Self::Images => "images",
        }
    }
    fn mask(self) -> u8 {
        match self {
            Self::Game => 1,
            Self::Story => 2,
            Self::Database => 4,
            Self::Images => 8,
        }
    }
    fn enabled(self, cfg: &RuntimeConfig) -> bool {
        match self {
            Self::Game => cfg.data_backend == DataBackend::Json && !cfg.is_custom_gamedata,
            Self::Story => cfg.data_backend == DataBackend::Json && cfg.story_sync_enabled,
            Self::Database => {
                cfg.data_backend == DataBackend::Sqlite && cfg.custom_database.is_none()
            }
            Self::Images => cfg.images_enabled && cfg.local_image,
        }
    }
}
enum Outcome {
    Done,
    Retry,
    Busy,
    Cancelled,
}
async fn run(owner: &Arc<Coordinator>, dataset: Dataset, force: bool) -> Outcome {
    let Ok(job) = owner.begin(dataset.name(), "background", dataset.mask(), 0) else {
        return Outcome::Busy;
    };
    let cfg = &job.snapshot.config;
    let transport = Controlled {
        inner: job.snapshot.transport.as_ref(),
        control: job.control.clone(),
    };
    let retry = job
        .control
        .scope(async {
            match dataset {
                Dataset::Game => scheduler::run_gamedata_sync(cfg, &transport, force).await,
                Dataset::Story => scheduler::run_story_sync(cfg, &transport, force).await,
                Dataset::Images => scheduler::run_images_sync(cfg, &transport, force).await,
                Dataset::Database => match super::database::sync_with_source(
                    &transport,
                    &cfg.database_dir,
                    cfg.validation_mode,
                    &cfg.data_source,
                )
                .await
                {
                    Ok(updated) => {
                        crate::log_info(if updated {
                            "SQLite dataset updated."
                        } else {
                            "SQLite dataset is up to date."
                        });
                        false
                    }
                    Err(error) => {
                        crate::log_warn(&format!(
                            "SQLite sync failed; keeping cached/bundled data: {error}"
                        ));
                        true
                    }
                },
            }
        })
        .await;
    let cancelled = job.control.cancelled();
    job.finish(
        if cancelled {
            "cancelled"
        } else if retry {
            "failed"
        } else {
            "succeeded"
        },
        json!({"ok":!retry && !cancelled,"message":if cancelled {"任务已取消"} else if retry {"后台同步失败；请查看服务器日志"} else {"同步完成"}}),
    );
    if cancelled {
        Outcome::Cancelled
    } else if retry {
        Outcome::Retry
    } else {
        Outcome::Done
    }
}

pub fn start(owner: Arc<Coordinator>) {
    for dataset in [
        Dataset::Game,
        Dataset::Story,
        Dataset::Database,
        Dataset::Images,
    ] {
        if !dataset.enabled(&owner.snapshot().config) {
            continue;
        }
        tokio::spawn(worker(owner.clone(), dataset));
    }
}
async fn worker(owner: Arc<Coordinator>, dataset: Dataset) {
    let mut changed = owner.subscribe();
    let mut first = true;
    loop {
        if owner.stopping() {
            return;
        }
        let mut attempt = 0;
        loop {
            if owner.stopping() {
                return;
            }
            match run(&owner, dataset, !first || attempt > 0).await {
                Outcome::Done | Outcome::Cancelled => break,
                Outcome::Busy => {
                    // An overlapping operator job owns this dataset. Recheck
                    // later without consuming a failure retry.
                    tokio::select! { _=tokio::time::sleep(Duration::from_secs(30))=>(), _=changed.changed()=>() }
                }
                Outcome::Retry if first && !matches!(dataset, Dataset::Database) => {
                    // JSON/images retries run alongside periodic polling, as
                    // before; the shared reservation serializes actual work.
                    tokio::spawn(retry(owner.clone(), dataset, tokio::time::Instant::now()));
                    break;
                }
                Outcome::Retry if matches!(dataset, Dataset::Database) => {
                    let Some(delay) = [30, 120, 600].get(attempt).copied() else {
                        break;
                    };
                    crate::log_info(&format!("{} sync will retry in {delay}s.", dataset.name()));
                    attempt += 1;
                    // Interval changes do not restart or skip a dense retry.
                    let until = tokio::time::Instant::now() + Duration::from_secs(delay);
                    loop {
                        tokio::select! { _=tokio::time::sleep_until(until)=>break, _=changed.changed()=> { if owner.stopping() { return; } } }
                    }
                }
                Outcome::Retry => break,
            }
        }
        first = false;
        loop {
            if owner.stopping() {
                return;
            }
            let interval = owner.snapshot().config.auto_sync_interval_ms;
            if matches!(dataset, Dataset::Game | Dataset::Database) {
                if interval == 0 {
                    crate::log_info("Periodic auto-sync is disabled; startup sync completed.");
                } else {
                    crate::log_info(&format!("Next auto-sync check in {}s.", interval / 1000));
                }
            }
            if interval == 0 {
                if changed.changed().await.is_err() {
                    return;
                }
            } else {
                tokio::select! {
                    _=tokio::time::sleep(Duration::from_millis(interval))=>break,
                    _=changed.changed()=>(),
                }
            }
        }
    }
}

async fn retry(owner: Arc<Coordinator>, dataset: Dataset, mut base: tokio::time::Instant) {
    let mut changed = owner.subscribe();
    let mut attempt = 0;
    while let Some(delay) = [30, 120, 600].get(attempt).copied() {
        crate::log_info(&format!("{} sync will retry in {delay}s.", dataset.name()));
        let until = base + Duration::from_secs(delay);
        loop {
            if owner.stopping() {
                return;
            }
            tokio::select! { _=tokio::time::sleep_until(until)=>break, _=changed.changed()=>() }
        }
        if owner.stopping() {
            return;
        }
        match run(&owner, dataset, true).await {
            Outcome::Done | Outcome::Cancelled => return,
            Outcome::Busy => (),
            Outcome::Retry => attempt += 1,
        }
        base = tokio::time::Instant::now();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Offline;
    #[async_trait::async_trait]
    impl crate::sync::transport::Transport for Offline {
        async fn fetch_json(
            &self,
            _: &str,
            _: u64,
        ) -> Result<serde_json::Value, crate::sync::transport::TransportError> {
            Err(crate::sync::transport::TransportError::Network(
                "fixture offline".into(),
            ))
        }
        async fn download(
            &self,
            _: &str,
            _: &std::path::Path,
            _: u64,
        ) -> Result<crate::sync::transport::DownloadStats, crate::sync::transport::TransportError>
        {
            unreachable!()
        }
        async fn download_file_limited(
            &self,
            _: &str,
            _: &std::path::Path,
            _: u64,
            _: u64,
        ) -> Result<u64, crate::sync::transport::TransportError> {
            unreachable!()
        }
        fn mirrors(&self) -> Vec<String> {
            vec![]
        }
        fn github_headers(&self) -> Vec<(String, String)> {
            vec![]
        }
    }
    #[tokio::test(start_paused = true)]
    async fn json_periodic_cycle_is_not_delayed_by_startup_retry_chain() {
        let root = std::env::temp_dir().join(format!("prts-timer-test-{}", uuid::Uuid::new_v4()));
        let cfg = RuntimeConfig::from_lookup(|key| match key {
            "XDG_DATA_HOME" | "LOCALAPPDATA" => Some(root.to_string_lossy().into_owned()),
            "PRTS_DATA_BACKEND" => Some("json".into()),
            "PRTS_AUTO_SYNC_INTERVAL_SECONDS" => Some("60".into()),
            _ => None,
        });
        let owner = Coordinator::new(Arc::new(cfg), Arc::new(Offline));
        let task = tokio::spawn(worker(owner.clone(), Dataset::Game));
        async fn completed(owner: &Coordinator, wanted: usize) {
            // Yield without sleeping, so Tokio cannot auto-advance past the
            // deadline under examination while filesystem workers finish.
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            while std::time::Instant::now() < deadline {
                if owner.list()["jobs"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|j| j["status"] == "failed")
                    .count()
                    >= wanted
                {
                    return;
                }
                tokio::task::yield_now().await;
            }
            panic!("expected {wanted} completed attempts: {}", owner.list());
        }
        completed(&owner, 1).await;
        tokio::time::advance(Duration::from_secs(30)).await;
        completed(&owner, 2).await;
        tokio::time::advance(Duration::from_secs(30)).await;
        completed(&owner, 3).await; // periodic pass at 60s, second retry is at 150s
        owner.stop();
        task.await.unwrap();
        owner.drain().await;
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn background_image_lock_keeps_default_wait_and_remains_cancellable() {
        let root = std::env::temp_dir().join(format!("prts-worker-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let lock = std::fs::File::create(root.join(".images-writer.lock")).unwrap();
        lock.lock().unwrap();
        let cfg = RuntimeConfig::from_lookup(|key| match key {
            "PRTS_IMAGE_DIR" => Some(root.to_string_lossy().into_owned()),
            "LOCAL_IMAGE" => Some("true".into()),
            _ => None,
        });
        let owner = Coordinator::new(
            Arc::new(cfg),
            Arc::new(super::super::transport::ReqwestTransport::new(vec![], None)),
        );
        let task = tokio::spawn({
            let owner = owner.clone();
            async move { run(&owner, Dataset::Images, false).await }
        });
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(
            !task.is_finished(),
            "background lock contention must wait, not use the manual zero budget"
        );
        owner.stop();
        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(2), task)
                .await
                .unwrap()
                .unwrap(),
            Outcome::Cancelled
        ));
        assert!(std::fs::File::open(root.join(".images-writer.lock"))
            .unwrap()
            .try_lock()
            .is_err());
        drop(lock);
        std::fs::remove_dir_all(root).unwrap();
    }
}
