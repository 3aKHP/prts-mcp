//! P7 process-level contracts: debug endpoints (D-002), per-profile PORT
//! semantics, signal/EOF exit behavior, and the bundled-data fallback
//! (package layout / `--bundle-root`).

use std::io::{Read, Write};
use std::net::TcpListener;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

fn free_port() -> u16 {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("free port");
    listener.local_addr().expect("addr").port()
}

fn fixture(name: &str) -> String {
    format!("{}/.runtime/fixtures/{name}", env!("CARGO_MANIFEST_DIR"))
}

struct ServerGuard(Child);

impl Drop for ServerGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// std has no stable wait_timeout — poll try_wait.
fn wait_with_timeout(child: &mut Child, limit: Duration) -> Option<ExitStatus> {
    let deadline = Instant::now() + limit;
    loop {
        if let Some(status) = child.try_wait().expect("child alive") {
            return Some(status);
        }
        if Instant::now() > deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn base_env() -> Vec<(String, String)> {
    vec![
        ("PATH".into(), std::env::var("PATH").unwrap_or_default()),
        ("HOME".into(), std::env::var("HOME").unwrap_or_default()),
        ("GAMEDATA_PATH".into(), fixture("empty-gamedata-v1")),
        (
            "STORYJSON_PATH".into(),
            fixture("empty-gamedata-v1") + "/does-not-exist.zip",
        ),
        ("GITHUB_MIRRORS".into(), String::new()),
        ("IMAGES_ENABLED".into(), "true".into()),
        ("HOST".into(), "127.0.0.1".into()),
    ]
}

fn spawn_bin(bin: &str, args: &[&str], env_extra: &[(&str, &str)]) -> Child {
    Command::new(bin)
        .args(args)
        .env_clear()
        .envs(base_env())
        .envs(
            env_extra
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string())),
        )
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn binary")
}

fn spawn_http(bin: &str, port: &str, env_extra: &[(&str, &str)]) -> ServerGuard {
    let mut envs: Vec<(&str, &str)> = vec![("PORT", port)];
    envs.extend_from_slice(env_extra);
    ServerGuard(spawn_bin(bin, &["--transport", "http"], &envs))
}

