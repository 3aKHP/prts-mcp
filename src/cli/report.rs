//! Stable management output; no Debug serialization of runtime secrets.
use super::settings::{environment_value, runtime_environment_value};
use crate::config::{DataBackend, RuntimeConfig};
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::Path};

/// JSON paths are display strings; native paths used for I/O stay lossless.
pub fn path_value(path: Option<&Path>) -> Value {
    json!(path.map(|p| p.to_string_lossy().into_owned()))
}

pub fn configuration(
    cfg: &RuntimeConfig,
    transport: &str,
    path: Option<&Path>,
    env: &BTreeMap<String, String>,
    file: &BTreeMap<String, String>,
    args: &BTreeMap<String, String>,
) -> Value {
    let fields:Vec<_>=super::schema::FIELDS.iter().map(|field|{
        let key=field.key;
        let source=if args.contains_key(key){"argument"}else if runtime_environment_value(env,key).is_some(){"environment"}else if file.contains_key(key){"file"}else{"default"};
        let raw=args.get(key).or_else(||runtime_environment_value(env,key)).or_else(||file.get(key));
        let value=effective(cfg,transport,key);
        let input=if super::schema::redacted(key){raw.map(|_|"[redacted]")}else{raw.map(String::as_str)};
        json!({"key":key,"value":value,"input":input,"source":source,"explanation":explanation(cfg,key)})
    }).collect();
    let network:Vec<_>=["HTTP_PROXY","HTTPS_PROXY","ALL_PROXY","NO_PROXY","http_proxy","https_proxy","all_proxy","no_proxy","NODE_EXTRA_CA_CERTS"].iter().map(|key|{
        let value=environment_value(env,key);
        json!({"key":key,"source":if value.is_some(){"environment"}else{"unset"},"configured":value.is_some(),"value":value.map(|v|if super::schema::redacted(key){"[redacted]"}else{v.as_str()})})
    }).collect();
    json!({"schema_version":1,"scope":"invocation","config_file":path_value(path),"fields":fields,"network_environment":network,"derived":{
        "proxy_discovery":if cfg.network.uses_system_discovery(){"system"}else{"configured"},
        "preferred_backend":backend(cfg),"allow_json_fallback":cfg.allow_json_fallback,
        "game_sync_enabled":match cfg.data_backend{DataBackend::Sqlite=>cfg.custom_database.is_none(),DataBackend::Json=>!cfg.is_custom_gamedata},
        "story_sync_enabled":cfg.data_backend==DataBackend::Json&&cfg.story_sync_enabled,
        "image_sync_enabled":cfg.images_enabled&&cfg.local_image,
        "bundle_root":path_value(cfg.bundle_root.as_deref()),
    }})
}
pub fn backend(cfg: &RuntimeConfig) -> &'static str {
    match cfg.data_backend {
        DataBackend::Json => "json",
        DataBackend::Sqlite => "sqlite",
    }
}
fn effective(c: &RuntimeConfig, transport: &str, key: &str) -> Value {
    match key {
        "HTTP_PROXY" | "HTTPS_PROXY" | "ALL_PROXY" | "NO_PROXY" => {
            json!(c.network.values.get(key).map(|_| "[redacted]"))
        }
        "NODE_EXTRA_CA_CERTS" => path_value(c.network.extra_ca.as_deref()),
        "PRTS_CONTROL_ENDPOINT" => path_value(c.control_endpoint.as_deref()),
        "PRTS_INSTANCE_NAME" => json!(c.instance_name),
        "PRTS_TRANSPORT" => json!(if transport.trim().eq_ignore_ascii_case("stdio") {
            "stdio"
        } else {
            "http"
        }),
        "HOST" => json!(c.host),
        "PORT" => json!(crate::config::ts_bind_port(
            c.port_raw
                .as_deref()
                .map(crate::config::js_parse_number)
                .unwrap_or(3000.0)
        )),
        "PRTS_DATA_BACKEND" => json!(backend(c)),
        "PRTS_VALIDATION_MODE" => json!(if c.validation_mode
            == crate::config::ValidationMode::Strict
        {
            "strict"
        } else {
            "normal"
        }),
        "PRTS_DATA_DIR" => path_value(Some(&c.database_dir)),
        "PRTS_DATA_DB" => path_value(c.custom_database.as_deref()),
        "GAMEDATA_PATH" => path_value(Some(&c.gamedata_path)),
        "STORYJSON_PATH" => path_value(Some(&c.storyjson_zip)),
        "PRTS_IMAGE_DIR" => path_value(Some(&c.images_path)),
        "PRTS_DATA_SOURCE_REPO" => json!(c.data_source.slug()),
        "GITHUB_TOKEN" => json!(c.github_token.as_ref().map(|_| "[redacted]")),
        "PRTS_DEBUG_TOKEN" => json!(c.debug_token.as_ref().map(|_| "[redacted]")),
        "GITHUB_MIRRORS" => json!(c
            .github_mirrors
            .iter()
            .map(|_| "[redacted]")
            .collect::<Vec<_>>()),
        "PRTS_AUTO_SYNC_INTERVAL_SECONDS" => json!(c.auto_sync_interval_ms / 1000),
        "IMAGES_ENABLED" => json!(c.images_enabled),
        "LOCAL_IMAGE" => json!(c.local_image),
        "ORIGINAL_IMAGE" => json!(c.original_image),
        "PRTS_IMAGE_CACHE" => json!(c.prts_image_cache),
        "PRTS_METRICS_ENABLED" => json!(c.metrics_enabled),
        "PRTS_OUTPUT_CHANNEL" => json!(c.output_channel.as_str()),
        "SESSION_IDLE_TIMEOUT_MS" => json!(c.session_idle_timeout_ms),
        _ => Value::Null,
    }
}
fn explanation(c: &RuntimeConfig, key: &str) -> &'static str {
    match key {
        "GAMEDATA_PATH" if c.is_custom_gamedata => "显式 JSON 路径；JSON 游戏表与关卡自动同步关闭",
        "STORYJSON_PATH" if !c.story_sync_enabled => "显式剧情路径；JSON 剧情自动同步关闭",
        "PRTS_DATA_DB" if c.custom_database.is_some() => "只读数据库；游戏数据自动同步关闭",
        "PRTS_DATA_BACKEND" if c.allow_json_fallback => {
            "默认 SQLite 偏好；DB 未就绪时允许 JSON 备用，只同步 SQLite"
        }
        "ORIGINAL_IMAGE" if !c.images_enabled || !c.local_image => {
            "当前未启用本地立绘；该设置不生效"
        }
        "PRTS_IMAGE_CACHE" if c.local_image => "仅用于 Wiki 图片模式；当前不生效",
        "PRTS_METRICS_ENABLED" if c.debug_token.is_none() => "诊断令牌未设置，指标端点不可访问",
        "PORT" => "HTTP 保留既有 Number() 与端口归一化规则；stdio 不使用",
        "PRTS_AUTO_SYNC_INTERVAL_SECONDS" if c.auto_sync_interval_ms == 0 => {
            "仍执行启动同步，关闭周期轮询"
        }
        "SESSION_IDLE_TIMEOUT_MS" if c.session_idle_timeout_ms.is_none() => "空闲会话清理已禁用",
        _ => "",
    }
}

