use std::{fs, process::Command};
struct Fixture(std::path::PathBuf);
impl Fixture {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!("prts-cli-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&p).unwrap();
        Self(p)
    }
    fn command(&self) -> Command {
        let mut c = Command::new(env!("CARGO_BIN_EXE_prtsctl"));
        c.env_clear()
            .env("HOME", &self.0)
            .env("USERPROFILE", &self.0)
            .env("APPDATA", &self.0)
            .env("XDG_CONFIG_HOME", &self.0)
            .env("XDG_DATA_HOME", self.0.join("data"));
        c
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
#[test]
fn help_ignores_bad_configuration_and_never_initializes_data() {
    let f = Fixture::new();
    let o = f
        .command()
        .env("PRTS_DATA_BACKEND", "invalid")
        .args(["--help"])
        .output()
        .unwrap();
    assert!(o.status.success());
    assert!(!f.0.join("data").exists());
}
#[test]
fn edits_can_repair_a_bad_field_but_reject_other_invalid_content() {
    let f = Fixture::new();
    let path = f.0.join("repair.toml");
    for args in [
        vec!["config", "set", "PORT", "3000"],
        vec!["config", "unset", "PORT"],
    ] {
        fs::write(&path, "schema_version=1\n[runtime]\nPORT='oops'\n").unwrap();
        let out = f
            .command()
            .arg("--config")
            .arg(&path)
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "{out:?}");
        assert!(!fs::read_to_string(&path).unwrap().contains("oops"));
    }
    for invalid in [
        "schema_version=1\n[runtime]\nPORT='oops'\nLOCAL_IMAGE='invalid'\n",
        "schema_version=1\nruntime='invalid'\n",
    ] {
        fs::write(&path, invalid).unwrap();
        let out = f
            .command()
            .arg("--config")
            .arg(&path)
            .args(["config", "set", "PORT", "3000"])
            .output()
            .unwrap();
        assert_eq!(out.status.code(), Some(2), "{out:?}");
        assert_eq!(fs::read_to_string(&path).unwrap(), invalid);
    }
}
#[test]
fn explicit_missing_config_fails_even_with_equals_syntax() {
    let f = Fixture::new();
    let o = f
        .command()
        .arg(format!("--config={}", f.0.join("missing.toml").display()))
        .args(["config", "show", "-o", "json"])
        .output()
        .unwrap();
    assert_eq!(o.status.code(), Some(2));
    assert!(o.stdout.is_empty());
}
#[test]
fn edits_preserve_comments_and_environment_overrides() {
    let f = Fixture::new();
    let p = f.0.join("settings.toml");
    fs::write(
        &p,
        "schema_version = 1\n[runtime]\n# retained\nHOST = 'localhost'\n",
    )
    .unwrap();
    let o = f
        .command()
        .arg("--config")
        .arg(&p)
        .args(["config", "set", "PORT", "3100", "-o", "json"])
        .output()
        .unwrap();
    assert!(o.status.success(), "{:?}", o);
    assert!(fs::read_to_string(&p).unwrap().contains("# retained"));
    let o = f
        .command()
        .env("PORT", "3200")
        .arg("--config")
        .arg(&p)
        .args(["config", "show", "-o", "json"])
        .output()
        .unwrap();
    assert!(o.status.success());
    let value: serde_json::Value = serde_json::from_slice(&o.stdout).unwrap();
    let field = value["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["key"] == "PORT")
        .unwrap();
    assert_eq!(field["value"], 3200);
    assert_eq!(field["source"], "environment");
    assert!(!f.0.join("data").exists());
}
#[test]
fn dry_run_creates_neither_directory_nor_lock() {
    let f = Fixture::new();
    let root = f.0.join("absent");
    let o = f
        .command()
        .arg("--config")
        .arg(root.join("config.toml"))
        .args(["config", "init", "--dry-run"])
        .output()
        .unwrap();
    assert!(o.status.success());
    assert!(!root.exists());
}
#[test]
fn legacy_help_does_not_parse_bad_runtime_environment() {
    let o = Command::new(env!("CARGO_BIN_EXE_prts-mcp"))
        .env("PRTS_DATA_BACKEND", "bad")
        .arg("--version")
        .output()
        .unwrap();
    assert!(o.status.success());
    assert!(String::from_utf8_lossy(&o.stdout).contains(env!("CARGO_PKG_VERSION")));
}

#[test]
fn file_types_are_strict_even_when_environment_overrides_them() {
    let f = Fixture::new();
    let p = f.0.join("settings.toml");
    for content in [
        "PORT = '3000'",
        "LOCAL_IMAGE = 'true'",
        "GAMEDATA_PATH = ''",
        "PRTS_DATA_SOURCE_REPO = 'not/a/repo'",
        "UNKNOWN = true",
    ] {
        fs::write(&p, format!("schema_version = 1\n[runtime]\n{content}\n")).unwrap();
        let o = f
            .command()
            .env("PORT", "3000")
            .arg("--config")
            .arg(&p)
            .args(["config", "validate"])
            .output()
            .unwrap();
        assert_eq!(o.status.code(), Some(2), "{content}: {o:?}");
        assert!(o.stdout.is_empty());
    }
}
#[test]
fn effective_defaults_fallbacks_and_secrets_are_reported() {
    let f = Fixture::new();
    let o = f
        .command()
        .env("GITHUB_TOKEN", "secret-needle")
        .env("HTTPS_PROXY", "https://user:secret-needle@example.invalid")
        .env("PRTS_AUTO_SYNC_INTERVAL_SECONDS", "invalid")
        .env("PRTS_OUTPUT_CHANNEL", "invalid")
        .args(["config", "show", "-o", "json"])
        .output()
        .unwrap();
    assert!(o.status.success());
    assert!(!String::from_utf8_lossy(&o.stdout).contains("secret-needle"));
    let report: serde_json::Value = serde_json::from_slice(&o.stdout).unwrap();
    let field = |k: &str| {
        report["fields"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["key"] == k)
            .unwrap()
    };
    assert_eq!(field("PRTS_AUTO_SYNC_INTERVAL_SECONDS")["value"], 3600);
    assert_eq!(field("PRTS_OUTPUT_CHANNEL")["value"], "content");
    assert_eq!(field("PORT")["value"], 3000);
    assert_eq!(field("IMAGES_ENABLED")["value"], true);
    assert_eq!(field("GITHUB_TOKEN")["value"], "[redacted]");
}
#[test]
fn edits_validate_cross_field_conflicts_and_keep_original_file() {
    let f = Fixture::new();
    let p = f.0.join("settings.toml");
    let original = "schema_version = 1\n[runtime]\nPRTS_DATA_BACKEND = 'json'\n";
    fs::write(&p, original).unwrap();
    let o = f
        .command()
        .arg("--config")
        .arg(&p)
        .args(["config", "set", "PRTS_DATA_DB", "db.sqlite"])
        .output()
        .unwrap();
    assert_eq!(o.status.code(), Some(2));
    assert_eq!(fs::read_to_string(&p).unwrap(), original);
}
#[test]
fn init_template_is_valid_and_does_not_copy_environment() {
    let f = Fixture::new();
    let p = f.0.join("settings.toml");
    let o = f
        .command()
        .env("GITHUB_TOKEN", "secret-needle")
        .arg("--config")
        .arg(&p)
        .args(["config", "init"])
        .output()
        .unwrap();
    assert!(o.status.success(), "{o:?}");
    let content = fs::read_to_string(&p).unwrap();
    assert!(!content.contains("secret-needle"));
    assert!(content.contains("PRTS_DATA_BACKEND"));
    let o = f
        .command()
        .arg("--config")
        .arg(&p)
        .args(["config", "validate"])
        .output()
        .unwrap();
    assert!(o.status.success(), "{o:?}");
}

#[test]
fn concurrent_configuration_edits_do_not_lose_updates() {
    let f = Fixture::new();
    let p = f.0.join("shared.toml");
    fs::write(&p, "schema_version = 1\n[runtime]\n# retained comment\n").unwrap();
    let mut a = f
        .command()
        .arg("--config")
        .arg(&p)
        .args(["config", "set", "HOST", "localhost"])
        .stdout(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let mut b = f
        .command()
        .arg("--config")
        .arg(&p)
        .args(["config", "set", "PORT", "3200"])
        .stdout(std::process::Stdio::null())
        .spawn()
        .unwrap();
    assert!(a.wait().unwrap().success());
    assert!(b.wait().unwrap().success());
    let doc = fs::read_to_string(&p)
        .unwrap()
        .parse::<toml_edit::DocumentMut>()
        .unwrap();
    assert_eq!(doc["runtime"]["HOST"].as_str(), Some("localhost"));
    assert_eq!(doc["runtime"]["PORT"].as_integer(), Some(3200));
    assert!(doc.to_string().contains("# retained comment"));
}
#[test]
fn filesystem_failure_is_operation_error_and_secret_rejection_has_no_side_effect() {
    let f = Fixture::new();
    let file = f.0.join("not-a-directory");
    fs::write(&file, "keep").unwrap();
    let out = f
        .command()
        .arg("--config")
        .arg(file.join("config.toml"))
        .args(["config", "init"])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1), "{out:?}");
    assert_eq!(fs::read_to_string(file).unwrap(), "keep");
    let missing = f.0.join("not-created");
    let out = f
        .command()
        .arg("--config")
        .arg(missing.join("config.toml"))
        .args(["config", "set", "GITHUB_TOKEN", "secret-needle"])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert!(!missing.exists());
    assert!(!String::from_utf8_lossy(&out.stderr).contains("secret-needle"));
}
#[cfg(unix)]
#[test]
fn symbolic_config_targets_are_rejected_and_permissions_preserved() {
    use std::os::unix::{fs::symlink, fs::PermissionsExt};
    let f = Fixture::new();
    let target = f.0.join("actual.toml");
    fs::write(&target, "schema_version = 1\n[runtime]\n").unwrap();
    fs::set_permissions(&target, fs::Permissions::from_mode(0o640)).unwrap();
    let link = f.0.join("alias.toml");
    symlink(&target, &link).unwrap();
    let out = f
        .command()
        .arg("--config")
        .arg(link)
        .args(["config", "set", "PORT", "3200"])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2));
    let out = f
        .command()
        .arg("--config")
        .arg(&target)
        .args(["config", "set", "PORT", "3200"])
        .output()
        .unwrap();
    assert!(out.status.success());
    assert_eq!(
        fs::metadata(target).unwrap().permissions().mode() & 0o777,
        0o640
    );
}

#[cfg(unix)]
#[test]
fn native_config_filename_does_not_panic_during_json_reporting() {
    use std::os::unix::ffi::OsStringExt;
    let f = Fixture::new();
    let path =
        f.0.join(std::ffi::OsString::from_vec(b"config-\xff.toml".to_vec()));
    let out = f
        .command()
        .arg("--config")
        .arg(&path)
        .args(["config", "init", "-o", "json"])
        .output()
        .unwrap();
    // APFS rejects filenames containing invalid UTF-8 at the filesystem layer.
    // That is an operation error, not a lossy replacement or a CLI panic.
    #[cfg(target_os = "macos")]
    if !out.status.success() {
        assert_eq!(out.status.code(), Some(1), "{out:?}");
        assert!(!path.exists());
        return;
    }
    assert!(out.status.success(), "{out:?}");
    assert!(path.is_file());
    let out = f
        .command()
        .arg("--config")
        .arg(&path)
        .args(["config", "show", "-o", "json"])
        .output()
        .unwrap();
    assert!(out.status.success(), "{out:?}");
    let value: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(value["scope"], "invocation");
}