async fn wait_origin(origin: &str) {
    for _ in 0..150 {
        if let Ok(res) = reqwest::get(format!("{origin}/health")).await {
            if res.status().is_success() {
                return;
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("server did not come up at {origin}");
}

#[tokio::test]
async fn product_default_and_compatibility_http_profiles() {
    for (bin, transport) in [
        (env!("CARGO_BIN_EXE_prts-mcp"), None),
        (env!("CARGO_BIN_EXE_prts-mcp"), Some("")),
        (env!("CARGO_BIN_EXE_prts-mcp"), Some("unknown")),
        (env!("CARGO_BIN_EXE_prts-mcp"), Some(" HTTP ")),
        (env!("CARGO_BIN_EXE_prts-mcp-ghcr"), Some(" HtTp ")),
        (env!("CARGO_BIN_EXE_prts-mcp-ts"), Some("stdio")),
        (env!("CARGO_BIN_EXE_prts-mcp-ts-bun"), Some("stdio")),
    ] {
        let port = free_port().to_string();
        let mut extra = vec![("PORT", port.as_str())];
        if let Some(value) = transport {
            extra.push(("PRTS_TRANSPORT", value));
        }
        let _guard = ServerGuard(spawn_bin(bin, &[], &extra));
        wait_origin(&format!("http://127.0.0.1:{port}")).await;
    }
}

async fn get(origin: &str, path: &str, headers: &[(&str, &str)]) -> (u16, String) {
    let client = reqwest::Client::new();
    let mut request = client.get(format!("{origin}{path}"));
    for (k, v) in headers {
        request = request.header(*k, *v);
    }
    let res = request.send().await.expect("get");
    let status = res.status().as_u16();
    (status, res.text().await.expect("body"))
}

async fn post_mcp(
    origin: &str,
    body: Value,
    session: Option<&str>,
) -> (u16, Value, Option<String>) {
    let client = reqwest::Client::new();
    let mut request = client
        .post(format!("{origin}/mcp"))
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
    let body = text
        .lines()
        .find_map(|l| l.strip_prefix("data: "))
        .and_then(|d| serde_json::from_str(d).ok())
        .unwrap_or(Value::Null);
    (status, body, sid)
}

// ---------------------------------------------------------------------------
// /debug endpoints: auth, 404 parity, schemas (D-002)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn debug_endpoints_auth_and_schemas() {
    let port = free_port();
    let origin = format!("http://127.0.0.1:{port}");
    let _guard = spawn_http(
        env!("CARGO_BIN_EXE_prts-mcp-rust"),
        &port.to_string(),
        &[
            ("PRTS_DEBUG_TOKEN", "sekrit"),
            ("PRTS_METRICS_ENABLED", "true"),
        ],
    );
    wait_origin(&origin).await;

    let (status, body) = get(&origin, "/health", &[]).await;
    assert_eq!(status, 200);
    assert_eq!(body, "{\"status\":\"ok\"}");

    let auth = [("authorization", "Bearer sekrit")];
    // Missing / wrong token → Express sendStatus parity: 404 "Not Found".
    for headers in [
        &[][..],
        &[("authorization", "Bearer nope")][..],
        &[("authorization", "sekrit")][..],
    ] {
        let (status, body) = get(&origin, "/debug/cache", headers).await;
        assert_eq!(status, 404, "cache with {headers:?}");
        assert_eq!(body, "Not Found");
        let (status, _) = get(&origin, "/debug/metrics", headers).await;
        assert_eq!(status, 404, "metrics with {headers:?}");
    }

    // Correct token → the 11-domain cache projection.
    let (status, body) = get(&origin, "/debug/cache", &auth).await;
    assert_eq!(status, 200);
    let cache: Value = serde_json::from_str(&body).expect("cache json");
    let domains: Vec<&str> = cache
        .as_object()
        .unwrap()
        .keys()
        .map(|k| k.as_str())
        .collect();
    assert_eq!(
        domains,
        [
            "operator",
            "enemy",
            "stage",
            "stage_enemy",
            "item",
            "search",
            "building",
            "skill",
            "story_search",
            "images",
            "artwork_mediawiki"
        ]
    );

    // Metrics: Rust schema (D-002), no V8 heap fields.
    let (status, body) = get(&origin, "/debug/metrics", &auth).await;
    assert_eq!(status, 200);
    let metrics: Value = serde_json::from_str(&body).expect("metrics json");
    assert_eq!(metrics["schema_version"], "prts-mcp.rust.metrics/v1");
    assert_eq!(metrics["process"]["runtime"], "rust");
    for absent in [
        "heap_total_bytes",
        "heap_used_bytes",
        "external_bytes",
        "array_buffers_bytes",
    ] {
        assert!(metrics["process"].get(absent).is_none());
    }
    assert!(metrics["process"]["rss_bytes"].as_u64().unwrap() > 0);
    assert!(metrics["process"]["rss_high_water_bytes"].as_u64().unwrap() > 0);
    // Token never appears anywhere in diagnostics output.
    assert!(!body.contains("sekrit"));
}

#[tokio::test]
async fn metrics_flag_is_strict_true() {
    let port = free_port();
    let origin = format!("http://127.0.0.1:{port}");
    // TRUE / 1 / empty / " true" are all off — only the exact string counts.
    let _guard = spawn_http(
        env!("CARGO_BIN_EXE_prts-mcp-rust"),
        &port.to_string(),
        &[
            ("PRTS_DEBUG_TOKEN", "sekrit"),
            ("PRTS_METRICS_ENABLED", "TRUE"),
        ],
    );
    wait_origin(&origin).await;
    let (status, body) = get(
        &origin,
        "/debug/metrics",
        &[("authorization", "Bearer sekrit")],
    )
    .await;
    assert_eq!(status, 404);
    assert_eq!(body, "Not Found");
}

#[tokio::test]
async fn metrics_counters_track_real_activity() {
    let port = free_port();
    let origin = format!("http://127.0.0.1:{port}");
    // Real gamedata fixture so tools/call reaches the dataset caches.
    let gamedata = fixture("minimal-gamedata-v1");
    let _guard = ServerGuard(spawn_bin(
        env!("CARGO_BIN_EXE_prts-mcp-rust"),
        &["--transport", "http"],
        &[
            ("PORT", &port.to_string()),
            ("PRTS_DEBUG_TOKEN", "sekrit"),
            ("PRTS_METRICS_ENABLED", "true"),
            ("GAMEDATA_PATH", &gamedata),
            ("STORYJSON_PATH", &format!("{gamedata}/does-not-exist.zip")),
        ],
    ));
    wait_origin(&origin).await;

    let initialize = json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                   "clientInfo": {"name": "t", "version": "0"}}
    });
    let (_, _, session) = post_mcp(&origin, initialize, None).await;
    let session = session.expect("session id");

    let call = json!({
        "jsonrpc": "2.0", "id": 2, "method": "tools/call",
        "params": {"name": "list_stages", "arguments": {}}
    });
    let (status, body, _) = post_mcp(&origin, call, Some(&session)).await;
    assert_eq!(status, 200);
    assert!(
        body["result"]["content"].is_array(),
        "tool call ran: {body}"
    );
    // Second call hits the caches.
    let call2 = json!({
        "jsonrpc": "2.0", "id": 3, "method": "tools/call",
        "params": {"name": "list_stages", "arguments": {}}
    });
    post_mcp(&origin, call2, Some(&session)).await;

    let client = reqwest::Client::new();
    let res = client
        .delete(format!("{origin}/mcp"))
        .header("mcp-session-id", &session)
        .send()
        .await
        .expect("delete");
    assert_eq!(res.status().as_u16(), 200);

    let (_, body) = get(
        &origin,
        "/debug/metrics",
        &[("authorization", "Bearer sekrit")],
    )
    .await;
    let metrics: Value = serde_json::from_str(&body).expect("metrics json");
    assert!(metrics["requests"]["total"].as_u64().unwrap() >= 4);
    assert_eq!(metrics["sessions"]["initialized_total"], 1);
    assert_eq!(metrics["sessions"]["closed_total"], 1);
    assert_eq!(metrics["sessions"]["active"], 0);
    assert_eq!(metrics["tool_calls"]["total"], 2);
    assert_eq!(metrics["tool_calls"]["by_name"]["list_stages"]["total"], 2);
    assert_eq!(
        metrics["tool_calls"]["by_name"]["list_stages"]["in_flight"],
        0
    );

    // Real cache activity. Rust reads stage_table once per generation
    // (stages_map caches the projection and short-circuits later calls), so
    // the repeating hit lands on stages_map / zone_table instead — the
    // documented cache-merge mapping (reports/P7.md).
    let stage = &metrics["cache"]["stage"];
    assert_eq!(stage["stage_table"]["loaded"], true);
    assert!(stage["stage_table"]["count"].as_u64().unwrap() > 0);
    assert_eq!(stage["stages_map"]["loaded"], true);
    assert_eq!(stage["stages_map"]["hits"], 1);
    assert_eq!(stage["stages_map"]["misses"], 1);
    assert_eq!(stage["zone_table"]["hits"], 1);
}

