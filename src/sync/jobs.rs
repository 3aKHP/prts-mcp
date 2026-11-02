//! Shared, process-local ownership of background and operator sync jobs.
use super::{control::Control, transport::Transport};
use crate::config::RuntimeConfig;
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{watch, Notify};

#[derive(Clone)]
pub struct Snapshot {
    pub config: Arc<RuntimeConfig>,
    pub transport: Arc<dyn Transport>,
    pub revision: u64,
}

struct Job {
    value: Value,
    mask: u8,
    control: Arc<Control>,
}
struct State {
    snapshot: Snapshot,
    jobs: VecDeque<Job>,
    stopping: bool,
}
pub struct Coordinator {
    state: Mutex<State>,
    changed: watch::Sender<u64>,
    finished: Notify,
}
pub(crate) struct Running {
    owner: Arc<Coordinator>,
    pub id: String,
    pub snapshot: Snapshot,
    pub control: Arc<Control>,
    finished: bool,
}
impl Running {
    pub fn finish(mut self, status: &str, result: Value) {
        self.owner.finish(&self.id, status, result);
        self.finished = true;
    }
}
impl Drop for Running {
    fn drop(&mut self) {
        if !self.finished {
            self.owner
                .finish(&self.id, "failed", json!({"message":"同步任务意外结束"}));
        }
    }
}

