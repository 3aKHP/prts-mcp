//! Explicit opt-in systemd fixture; never touches an existing service.
#[cfg(target_os = "linux")]
#[test]
#[ignore = "requires a running user systemd manager; creates one temporary unit"]
fn user_unit_lifecycle_over_dbus() {
    use std::{fs, path::PathBuf, process::Command};
    struct Unit {
        name: String,
        path: PathBuf,
    }
    impl Drop for Unit {
        fn drop(&mut self) {
            let _ = Command::new("systemctl")
                .args(["--user", "stop", &self.name])
                .output();
            let _ = Command::new("systemctl")
                .args(["--user", "disable", &self.name])
                .output();
            let _ = fs::remove_file(&self.path);
            let _ = Command::new("systemctl")
                .args(["--user", "daemon-reload"])
                .output();
        }
    }
    let name = format!("prts-control-test-{}.service", uuid::Uuid::new_v4());
    let root = PathBuf::from(std::env::var_os("XDG_RUNTIME_DIR").expect("user runtime directory"))
        .join("systemd/user");
    fs::create_dir_all(&root).unwrap();
    let unit = Unit {
        path: root.join(&name),
        name,
    };
    fs::write(
        &unit.path,
        "[Service]\nExecStart=/bin/sleep 300\n[Install]\nWantedBy=default.target\n",
    )
    .unwrap();
    assert!(Command::new("systemctl")
        .args(["--user", "daemon-reload"])
        .status()
        .unwrap()
        .success());
    let call = |operation: &str| {
        let out = Command::new(env!("CARGO_BIN_EXE_prtsctl"))
            .env("PRTS_DATA_BACKEND", "invalid-business-setting")
            .args([
                "service", "--user", "--unit", &unit.name, operation, "-o", "json",
            ])
            .output()
            .unwrap();
        assert!(out.status.success(), "{operation}: {out:?}");
        serde_json::from_slice::<serde_json::Value>(&out.stdout).unwrap()
    };
    assert_eq!(call("status")["active_state"], "inactive");
    assert_eq!(call("enable")["unit_file_state"], "enabled");
    let started = call("start");
    assert_eq!(started["active_state"], "active");
    let restarted = call("restart");
    assert_eq!(restarted["active_state"], "active");
    assert_ne!(started["main_pid"], restarted["main_pid"]);
    assert_eq!(call("stop")["active_state"], "inactive");
    assert_eq!(call("disable")["unit_file_state"], "disabled");
}

#[test]
fn service_help_and_validation_do_not_load_business_configuration() {
    use std::process::Command;
    let out = Command::new(env!("CARGO_BIN_EXE_prtsctl"))
        .env("PRTS_DATA_BACKEND", "invalid")
        .args(["service", "--help"])
        .output()
        .unwrap();
    assert!(out.status.success());
    #[cfg(target_os = "linux")]
    {
        let out = Command::new(env!("CARGO_BIN_EXE_prtsctl"))
            .args(["service", "--unit", "../other.service", "start"])
            .output()
            .unwrap();
        assert_eq!(out.status.code(), Some(2));
    }
}