// ---------------------------------------------------------------------------
// PORT semantics per entry profile (oracle-pinned)
// ---------------------------------------------------------------------------

/// Drain the child's stderr on a thread (a blocking pipe read can't be
/// deadline-polled) and wait until the log line shows up.
fn wait_stderr_contains(child: &mut Child, needle: &str, limit: Duration) -> String {
    use std::sync::{Arc, Mutex};
    let collected = Arc::new(Mutex::new(String::new()));
    let sink = Arc::clone(&collected);
    let mut stderr = child.stderr.take().expect("stderr");
    std::thread::spawn(move || {
        let mut raw = [0u8; 16384];
        while let Ok(n) = stderr.read(&mut raw) {
            if n == 0 {
                break;
            }
            sink.lock()
                .unwrap()
                .push_str(&String::from_utf8_lossy(&raw[..n]));
        }
    });
    let deadline = Instant::now() + limit;
    loop {
        {
            let text = collected.lock().unwrap().clone();
            if text.contains(needle) || Instant::now() > deadline {
                // Give the thread a moment to finish draining, then return.
                std::thread::sleep(Duration::from_millis(80));
                return collected.lock().unwrap().clone();
            }
        }
        std::thread::sleep(Duration::from_millis(30));
    }
}

#[tokio::test]
async fn port_number_semantics_ts_profile() {
    // The startup log echoes Number(PORT) verbatim (oracle-pinned values).
    // Bind numeric spellings on a fresh non-privileged port so a normal CI
    // user can exercise the same semantics. Fixed low-value conversions
    // (1e2 -> 100 and 0x10 -> 16) remain covered by config's parser tests.
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("free");
    let frac_port = listener.local_addr().unwrap().port();
    drop(listener);
    let cases: [(String, String, Option<u16>); 6] = [
        ("abc".into(), "NaN".into(), None),
        ("".into(), "0".into(), None),
        (
            format!("{frac_port}.5"),
            format!("{frac_port}.5"),
            Some(frac_port),
        ),
        (
            format!("{frac_port}e0"),
            frac_port.to_string(),
            Some(frac_port),
        ),
        (
            format!("0x{frac_port:x}"),
            frac_port.to_string(),
            Some(frac_port),
        ),
        // ("70000" binds 65535 — asserted in the clamp test below instead,
        // one 65535 holder at a time under parallel tests.)
        ("-1".into(), "-1".into(), None),
    ];
    for (raw, display, bound_port) in cases {
        let mut guard = spawn_http(env!("CARGO_BIN_EXE_prts-mcp-rust"), raw.as_str(), &[]);
        let stderr = wait_stderr_contains(&mut guard.0, "listening on", Duration::from_secs(10));
        let expected = format!("listening on 127.0.0.1:{display} (StreamableHTTP at /mcp)");
        assert!(
            stderr.contains(&expected),
            "PORT {raw:?}: log should contain {expected:?}, got: {stderr}"
        );
        if let Some(port) = bound_port {
            wait_origin(&format!("http://127.0.0.1:{port}")).await;
        }
        drop(guard);
    }
}

