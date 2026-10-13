//! stdio transport: newline-delimited JSON-RPC on stdout, everything else on
//! stderr. No HTTP listener is ever created; EOF exits 0.

use tokio::io::AsyncWriteExt;

use crate::protocol::dispatch::{self, ConnectionState};
use crate::tools::output::OutputChannel;
use crate::tools::{AppHandle, ToolEntry};

pub async fn run_stdio(app: AppHandle, tools: Vec<ToolEntry>, channel: OutputChannel) -> i32 {
    crate::log_info(&format!(
        "PRTS-MCP stdio server {} connected (channel={})",
        crate::SERVER_VERSION,
        channel.as_str()
    ));

    let mut state = ConnectionState::default();
    let stdin = tokio::io::stdin();
    let mut reader = tokio::io::BufReader::new(stdin);
    let mut stdout = tokio::io::stdout();

    loop {
        let mut line = String::new();
        let n = tokio::io::AsyncBufReadExt::read_line(&mut reader, &mut line).await;
        match n {
            Ok(0) => break, // EOF
            Ok(_) => {}
            Err(err) => {
                crate::log_err(&format!("stdio read failed: {err}"));
                return 1;
            }
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(message) = serde_json::from_str::<serde_json::Value>(trimmed) else {
            // The oracle emits nothing for an unparseable line.
            continue;
        };
        if !message.is_object() {
            continue;
        }
        if let Some(response) =
            dispatch::handle_stdio_message(&mut state, &message, channel, &app, &tools).await
        {
            let mut payload = serde_json::to_string(&response).unwrap_or_default();
            payload.push('\n');
            if stdout.write_all(payload.as_bytes()).await.is_err() {
                return 1;
            }
            let _ = stdout.flush().await;
        }
    }
    0
}
