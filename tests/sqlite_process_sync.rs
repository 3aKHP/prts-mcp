//! Process-level sync contract: missing data → background sync → readable
//! without restart, and stdio exit with pending retry timers (docs/05
//! "传输与调度" + docs/07 P2 完成条件).

#[path = "support/sqlite.rs"]
mod sqlite_fixture;

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

const TAG: &str = "data-26-10-10-00-00-00_cafe01";
const VID: &str = "26-10-10-00-00-00_cafe01";

fn free_port() -> u16 {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("free port");
    listener.local_addr().expect("addr").port()
}

/// Build the three release zips from the minimal fixture: stage/zone/item
/// tables are real, the remaining required entries are `{}` sentinels. The
/// resulting list_stages output is byte-identical to the P1 golden recorded
/// against the fixture (same tables, default arguments).
fn release_assets() -> Vec<(String, Vec<u8>)> {
    let temp = std::env::temp_dir().join(format!("prts-process-db-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&temp).unwrap();
    let descriptor = sqlite_fixture::compiler::compile(&sqlite_fixture::compiler::Options {
        input: Some(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join(".runtime/fixtures/minimal-gamedata-v1"),
        ),
        output: temp.join("zh_CN.sqlite"),
        version: VID.into(),
        revision: 1,
        allow_incomplete: true,
        ..Default::default()
    })
    .unwrap();
    let payload = std::fs::read(temp.join("zh_CN.sqlite.gz")).unwrap();
    let manifest = json!({"contractVersion":"prts-mcp-data/v1","source":{"versionId":VID},
        "publicationRevision":1,"sqlite":descriptor,
        "assets":{"zh_CN.sqlite.gz":{"size":payload.len(),"sha256":sha256_hex(&payload)}}});
    std::fs::remove_dir_all(temp).unwrap();
    vec![
        ("manifest.json".into(), manifest.to_string().into_bytes()),
        ("zh_CN.sqlite.gz".into(), payload),
    ]
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::Digest;
    format!("{:x}", sha2::Sha256::digest(bytes))
}

/// A dumb ghproxy-style mirror: requests arrive as
/// `GET http://127.0.0.1:<port>/<original-url>` (mirror prefix + full URL).
/// Mirror state: hit counter plus a gate that holds the FIRST discovery
/// response until the test has observed the missing-data state.
pub struct Mirror {
    pub port: u16,
    requests: Arc<std::sync::Mutex<Vec<String>>>,
    hits: Arc<std::sync::atomic::AtomicUsize>,
    gate: Arc<(std::sync::Mutex<bool>, std::sync::Condvar)>,
}

impl Mirror {
    pub fn hits(&self) -> usize {
        self.hits.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Let the held discovery response through.
    pub fn release(&self) {
        let (held, condvar) = &*self.gate;
        let mut held = held.lock().unwrap();
        *held = false;
        condvar.notify_all();
    }
}

fn start_mirror() -> Mirror {
    let requests = Arc::new(std::sync::Mutex::new(Vec::new()));
    let assets = Arc::new(release_assets());
    let hits = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let gate = Arc::new((std::sync::Mutex::new(true), std::sync::Condvar::new()));
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("mirror bind");
    let port = listener.local_addr().expect("addr").port();
    let requests_for_threads = Arc::clone(&requests);
    let hits_for_threads = Arc::clone(&hits);
    let gate_for_threads = Arc::clone(&gate);
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { break };
            let requests = Arc::clone(&requests_for_threads);
            let assets = Arc::clone(&assets);
            let hits = Arc::clone(&hits_for_threads);
            let gate = Arc::clone(&gate_for_threads);
            std::thread::spawn(move || handle(stream, assets, hits, gate, requests));
        }
    });
    Mirror {
        port,
        hits,
        gate,
        requests,
    }
}

