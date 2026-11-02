//! Local administration of an actual running application.
use super::wire::{self, Command, Request, Response};
use crate::app::DataState;
use serde_json::{json, Value};
use std::{
    io,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Instant,
};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    sync::Semaphore,
    task::JoinSet,
};

pub struct State {
    pub ready: Arc<AtomicBool>,
    pub instance: String,
    pub startup_id: String,
    pub transport: &'static str,
    pub configuration: Value,
    pub data: Arc<DataState>,
    pub reload: Option<super::reload::Configuration>,
    pub jobs: Option<Arc<crate::sync::jobs::Coordinator>>,
    started: Instant,
}
impl State {
    pub fn new(
        instance: String,
        transport: &'static str,
        configuration: Value,
        data: Arc<DataState>,
    ) -> Self {
        Self {
            ready: Arc::new(AtomicBool::new(false)),
            instance,
            startup_id: uuid::Uuid::new_v4().to_string(),
            transport,
            configuration,
            data,
            jobs: None,
            reload: None,
            started: Instant::now(),
        }
    }
    fn job_result(
        &self,
        action: impl FnOnce(&Arc<crate::sync::jobs::Coordinator>) -> Result<Value, String>,
    ) -> Response {
        match self
            .jobs
            .as_ref()
            .ok_or_else(|| "同步管理不可用".into())
            .and_then(action)
        {
            Ok(value) => Response::success(value),
            Err(error) => Response::failure("job_operation", &error),
        }
    }
    fn respond(&self, request: Request) -> Response {
        if request.protocol_version != wire::PROTOCOL_VERSION {
            return Response::failure("protocol_version", "不兼容的管理协议版本");
        }
        if request.instance != self.instance {
            return Response::failure("instance_mismatch", "管理端点实例名称不匹配");
        }
        if request
            .expected_startup_id
            .as_ref()
            .is_some_and(|id| id != &self.startup_id)
        {
            return Response::failure("instance_restarted", "实例已经重启，请重新连接");
        }
        if matches!(
            request.command,
            Command::DataSync { .. } | Command::JobCancel { .. } | Command::ConfigReload { .. }
        ) && request.expected_startup_id.as_deref() != Some(&self.startup_id)
        {
            return Response::failure("startup_id_required", "写操作必须提供握手取得的 startup_id");
        }
        let value = match request.command {
            Command::Hello => {
                json!({"schema_version":1,"instance":self.instance,"startup_id":self.startup_id,"pid":std::process::id(),"server_version":crate::SERVER_VERSION,"capabilities":["status","config_show","data_status","data_sync","jobs_list","job_show","job_cancel","config_diff","config_reload"]})
            }
            Command::Status => {
                json!({"schema_version":1,"instance":self.instance,"startup_id":self.startup_id,"pid":std::process::id(),"server_version":crate::SERVER_VERSION,"transport":self.transport,"ready":self.ready.load(Ordering::Acquire),"uptime_ms":self.started.elapsed().as_millis() as u64,"effective_backend":self.data.snapshot().effective_backend()})
            }
            Command::ConfigShow => self
                .reload
                .as_ref()
                .map(|r| r.show())
                .unwrap_or_else(|| self.configuration.clone()),
            Command::ConfigDiff | Command::ConfigReload { .. } => {
                let expected = match request.command {
                    Command::ConfigReload { expected_revision } => Some(expected_revision),
                    _ => None,
                };
                return match self
                    .reload
                    .as_ref()
                    .ok_or_else(|| "配置重载不可用".to_owned())
                    .and_then(|r| r.evaluate(expected))
                {
                    Ok(value) => Response::success(value),
                    Err(error) => Response::failure("configuration", &error),
                };
            }
            Command::DataSync {
                target,
                wait_timeout,
            } => return self.job_result(|jobs| jobs.submit(&target, wait_timeout)),
            Command::JobsList => return self.job_result(|jobs| Ok(jobs.list())),
            Command::JobShow { id } => return self.job_result(|jobs| jobs.show(&id)),
            Command::JobCancel { id } => return self.job_result(|jobs| jobs.cancel(&id)),
            Command::DataStatus => {
                let view = self.data.snapshot();
                json!({"schema_version":1,"scope":"runtime","effective_backend":view.effective_backend(),"database":view.database.as_ref().map(|db|db.path.to_string_lossy().into_owned()),"excel":view.excel_root.as_ref().map(|p|p.to_string_lossy().into_owned()),"levels":view.levels_root.as_ref().map(|p|p.to_string_lossy().into_owned()),"story":view.story_zip.as_ref().map(|p|p.to_string_lossy().into_owned())})
            }
        };
        Response::success(value)
    }
}

