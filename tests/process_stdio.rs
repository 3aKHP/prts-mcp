//! Process-level stdio contract: no HTTP listener, stdout carries only
//! protocol lines, era rules hold, EOF exits 0.

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::process::{Child, Command, Stdio};

use serde_json::Value;

fn spawn_stdio(extra_env: &[(&str, &str)]) -> Child {
    spawn_stdio_profile(
        env!("CARGO_BIN_EXE_prts-mcp-rust"),
        &["--transport", "stdio"],
        extra_env,
    )
}

fn spawn_stdio_profile(bin: &str, args: &[&str], extra_env: &[(&str, &str)]) -> Child {
    let fixture = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/.runtime/fixtures/minimal-gamedata-v1"
    );
    Command::new(bin)
        .args(args)
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", std::env::var("HOME").unwrap_or_default())
        .env("GAMEDATA_PATH", fixture)
        .env("STORYJSON_PATH", format!("{fixture}/does-not-exist.zip"))
        .env("GITHUB_MIRRORS", "")
        .env("IMAGES_ENABLED", "true")
        .env("PORT", "39999")
        .envs(
            extra_env
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string())),
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn stdio binary")
}

fn send(child: &mut Child, message: &Value) {
    let json = serde_json::to_string(message).unwrap();
    child
        .stdin
        .as_mut()
        .expect("stdin")
        .write_all(json.as_bytes())
        .unwrap();
    child.stdin.as_mut().unwrap().write_all(b"\n").unwrap();
}

fn recv(child: &mut Child, id: i64) -> Value {
    let stdout = child.stdout.as_mut().expect("stdout");
    let mut reader = BufReader::new(stdout);
    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line).expect("read stdout line");
        assert!(n > 0, "stdout closed before response for id={id}");
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let value: Value = serde_json::from_str(trimmed)
            .unwrap_or_else(|e| panic!("stdout must carry only JSON lines, got {trimmed:?}: {e}"));
        if value.get("id").and_then(|v| v.as_i64()) == Some(id) {
            return value;
        }
    }
}

const INIT: &str = r#"{"jsonrpc":"2.0","method":"initialize","id":1,"params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}"#;

#[test]
fn product_and_compatibility_stdio_profiles() {
    for (bin, transport) in [
        (env!("CARGO_BIN_EXE_prts-mcp"), " StDiO "),
        (env!("CARGO_BIN_EXE_prts-mcp-ghcr"), ""),
        (env!("CARGO_BIN_EXE_prts-mcp-ghcr"), "unknown"),
        (env!("CARGO_BIN_EXE_prts-mcp-ts-stdio"), "http"),
    ] {
        let mut child = spawn_stdio_profile(
            bin,
            &[],
            &[("PRTS_TRANSPORT", transport), ("PORT", "invalid")],
        );
        send(&mut child, &serde_json::from_str(INIT).unwrap());
        let response = recv(&mut child, 1);
        assert_eq!(
            response["result"]["serverInfo"]["version"],
            env!("CARGO_PKG_VERSION")
        );
        drop(child.stdin.take());
        assert!(
            child.wait().unwrap().success(),
            "{bin} must exit cleanly on EOF"
        );
    }
}

#[test]
fn stdio_handshake_and_tools_call() {
    let mut child = spawn_stdio(&[]);
    send(&mut child, &serde_json::from_str(INIT).unwrap());
    let init = recv(&mut child, 1);
    assert_eq!(init["result"]["serverInfo"]["name"], "PRTS_Wiki_Assistant");
    assert_eq!(init["result"]["protocolVersion"], "2024-11-05");
    send(
        &mut child,
        &serde_json::from_str(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#).unwrap(),
    );
    send(&mut child, &serde_json::from_str(r#"{"jsonrpc":"2.0","method":"tools/call","id":2,"params":{"name":"list_stages","arguments":{"limit":2}}}"#).unwrap());
    let call = recv(&mut child, 2);
    assert!(call["result"]["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("关卡列表"));
    // Invalid line: no output.
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(b"{broken\n")
        .unwrap();
    // Unknown method still answers.
    send(
        &mut child,
        &serde_json::from_str(r#"{"jsonrpc":"2.0","method":"no/such","id":3}"#).unwrap(),
    );
    let err = recv(&mut child, 3);
    assert_eq!(err["error"]["code"], -32601);
    // Clean EOF exit.
    drop(child.stdin.take());
    let status = child.wait().unwrap();
    assert!(status.success(), "EOF must exit 0, got {status:?}");
}

#[test]
fn stdio_binds_no_tcp_port() {
    // Bind a probe port, drop it, spawn stdio with that PORT set, then verify
    // the port stays free (server-stdio must never import the HTTP entry).
    let probe_port = 39998u16;
    {
        let listener = TcpListener::bind(("127.0.0.1", probe_port)).expect("probe binds");
        drop(listener);
    }
    let mut child = spawn_stdio(&[("PORT", "39998")]);
    send(&mut child, &serde_json::from_str(INIT).unwrap());
    let _ = recv(&mut child, 1);
    std::thread::sleep(std::time::Duration::from_millis(300));
    let rebound = TcpListener::bind(("127.0.0.1", probe_port));
    assert!(
        rebound.is_ok(),
        "stdio server must not bind TCP {probe_port}"
    );
    drop(rebound);
    drop(child.stdin.take());
    let _ = child.wait();
}

#[test]
fn stdio_modern_then_legacy_initialize_rejected() {
    let mut child = spawn_stdio(&[]);
    send(&mut child, &serde_json::from_str(
        r#"{"jsonrpc":"2.0","method":"server/discover","id":10,"params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"t","version":"0"},"io.modelcontextprotocol/clientCapabilities":{}}}}"#,
    ).unwrap());
    let discover = recv(&mut child, 10);
    assert_eq!(discover["result"]["supportedVersions"][0], "2026-07-28");
    send(&mut child, &serde_json::from_str(INIT).unwrap());
    let rejected = recv(&mut child, 1);
    assert_eq!(rejected["error"]["code"], -32022);
    drop(child.stdin.take());
    assert!(child.wait().unwrap().success());
}