#[tokio::test]
async fn port_fractional_binds_truncated_and_70000_clamps() {
    // <port>.5 binds the truncated port (bun truncation, oracle-pinned).
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("free");
    let port_base = listener.local_addr().unwrap().port();
    drop(listener);
    let _guard = spawn_http(
        env!("CARGO_BIN_EXE_prts-mcp-rust"),
        &format!("{port_base}.5"),
        &[],
    );
    wait_origin(&format!("http://127.0.0.1:{port_base}")).await;

    // 65535 is the clamp ceiling — bind it to prove clamping lands.
    let _guard2 = spawn_http(env!("CARGO_BIN_EXE_prts-mcp-rust"), "70000", &[]);
    wait_origin("http://127.0.0.1:65535").await;
}

#[tokio::test]
async fn port_invalid_does_not_default_to_3000() {
    // NaN / 0 / -1 all bind EPHEMERAL ports: with 3000 already taken by us,
    // the server must still start (it did not fall back to 3000).
    let holder = TcpListener::bind(("127.0.0.1", 3000)).expect("hold 3000");
    for raw in ["abc", "", "-1"] {
        let mut guard = spawn_http(env!("CARGO_BIN_EXE_prts-mcp-rust"), raw, &[]);
        tokio::time::sleep(Duration::from_millis(600)).await;
        assert!(
            guard.0.try_wait().expect("wait").is_none(),
            "PORT {raw:?} must not exit"
        );
        drop(guard);
    }
    drop(holder);
}