fn handle(
    mut stream: TcpStream,
    assets: Arc<Vec<(String, Vec<u8>)>>,
    hits: Arc<std::sync::atomic::AtomicUsize>,
    gate: Arc<(std::sync::Mutex<bool>, std::sync::Condvar)>,
    requests: Arc<std::sync::Mutex<Vec<String>>>,
) {
    let mut buffer = [0u8; 8192];
    let mut read = 0;
    loop {
        match stream.read(&mut buffer[read..]) {
            Ok(0) | Err(_) => return,
            Ok(n) => {
                read += n;
                if buffer[..read].windows(4).any(|w| w == b"\r\n\r\n") || read == buffer.len() {
                    break;
                }
            }
        }
    }
    let head = String::from_utf8_lossy(&buffer[..read]).to_string();
    let path = head
        .split_whitespace()
        .nth(1)
        .unwrap_or_default()
        .to_string();
    hits.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    requests.lock().unwrap().push(path.clone());

    let (status, content_type, body) = if path.contains("api.github.com") {
        // First discovery is held until the test releases the gate, so the
        // missing-data state is observable before activation.
        let (held, condvar) = &*gate;
        let mut held = held.lock().unwrap();
        while *held {
            let (guard, timeout) = condvar
                .wait_timeout(held, Duration::from_secs(120))
                .unwrap();
            held = guard;
            if timeout.timed_out() {
                break;
            }
        }
        let downloads: Vec<Value> = assets
            .iter()
            .map(|(name, _)| {
                json!({
                    "name": name,
                    "browser_download_url": format!(
                        "https://github.com/3aKHP/arknights-data-pipeline/releases/download/{TAG}/{name}"
                    ),
                })
            })
            .collect();
        (
            "200 OK",
            "application/json",
            json!([{
                "tag_name": TAG,
                "created_at": "2026-10-10T00:00:00Z",
                "assets": downloads,
            }])
            .to_string(),
        )
    } else if path.contains("manifest.json") {
        (
            "200 OK",
            "application/json",
            String::from_utf8(
                assets
                    .iter()
                    .find(|(name, _)| name == "manifest.json")
                    .unwrap()
                    .1
                    .clone(),
            )
            .unwrap(),
        )
    } else if let Some((_, bytes)) = assets
        .iter()
        .find(|(name, _)| path.ends_with(name.as_str()))
    {
        // Binary asset — serve raw bytes.
        let response = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/octet-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
            bytes.len()
        );
        let _ = stream.write_all(response.as_bytes());
        let _ = stream.write_all(bytes);
        let _ = stream.flush();
        return;
    } else {
        ("404 Not Found", "text/plain", "missing".to_string())
    };
    let response = format!(
        "HTTP/1.1 {status}\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

/// Isolated env: XDG data root under a temp dir, direct GitHub unreachable
/// (dead proxy), mirror reachable, auto-sync startup-only.
fn sync_env(port: u16, mirror_port: u16) -> Vec<(String, String)> {
    vec![
        ("PORT".to_string(), port.to_string()),
        ("HOST".to_string(), "127.0.0.1".to_string()),
        ("XDG_DATA_HOME".to_string(), String::new()),
        (
            "GITHUB_MIRRORS".to_string(),
            format!("http://127.0.0.1:{mirror_port}"),
        ),
        // Port 9 (discard) refuses connections instantly: the direct
        // candidates fail and the cascade reaches the local mirror.
        ("HTTPS_PROXY".to_string(), "http://127.0.0.1:9".to_string()),
        ("IMAGES_ENABLED".to_string(), "true".to_string()),
        (
            "PRTS_AUTO_SYNC_INTERVAL_SECONDS".to_string(),
            "0".to_string(),
        ),
    ]
}

fn xdg_root() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("prts-sync-proc-{}", uuid::Uuid::new_v4()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn spawn_binary(args: &[&str], env: &[(String, String)]) -> Child {
    let bin = env!("CARGO_BIN_EXE_prts-mcp-rust");
    Command::new(bin)
        .args(args)
        .env_clear()
        .env("PRTS_DATA_BACKEND", "sqlite")
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", std::env::var("HOME").unwrap_or_default())
        .envs(env.iter().cloned())
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn binary")
}

/// Drain a child's stderr into a buffer (a full pipe would block the child).
fn drain_stderr(child: &mut Child) -> Arc<std::sync::Mutex<String>> {
    let stderr = child.stderr.take().expect("stderr piped");
    let buffer = Arc::new(std::sync::Mutex::new(String::new()));
    let sink = Arc::clone(&buffer);
    std::thread::spawn(move || {
        use std::io::Read;
        let mut stderr = stderr;
        let mut chunk = [0u8; 4096];
        loop {
            match stderr.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => sink
                    .lock()
                    .unwrap()
                    .push_str(&String::from_utf8_lossy(&chunk[..n])),
            }
        }
    });
    buffer
}

async fn wait_health(origin: &str) {
    for _ in 0..150 {
        if let Ok(res) = reqwest::get(format!("{origin}/health")).await {
            if res.status().is_success() {
                return;
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("server did not come up");
}

async fn post(origin: &str, body: Value, session: Option<&str>) -> (u16, Option<String>, Value) {
    let mut request = reqwest::Client::new()
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

/// docs/07 P2: "缺数据→后台出现数据不重启可读" — the service starts with no
/// data, answers the missing-data wording, and serves real listings once the
/// background activation lands — same process, no restart.
#[tokio::test]
async fn missing_data_background_sync_readable_without_restart() {
    let mirror = start_mirror();
    let port = free_port();
    let xdg = xdg_root();
    let mut env = sync_env(port, mirror.port);
    env.iter_mut()
        .find(|(key, _)| key == "XDG_DATA_HOME")
        .unwrap()
        .1 = xdg.to_string_lossy().into_owned();
    let mut child = spawn_binary(&["--transport", "http"], &env);
    let stderr_log = drain_stderr(&mut child);
    let origin = format!("http://127.0.0.1:{port}");
    wait_health(&origin).await;

    // No data yet: the oracle's missing-data wording, listing the sync target.
    let (status, sid, _) = post(&origin, init_body(1), None).await;
    assert_eq!(status, 200);
    let sid = sid.expect("session id");
    post(
        &origin,
        json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
        Some(&sid),
    )
    .await;
    let (status, _, body) = post(
        &origin,
        json!({"jsonrpc":"2.0","method":"tools/call","id":2,"params":{"name":"list_stages","arguments":{}}}),
        Some(&sid),
    )
    .await;
    assert_eq!(status, 200);
    let text = body["result"]["content"][0]["text"].as_str().unwrap();
    assert!(
        text.starts_with("关卡数据暂不可用。"),
        "missing-data wording first, got: {text}"
    );
    assert!(text.contains("（当前同步目标路径："));
    // Plain text result (matches the TS golden: no isError for the
    // missing-data wording).
    assert!(body["result"]["isError"].is_null());
    assert!(body["result"]["structuredContent"].is_null());

    // Missing state observed — let the held discovery through.
    mirror.release();

    // Background sync lands; poll until the tool serves real data.
    let golden_path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/contracts/cases/golden/stage.list.default.json"
    );
    let golden: Value = serde_json::from_str(&std::fs::read_to_string(golden_path).unwrap())
        .expect("golden parses");
    let expected = &golden["expected"]["body"]["result"];
    // The default channel is content (same as the golden case), so the
    // landing signal is the listing text rather than structuredContent.
    let deadline = Instant::now() + Duration::from_secs(90);
    let served;
    loop {
        let (_, _, body) = post(
            &origin,
            json!({"jsonrpc":"2.0","method":"tools/call","id":3,"params":{"name":"list_stages","arguments":{}}}),
            Some(&sid),
        )
        .await;
        let text = body["result"]["content"][0]["text"].as_str().unwrap_or("");
        if text.starts_with("# 关卡列表") {
            served = body["result"].clone();
            break;
        }
        assert!(
            Instant::now() < deadline,
            "sync did not land in 90s; mirror hits={}; child stderr: {}",
            mirror.hits(),
            stderr_log.lock().unwrap().clone()
        );
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    // Byte-identical to the golden recorded against the same fixture tables.
    assert_eq!(served["content"], expected["content"]);
    assert_eq!(served["isError"], expected["isError"]);
    assert!(served["structuredContent"].is_null());

    // Runtime writes only immutable SQLite files, their lease, and text pointers.
    let database = xdg.join("prts-mcp/database");
    let pointer = prts_mcp_rust::storage::database::active(&database)
        .unwrap()
        .unwrap();
    assert_eq!(pointer.source_version, VID);
    assert!(pointer.path(&database).is_file());
    assert!(!xdg.join("prts-mcp/gamedata/archives").exists());
    assert!(!xdg.join("prts-mcp/storyjson/zh_CN.zip").exists());
    assert!(mirror.hits() >= 3);
    assert!(mirror
        .requests
        .lock()
        .unwrap()
        .iter()
        .any(|path| path.ends_with(".sqlite.gz")));
    assert!(!mirror
        .requests
        .lock()
        .unwrap()
        .iter()
        .any(|path| path.ends_with(".zip")));

    // Server stays healthy after activation.
    let res = reqwest::get(format!("{origin}/health")).await.unwrap();
    assert!(res.status().is_success());

    child.kill().unwrap();
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(&xdg);
}

/// docs/05 "传输与调度": retries and timers must not keep the process alive
/// after stdio closes — the exit is prompt with retry chains still armed.
#[tokio::test]
async fn stdio_exit_with_pending_retries() {
    let xdg = xdg_root();
    let mut child = spawn_binary(
        &["--transport", "stdio"],
        &[
            (
                "XDG_DATA_HOME".to_string(),
                xdg.to_string_lossy().into_owned(),
            ),
            // No mirror, direct unreachable: sync fails no_data and arms the
            // 30s dense retry before we close stdin.
            ("HTTPS_PROXY".to_string(), "http://127.0.0.1:9".to_string()),
            ("IMAGES_ENABLED".to_string(), "true".to_string()),
        ],
    );
    // Legacy initialize handshake.
    let init = serde_json::to_string(&init_body(1)).unwrap();
    child
        .stdin
        .as_mut()
        .expect("stdin")
        .write_all(format!("{init}\n").as_bytes())
        .unwrap();
    // Give the startup sync + retry scheduling a moment to happen.
    tokio::time::sleep(Duration::from_millis(600)).await;
    child.stdin.take(); // EOF
    let started = Instant::now();
    let output = child.wait_with_output().expect("wait");
    let elapsed = started.elapsed();
    assert!(
        elapsed < Duration::from_secs(10),
        "stdio exit blocked on background timers: {elapsed:?}"
    );
    assert_eq!(output.status.code(), Some(0), "clean exit code");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("SQLite sync failed"),
        "retry chains were armed before exit; stderr: {}",
        stderr.chars().take(600).collect::<String>()
    );
    let _ = std::fs::remove_dir_all(&xdg);
}
