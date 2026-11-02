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
                Outcome::Retry if first || matches!(dataset, Dataset::Database) => {
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

#[cfg(test)]
mod tests {
    use super::*;
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
