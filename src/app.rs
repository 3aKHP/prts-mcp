//! Application assembly: shared state, transports, shutdown.

use std::sync::Arc;

use crate::config::RuntimeConfig;
use crate::protocol::http::{self, Shared};
use crate::protocol::session::SessionTable;
use crate::protocol::stdio;
use crate::tools::{registry, AppHandle};

pub struct App {
    pub config: RuntimeConfig,
    pub handle: AppHandle,
    pub tools: Arc<Vec<crate::tools::ToolEntry>>,
}

impl App {
    pub fn from_env() -> Self {
        Self::with_config(RuntimeConfig::from_env())
    }

    pub fn with_config(config: RuntimeConfig) -> Self {
        let handle = AppHandle::from_config(&config);
        Self {
            handle,
            tools: Arc::new(registry()),
            config,
        }
    }

    pub fn run_http(self) -> std::io::Result<()> {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()?;
        runtime.block_on(async move {
            let shared = Arc::new(Shared {
                app: self.handle,
                tools: self.tools,
                sessions: Arc::new(SessionTable::new(self.config.session_idle_timeout_ms)),
                env_channel: self.config.output_channel,
            });
            http::run_http(shared, &self.config.host, self.config.port).await
        })
    }

    pub fn run_stdio(self) -> i32 {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("tokio runtime builds");
        runtime.block_on(stdio::run_stdio(
            self.handle,
            (*self.tools).clone(),
            self.config.output_channel,
        ))
    }
}