#[tokio::test]
async fn ghcr_profile_port_semantics() {
    let bin = env!("CARGO_BIN_EXE_prts-mcp-ghcr");
    // Non-numeric PORT on the HTTP branch: python-style message, exit 1.
    for raw in ["abc", "3000.5", "0x10", " 42x"] {
        let mut child = spawn_bin(
            bin,
            &[],
            &[
                ("PRTS_TRANSPORT", "http"),
                ("PORT", raw),
                ("PRTS_AUTO_SYNC_INTERVAL_SECONDS", "60"),
            ],
        );
        let output = wait_with_timeout(&mut child, Duration::from_secs(10)).expect("exits");
        assert_eq!(output.code(), Some(1), "PORT {raw:?} exits 1");
        let mut stderr = String::new();
        child
            .stderr
            .take()
            .unwrap()
            .read_to_string(&mut stderr)
            .unwrap();
        assert!(
            stderr.contains(&format!("PORT must be numeric, got '{raw}'. Exiting.")),
            "PORT {raw:?}: {stderr}"
        );
    }

    // Whitespace is allowed (int() strips) and serves.
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("free");
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let _guard = ServerGuard(spawn_bin(
        bin,
        &[],
        &[("PRTS_TRANSPORT", "http"), ("PORT", &format!(" {port} "))],
    ));
    wait_origin(&format!("http://127.0.0.1:{port}")).await;

    // stdio branch never parses PORT: PORT=abc stays alive and answers.
    let mut child = Command::new(bin)
        .env_clear()
        .envs(base_env())
        .env("PRTS_TRANSPORT", "stdio")
        .env("PORT", "abc")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn ghcr stdio");
    tokio::time::sleep(Duration::from_millis(400)).await;
    let initialize = json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                   "clientInfo": {"name": "t", "version": "0"}}
    });
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(format!("{}\n", initialize).as_bytes())
        .unwrap();
    let mut out = String::new();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !out.contains("serverInfo") && Instant::now() < deadline {
        let mut chunk = [0u8; 4096];
        let n = child.stdout.as_mut().unwrap().read(&mut chunk).unwrap_or(0);
        if n > 0 {
            out.push_str(&String::from_utf8_lossy(&chunk[..n]));
        }
    }
    assert!(
        out.contains("serverInfo"),
        "stdio answered despite PORT=abc"
    );
    drop(child.stdin.take());
    let status = child.wait().unwrap();
    assert_eq!(status.code(), Some(0));
    let _ = child.kill();
}

// ---------------------------------------------------------------------------
// Signals / EOF (docs/04: process tests; downloads never gate shutdown)
// ---------------------------------------------------------------------------

#[test]
fn signals_and_eof_exit_behavior() {
    // HTTP: SIGTERM/SIGINT kill promptly even while the sync retry ladder is
    // armed against a dead mirror (download completion is not a gate).
    for sig in ["TERM", "INT"] {
        let mut child = spawn_bin(
            env!("CARGO_BIN_EXE_prts-mcp-rust"),
            &["--transport", "http"],
            &[
                ("GITHUB_MIRRORS", "http://127.0.0.1:9/"),
                ("PORT", "0"),
                ("PRTS_AUTO_SYNC_INTERVAL_SECONDS", "60"),
            ],
        );
        std::thread::sleep(Duration::from_millis(700));
        let kill = Command::new("kill")
            .arg(format!("-{}", sig))
            .arg(child.id().to_string())
            .status()
            .expect("kill binary");
        assert!(kill.success(), "signal delivered");
        let start = Instant::now();
        let status = wait_with_timeout(&mut child, Duration::from_secs(5))
            .expect("signal exits the process");
        assert!(start.elapsed() < Duration::from_secs(2), "prompt exit");
        assert_eq!(status.code(), None, "terminated by signal");
        assert_eq!(
            std::os::unix::process::ExitStatusExt::signal(&status),
            Some(if sig == "TERM" { 15 } else { 2 })
        );
    }

    // stdio: EOF → exit 0 (P1 contract; re-pinned with the retry ladder armed).
    let mut child = Command::new(env!("CARGO_BIN_EXE_prts-mcp-rust"))
        .arg("--transport")
        .arg("stdio")
        .env_clear()
        .envs(base_env())
        .env("GITHUB_MIRRORS", "http://127.0.0.1:9/")
        .env("PRTS_AUTO_SYNC_INTERVAL_SECONDS", "60")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn stdio");
    std::thread::sleep(Duration::from_millis(400));
    drop(child.stdin.take());
    let status = wait_with_timeout(&mut child, Duration::from_secs(10)).expect("EOF exits");
    assert_eq!(status.code(), Some(0));
}

// ---------------------------------------------------------------------------
// Bundled-data fallback (package layout)
// ---------------------------------------------------------------------------

