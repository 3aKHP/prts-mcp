//! Explicit instance mappings contain destinations, never business credentials.
use std::path::{Path, PathBuf};
use toml_edit::DocumentMut;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Instance {
    pub name: String,
    pub endpoint: PathBuf,
    pub unit: Option<String>,
    pub user: bool,
}

pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub fn valid_endpoint(path: &Path) -> bool {
    #[cfg(windows)]
    {
        path.to_str().is_some_and(|s| {
            s.starts_with(r"\\.\pipe\prts-mcp-")
                && !s[r"\\.\pipe\prts-mcp-".len()..].is_empty()
                && !s[r"\\.\pipe\prts-mcp-".len()..].contains(['\\', '/', '\0'])
        })
    }
    #[cfg(unix)]
    {
        path.is_absolute()
    }
}

pub fn load(path: &Path, name: &str) -> Result<Instance, String> {
    let text = std::fs::read_to_string(path).map_err(|_| "无法读取实例映射文件")?;
    parse(&text, name)
}

pub fn parse(text: &str, name: &str) -> Result<Instance, String> {
    if !valid_name(name) {
        return Err("实例名称须为 1–64 个 ASCII 字母、数字、横线或下划线".into());
    }
    let doc = text
        .parse::<DocumentMut>()
        .map_err(|_| "实例映射 TOML 语法无效")?;
    if doc.get("schema_version").and_then(|v| v.as_integer()) != Some(1) {
        return Err("实例映射 schema_version 必须为 1".into());
    }
    if doc
        .iter()
        .any(|(k, _)| !["schema_version", "instances"].contains(&k))
    {
        return Err("未知实例映射字段".into());
    }
    let entries = doc
        .get("instances")
        .and_then(|v| v.as_table())
        .ok_or("缺少 instances 表")?;
    let mut selected = None;
    for (key, entry) in entries.iter() {
        if !valid_name(key) {
            return Err("无效实例名称".into());
        }
        let table = entry.as_table().ok_or("实例映射必须为表")?;
        if table
            .iter()
            .any(|(k, _)| !["endpoint", "unit", "user"].contains(&k))
        {
            return Err("未知实例配置字段".into());
        }
        let endpoint = table
            .get("endpoint")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .ok_or("实例须配置 endpoint")?;
        if !valid_endpoint(Path::new(endpoint)) {
            return Err("控制端点须为本机绝对 socket 路径或 prts-mcp 命名管道".into());
        }
        let unit = table
            .get("unit")
            .map(|v| {
                v.as_str()
                    .filter(|s| {
                        s.ends_with(".service")
                            && !s.starts_with('-')
                            && !s.contains('/')
                            && !s.chars().any(char::is_whitespace)
                    })
                    .map(str::to_owned)
                    .ok_or("unit 必须为 service 单元名称")
            })
            .transpose()?;
        let user = table
            .get("user")
            .map(|v| v.as_bool().ok_or("user 必须为布尔值"))
            .transpose()?
            .unwrap_or(false);
        if key == name {
            selected = Some(Instance {
                name: key.into(),
                endpoint: endpoint.into(),
                unit,
                user,
            });
        }
    }
    selected.ok_or_else(|| format!("未配置实例 {name}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input() -> String {
        #[cfg(unix)]
        let endpoint = std::env::temp_dir().join("prts-main.sock");
        #[cfg(windows)]
        let endpoint = PathBuf::from(r"\\.\pipe\prts-mcp-main");
        format!("schema_version=1\n[instances.main]\nendpoint='{}'\nunit='prts-mcp.service'\nuser=true\n", endpoint.display())
    }
    #[cfg(windows)]
    #[test]
    fn windows_endpoints_are_local_named_pipes_only() {
        for path in [
            r"\\server\pipe\prts-mcp-main",
            r"C:\data\file",
            r"\\.\pipe\other",
            r"\\.\pipe\prts-mcp-a\b",
        ] {
            assert!(!valid_endpoint(Path::new(path)));
        }
        assert!(valid_endpoint(Path::new(r"\\.\pipe\prts-mcp-main")));
    }
    #[test]
    fn resolves_only_explicit_mapping() {
        let value = parse(&input(), "main").unwrap();
        assert!(value.user);
        assert_eq!(value.unit.as_deref(), Some("prts-mcp.service"));
        assert!(parse(&input(), "other").is_err());
    }
    #[test]
    fn rejects_ambiguous_or_credential_fields() {
        let original = input();
        let invalid = [
            format!("{original}\ntoken='secret'"),
            original.replace("user=true", "user='true'"),
            original.replace("unit='prts-mcp.service'", "unit='other/socket.service'"),
            original
                .lines()
                .map(|line| {
                    if line.starts_with("endpoint=") {
                        "endpoint='relative.sock'"
                    } else {
                        line
                    }
                })
                .collect::<Vec<_>>()
                .join("\n"),
        ];
        for text in invalid {
            assert!(parse(&text, "main").is_err());
        }
        assert!(parse(
            &input().replace("schema_version=1", "schema_version=2"),
            "main"
        )
        .is_err());
    }
}
