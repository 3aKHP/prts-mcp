//! P1 evaluation probe: run rmcp 3.5.1's StreamableHttpService with the same
//! server identity the TS oracle reports, so the wire behavior can be diffed
//! against contracts/wire/. This is selection evidence, not product code.
//!
//! Run: cargo run --locked --example rmcp_probe -- 127.0.0.1:8901

use rmcp::model::{
    Implementation, InitializeResult, ProtocolVersion, ServerCapabilities, ToolsCapability,
};
use rmcp::transport::streamable_http_server::{
    session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
};
use rmcp::ServerHandler;

#[derive(Clone, Default)]
struct Probe;

impl ServerHandler for Probe {
    fn get_info(&self) -> InitializeResult {
        let mut info = InitializeResult::default();
        info.protocol_version = ProtocolVersion::V_2025_03_26;
        let mut capabilities = ServerCapabilities::default();
        let mut tools = ToolsCapability::default();
        tools.list_changed = Some(true);
        capabilities.tools = Some(tools);
        info.capabilities = capabilities;
        let mut server_info = Implementation::default();
        server_info.name = "PRTS_Wiki_Assistant".into();
        server_info.version = "0.1.0+ts2.8.1.local".into();
        info.server_info = server_info;
        info
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let bind = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "127.0.0.1:8901".into());
    let service = StreamableHttpService::new(
        || Ok(Probe),
        LocalSessionManager::default().into(),
        StreamableHttpServerConfig::default(),
    );
    let router = axum::Router::new().nest_service("/mcp", service);
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    eprintln!("rmcp probe listening on http://{bind}/mcp");
    axum::serve(listener, router).await?;
    Ok(())
}
