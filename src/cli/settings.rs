//! Explicit, side-effect-free TOML loading shared by management and legacy entries.
use crate::config::RuntimeConfig;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};
use toml_edit::DocumentMut;

pub fn default_path() -> Result<PathBuf, String> {
    if cfg!(windows) {
        let root = std::env::var_os("APPDATA")
            .filter(|p| !p.is_empty())
            .map(PathBuf::from)
            .or_else(|| std::env::home_dir().map(|p| p.join("AppData/Roaming")));
        root.map(|p| p.join("prts-mcp/config.toml"))
            .ok_or("无法确定配置目录".into())
    } else {
        let root = std::env::var_os("XDG_CONFIG_HOME")
            .filter(|p| !p.is_empty())
            .map(PathBuf::from)
            .or_else(|| std::env::home_dir().map(|p| p.join(".config")));
        root.map(|p| p.join("prts-mcp/config.toml"))
            .ok_or("无法确定配置目录".into())
    }
}
pub fn document(path: &Path, required: bool) -> Result<DocumentMut, String> {
    match std::fs::read_to_string(path) {
        Ok(s) => s.parse().map_err(|_| "配置 TOML 语法无效".into()),
        Err(e) if !required && e.kind() == std::io::ErrorKind::NotFound => {
            Ok("schema_version = 1\n[runtime]\n".parse().unwrap())
        }
        Err(e) => Err(format!("无法读取配置 {}: {e}", path.display())),
    }
}
pub fn values(doc: &DocumentMut, path: &Path) -> Result<BTreeMap<String, String>, String> {
    if doc.get("schema_version").and_then(|v| v.as_integer()) != Some(1) {
        return Err("schema_version 必须为 1".into());
    }
    if doc
        .iter()
        .any(|(k, _)| k != "schema_version" && k != "runtime")
    {
        return Err("未知配置表".into());
    }
    let mut out = BTreeMap::new();
    if let Some(item) = doc.get("runtime") {
        let table = item.as_table().ok_or("runtime 必须为表")?;
        for (key, value) in table.iter() {
            let field = super::schema::field(key)?;
            let mut value = field.read(value)?;
            if matches!(field.kind, super::schema::Kind::Path)
                && !value.is_empty()
                && Path::new(&value).is_relative()
            {
                value = path
                    .parent()
                    .unwrap_or(Path::new("."))
                    .join(value)
                    .into_os_string()
                    .into_string()
                    .map_err(|_| "配置文件相对路径不能表示为 UTF-8；请使用可表示的绝对路径")?
            }
            out.insert(key.into(), value);
        }
    }
    Ok(out)
}
pub struct Settings {
    pub config: RuntimeConfig,
    pub transport: String,
    pub report: Value,
    pub transport_input: Option<String>,
}
pub fn load(
    path: Option<&Path>,
    automatic: bool,
    overrides: &BTreeMap<String, String>,
) -> Result<Settings, String> {
    let explicit = path.is_some();
    let path = if let Some(p) = path {
        Some(p.to_path_buf())
    } else if automatic {
        Some(default_path()?)
    } else {
        None
    };
    let file = if let Some(p) = &path {
        values(&document(p, explicit)?, p)?
    } else {
        BTreeMap::new()
    };
    let env: BTreeMap<_, _> = std::env::vars_os()
        .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?)))
        .collect();
    let lookup = |k: &str| {
        overrides
            .get(k)
            .or_else(|| env.get(k))
            .or_else(|| file.get(k))
            .cloned()
    };
    let mut config =
        RuntimeConfig::try_from_lookup_with_home(lookup, std::env::home_dir().as_deref())?;
    config.bundle_root = crate::config::resolve_bundle_root();
    let transport = lookup("PRTS_TRANSPORT").unwrap_or_else(|| "http".into());
    let report =
        super::report::configuration(&config, &transport, path.as_deref(), &env, &file, overrides);
    let transport_input = lookup("PRTS_TRANSPORT");
    Ok(Settings {
        config,
        transport,
        report,
        transport_input,
    })
}