fn copy_dir(src: &std::path::Path, dst: &std::path::Path) {
    std::fs::create_dir_all(dst).unwrap();
    for entry in std::fs::read_dir(src).unwrap() {
        let entry = entry.unwrap();
        let target = dst.join(entry.file_name());
        if entry.path().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), target).unwrap();
        }
    }
}

/// Build a TS-package-layout bundle dir (`gamedata/` + `storyjson/`) from
/// the minimal-gamedata-v2 fixture (which is itself a gamedata root).
fn make_bundle(target: &std::path::Path) {
    let fixture_dir = fixture("minimal-gamedata-v2");
    let source = std::path::Path::new(&fixture_dir);
    std::fs::create_dir_all(target).unwrap();
    copy_dir(&source.join("zh_CN"), &target.join("gamedata/zh_CN"));
    std::fs::create_dir_all(target.join("storyjson")).unwrap();
    std::fs::copy(
        source.join("storyjson/zh_CN.zip"),
        target.join("storyjson/zh_CN.zip"),
    )
    .unwrap();
}

fn stdio_call(bin: &str, args: &[&str], payload: Value) -> Value {
    let mut child = Command::new(bin)
        .args(args)
        .env_clear()
        .envs(base_env())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn stdio");
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(format!("{}\n", payload).as_bytes())
        .unwrap();
    let mut out = String::new();
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        let mut chunk = [0u8; 8192];
        let n = child.stdout.as_mut().unwrap().read(&mut chunk).unwrap_or(0);
        if n > 0 {
            out.push_str(&String::from_utf8_lossy(&chunk[..n]));
            if out.contains("\"id\"") {
                break;
            }
        }
    }
    drop(child.stdin.take());
    let _ = child.wait();
    serde_json::from_str(out.trim()).unwrap_or(Value::Null)
}

#[test]
fn bundle_root_argument_fills_missing_data() {
    // Custom-but-empty GAMEDATA_PATH + `--bundle-root` package dir: the
    // bundled generation serves excel data (TS BUNDLED_GAMEDATA_PATH).
    let temp = std::env::temp_dir().join(format!(
        "prts-p7-bundle-{}-{}",
        std::process::id(),
        free_port()
    ));
    let bundle = temp.join("data");
    make_bundle(&bundle);

    let call = json!({
        "jsonrpc": "2.0", "id": 7, "method": "tools/call",
        "params": {"name": "list_stages", "arguments": {}}
    });
    let result = stdio_call(
        env!("CARGO_BIN_EXE_prts-mcp-rust"),
        &[
            "--transport",
            "stdio",
            "--bundle-root",
            bundle.to_str().unwrap(),
        ],
        call,
    );
    let text = result["result"]["content"][0]["text"]
        .as_str()
        .unwrap_or_default();
    assert!(
        !text.contains("数据暂不可用"),
        "bundled data must serve list_stages: {result}"
    );

    let _ = std::fs::remove_dir_all(&temp);
}

#[test]
fn exe_relative_bundle_layout() {
    // Native package layout: <root>/bin/<binary> + <root>/data/… — the
    // binary finds the sibling bundle without any launcher help.
    let temp = std::env::temp_dir().join(format!(
        "prts-p7-native-{}-{}",
        std::process::id(),
        free_port()
    ));
    let bin_dir = temp.join("bin");
    std::fs::create_dir_all(&bin_dir).unwrap();
    std::fs::copy(
        env!("CARGO_BIN_EXE_prts-mcp-rust"),
        bin_dir.join("prts-mcp-rust"),
    )
    .unwrap();
    make_bundle(&temp.join("data"));

    let bin = bin_dir.join("prts-mcp-rust");
    let call = json!({
        "jsonrpc": "2.0", "id": 9, "method": "tools/call",
        "params": {"name": "list_stages", "arguments": {}}
    });
    let result = stdio_call(bin.to_str().unwrap(), &["--transport", "stdio"], call);
    let text = result["result"]["content"][0]["text"]
        .as_str()
        .unwrap_or_default();
    assert!(
        !text.contains("数据暂不可用"),
        "exe-relative bundle must serve: {result}"
    );

    let _ = std::fs::remove_dir_all(&temp);
}
