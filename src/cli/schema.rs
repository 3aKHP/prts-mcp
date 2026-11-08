//! One schema for file parsing, editing, templates and configuration reports.
use toml_edit::{Item, Value};

#[derive(Clone, Copy)]
pub enum Kind {
    String,
    Path,
    Bool,
    Port,
    Interval,
    Milliseconds,
    Bytes,
    Choice(&'static [&'static str]),
}
pub struct Field {
    pub key: &'static str,
    pub kind: Kind,
    pub example: &'static str,
    pub description: &'static str,
}
use Kind::*;
pub const FIELDS: &[Field] = &[
    Field {
        key: "PRTS_MAX_IMAGE_BYTES",
        kind: Bytes,
        example: "8388608",
        description: "Wiki 图片下载上限（字节），正整数；修改后重启",
    },
    Field {
        key: "HTTP_PROXY",
        kind: String,
        example: "",
        description: "网络代理与免代理配置",
    },
    Field {
        key: "HTTPS_PROXY",
        kind: String,
        example: "",
        description: "网络代理与免代理配置",
    },
    Field {
        key: "ALL_PROXY",
        kind: String,
        example: "",
        description: "网络代理与免代理配置",
    },
    Field {
        key: "NO_PROXY",
        kind: String,
        example: "",
        description: "网络代理与免代理配置",
    },
    Field {
        key: "NODE_EXTRA_CA_CERTS",
        kind: Path,
        example: "ca.pem",
        description: "Wiki 请求的附加 CA 证书",
    },
    Field {
        key: "PRTS_CONTROL_ENDPOINT",
        kind: String,
        example: if cfg!(windows) {
            r"\\.\pipe\prts-mcp-main"
        } else {
            "/run/prts-mcp-main/control.sock"
        },
        description: "本机管理端点；空值关闭，Unix 使用绝对 socket 路径",
    },
    Field {
        key: "PRTS_INSTANCE_NAME",
        kind: String,
        example: "main",
        description: "本机管理实例名称",
    },
    Field {
        key: "PRTS_TRANSPORT",
        kind: Choice(&["http", "stdio"]),
        example: "http",
        description: "传输模式；旧兼容入口保留各自规则",
    },
    Field {
        key: "HOST",
        kind: String,
        example: "0.0.0.0",
        description: "HTTP 监听地址",
    },
    Field {
        key: "PORT",
        kind: Port,
        example: "3000",
        description: "HTTP 监听端口；stdio 不使用",
    },
    Field {
        key: "PRTS_DATA_BACKEND",
        kind: Choice(&["json", "sqlite"]),
        example: "sqlite",
        description: "不设置时默认偏好 SQLite，并允许 JSON 备用；显式 sqlite 不回落",
    },
    Field {
        key: "PRTS_VALIDATION_MODE",
        kind: Choice(&["normal", "strict"]),
        example: "normal",
        description: "数据准入验证模式",
    },
    Field {
        key: "PRTS_DATA_DIR",
        kind: Path,
        example: "database",
        description: "SQLite 可写同步目录",
    },
    Field {
        key: "PRTS_DATA_DB",
        kind: Path,
        example: "data.sqlite",
        description: "自定义只读数据库；关闭游戏数据同步",
    },
    Field {
        key: "GAMEDATA_PATH",
        kind: Path,
        example: "gamedata",
        description: "自定义 JSON 数据路径；关闭游戏表与关卡同步",
    },
    Field {
        key: "STORYJSON_PATH",
        kind: Path,
        example: "storyjson/zh_CN.zip",
        description: "自定义剧情 ZIP；关闭剧情同步",
    },
    Field {
        key: "PRTS_IMAGE_DIR",
        kind: Path,
        example: "images",
        description: "本地立绘同步目录",
    },
    Field {
        key: "PRTS_DATA_SOURCE_REPO",
        kind: String,
        example: "3aKHP/arknights-data-pipeline",
        description: "GitHub 数据源 owner/repo",
    },
    Field {
        key: "GITHUB_TOKEN",
        kind: String,
        example: "",
        description: "GitHub 令牌；优先通过环境变量设置",
    },
    Field {
        key: "GITHUB_MIRRORS",
        kind: String,
        example: "",
        description: "逗号分隔的下载镜像前缀",
    },
    Field {
        key: "PRTS_AUTO_SYNC_INTERVAL_SECONDS",
        kind: Interval,
        example: "3600",
        description: "周期秒数 60..604800；0 仍执行启动同步",
    },
    Field {
        key: "IMAGES_ENABLED",
        kind: Bool,
        example: "true",
        description: "启用立绘工具",
    },
    Field {
        key: "LOCAL_IMAGE",
        kind: Bool,
        example: "false",
        description: "启用本地立绘同步；资产可能达到 GB 量级",
    },
    Field {
        key: "ORIGINAL_IMAGE",
        kind: Bool,
        example: "false",
        description: "本地立绘额外下载原图",
    },
    Field {
        key: "PRTS_IMAGE_CACHE",
        kind: Bool,
        example: "true",
        description: "Wiki 图片内存缓存",
    },
    Field {
        key: "PRTS_OUTPUT_CHANNEL",
        kind: Choice(&["content", "structured", "both"]),
        example: "content",
        description: "MCP 工具输出通道，与 CLI -o 无关",
    },
    Field {
        key: "SESSION_IDLE_TIMEOUT_MS",
        kind: Milliseconds,
        example: "86400000",
        description: "会话空闲毫秒数；非正值禁用清理",
    },
    Field {
        key: "PRTS_DEBUG_TOKEN",
        kind: String,
        example: "",
        description: "诊断端点令牌；优先通过环境变量设置",
    },
    Field {
        key: "PRTS_METRICS_ENABLED",
        kind: Bool,
        example: "false",
        description: "启用指标；还需设置诊断令牌",
    },
];
pub fn field(key: &str) -> Result<&'static Field, std::string::String> {
    FIELDS
        .iter()
        .find(|f| f.key == key)
        .ok_or_else(|| format!("未知配置字段: runtime.{key}"))
}
pub fn sensitive(key: &str) -> bool {
    key.ends_with("TOKEN")
}
pub fn redacted(key: &str) -> bool {
    sensitive(key) || key == "GITHUB_MIRRORS" || key.to_ascii_uppercase().ends_with("PROXY")
}
impl Field {
    /// New configuration values are strict; legacy environment parsing is untouched.
    pub fn parse(&self, raw: &str) -> Result<Value, std::string::String> {
        let invalid = || format!("配置值无效: {}", self.key);
        let value = match self.kind {
            String | Path | Choice(_) => Value::from(raw),
            Bool => Value::from(raw.parse::<bool>().map_err(|_| invalid())?),
            Port | Interval | Bytes => Value::from(raw.parse::<i64>().map_err(|_| invalid())?),
            Milliseconds => Value::from(raw.parse::<f64>().map_err(|_| invalid())?),
        };
        self.read(&Item::Value(value.clone()))?;
        Ok(value)
    }
    pub fn read(&self, item: &Item) -> Result<std::string::String, std::string::String> {
        let invalid = || format!("配置字段类型或取值无效: {}", self.key);
        let raw = match self.kind {
            Bytes => {
                let raw = item.as_integer().ok_or_else(invalid)?.to_string();
                crate::config::parse_max_image_bytes(&raw)?;
                raw
            }
            String => item.as_str().ok_or_else(invalid)?.to_owned(),
            Path => item
                .as_str()
                .filter(|v| !v.trim().is_empty())
                .ok_or_else(invalid)?
                .to_owned(),
            Choice(options) => item
                .as_str()
                .filter(|v| options.contains(v))
                .ok_or_else(invalid)?
                .to_owned(),
            Bool => item.as_bool().ok_or_else(invalid)?.to_string(),
            Port => item
                .as_integer()
                .filter(|n| (0..=65535).contains(n))
                .ok_or_else(invalid)?
                .to_string(),
            Interval => item
                .as_integer()
                .filter(|n| *n == 0 || (60..=604800).contains(n))
                .ok_or_else(invalid)?
                .to_string(),
            Milliseconds => item
                .as_float()
                .or_else(|| item.as_integer().map(|n| n as f64))
                .filter(|n| n.is_finite())
                .ok_or_else(invalid)?
                .to_string(),
        };
        if self.key == "PRTS_DATA_SOURCE_REPO" {
            crate::config::DataSource::parse(Some(&raw))?;
        }
        match self.key {
            "PRTS_INSTANCE_NAME" if !crate::control::instances::valid_name(&raw) => {
                return Err(invalid())
            }
            "PRTS_CONTROL_ENDPOINT"
                if !raw.is_empty()
                    && !crate::control::instances::valid_endpoint(std::path::Path::new(&raw)) =>
            {
                return Err(invalid())
            }
            "HTTP_PROXY" | "HTTPS_PROXY" | "ALL_PROXY"
                if !raw.is_empty() && !crate::config::network::NetworkConfig::valid_proxy(&raw) =>
            {
                return Err(invalid())
            }
            _ => (),
        }
        Ok(raw)
    }
}
pub fn template() -> std::string::String {
    let mut out=std::string::String::from("# PRTS-MCP 用户配置。显式参数 > 环境变量 > 本文件 > 默认值。\n# 取消注释即显式选择；路径相对于本文件。\nschema_version = 1\n\n[runtime]\n");
    for field in FIELDS {
        let example = field.parse(field.example).expect("schema template example");
        out.push_str(&format!(
            "# {}\n# {} = {}\n\n",
            field.description, field.key, example
        ));
    }
    out
}
