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
    post_with_headers(origin, body, session, query, &[]).await
}

async fn post_with_headers(
    origin: &str,
    body: Value,
    session: Option<&str>,
    query: &str,
    headers: &[(&str, &str)],
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
    for (name, value) in headers {
        request = request.header(*name, *value);
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
async fn legacy_protocol_headers_preserve_session_lifecycle_and_tool_calls() {
    let port = free_port();
    let mut child = spawn_http(port, &[]);
    let origin = format!("http://127.0.0.1:{port}");
    wait_health(&origin).await;

    for version in ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"] {
        let headers = [("mcp-protocol-version", version)];
        let mut init = init_body(1);
        init["params"]["protocolVersion"] = json!(version);
        let (status, sid, body) =
            post_with_headers(&origin, init.clone(), None, "", &headers).await;
        assert_eq!(status, 200, "initialize {version}: {body}");
        assert_eq!(body["result"]["protocolVersion"], version);
        let sid = sid.expect("legacy session id");
        let (status, _, _) = post_with_headers(
            &origin,
            json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
            Some(&sid),
            "",
            &headers,
        )
        .await;
        assert_eq!(status, 202);
        let (status, _, body) =
            post_with_headers(&origin, call_stages(2), Some(&sid), "", &headers).await;
        assert_eq!(status, 200, "tools/call {version}: {body}");
        assert!(body["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("关卡列表"));

        let res = reqwest::Client::new()
            .delete(format!("{origin}/mcp"))
            .header("mcp-session-id", &sid)
            .header("mcp-protocol-version", version)
            .send()
            .await
            .unwrap();
        assert_eq!(res.status().as_u16(), 200);
        let (status, _, body) =
            post_with_headers(&origin, call_stages(3), Some(&sid), "", &headers).await;
        assert_eq!(status, 404);
        assert_eq!(body["error"]["code"], -32002);
        let (status, new_sid, body) =
            post_with_headers(&origin, init, Some(&sid), "", &headers).await;
        assert_eq!(status, 200, "reinitialize {version}: {body}");
        assert_ne!(new_sid.as_deref(), Some(sid.as_str()));
    }

    // The SDK ignores Mcp-Method as an era claim without a modern revision.
    let (status, sid, body) = post_with_headers(
        &origin,
        init_body(10),
        None,
        "",
        &[("mcp-method", "initialize")],
    )
    .await;
    assert_eq!(status, 200, "Mcp-Method only: {body}");
    assert!(sid.is_some());

    child.kill().unwrap();
    let _ = child.wait();
}

#[tokio::test]
async fn modern_protocol_headers_still_require_the_envelope() {
    let port = free_port();
    let mut child = spawn_http(port, &[]);
    let origin = format!("http://127.0.0.1:{port}");
    wait_health(&origin).await;
    for version in ["2026-07-28", "2026-07-29", " 2026-07-28\t"] {
        let (status, _, body) = post_with_headers(
            &origin,
            json!({"jsonrpc":"2.0","method":"tools/list","id":1,"params":{}}),
            None,
            "",
            &[("mcp-protocol-version", version)],
        )
        .await;
        assert_eq!(status, 400, "modern {version}: {body}");
        assert_eq!(body["error"]["code"], -32602);
        assert_eq!(
            body["error"]["data"]["envelope"]["missing"],
            json!(["_meta"])
        );
    }
    child.kill().unwrap();
    let _ = child.wait();
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

/// D-005 (approved 2026-10-11): lone UTF-16 surrogate escapes are rejected
/// with an explicit parse error; this must stay a 400 + JSON-RPC -32700 with
/// a message that says what failed.
#[tokio::test]
async fn lone_surrogate_body_rejected_with_explicit_parse_error() {
    let port = free_port();
    let mut child = spawn_http(port, &[]);
    let origin = format!("http://127.0.0.1:{port}");
    wait_health(&origin).await;

    let client = reqwest::Client::new();
    let res = client
        .post(format!("{origin}/mcp"))
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .body(r#"{"jsonrpc":"2.0","method":"tools/call","id":1,"params":{"name":"list_stages","arguments":{"chapter":"\ud83d"}}}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status().as_u16(), 400);
    assert!(res.headers()["content-type"]
        .to_str()
        .unwrap()
        .starts_with("application/json"));
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["error"]["code"], -32700);
    let message = body["error"]["message"].as_str().unwrap();
    assert!(
        message.starts_with("Parse error"),
        "message must be an explicit parse error: {message}"
    );
    // Explicitness: serde names the failure mode and position (wording varies
    // with where the lone surrogate sits — e.g. "unexpected end of hex escape
    // at line 1 column N" / "lone leading surrogate in hex escape …").
    assert!(
        message.contains("hex escape") && message.contains("line 1"),
        "message should carry the failure mode and position: {message}"
    );

    child.kill().unwrap();
    let _ = child.wait();
}

/// D-006 (approved 2026-10-11): unparseable bodies get the JSON-RPC parse
/// error family, not the oracle's Express HTML page.
#[tokio::test]
async fn unparseable_body_returns_json_rpc_parse_error() {
    let port = free_port();
    let mut child = spawn_http(port, &[]);
    let origin = format!("http://127.0.0.1:{port}");
    wait_health(&origin).await;

    let client = reqwest::Client::new();
    let res = client
        .post(format!("{origin}/mcp"))
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .body("{not json")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status().as_u16(), 400);
    assert!(res.headers()["content-type"]
        .to_str()
        .unwrap()
        .starts_with("application/json"));
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["error"]["code"], -32700);
    assert!(body["error"]["message"]
        .as_str()
        .unwrap()
        .starts_with("Parse error"));

    child.kill().unwrap();
    let _ = child.wait();
}

/// Guard rail for D-005's scope: complete characters — including valid
/// surrogate pairs — must flow through untouched and match normal filtering
/// semantics (no filter hit -> the exact empty-filter message).
#[tokio::test]
async fn paired_surrogates_flow_through() {
    let port = free_port();
    let mut child = spawn_http(port, &[]);
    let origin = format!("http://127.0.0.1:{port}");
    wait_health(&origin).await;

    let (status, sid, _) = post(&origin, init_body(1), None, "").await;
    assert_eq!(status, 200);
    let sid = sid.expect("session id");
    post(
        &origin,
        json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
        Some(&sid),
        "",
    )
    .await;
    // U+20BB7 as a valid escaped surrogate pair in the JSON text.
    let (status, _, body) = post(
        &origin,
        json!({"jsonrpc":"2.0","method":"tools/call","id":2,"params":{"name":"list_stages","arguments":{"chapter":"\u{20BB7}"}}}),
        Some(&sid),
        "",
    )
    .await;
    assert_eq!(status, 200);
    let text = body["result"]["content"][0]["text"].as_str().unwrap();
    assert_eq!(
        text,
        format!("没有匹配的关卡（filter: zoneId={}）。", "\u{20BB7}")
    );

    child.kill().unwrap();
    let _ = child.wait();
}
