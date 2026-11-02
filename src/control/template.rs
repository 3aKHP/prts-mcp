//! Render reviewable systemd units without installing or replacing files.
use std::path::Path;

fn quoted(path: &Path) -> Result<String, String> {
    if !path.is_absolute() {
        return Err("服务路径必须为绝对路径".into());
    }
    let text = path.to_str().ok_or("systemd 模板路径必须可表示为 UTF-8")?;
    if text.chars().any(char::is_control) {
        return Err("服务路径不能包含控制字符".into());
    }
    Ok(format!(
        "\"{}\"",
        text.replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('%', "%%")
            .replace('$', "$$")
    ))
}

pub fn render(
    name: &str,
    executable: &Path,
    config: &Path,
    data_home: &Path,
    user: Option<&str>,
) -> Result<String, String> {
    if !super::instances::valid_name(name) {
        return Err("无效实例名称".into());
    }
    let executable = quoted(executable)?.replace("$$", "$");
    let config = quoted(config)?;
    // Environment= interprets specifiers but does not expand dollar variables.
    let data = quoted(data_home)?.replace("$$", "$");
    let account = if let Some(user) = user {
        if user.is_empty()
            || !user
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        {
            return Err("无效服务用户".into());
        }
        format!("User={user}\n")
    } else {
        String::new()
    };
    let endpoint = if user.is_some() {
        format!("/run/prts-mcp-{name}/control.sock")
    } else {
        format!("%t/prts-mcp-{name}/control.sock")
    };
    let target = if user.is_some() {
        "multi-user.target"
    } else {
        "default.target"
    };
    Ok(format!("[Unit]\nDescription=PRTS MCP ({name})\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\n{account}RuntimeDirectory=prts-mcp-{name}\nRuntimeDirectoryMode=0700\nEnvironment=XDG_DATA_HOME={data}\nEnvironment=PRTS_INSTANCE_NAME={name}\nEnvironment=PRTS_CONTROL_ENDPOINT={endpoint}\nExecStart={executable} --config {config}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=30\nKillMode=control-group\n\n[Install]\nWantedBy={target}\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quotes_paths_without_shell_or_systemd_expansion() {
        #[cfg(unix)]
        {
            let unit = render(
                "main",
                Path::new("/opt/space dir/$binary%"),
                Path::new("/etc/prts/config.toml"),
                Path::new("/var/lib/prts"),
                Some("prts-mcp"),
            )
            .unwrap();
            assert!(unit.contains("\"/opt/space dir/$binary%%\""));
            assert!(unit.contains("RuntimeDirectoryMode=0700"));
            assert!(!unit.contains("/bin/sh"));
            assert!(render(
                "main",
                Path::new("/opt/a\nExecStart=/bad"),
                Path::new("/etc/config"),
                Path::new("/data"),
                None
            )
            .is_err());
        }
    }
}