impl Coordinator {
    pub fn new(config: Arc<RuntimeConfig>, transport: Arc<dyn Transport>) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State {
                snapshot: Snapshot {
                    config,
                    transport,
                    revision: 1,
                },
                jobs: VecDeque::new(),
                stopping: false,
            }),
            changed: watch::channel(1).0,
            finished: Notify::new(),
        })
    }
    pub fn snapshot(&self) -> Snapshot {
        self.state.lock().expect("sync jobs").snapshot.clone()
    }
    pub fn stopping(&self) -> bool {
        self.state.lock().expect("sync jobs").stopping
    }
    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.changed.subscribe()
    }
    /// The caller validates a complete candidate before publishing it here.
    pub fn replace(
        &self,
        expected: u64,
        config: Arc<RuntimeConfig>,
        transport: Arc<dyn Transport>,
    ) -> Result<u64, String> {
        let mut state = self.state.lock().expect("sync jobs");
        if state.stopping {
            return Err("实例正在停止".into());
        }
        if state.snapshot.revision != expected {
            return Err("配置 revision 已变化，请重新 diff".into());
        }
        let revision = expected + 1;
        state.snapshot = Snapshot {
            config,
            transport,
            revision,
        };
        self.changed.send_replace(revision);
        Ok(revision)
    }
    pub(crate) fn begin(
        self: &Arc<Self>,
        target: &str,
        origin: &str,
        mask: u8,
        wait: u64,
    ) -> Result<Running, String> {
        let mut state = self.state.lock().expect("sync jobs");
        if state.stopping {
            return Err("实例正在停止，不再接受同步任务".into());
        }
        if let Some(job) = state.jobs.iter().find(|j| j.mask & mask != 0) {
            return Err(format!(
                "同步目标正被任务 {} 使用",
                job.value["id"].as_str().unwrap_or("")
            ));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let control = if origin == "background" {
            Control::background()
        } else {
            Control::new(Duration::from_secs(wait))
        };
        let snapshot = state.snapshot.clone();
        state.jobs.push_back(Job {
            value: json!({"schema_version":1,"id":id,"target":target,"origin":origin,"status":"running","config_revision":snapshot.revision,"result":null}),
            mask, control: control.clone(),
        });
        Ok(Running {
            owner: self.clone(),
            id,
            snapshot,
            control,
            finished: false,
        })
    }
    fn finish(&self, id: &str, status: &str, result: Value) {
        let mut state = self.state.lock().expect("sync jobs");
        if let Some(job) = state.jobs.iter_mut().find(|j| j.value["id"] == id) {
            job.mask = 0;
            job.value["status"] = json!(status);
            job.value["result"] = result;
        }
        while state.jobs.iter().filter(|j| j.mask == 0).count() > 100 {
            let index = state
                .jobs
                .iter()
                .position(|j| j.mask == 0)
                .expect("completed job");
            state.jobs.remove(index);
        }
        self.finished.notify_waiters();
    }
    pub fn list(&self) -> Value {
        json!({"schema_version":1,"jobs":self.state.lock().expect("sync jobs").jobs.iter().map(|j|j.value.clone()).collect::<Vec<_>>()})
    }
    pub fn show(&self, id: &str) -> Result<Value, String> {
        self.state
            .lock()
            .expect("sync jobs")
            .jobs
            .iter()
            .find(|j| j.value["id"] == id)
            .map(|j| j.value.clone())
            .ok_or_else(|| "任务不存在，可能已过期或实例已重启".into())
    }
    pub fn cancel(&self, id: &str) -> Result<Value, String> {
        let mut state = self.state.lock().expect("sync jobs");
        let job = state
            .jobs
            .iter_mut()
            .find(|j| j.value["id"] == id)
            .ok_or("任务不存在，可能已过期或实例已重启")?;
        if job.mask != 0 {
            job.control.cancel(130);
            job.value["status"] = json!("cancelling");
        }
        Ok(job.value.clone())
    }
    pub fn submit(self: &Arc<Self>, target: &str, wait: u64) -> Result<Value, String> {
        if wait > 86400 {
            return Err("wait_timeout 超过 86400 秒".into());
        }
        super::once::validate(&self.snapshot().config, target)?;
        let mask = match target {
            "game" => 7,
            "images" => 8,
            "all" => 15,
            _ => return Err("未知同步目标".into()),
        };
        let running = self.begin(target, "manual", mask, wait)?;
        let value = self.show(&running.id)?;
        let target = target.to_owned();
        tokio::spawn(async move {
            let result = super::once::run(
                &running.snapshot.config,
                &target,
                running.snapshot.transport.as_ref(),
                running.control.clone(),
            )
            .await;
            let cancelled = running.control.cancelled();
            let (ok, result) = match result {
                Ok(report) => (
                    report.ok,
                    serde_json::to_value(report).expect("sync report"),
                ),
                Err(_) => (false, json!({"message":"同步失败，请检查服务器日志"})),
            };
            running.finish(
                if cancelled {
                    "cancelled"
                } else if ok {
                    "succeeded"
                } else {
                    "failed"
                },
                result,
            );
        });
        Ok(value)
    }
    pub fn stop(&self) {
        let mut state = self.state.lock().expect("sync jobs");
        state.stopping = true;
        for job in state.jobs.iter_mut().filter(|j| j.mask != 0) {
            job.control.cancel(143);
            job.value["status"] = json!("cancelling");
        }
        self.changed.send_modify(|revision| *revision += 1);
    }
    /// Publishers are allowed to finish while network and lock waits unwind.
    pub async fn drain(&self) {
        loop {
            let notified = self.finished.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self
                .state
                .lock()
                .expect("sync jobs")
                .jobs
                .iter()
                .all(|j| j.mask == 0)
            {
                return;
            }
            notified.await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::transport::ReqwestTransport;
    fn coordinator() -> Arc<Coordinator> {
        Coordinator::new(
            Arc::new(RuntimeConfig::from_lookup(|_| None)),
            Arc::new(ReqwestTransport::new(vec![], None)),
        )
    }
    #[tokio::test]
    async fn reservations_history_snapshots_and_shutdown() {
        let owner = coordinator();
        let running = owner.begin("game", "background", 1, 0).unwrap();
        assert!(owner.begin("game", "manual", 7, 0).is_err());
        let images = owner.begin("images", "manual", 8, 0).unwrap();
        let old = owner.snapshot();
        assert_eq!(
            owner
                .replace(1, old.config.clone(), old.transport.clone())
                .unwrap(),
            2
        );
        assert!(owner
            .replace(1, old.config.clone(), old.transport.clone())
            .is_err());
        assert_eq!(running.snapshot.revision, 1);
        drop(images); // even a panicking worker releases its reservation
        assert_eq!(
            owner
                .begin("images", "manual", 8, 0)
                .unwrap()
                .snapshot
                .revision,
            2
        );
        for _ in 0..105 {
            owner
                .begin("images", "manual", 8, 0)
                .unwrap()
                .finish("succeeded", json!({}));
        }
        assert_eq!(owner.list()["jobs"].as_array().unwrap().len(), 101);
        assert_eq!(owner.show(&running.id).unwrap()["status"], "running");
        owner.stop();
        assert!(running.control.cancelled());
        assert!(owner.begin("images", "manual", 8, 0).is_err());
        running.finish("cancelled", json!({}));
        tokio::time::timeout(Duration::from_secs(1), owner.drain())
            .await
            .unwrap();
        assert_eq!(owner.list()["jobs"].as_array().unwrap().len(), 100);
    }
    #[tokio::test]
    async fn manual_cancel_unwinds_wait_without_releasing_another_owners_lock() {
        let root = std::env::temp_dir().join(format!("prts-job-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let lock = std::fs::File::create(root.join("sync.lock")).unwrap();
        lock.lock().unwrap();
        let cfg = RuntimeConfig::from_lookup(|k| match k {
            "PRTS_DATA_DIR" => Some(root.to_string_lossy().into_owned()),
            "PRTS_DATA_BACKEND" => Some("sqlite".into()),
            _ => None,
        });
        let owner = Coordinator::new(Arc::new(cfg), Arc::new(ReqwestTransport::new(vec![], None)));
        let job = owner.submit("game", 30).unwrap();
        let id = job["id"].as_str().unwrap();
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(owner.cancel(id).unwrap()["status"], "cancelling");
        tokio::time::timeout(Duration::from_secs(2), owner.drain())
            .await
            .unwrap();
        assert_eq!(owner.show(id).unwrap()["status"], "cancelled");
        assert!(std::fs::File::open(root.join("sync.lock"))
            .unwrap()
            .try_lock()
            .is_err());
        drop(lock);
        std::fs::remove_dir_all(root).unwrap();
    }
}
