//! Explicit, side-effect-free TOML loading shared by management and legacy entries.
use crate::config::RuntimeConfig;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};
use toml_edit::DocumentMut;

/// Preserve Windows environment lookup semantics after taking a snapshot.
/// All recognized runtime/proxy keys are ASCII; Unix names remain case-sensitive.
pub(super) fn environment_value<'a>(
    env: &'a BTreeMap<String, String>,
    key: &str,
) -> Option<&'a String> {
    env.get(key).or_else(|| {
        if cfg!(windows) {
            env.iter()
                .find_map(|(name, value)| name.eq_ignore_ascii_case(key).then_some(value))
        } else {
            None
        }
    })
}

pub(super) fn runtime_environment_value<'a>(
    env: &'a BTreeMap<String, String>,
    key: &str,
) -> Option<&'a String> {
    environment_value(env, key).or_else(|| {
        crate::config::network::PROXY_KEYS
            .contains(&key)
            .then(|| environment_value(env, &key.to_ascii_lowercase()))
            .flatten()
    })
}

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
/// The startup lookup context is immutable across reloads. Environment secrets
/// stay in process memory and are never serialized into management reports.
#[derive(Clone)]
pub struct Context {
    pub path: Option<PathBuf>,
    required: bool,
    env: BTreeMap<String, String>,
    overrides: BTreeMap<String, String>,
    home: Option<PathBuf>,
    bundle: Option<PathBuf>,
    profile: String,
    network: crate::config::network::NetworkConfig,
    control_endpoint: Option<PathBuf>,
}
impl Context {
    #[cfg(test)]
    pub(crate) fn isolated(
        path: PathBuf,
        env: BTreeMap<String, String>,
        overrides: BTreeMap<String, String>,
    ) -> Self {
        Self {
            network: crate::config::network::NetworkConfig::from_lookup(|key| {
                env.get(key).cloned()
            }),
            control_endpoint: env
                .get("PRTS_CONTROL_ENDPOINT")
                .filter(|v| !v.is_empty())
                .map(PathBuf::from),
            path: Some(path),
            required: true,
            env,
            overrides,
            home: None,
            bundle: None,
            profile: "prts-mcp".into(),
        }
    }
    pub fn capture(
        path: Option<PathBuf>,
        required: bool,
        overrides: BTreeMap<String, String>,
    ) -> Self {
        Self {
            profile: "prts-mcp".into(),
            network: crate::config::network::NetworkConfig::from_env(),
            control_endpoint: std::env::var_os("PRTS_CONTROL_ENDPOINT")
                .filter(|v| !v.is_empty())
                .map(PathBuf::from),
            path,
            required,
            overrides,
            env: std::env::vars_os()
                .filter_map(|(k, v)| {
                    let k = k.into_string().ok()?;
                    let v = if k == "PRTS_CONTROL_ENDPOINT" {
                        v.to_string_lossy().into_owned()
                    } else {
                        v.into_string().ok()?
                    };
                    Some((k, v))
                })
                .collect(),
            home: std::env::home_dir(),
            bundle: crate::config::resolve_bundle_root(),
        }
    }
    pub fn set_profile(&mut self, profile: &str) {
        self.profile = profile.to_owned();
    }
    pub fn read(&self) -> Result<Settings, String> {
        let file = if let Some(path) = &self.path {
            values(&document(path, self.required)?, path)?
        } else {
            BTreeMap::new()
        };
        let lookup = |key: &str| {
            self.overrides
                .get(key)
                .or_else(|| runtime_environment_value(&self.env, key))
                .or_else(|| file.get(key))
                .cloned()
        };
        let mut config = RuntimeConfig::try_from_lookup_with_home(lookup, self.home.as_deref())?;
        if !crate::config::network::PROXY_KEYS
            .iter()
            .any(|key| file.contains_key(*key))
        {
            config.network.retain_system_resolver(&self.network);
        }
        if let Some(endpoint) = &self.control_endpoint {
            config.control_endpoint = Some(endpoint.clone());
        }
        config.bundle_root = self.bundle.clone();
        let transport_input = lookup("PRTS_TRANSPORT");
        let requested = transport_input
            .as_deref()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        let stdio = match self.profile.as_str() {
            "prts-mcp-ts-stdio" => true,
            "prts-mcp-ghcr" => requested != "http",
            "prts-mcp" => requested == "stdio",
            _ => false,
        };
        let transport = if stdio { "stdio" } else { "http" }.to_owned();
        let report = super::report::configuration(
            &config,
            &transport,
            self.path.as_deref(),
            &self.env,
            &file,
            &self.overrides,
        );
        Ok(Settings {
            config,
            transport,
            report,
            transport_input,
            context: self.clone(),
        })
    }
}
pub struct Settings {
    pub config: RuntimeConfig,
    pub transport: String,
    pub report: Value,
    pub transport_input: Option<String>,
    pub context: Context,
}
pub fn load(
    path: Option<&Path>,
    automatic: bool,
    overrides: &BTreeMap<String, String>,
) -> Result<Settings, String> {
    let explicit = path.is_some();
    let path = if let Some(path) = path {
        Some(path.to_path_buf())
    } else if automatic {
        Some(default_path()?)
    } else {
        None
    };
    // File-relative paths keep the startup directory even if process code
    // subsequently changes its working directory.
    let path = path
        .map(|path| {
            if path.is_absolute() {
                Ok(path)
            } else {
                std::env::current_dir()
                    .map(|cwd| cwd.join(path))
                    .map_err(|e| e.to_string())
            }
        })
        .transpose()?;
    Context::capture(path, explicit, overrides.clone()).read()
}