async fn connection<S: AsyncRead + AsyncWrite + Unpin>(
    mut stream: S,
    state: Arc<State>,
    permit: tokio::sync::OwnedSemaphorePermit,
) -> io::Result<()> {
    let request: Request =
        tokio::time::timeout(wire::HANDSHAKE_TIMEOUT, wire::receive(&mut stream))
            .await
            .map_err(|_| {
                io::Error::new(io::ErrorKind::TimedOut, "management request read timed out")
            })??;
    tokio::time::timeout(request.command.response_timeout(), async move {
        let (response, _permit) =
            tokio::task::spawn_blocking(move || (state.respond(request), permit))
                .await
                .map_err(io::Error::other)?;
        wire::send(&mut stream, &response).await
    })
    .await
    .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "management response timed out"))?
}

/// Disabled by default; callers keep this task owned by the server runtime.
pub struct Server {
    pub ready: Arc<AtomicBool>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Server {
    fn drop(&mut self) {
        self.ready.store(false, Ordering::Release);
        self.task.abort();
    }
}

pub async fn start(state: Arc<State>) -> io::Result<Option<Server>> {
    let Some(endpoint) = std::env::var_os("PRTS_CONTROL_ENDPOINT").filter(|v| !v.is_empty()) else {
        return Ok(None);
    };
    if !super::instances::valid_name(&state.instance) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid PRTS_INSTANCE_NAME",
        ));
    }
    let endpoint = PathBuf::from(endpoint);
    #[cfg(unix)]
    let listener = super::unix::Listener::bind(&endpoint).await?;
    #[cfg(windows)]
    let mut listener = super::windows::Listener::bind(&endpoint)?;
    let ready = state.ready.clone();
    let task = tokio::spawn(async move {
        let permits = Arc::new(Semaphore::new(32));
        let mut connections = JoinSet::new();
        loop {
            tokio::select! {
                Some(_)=connections.join_next(), if !connections.is_empty()=>{},
                accepted=listener.accept()=>{
                    match accepted {
                        Ok(stream)=>{
                            let Ok(permit)=permits.clone().try_acquire_owned() else {continue};
                            let state=state.clone();
                            connections.spawn(async move {
                                let _=connection(stream,state,permit).await;
                            });
                        }
                        Err(error) if error.kind()==io::ErrorKind::PermissionDenied=>continue,
                        Err(_)=>{crate::log_warn("Local management listener failed");break;}
                    }
                }
            }
        }
    });
    Ok(Some(Server { ready, task }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test(start_paused = true)]
    async fn incomplete_request_still_times_out_after_five_seconds() {
        use tokio::io::AsyncWriteExt;
        let cfg = Arc::new(crate::config::RuntimeConfig::from_lookup(|_| None));
        let state = Arc::new(State::new(
            "main".into(),
            "stdio",
            json!({}),
            Arc::new(DataState::new(cfg)),
        ));
        let permits = Arc::new(Semaphore::new(1));
        let (mut client, server) = tokio::io::duplex(128);
        client.write_u32(100).await.unwrap();
        let started = tokio::time::Instant::now();
        let result = connection(
            server,
            state,
            permits.clone().acquire_owned().await.unwrap(),
        )
        .await;
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::TimedOut);
        assert_eq!(started.elapsed(), wire::HANDSHAKE_TIMEOUT);
        assert!(permits.try_acquire_owned().is_ok());
    }
    #[test]
    fn real_snapshot_request_survives_six_seconds_of_blocking_pool_contention() {
        // Occupy the sole blocking worker only after Hello, reproducing a
        // snapshot waiting for cold SQLite admission without a production hook.
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .max_blocking_threads(1)
            .build()
            .unwrap();
        runtime.block_on(async {
            let id = uuid::Uuid::new_v4();
            #[cfg(unix)]
            let root = PathBuf::from("/tmp").join(format!("prts-cold-{id}"));
            #[cfg(windows)]
            let root = std::env::temp_dir().join(format!("prts-cold-{id}"));
            std::fs::create_dir(&root).unwrap();
            #[cfg(unix)]
            let endpoint = root.join("run/control.sock");
            #[cfg(windows)]
            let endpoint = PathBuf::from(format!(r"\\.\pipe\prts-mcp-cold-{id}"));
            #[cfg(unix)]
            let listener = crate::control::unix::Listener::bind(&endpoint)
                .await
                .unwrap();
            #[cfg(windows)]
            let mut listener = crate::control::windows::Listener::bind(&endpoint).unwrap();
            let cfg = Arc::new(crate::config::RuntimeConfig::from_lookup(|key| {
                matches!(key, "XDG_DATA_HOME" | "LOCALAPPDATA")
                    .then(|| root.join("data").to_string_lossy().into_owned())
            }));
            let state = Arc::new(State::new(
                "main".into(),
                "stdio",
                json!({}),
                Arc::new(DataState::new(cfg)),
            ));
            let target = crate::control::instances::Instance {
                name: "main".into(),
                endpoint,
                unit: None,
                user: false,
            };
            let task = tokio::spawn(async move {
                let permits = Arc::new(Semaphore::new(1));
                connection(
                    listener.accept().await.unwrap(),
                    state.clone(),
                    permits.clone().acquire_owned().await.unwrap(),
                )
                .await
                .unwrap();
                let (ready, waiting) = tokio::sync::oneshot::channel();
                let blocker = tokio::task::spawn_blocking(move || {
                    ready.send(()).unwrap();
                    std::thread::sleep(std::time::Duration::from_secs(6));
                });
                waiting.await.unwrap();
                connection(
                    listener.accept().await.unwrap(),
                    state,
                    permits.acquire_owned().await.unwrap(),
                )
                .await
                .unwrap();
                blocker.await.unwrap();
            });
            let started = Instant::now();
            let result = crate::control::client::request(&target, Command::Status)
                .await
                .unwrap();
            assert_eq!(result["instance"], "main");
            assert!(started.elapsed() >= std::time::Duration::from_secs(6));
            task.await.unwrap();
            std::fs::remove_dir_all(root).unwrap();
        });
    }
    #[test]
    fn instance_protocol_and_startup_identity_gate_mutations() {
        let config = Arc::new(crate::config::RuntimeConfig::from_lookup(|_| None));
        let state = State::new(
            "main".into(),
            "stdio",
            json!({}),
            Arc::new(DataState::new(config)),
        );
        let request = |version, instance: &str, startup: Option<&str>| Request {
            protocol_version: version,
            command: Command::JobCancel {
                id: "unsubmitted-job".into(),
            },
            instance: instance.into(),
            expected_startup_id: startup.map(str::to_owned),
        };
        for (request, kind) in [
            (
                request(2, "main", Some(&state.startup_id)),
                "protocol_version",
            ),
            (
                request(1, "other", Some(&state.startup_id)),
                "instance_mismatch",
            ),
            (
                request(1, "main", Some("previous-startup")),
                "instance_restarted",
            ),
            (request(1, "main", None), "startup_id_required"),
        ] {
            match state.respond(request).outcome {
                super::super::wire::Outcome::Failure { error } => assert_eq!(error.kind, kind),
                _ => panic!("identity mismatch must be rejected before mutation"),
            }
        }
    }
    #[tokio::test]
    async fn slow_response_reader_keeps_connection_permit() {
        let config = Arc::new(crate::config::RuntimeConfig::from_lookup(|_| None));
        let state = Arc::new(State::new(
            "main".into(),
            "stdio",
            json!({"value":"x".repeat(10000)}),
            Arc::new(DataState::new(config)),
        ));
        let permits = Arc::new(Semaphore::new(1));
        let permit = permits.clone().acquire_owned().await.unwrap();
        let (mut client, server) = tokio::io::duplex(128);
        let request = Request {
            protocol_version: 1,
            command: Command::ConfigShow,
            instance: "main".into(),
            expected_startup_id: Some(state.startup_id.clone()),
        };
        let task = tokio::spawn(connection(server, state, permit));
        wire::send(&mut client, &request).await.unwrap();
        // Read just the header: the worker has completed, but response body
        // cannot fit in the transport buffer until this client consumes it.
        use tokio::io::AsyncReadExt;
        let size = client.read_u32().await.unwrap();
        assert!(size > 128);
        assert!(permits.clone().try_acquire_owned().is_err());
        let mut body = vec![0; size as usize];
        client.read_exact(&mut body).await.unwrap();
        task.await.unwrap().unwrap();
        assert!(permits.try_acquire_owned().is_ok());
    }
}
