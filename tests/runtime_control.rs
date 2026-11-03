use std::{
    fs,
    io::Write,
    path::PathBuf,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

struct Fixture {
    root: PathBuf,
    child: Option<Child>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(child) = &mut self.child {
            let _ = child.kill();
            let _ = child.wait();
        }
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn stdio_instance_has_separate_management_and_preserves_protocol_output() {
    managed_instance(false, false);
}
#[test]
fn native_entry_loads_management_from_toml() {
    managed_instance(true, false);
}
#[test]
fn serve_entry_loads_management_from_toml() {
    managed_instance(true, true);
}
fn managed_instance(file_control: bool, serve: bool) {
    let id = uuid::Uuid::new_v4();
    // Darwin's per-user temp prefix can exceed sockaddr_un's small limit.
    #[cfg(unix)]
    let root = PathBuf::from("/tmp").join(format!("prts-control-test-{id}"));
    #[cfg(windows)]
    let root = std::env::temp_dir().join(format!("prts-control-test-{id}"));
    fs::create_dir(&root).unwrap();
    #[cfg(unix)]
    let endpoint = root.join("run/control.sock");
    #[cfg(windows)]
    let endpoint = PathBuf::from(format!(r"\\.\pipe\prts-mcp-test-{id}"));
    let config = root.join("server.toml");
    let control_fields = if file_control {
        format!(
            "PRTS_CONTROL_ENDPOINT='{}'\nPRTS_INSTANCE_NAME='main'\n",
            endpoint.display()
        )
    } else {
        String::new()
    };
    let write_configuration =
        |text: &str| fs::write(&config, format!("{text}{control_fields}")).unwrap();
    fs::write(
        &config,
        "schema_version=1\n[runtime]\nPRTS_TRANSPORT='stdio'\nHOST='fixture-host'\n",
    )
    .unwrap();
    let mapping = root.join("instances.toml");
    fs::write(
        &mapping,
        format!(
            "schema_version=1\n[instances.main]\nendpoint='{}'\n",
            endpoint.display()
        ),
    )
    .unwrap();
    if file_control {
        let mut file = fs::OpenOptions::new().append(true).open(&config).unwrap();
        writeln!(
            file,
            "PRTS_CONTROL_ENDPOINT='{}'\nPRTS_INSTANCE_NAME='main'",
            endpoint.display()
        )
        .unwrap();
    }
    let mut command = Command::new(if serve {
        env!("CARGO_BIN_EXE_prtsctl")
    } else {
        env!("CARGO_BIN_EXE_prts-mcp")
    });
    command
        .env_clear()
        .env("HOME", &root)
        .env("USERPROFILE", &root)
        .env("APPDATA", &root)
        .env("XDG_DATA_HOME", &root)
        .env("PRTS_CONTROL_ENDPOINT", &endpoint)
        .env("GAMEDATA_PATH", "")
        .env("STORYJSON_PATH", root.join("unused.zip"))
        .env("IMAGES_ENABLED", "false")
        .args(["--config"])
        .arg(&config)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if file_control {
        command.env_remove("PRTS_CONTROL_ENDPOINT");
    }
    if serve {
        command.arg("serve");
    }
    let mut fixture = Fixture {
        root,
        child: Some(command.spawn().unwrap()),
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
    loop {
        let out = query(&["status"]);
        if out.status.success() {
            let report: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
            assert_eq!(report["transport"], "stdio");
            assert_eq!(report["schema_version"], 1);
            assert_eq!(report["ready"], true);
            assert_eq!(report["instance"], "main");
            break;
        }
        assert!(Instant::now() < deadline, "{out:?}");
        std::thread::sleep(Duration::from_millis(25));
    }
    #[cfg(unix)]
    {
        use std::{
            io::Read,
            os::unix::{fs::PermissionsExt, net::UnixStream},
        };
        assert_eq!(
            fs::metadata(&endpoint).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(endpoint.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        for (instance, startup, expected) in [
            ("other", None, "instance_mismatch"),
            ("main", Some("previous-process"), "instance_restarted"),
        ] {
            let mut stream = UnixStream::connect(&endpoint).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let request=serde_json::to_vec(&serde_json::json!({"protocol_version":1,"command":{"method":"status"},"instance":instance,"expected_startup_id":startup})).unwrap();
            stream
                .write_all(&(request.len() as u32).to_be_bytes())
                .unwrap();
            stream.write_all(&request).unwrap();
            let mut header = [0; 4];
            stream.read_exact(&mut header).unwrap();
            let mut body = vec![0; u32::from_be_bytes(header) as usize];
            stream.read_exact(&mut body).unwrap();
            let response: serde_json::Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(response["error"]["kind"], expected);
        }
        let mut oversized = UnixStream::connect(&endpoint).unwrap();
        oversized.write_all(&u32::MAX.to_be_bytes()).unwrap();
        drop(oversized);
        assert!(
            query(&["status"]).status.success(),
            "malformed client must not stop listener"
        );
    }
    let out = query(&["config", "show"]);
    assert!(out.status.success(), "{out:?}");
    let report: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    let host = report["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["key"] == "HOST")
        .unwrap();
    assert_eq!(host["value"], "fixture-host");
    assert_eq!(host["source"], "file");
    let out = query(&["data", "status"]);
    assert!(out.status.success(), "{out:?}");
    let report: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(report["schema_version"], 1);
    write_configuration("schema_version=1\n[runtime]\nPRTS_TRANSPORT='stdio'\nHOST='fixture-host'\nPRTS_AUTO_SYNC_INTERVAL_SECONDS=120\n");
    let out = query(&["config", "diff"]);
    assert!(out.status.success(), "{out:?}");
    let diff: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(diff["restart_required"], false);
    assert_eq!(diff["revision"], 1);
    let out = query(&["config", "reload", "--expected-revision", "1"]);
    assert!(out.status.success(), "{out:?}");
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&out.stdout).unwrap()["revision"],
        2
    );
    assert!(!query(&["config", "reload", "--expected-revision", "1"])
        .status
        .success());
    write_configuration("schema_version=1\n[runtime]\nPRTS_TRANSPORT='stdio'\nHOST='changed-host'\nPRTS_AUTO_SYNC_INTERVAL_SECONDS=240\n");
    assert!(!query(&["config", "reload", "--expected-revision", "2"])
        .status
        .success());
    let out = query(&["config", "show"]);
    let current: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(current["revision"], 2);
    assert_eq!(
        current["fields"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["key"] == "PRTS_AUTO_SYNC_INTERVAL_SECONDS")
            .unwrap()["value"],
        120
    );
    let mut child = fixture.child.take().unwrap();
    let mut input = child.stdin.take().unwrap();
    writeln!(input,r#"{{"jsonrpc":"2.0","id":1,"method":"initialize","params":{{"protocolVersion":"2025-03-26","capabilities":{{}},"clientInfo":{{"name":"control-test","version":"1"}}}}}}"#).unwrap();
    drop(input);
    let deadline = Instant::now() + Duration::from_secs(10);
    while child.try_wait().unwrap().is_none() {
        if Instant::now() > deadline {
            let _ = child.kill();
            panic!("stdio EOF did not stop server")
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success(), "{out:?}");
    for line in String::from_utf8(out.stdout).unwrap().lines() {
        let value: serde_json::Value = serde_json::from_str(line).unwrap();
        assert_eq!(value["jsonrpc"], "2.0");
    }
    #[cfg(unix)]
    assert!(!endpoint.exists());
}
