use std::{
    fs,
    io::Write,
    path::PathBuf,
    process::{Child, Command, Output, Stdio},
    time::{Duration, Instant},
};
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!("prts-cli-process-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&p).unwrap();
        Self(p)
    }
    fn command(&self, bin: &str) -> Command {
        let mut c = Command::new(bin);
        c.env_clear()
            .env("HOME", &self.0)
            .env("USERPROFILE", &self.0)
            .env("APPDATA", &self.0)
            .env("XDG_CONFIG_HOME", &self.0)
            .env("LOCALAPPDATA", &self.0)
            .env("XDG_DATA_HOME", &self.0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        c
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn bounded(mut child: Child) -> Output {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if child.try_wait().unwrap().is_some() {
            return child.wait_with_output().unwrap();
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            let out = child.wait_with_output().unwrap();
            panic!("child exceeded timeout: {out:?}")
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}
#[test]
fn serve_and_legacy_explicit_file_keep_stdio_protocol_clean() {
    let f = Fixture::new();
    let config = f.0.join("server 中文.toml");
    fs::write(
        &config,
        "schema_version = 1\n[runtime]\nPRTS_TRANSPORT = 'stdio'\n",
    )
    .unwrap();
    for (bin, args) in [
        (env!("CARGO_BIN_EXE_prtsctl"), vec!["serve"]),
        (env!("CARGO_BIN_EXE_prts-mcp"), vec![]),
        (env!("CARGO_BIN_EXE_prts-mcp-ghcr"), vec![]),
    ] {
        let mut child = f
            .command(bin)
            .args(args)
            .arg("--config")
            .arg(&config)
            .env("GAMEDATA_PATH", "")
            .env("STORYJSON_PATH", f.0.join("unused.zip"))
            .env("IMAGES_ENABLED", "false")
            .env("PORT", "unused-in-stdio")
            .spawn()
            .unwrap();
        let mut input = child.stdin.take().unwrap();
        writeln!(input,r#"{{"jsonrpc":"2.0","id":1,"method":"initialize","params":{{"protocolVersion":"2025-03-26","capabilities":{{}},"clientInfo":{{"name":"cli-test","version":"1"}}}}}}"#).unwrap();
        drop(input);
        let out = bounded(child);
        assert!(out.status.success(), "{out:?}");
        let text = String::from_utf8(out.stdout).unwrap();
        let lines: Vec<_> = text.lines().collect();
        assert!(!lines.is_empty());
        for line in lines {
            let value: serde_json::Value = serde_json::from_str(line).unwrap();
            assert_eq!(value["jsonrpc"], "2.0");
            assert!(value.get("result").is_some(), "{value}");
        }
    }
}
#[cfg(unix)]
#[test]
fn sigterm_while_waiting_returns_cancelled_json_and_preserves_old_data() {
    let f = Fixture::new();
    let root = f.0.join("database");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("active"), "existing-active-sentinel").unwrap();
    fs::write(
        root.join(".prts-data-source.json"),
        r#"{"schemaVersion":1,"repo":"fixture/source"}"#,
    )
    .unwrap();
    let lock = fs::File::create(root.join("sync.lock")).unwrap();
    lock.lock().unwrap();
    let mut child = f
        .command(env!("CARGO_BIN_EXE_prtsctl"))
        .env("PRTS_DATA_SOURCE_REPO", "fixture/source")
        .env("PRTS_DATA_DIR", &root)
        .args(["data", "sync", "--wait-timeout", "30", "-o", "json"])
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !root.join(".prts-data-source.lock").exists() {
        if Instant::now() > deadline {
            let _ = child.kill();
            let out = child.wait_with_output().unwrap();
            panic!("sync did not start: {out:?}")
        }
        assert!(child.try_wait().unwrap().is_none());
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(Command::new("kill")
        .args(["-TERM", &child.id().to_string()])
        .status()
        .unwrap()
        .success());
    let out = bounded(child);
    assert_eq!(out.status.code(), Some(143), "{out:?}");
    let value: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(value["cancelled"], true);
    assert_eq!(
        fs::read_to_string(root.join("active")).unwrap(),
        "existing-active-sentinel"
    );
    assert!(
        fs::File::open(root.join("sync.lock"))
            .unwrap()
            .try_lock()
            .is_err(),
        "another process's lock was retained"
    );
}
