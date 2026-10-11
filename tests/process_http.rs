//! Process-level HTTP contract: two concurrent legacy sessions with different
//! channels must not cross wires (docs/04 HTTP session section).

use std::net::TcpListener;
use std::process::{Child, Command, Stdio};

use serde_json::{json, Value};

fn free_port() -> u16 {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("free port");
    listener.local_addr().expect("addr").port()
}

fn spawn_http(port: u16, extra_env: &[(&str, &str)]) -> Child {
    let bin = env!("CARGO_BIN_EXE_prts-mcp-rust");
    let fixture = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/.runtime/fixtures/minimal-gamedata-v1"
    );
    Command::new(bin)
        .arg("--transport")
        .arg("http")
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", std::env::var("HOME").unwrap_or_default())
        .env("GAMEDATA_PATH", fixture)
        .env("STORYJSON_PATH", format!("{fixture}/does-not-exist.zip"))
        .env("GITHUB_MIRRORS", "")
        .env("IMAGES_ENABLED", "true")
        .env("HOST", "127.0.0.1")
        .env("PORT", port.to_string())
        .envs(
            extra_env
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string())),
        )
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn http binary")
}

async fn wait_health(origin: &str) {
    for _ in 0..100 {
        if let Ok(res) = reqwest::get(format!("{origin}/health")).await {
            if res.status().is_success() {
                return;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    panic!("server did not come up");
}

async fn post(
    origin: &str,
    body: Value,
    session: Option<&str>,
    query: &str,
) -> (u16, Option<String>, Value) {
    let mut url = format!("{origin}/mcp");
    if !query.is_empty() {
        url.push('?');
        url.push_str(query);
    }
    let client = reqwest::Client::new();
    let mut request = client
        .post(&url)
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .json(&body);
    if let Some(sid) = session {
        request = request.header("mcp-session-id", sid);
    }
    let res = request.send().await.expect("post");
    let sid = res
        .headers()
        .get("mcp-session-id")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let status = res.status().as_u16();
    let text = res.text().await.expect("body");
    // SSE or JSON.
    let body = if let Some(rest) = text.strip_prefix("event: message\ndata: ") {
        serde_json::from_str(rest.trim_end()).unwrap_or(Value::Null)
    } else {
        serde_json::from_str(&text).unwrap_or(Value::Null)
    };
    (status, sid, body)
}

fn init_body(id: i64) -> Value {
    json!({
        "jsonrpc": "2.0", "method": "initialize", "id": id,
        "params": { "protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "t", "version": "0"} }
    })
}

fn call_stages(id: i64) -> Value {
    json!({ "jsonrpc": "2.0", "method": "tools/call", "id": id, "params": {"name": "list_stages", "arguments": {"limit": 2}} })
}

#[tokio::test]
async fn two_sessions_isolated_channels() {
    let port = free_port();
    let mut child = spawn_http(port, &[]);
    let origin = format!("http://127.0.0.1:{port}");
    wait_health(&origin).await;

    // Session A pins channel=structured at creation (query), session B stays content.
    let (status_a, sid_a, _) = post(&origin, init_body(1), None, "output_channel=structured").await;
    assert_eq!(status_a, 200);
    let sid_a = sid_a.expect("session A id");
    let (_, sid_b, _) = post(&origin, init_body(2), None, "").await;
    let sid_b = sid_b.expect("session B id");
    assert_ne!(sid_a, sid_b);
    post(
        &origin,
        json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
        Some(&sid_a),
        "output_channel=structured",
    )
    .await;
    post(
        &origin,
        json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
        Some(&sid_b),
        "",
    )
    .await;

    // A: later requests' query must NOT flip its pinned channel.
    let (status, _, body) = post(
        &origin,
        call_stages(3),
        Some(&sid_a),
        "output_channel=content",
    )
    .await;
    assert_eq!(status, 200);
    assert!(
        body["result"]["structuredContent"].is_object(),
        "session A stays structured"
    );
    assert_eq!(
        body["result"]["content"][0]["text"].as_str().unwrap(),
        "（结构化结果共 4 条，详见 structuredContent）"
    );

    // B: content channel, no structuredContent even when the query says structured.
    let (status, _, body) = post(
        &origin,
        call_stages(4),
        Some(&sid_b),
        "output_channel=structured",
    )
    .await;
    assert_eq!(status, 200);
    assert!(
        body["result"]["structuredContent"].is_null(),
        "session B stays content"
    );
    assert!(body["result"]["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("关卡列表"));

    // DELETE session A; its requests now 404 while B keeps working.
    let res = reqwest::Client::new()
        .delete(format!("{origin}/mcp"))
        .header("mcp-session-id", &sid_a)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status().as_u16(), 200);
    let (status, _, body) = post(&origin, call_stages(5), Some(&sid_a), "").await;
    assert_eq!(status, 404);
    assert_eq!(body["error"]["code"], -32002);
    let (status, _, body) = post(&origin, call_stages(6), Some(&sid_b), "").await;
    assert_eq!(status, 200);
    assert!(body["result"]["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("关卡列表"));

    child.kill().unwrap();
    let _ = child.wait();
}
