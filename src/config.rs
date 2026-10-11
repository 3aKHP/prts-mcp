//! Startup option parsing (docs/04-runtime-contracts.md).
//!
//! `RuntimeConfig` mirrors the once-parsed startup half of TS `config.ts`:
//! paths and switches only. The TS `config.ts ↔ activation.ts` cycle does
//! not exist here — dynamic generation-pointer resolution lives in
//! `app::DataState`, and `config` stays free of downstream imports.

use std::path::{Path, PathBuf};

use crate::sync::scheduler::resolve_auto_sync_interval_ms;
use crate::sync::transport::parse_mirrors;
use crate::tools::output::OutputChannel;

/// Files whose presence marks an excel dataset "complete" (config.ts
/// REQUIRED_OPERATOR_FILES). Existence only — content checks belong to readers.
const REQUIRED_OPERATOR_FILES: [&str; 4] = [
    "character_table.json",
    "handbook_info_table.json",
    "charword_table.json",
    "story_review_table.json",
];

#[derive(Debug, Clone)]
pub struct RuntimeConfig {
    /// Sync write target / custom root when GAMEDATA_PATH is set.
    pub gamedata_path: PathBuf,
    /// GAMEDATA_PATH was explicitly present in the environment (even empty).
    pub is_custom_gamedata: bool,
    pub excel_path: PathBuf,
    pub levels_path: PathBuf,
    /// Configured storyjson zip (STORYJSON_PATH or the default sibling).
    /// The sync target — what is actually readable is a DataView concern.
    pub storyjson_zip: PathBuf,
    /// STORYJSON_PATH unset or empty → the release sync runs (JS falsy rule:
    /// an empty string does NOT disable story sync).
    pub story_sync_enabled: bool,
    pub images_enabled: bool,
    pub local_image: bool,
    pub original_image: bool,
    pub prts_image_cache: bool,
    pub images_path: PathBuf,
    /// PRTS_AUTO_SYNC_INTERVAL_SECONDS: 0 = startup sync only; invalid
    /// spellings fall back to the 3600s default.
    pub auto_sync_interval_ms: u64,
    /// GITHUB_TOKEN — used for GitHub request auth; never logged.
    pub github_token: Option<String>,
    /// GITHUB_MIRRORS parsed at startup.
    pub github_mirrors: Vec<String>,
    /// SESSION_IDLE_TIMEOUT_MS: None disables idle eviction (`<= 0` sentinel);
    /// unset defaults to 24h. Fractional seconds are legal (positive finite
    /// decimal), so this stays f64.
    pub session_idle_timeout_ms: Option<f64>,
    /// Default output channel from PRTS_OUTPUT_CHANNEL (per-process baseline;
    /// HTTP layers layer query/header overrides on top per their own rules).
    pub output_channel: OutputChannel,
    pub host: String,
    pub port: u16,
}

/// Strict-decimal check for SESSION_IDLE_TIMEOUT_MS: `[+-]?(digits[.digits]? | .digits)(e[+-]?digits)?`
/// — ASCII digits only; `0x10`, `1_000`, and fullwidth digits are rejected
/// like the TS regex (which deliberately avoids `\d` for parity reasons).
fn parse_session_idle_timeout(raw: &str) -> Option<f64> {
    let trimmed = raw.trim();
    let bytes = trimmed.as_bytes();
    let decimal = |b: u8| b.is_ascii_digit();
    let mut i = 0;
    if i < bytes.len() && (bytes[i] == b'+' || bytes[i] == b'-') {
        i += 1;
    }
    let int_digits = {
        let start = i;
        while i < bytes.len() && decimal(bytes[i]) {
            i += 1;
        }
        i - start
    };
    let mut frac_digits = 0;
    if i < bytes.len() && bytes[i] == b'.' {
        i += 1;
        let start = i;
        while i < bytes.len() && decimal(bytes[i]) {
            i += 1;
        }
        frac_digits = i - start;
    }
    if int_digits == 0 && frac_digits == 0 {
        return None;
    }
    if i < bytes.len() && (bytes[i] == b'e' || bytes[i] == b'E') {
        i += 1;
        if i < bytes.len() && (bytes[i] == b'+' || bytes[i] == b'-') {
            i += 1;
        }
        let start = i;
        while i < bytes.len() && decimal(bytes[i]) {
            i += 1;
        }
        if i - start == 0 {
            return None;
        }
    }
    if i != bytes.len() {
        return None;
    }
    match trimmed.parse::<f64>() {
        Ok(v) if v.is_finite() && v > 0.0 => Some(v),
        _ => None,
    }
}

pub fn files_complete(excel: &Path) -> bool {
    REQUIRED_OPERATOR_FILES
        .iter()
        .all(|f| excel.join(f).is_file())
}

pub fn levels_complete(root: &Path) -> bool {
    root.join("zh_CN/gamedata/levels/enemydata/enemy_database.json")
        .is_file()
}

fn home_local_share() -> PathBuf {
    std::env::var("HOME")
        .map(|h| PathBuf::from(h).join(".local").join("share"))
        .unwrap_or_else(|_| PathBuf::from(".local").join("share"))
}

