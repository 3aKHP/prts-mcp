//! Read-only administration of an actual running application.
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
    time::{Duration, Instant},
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
            started: Instant::now(),
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
        let value = match request.command {
            Command::Hello => {
                json!({"instance":self.instance,"startup_id":self.startup_id,"pid":std::process::id(),"server_version":crate::SERVER_VERSION,"capabilities":["status","config_show","data_status"]})
            }
            Command::Status => {
                json!({"instance":self.instance,"startup_id":self.startup_id,"pid":std::process::id(),"server_version":crate::SERVER_VERSION,"transport":self.transport,"ready":self.ready.load(Ordering::Acquire),"uptime_ms":self.started.elapsed().as_millis() as u64,"effective_backend":self.data.snapshot().effective_backend()})
            }
            Command::ConfigShow => self.configuration.clone(),
            Command::DataStatus => {
                let view = self.data.snapshot();
                json!({"scope":"runtime","effective_backend":view.effective_backend(),"database":view.database.as_ref().map(|db|db.path.to_string_lossy().into_owned()),"excel":view.excel_root.as_ref().map(|p|p.to_string_lossy().into_owned()),"levels":view.levels_root.as_ref().map(|p|p.to_string_lossy().into_owned()),"story":view.story_zip.as_ref().map(|p|p.to_string_lossy().into_owned())})
            }
        };
        Response::success(value)
    }
}

async fn connection<S: AsyncRead + AsyncWrite + Unpin>(
    mut stream: S,
    state: Arc<State>,
) -> io::Result<()> {
    let request = wire::receive(&mut stream).await?;
    wire::send(&mut stream, &state.respond(request)).await
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
                                let _permit=permit;
                                let _=tokio::time::timeout(Duration::from_secs(5),connection(stream,state)).await;
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