pub fn text(value: &Value, sources: bool) -> String {
    if let Some(template) = value.get("template").and_then(Value::as_str) {
        return template.to_owned();
    }
    if let Some(fields) = value.get("fields").and_then(Value::as_array) {
        let mut out = String::new();
        for field in fields {
            out.push_str(&format!(
                "{} = {}",
                field["key"].as_str().unwrap_or(""),
                field["value"]
            ));
            if sources {
                out.push_str(&format!(
                    "  来源：{}",
                    field["source"].as_str().unwrap_or("")
                ));
            }
            if let Some(reason) = field["explanation"].as_str().filter(|s| !s.is_empty()) {
                out.push_str(&format!("  ({reason})"));
            }
            out.push('\n');
        }
        return out;
    }
    let mut out = String::new();
    fn walk(value: &Value, prefix: &str, out: &mut String) {
        match value {
            Value::Object(map) => {
                for (key, v) in map {
                    walk(
                        v,
                        &if prefix.is_empty() {
                            key.clone()
                        } else {
                            format!("{prefix}.{key}")
                        },
                        out,
                    )
                }
            }
            Value::Array(values) => {
                for (i, v) in values.iter().enumerate() {
                    walk(v, &format!("{prefix}[{i}]"), out)
                }
            }
            _ => out.push_str(&format!("{prefix}: {value}\n")),
        }
    }
    walk(value, "", &mut out);
    out
}