fn default_gamedata_path() -> PathBuf {
    if std::env::var("PRTS_MCP_ROOT").as_deref() == Ok("/app") {
        return PathBuf::from("/data/gamedata");
    }
    // Windows LOCALAPPDATA handling is a pure-parsing fixture for P7; on this
    // Linux verification host the XDG branch is the live path.
    let base = std::env::var("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| home_local_share());
    base.join("prts-mcp").join("gamedata")
}

fn levels_path_of(gamedata_root: &Path) -> PathBuf {
    gamedata_root
        .parent()
        .unwrap_or(gamedata_root)
        .join("gamedata-levels")
}

fn resolve_levels_path(gamedata_root: &Path, gamedata_env_set: bool) -> PathBuf {
    if gamedata_env_set {
        if levels_complete(gamedata_root) {
            return gamedata_root.to_path_buf();
        }
        return levels_path_of(gamedata_root);
    }
    if std::env::var("PRTS_MCP_ROOT").as_deref() == Ok("/app") {
        return PathBuf::from("/data/gamedata-levels");
    }
    levels_path_of(gamedata_root)
}

fn excel_path_of(root: &Path) -> PathBuf {
    root.join("zh_CN").join("gamedata").join("excel")
}

impl RuntimeConfig {
    pub fn from_env() -> Self {
        Self::from_lookup(|name| std::env::var(name).ok())
    }

    /// Testable core: `lookup` stands in for the process environment. Tests
    /// inject GAMEDATA_PATH so the default-path branch stays inert.
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Self {
        let is_custom_gamedata = lookup("GAMEDATA_PATH").is_some();
        let gamedata_path = lookup("GAMEDATA_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(default_gamedata_path);
        let excel_path = excel_path_of(&gamedata_path);
        let levels_path = resolve_levels_path(&gamedata_path, is_custom_gamedata);

        let default_storyjson_zip = gamedata_path
            .parent()
            .unwrap_or(&gamedata_path)
            .join("storyjson")
            .join("zh_CN.zip");
        let storyjson_env = lookup("STORYJSON_PATH");
        let storyjson_zip = storyjson_env
            .clone()
            .map(PathBuf::from)
            .unwrap_or(default_storyjson_zip);
        // JS `!process.env["STORYJSON_PATH"]`: unset OR empty string runs the
        // release sync; only a non-empty value disables it.
        let story_sync_enabled = storyjson_env.as_deref().is_none_or(str::is_empty);

        let images_path = lookup("PRTS_IMAGE_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                gamedata_path
                    .parent()
                    .unwrap_or(&gamedata_path)
                    .join("images")
            });

        Self {
            gamedata_path,
            is_custom_gamedata,
            excel_path,
            levels_path,
            storyjson_zip,
            story_sync_enabled,
            images_enabled: env_bool_from(&lookup, "IMAGES_ENABLED", true),
            local_image: env_bool_from(&lookup, "LOCAL_IMAGE", false),
            original_image: env_bool_from(&lookup, "ORIGINAL_IMAGE", false),
            prts_image_cache: env_bool_from(&lookup, "PRTS_IMAGE_CACHE", true),
            images_path,
            auto_sync_interval_ms: resolve_auto_sync_interval_ms(
                lookup("PRTS_AUTO_SYNC_INTERVAL_SECONDS").as_deref(),
            ),
            github_token: lookup("GITHUB_TOKEN").filter(|t| !t.is_empty()),
            github_mirrors: parse_mirrors(lookup("GITHUB_MIRRORS").as_deref().unwrap_or("")),
            session_idle_timeout_ms: match lookup("SESSION_IDLE_TIMEOUT_MS") {
                None => Some(86_400_000.0),
                Some(raw) => parse_session_idle_timeout(&raw),
            },
            output_channel: crate::tools::output::parse_channel(
                lookup("PRTS_OUTPUT_CHANNEL").as_deref(),
            ),
            host: lookup("HOST").unwrap_or_else(|| "0.0.0.0".to_string()),
            port: lookup("PORT").and_then(|p| parse_port(&p)).unwrap_or(3000),
        }
    }
}

fn env_bool_from(lookup: &impl Fn(&str) -> Option<String>, name: &str, default: bool) -> bool {
    match lookup(name) {
        Some(raw) => ["1", "true", "yes", "on"].contains(&raw.trim().to_lowercase().as_str()),
        None => default,
    }
}

fn parse_port(raw: &str) -> Option<u16> {
    raw.trim()
        .parse::<f64>()
        .ok()
        .filter(|v| v.fract() == 0.0 && (0.0..=65535.0).contains(v))
        .map(|v| v as u16)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(pairs: &[(&str, &str)]) -> RuntimeConfig {
        let map: std::collections::HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        RuntimeConfig::from_lookup(|name| map.get(name).cloned())
    }

    #[test]
    fn custom_gamedata_path_wins() {
        let c = cfg(&[("GAMEDATA_PATH", "/tmp/x")]);
        assert!(c.is_custom_gamedata);
        assert_eq!(c.gamedata_path, PathBuf::from("/tmp/x"));
        assert_eq!(c.excel_path, PathBuf::from("/tmp/x/zh_CN/gamedata/excel"));
        // Custom root without levels data → sibling gamedata-levels.
        assert_eq!(c.levels_path, PathBuf::from("/tmp/gamedata-levels"));
    }

    #[test]
    fn empty_gamedata_path_is_still_custom() {
        let c = cfg(&[("GAMEDATA_PATH", "")]);
        assert!(c.is_custom_gamedata);
        assert_eq!(c.gamedata_path, PathBuf::from(""));
    }

    #[test]
    fn story_sync_enabled_follows_js_falsy_rule() {
        // Unset → enabled, default sibling path.
        let c = cfg(&[("GAMEDATA_PATH", "/tmp/x")]);
        assert!(c.story_sync_enabled);
        assert_eq!(c.storyjson_zip, PathBuf::from("/tmp/storyjson/zh_CN.zip"));
        // Empty string → STILL enabled (falsy value), but the target is "".
        let c = cfg(&[("GAMEDATA_PATH", "/tmp/x"), ("STORYJSON_PATH", "")]);
        assert!(c.story_sync_enabled);
        assert_eq!(c.storyjson_zip, PathBuf::from(""));
        // Non-empty → disabled.
        let c = cfg(&[("GAMEDATA_PATH", "/tmp/x"), ("STORYJSON_PATH", "/my/zip")]);
        assert!(!c.story_sync_enabled);
        assert_eq!(c.storyjson_zip, PathBuf::from("/my/zip"));
    }

    #[test]
    fn mirrors_and_token_parse_at_startup() {
        let c = cfg(&[
            ("GAMEDATA_PATH", "/tmp/x"),
            (
                "GITHUB_MIRRORS",
                " https://a.example/ ,, https://b.example// ",
            ),
            ("GITHUB_TOKEN", "secret"),
        ]);
        assert_eq!(
            c.github_mirrors,
            vec!["https://a.example", "https://b.example"]
        );
        assert_eq!(c.github_token.as_deref(), Some("secret"));
        let none = cfg(&[("GAMEDATA_PATH", "/tmp/x"), ("GITHUB_TOKEN", "")]);
        assert_eq!(none.github_token, None);
    }

    #[test]
    fn session_idle_timeout_strict_decimal() {
        assert_eq!(parse_session_idle_timeout("1500"), Some(1500.0));
        assert_eq!(parse_session_idle_timeout("+1.5e3"), Some(1500.0));
        assert_eq!(parse_session_idle_timeout("0"), None);
        assert_eq!(parse_session_idle_timeout("-5"), None);
        assert_eq!(parse_session_idle_timeout("0x10"), None);
        assert_eq!(parse_session_idle_timeout("1_000"), None);
        assert_eq!(parse_session_idle_timeout("１００"), None);
        assert_eq!(parse_session_idle_timeout(""), None);
        assert_eq!(parse_session_idle_timeout(" 300 "), Some(300.0));
    }

    #[test]
    fn unset_session_idle_defaults_to_24h() {
        let c = cfg(&[("GAMEDATA_PATH", "/tmp/x")]);
        assert_eq!(c.session_idle_timeout_ms, Some(86_400_000.0));
        let disabled = cfg(&[
            ("GAMEDATA_PATH", "/tmp/x"),
            ("SESSION_IDLE_TIMEOUT_MS", "abc"),
        ]);
        assert_eq!(disabled.session_idle_timeout_ms, None);
    }

    #[test]
    fn output_channel_from_env() {
        let c = cfg(&[
            ("GAMEDATA_PATH", "/tmp/x"),
            ("PRTS_OUTPUT_CHANNEL", " both "),
        ]);
        assert_eq!(c.output_channel, OutputChannel::Both);
        let bad = cfg(&[
            ("GAMEDATA_PATH", "/tmp/x"),
            ("PRTS_OUTPUT_CHANNEL", "nonsense"),
        ]);
        assert_eq!(bad.output_channel, OutputChannel::Content);
    }

    #[test]
    fn port_uses_number_semantics() {
        assert_eq!(parse_port("3000"), Some(3000));
        assert_eq!(parse_port(" 80 "), Some(80));
        assert_eq!(parse_port("0x10"), None);
        assert_eq!(parse_port("abc"), None);
        assert_eq!(parse_port("70000"), None);
    }

    #[test]
    fn auto_sync_interval_from_env() {
        let c = cfg(&[("GAMEDATA_PATH", "/tmp/x")]);
        assert_eq!(c.auto_sync_interval_ms, 3_600_000);
        let c = cfg(&[
            ("GAMEDATA_PATH", "/tmp/x"),
            ("PRTS_AUTO_SYNC_INTERVAL_SECONDS", "0"),
        ]);
        assert_eq!(c.auto_sync_interval_ms, 0);
        let c = cfg(&[
            ("GAMEDATA_PATH", "/tmp/x"),
            ("PRTS_AUTO_SYNC_INTERVAL_SECONDS", "nonsense"),
        ]);
        assert_eq!(c.auto_sync_interval_ms, 3_600_000);
    }
}
