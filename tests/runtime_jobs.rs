use serde_json::Value;
use std::{
    fs,
    path::PathBuf,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};
struct Fixture {
    root: PathBuf,
    child: Child,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.root);
    }
}
#[test]
fn cli_disconnect_keeps_job_and_explicit_cancel_unwinds_it() {
    let id = uuid::Uuid::new_v4();
    #[cfg(unix)]
    let root = PathBuf::from("/tmp").join(format!("prts-runtime-job-{id}"));
    #[cfg(windows)]
    let root = std::env::temp_dir().join(format!("prts-runtime-job-{id}"));
    fs::create_dir(&root).unwrap();
    let database = root.join("database");
    fs::create_dir(&database).unwrap();
    let lock = fs::File::create(database.join("sync.lock")).unwrap();
    lock.lock().unwrap();
    #[cfg(unix)]
    let endpoint = root.join("run/control.sock");
    #[cfg(windows)]
    let endpoint = PathBuf::from(format!(r"\\.\pipe\prts-mcp-test-{id}"));
    let mapping = root.join("instances.toml");
    fs::write(
        &mapping,
        format!(
            "schema_version=1\n[instances.main]\nendpoint='{}'\n",
            endpoint.display()
        ),
    )
    .unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_prts-mcp"));
    command
        .env_clear()
        .env("HOME", &root)
        .env("USERPROFILE", &root)
        .env("XDG_DATA_HOME", &root)
        .env("PRTS_DATA_DIR", &database)
        .env("PRTS_TRANSPORT", "stdio")
        .env("PRTS_DATA_BACKEND", "sqlite")
        .env("PRTS_AUTO_SYNC_INTERVAL_SECONDS", "0")
        .env("IMAGES_ENABLED", "false")
        .env("PRTS_CONTROL_ENDPOINT", &endpoint)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    for key in ["SystemRoot", "WINDIR"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    let mut fixture = Fixture {
        root,
        child: command.spawn().unwrap(),
    };
    let query = |args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_prtsctl"))
            .arg("runtime")
            .args(args)
            .arg("--instances-file")
            .arg(&mapping)
            .args(["-o", "json"])
            .output()
            .unwrap()
    };
    let deadline = Instant::now() + Duration::from_secs(10);
    // Wait for the startup attempt to relinquish the in-process reservation.
    loop {
        let out = query(&["jobs", "list"]);
        if out.status.success() {
            let result: Value = serde_json::from_slice(&out.stdout).unwrap();
            if result["jobs"]
                .as_array()
                .unwrap()
                .iter()
                .any(|j| j["status"] == "failed")
            {
                break;
            }
        }
        assert!(Instant::now() < deadline, "{out:?}");
        std::thread::sleep(Duration::from_millis(20));
    }
    let out = query(&["data", "sync", "--wait-timeout", "30"]);
    assert!(out.status.success(), "{out:?}");
    let job: Value = serde_json::from_slice(&out.stdout).unwrap();
    let id = job["id"].as_str().unwrap();
    let show = query(&["jobs", "show", id]);
    assert_eq!(
        serde_json::from_slice::<Value>(&show.stdout).unwrap()["status"],
        "running"
    );
    assert!(!query(&["data", "sync"]).status.success());
    assert!(query(&["jobs", "cancel", id]).status.success());
    loop {
        let out = query(&["jobs", "show", id]);
        let result: Value = serde_json::from_slice(&out.stdout).unwrap();
        if result["status"] == "cancelled" {
            break;
        }
        assert!(Instant::now() < deadline, "{out:?}");
        std::thread::sleep(Duration::from_millis(20));
    }
    // EOF drains jobs and preserves another process's ownership.
    drop(fixture.child.stdin.take());
    while fixture.child.try_wait().unwrap().is_none() {
        assert!(Instant::now() < deadline, "server did not drain after EOF");
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(fs::File::open(database.join("sync.lock"))
        .unwrap()
        .try_lock()
        .is_err());
    drop(lock);
}
