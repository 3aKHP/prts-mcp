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

/// Startup-only game-data backend. JSON remains the 3.1 default.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DataBackend {
    Json,
    Sqlite,
}

impl DataBackend {
    fn resolve(
        explicit: Option<&str>,
        custom_database: bool,
        custom_json: bool,
        default: Self,
    ) -> Result<Self, String> {
        let explicit = explicit.map(str::trim).filter(|value| !value.is_empty());
        match explicit {
            Some("json") if custom_database => {
                Err("PRTS_DATA_BACKEND=json conflicts with PRTS_DATA_DB".into())
            }
            Some("json") => Ok(Self::Json),
            Some("sqlite") => Ok(Self::Sqlite),
            Some(_) => Err("PRTS_DATA_BACKEND must be json or sqlite".into()),
            None if custom_database => Ok(Self::Sqlite),
            None if custom_json => Ok(Self::Json),
            None => Ok(default),
        }
    }
}

#[derive(Debug, Clone)]
pub struct RuntimeConfig {
    pub data_backend: DataBackend,
    /// Writable generation directory, used only by the SQLite backend.
    pub database_dir: PathBuf,
    /// Explicit read-only SQLite file; disables game-data auto-sync.
    pub custom_database: Option<PathBuf>,
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
    /// Raw PORT env value — binding semantics are per entry profile (TS
    /// `Number(PORT)` vs GHCR `int(PORT)`), resolved by the HTTP runner.
    pub port_raw: Option<String>,
    /// PRTS_DEBUG_TOKEN — debug-endpoint bearer token; unset or empty
    /// disables the endpoints (JS falsy rule). Never logged.
    pub debug_token: Option<String>,
    /// PRTS_METRICS_ENABLED — only the exact string "true" enables metrics
    /// (no trim/lowercase: TRUE/1/empty are all off).
    pub metrics_enabled: bool,
    /// Bundled read-only data fallback (package `data/` layout): resolved
    /// from `--bundle-root <dir>`, Docker `/app/data`, or the directory
    /// beside the executable's parent (`bin/` + `data/` package layout).
    pub bundle_root: Option<PathBuf>,
}

/// Read-only bundle paths derived from a bundle root (TS BUNDLED_*_PATH).
#[derive(Debug, Clone)]
pub struct BundleRoots {
    pub gamedata: PathBuf,
    pub levels: PathBuf,
    pub storyjson_zip: PathBuf,
}

impl BundleRoots {
    pub fn of(root: &Path) -> Self {
        Self {
            gamedata: root.join("gamedata"),
            levels: root.join("gamedata-levels"),
            storyjson_zip: root.join("storyjson").join("zh_CN.zip"),
        }
    }
}

/// Internal `--bundle-root <dir>` launcher argument (npm shims pass it
/// explicitly; not a public environment variable — docs/04).
pub fn bundle_root_from_argv() -> Option<PathBuf> {
    let args: Vec<String> = std::env::args().collect();
    let idx = args.iter().position(|a| a == "--bundle-root")?;
    args.get(idx + 1).map(PathBuf::from)
}

/// Bundle-root resolution order: explicit launcher argument, Docker layout
/// (`PRTS_MCP_ROOT == "/app"` → `/app/data`), then the native package
/// layout (`<exe_dir>/../data` — `bin/` beside `data/`). A dev-tree binary
/// finds no `data/` and gets no bundle, matching the TS dev layout.
pub fn resolve_bundle_root() -> Option<PathBuf> {
    if let Some(root) = bundle_root_from_argv() {
        return Some(root);
    }
    if std::env::var("PRTS_MCP_ROOT").as_deref() == Ok("/app") {
        return Some(PathBuf::from("/app/data"));
    }
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let candidate = dir.parent()?.join("data");
    candidate.is_dir().then_some(candidate)
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

#[cfg(not(windows))]
fn home_local_share() -> PathBuf {
    std::env::var("HOME")
        .map(|h| PathBuf::from(h).join(".local").join("share"))
        .unwrap_or_else(|_| PathBuf::from(".local").join("share"))
}

fn default_gamedata_path() -> PathBuf {
    if std::env::var("PRTS_MCP_ROOT").as_deref() == Ok("/app") {
        return PathBuf::from("/data/gamedata");
    }
    #[cfg(windows)]
    {
        // The TS baseline uses LOCALAPPDATA ?? homedir()/AppData/Local.
        // Rust >=1.85 resolves USERPROFILE or the Windows user-profile API,
        // matching Node's homedir() without assuming a Unix HOME variable.
        #[allow(deprecated)]
        let home = std::env::home_dir().unwrap_or_else(|| PathBuf::from("."));
        return windows_default_gamedata(std::env::var("LOCALAPPDATA").ok().as_deref(), &home);
    }
    #[cfg(not(windows))]
    {
        let base = std::env::var("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| home_local_share());
        base.join("prts-mcp").join("gamedata")
    }
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
        Self::try_from_lookup(|name| std::env::var(name).ok()).unwrap_or_else(|error| {
            crate::log_err(&error);
            std::process::exit(2);
        })
    }

    /// Testable core: `lookup` stands in for the process environment. Tests
    /// inject GAMEDATA_PATH so the default-path branch stays inert.
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Self {
        Self::try_from_lookup(lookup).expect("valid runtime configuration")
    }

    pub fn try_from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Result<Self, String> {
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

        let database_dir = lookup("PRTS_DATA_DIR")
            .filter(|s| !s.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                if is_custom_gamedata {
                    gamedata_path.join("database")
                } else {
                    gamedata_path
                        .parent()
                        .unwrap_or(&gamedata_path)
                        .join("database")
                }
            });
        let custom_database = lookup("PRTS_DATA_DB")
            .filter(|s| !s.trim().is_empty())
            .map(PathBuf::from);
        let data_backend = DataBackend::resolve(
            lookup("PRTS_DATA_BACKEND").as_deref(),
            custom_database.is_some(),
            is_custom_gamedata || !story_sync_enabled,
            DataBackend::Json,
        )?;
        Ok(Self {
            data_backend,
            database_dir,
            custom_database,
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
            port_raw: lookup("PORT"),
            debug_token: lookup("PRTS_DEBUG_TOKEN").filter(|t| !t.is_empty()),
            metrics_enabled: lookup("PRTS_METRICS_ENABLED").as_deref() == Some("true"),
            bundle_root: None,
        })
    }

    /// `from_env` plus the argv-dependent bundle root.
    pub fn from_env_with_bundle() -> Self {
        let mut config = Self::from_env();
        config.bundle_root = resolve_bundle_root();
        config
    }
}

fn env_bool_from(lookup: &impl Fn(&str) -> Option<String>, name: &str, default: bool) -> bool {
    match lookup(name) {
        Some(raw) => ["1", "true", "yes", "on"].contains(&raw.trim().to_lowercase().as_str()),
        None => default,
    }
}

/// JS `Number(string)` for the PORT input space: whitespace-trimmed decimal
/// (with exponent), `0x/0o/0b` literals, `Infinity`, and `""` → 0. Anything
/// else is NaN. (docs/04: TS profiles keep `Number(PORT)` semantics.)
pub fn js_parse_number(raw: &str) -> f64 {
    let trimmed = raw.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    if trimmed.is_empty() {
        return 0.0;
    }
    let lower = trimmed.to_ascii_lowercase();
    if let Some(hex) = lower.strip_prefix("0x") {
        return if hex.is_empty() || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
            f64::NAN
        } else {
            i64::from_str_radix(hex, 16)
                .map(|v| v as f64)
                .unwrap_or(f64::INFINITY)
        };
    }
    if let Some(oct) = lower.strip_prefix("0o") {
        return if oct.is_empty() || !oct.bytes().all(|b| (b'0'..=b'7').contains(&b)) {
            f64::NAN
        } else {
            i64::from_str_radix(oct, 8)
                .map(|v| v as f64)
                .unwrap_or(f64::INFINITY)
        };
    }
    if let Some(bin) = lower.strip_prefix("0b") {
        return if bin.is_empty() || !bin.bytes().all(|b| b == b'0' || b == b'1') {
            f64::NAN
        } else {
            i64::from_str_radix(bin, 2)
                .map(|v| v as f64)
                .unwrap_or(f64::INFINITY)
        };
    }
    match lower.as_str() {
        "infinity" | "+infinity" => return f64::INFINITY,
        "-infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    // Decimal + exponent; reject strings JS rejects (trailing garbage,
    // hex-float spellings, underscores).
    let bytes = trimmed.as_bytes();
    let mut i = 0;
    if i < bytes.len() && (bytes[i] == b'+' || bytes[i] == b'-') {
        i += 1;
    }
    let int_digits = {
        let start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        i - start
    };
    let mut frac_digits = 0;
    if i < bytes.len() && bytes[i] == b'.' {
        i += 1;
        let start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        frac_digits = i - start;
    }
    if int_digits == 0 && frac_digits == 0 {
        return f64::NAN;
    }
    if i < bytes.len() && (bytes[i] == b'e' || bytes[i] == b'E') {
        i += 1;
        if i < bytes.len() && (bytes[i] == b'+' || bytes[i] == b'-') {
            i += 1;
        }
        let start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i - start == 0 {
            return f64::NAN;
        }
    }
    if i != bytes.len() {
        return f64::NAN;
    }
    trimmed.parse::<f64>().unwrap_or(f64::NAN)
}

/// Bun's listen() interpretation of `Number(PORT)` output, pinned by the
/// oracle probes: NaN / negative / 0 bind an ephemeral port, fractions
/// truncate, >65535 clamps to 65535, and nothing exits on a weird value.
pub fn ts_bind_port(value: f64) -> u16 {
    if !value.is_finite() || value < 0.0 {
        return 0;
    }
    value.trunc().min(65535.0) as u16
}

/// Python `int(PORT)` parse failure marker (GHCR profile). Only the
/// message differs — callers log and exit 1.
#[derive(Debug, PartialEq, Eq)]
pub struct PortNotNumeric;

/// Python `int(PORT)` (GHCR profile): `[+-]?digits` with surrounding
/// whitespace allowed; anything else is a startup error. The value may be
/// out of socket range — binding then fails and the process exits 1.
pub fn python_int_port(raw: &str) -> Result<i64, PortNotNumeric> {
    let trimmed = raw.trim();
    let body = trimmed
        .strip_prefix('+')
        .or_else(|| trimmed.strip_prefix('-'))
        .unwrap_or(trimmed);
    if body.is_empty() || !body.bytes().all(|b| b.is_ascii_digit()) {
        return Err(PortNotNumeric);
    }
    trimmed.parse::<i64>().map_err(|_| PortNotNumeric)
}

/// Windows default data base (pure parsing fixture — docs/04: no Windows
/// real-machine claim from this Linux host). `LOCALAPPDATA ?? ~/AppData/Local`
/// uses the value even when empty (JS `??`, not truthiness).
pub fn windows_default_gamedata(localappdata: Option<&str>, home: &Path) -> PathBuf {
    let base = localappdata
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join("AppData").join("Local"));
    base.join("prts-mcp").join("gamedata")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backend_selection_is_explicit_and_json_remains_the_default() {
        assert_eq!(cfg(&[]).data_backend, DataBackend::Json);
        assert_eq!(
            cfg(&[("PRTS_DATA_BACKEND", "")]).data_backend,
            DataBackend::Json
        );
        assert_eq!(
            cfg(&[("PRTS_DATA_BACKEND", "sqlite")]).data_backend,
            DataBackend::Sqlite
        );
        assert_eq!(
            cfg(&[("PRTS_DATA_DB", "/data/offline.sqlite")]).data_backend,
            DataBackend::Sqlite
        );
        assert_eq!(
            cfg(&[("PRTS_DATA_DIR", "/data/database")]).data_backend,
            DataBackend::Json
        );
        for value in ["auto", "db", "SQLITE"] {
            assert!(RuntimeConfig::try_from_lookup(|key| {
                (key == "PRTS_DATA_BACKEND").then(|| value.into())
            })
            .is_err());
        }
        assert!(RuntimeConfig::try_from_lookup(|key| match key {
            "PRTS_DATA_BACKEND" => Some("json".into()),
            "PRTS_DATA_DB" => Some("offline.sqlite".into()),
            _ => None,
        })
        .is_err());
    }

    #[test]
    fn a_future_default_flip_preserves_explicit_and_legacy_choices() {
        let select =
            |mode, db, json| DataBackend::resolve(mode, db, json, DataBackend::Sqlite).unwrap();
        assert_eq!(select(None, false, false), DataBackend::Sqlite);
        assert_eq!(select(Some("json"), false, false), DataBackend::Json);
        assert_eq!(select(None, false, true), DataBackend::Json);
        assert_eq!(select(Some("sqlite"), false, true), DataBackend::Sqlite);
        for pairs in [
            vec![("GAMEDATA_PATH", "")],
            vec![("STORYJSON_PATH", "/custom/zh_CN.zip")],
        ] {
            assert_eq!(cfg(&pairs).data_backend, DataBackend::Json);
        }
    }

    fn cfg(pairs: &[(&str, &str)]) -> RuntimeConfig {
        let map: std::collections::HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        RuntimeConfig::from_lookup(|name| map.get(name).cloned())
    }

    #[test]
    fn database_paths_are_explicit_and_empty_values_are_ignored() {
        let c = cfg(&[("GAMEDATA_PATH", "/tmp/legacy")]);
        assert_eq!(c.database_dir, PathBuf::from("/tmp/legacy/database"));
        assert!(c.custom_database.is_none());
        let c = cfg(&[
            ("GAMEDATA_PATH", "/tmp/legacy"),
            ("PRTS_DATA_DIR", "/tmp/databases"),
            ("PRTS_DATA_DB", "/tmp/data.db"),
        ]);
        assert_eq!(c.database_dir, PathBuf::from("/tmp/databases"));
        assert_eq!(c.custom_database, Some(PathBuf::from("/tmp/data.db")));
        let c = cfg(&[
            ("GAMEDATA_PATH", "/tmp/legacy"),
            ("PRTS_DATA_DIR", " "),
            ("PRTS_DATA_DB", ""),
        ]);
        assert_eq!(c.database_dir, PathBuf::from("/tmp/legacy/database"));
        assert!(c.custom_database.is_none());
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
        assert_eq!(js_parse_number("3000"), 3000.0);
        assert_eq!(js_parse_number(" 3000 "), 3000.0);
        assert_eq!(js_parse_number("0x10"), 16.0);
        assert_eq!(js_parse_number("0o17"), 15.0);
        assert_eq!(js_parse_number("0b101"), 5.0);
        assert_eq!(js_parse_number("1e2"), 100.0);
        assert_eq!(js_parse_number("3000.5"), 3000.5);
        assert_eq!(js_parse_number(""), 0.0);
        assert!(js_parse_number("abc").is_nan());
        assert!(js_parse_number("1_000").is_nan());
        assert_eq!(js_parse_number("Infinity"), f64::INFINITY);
        // Bun bind interpretation (oracle-pinned).
        assert_eq!(ts_bind_port(3000.0), 3000);
        assert_eq!(ts_bind_port(3000.5), 3000);
        assert_eq!(ts_bind_port(70000.0), 65535);
        assert_eq!(ts_bind_port(-1.0), 0);
        assert_eq!(ts_bind_port(f64::NAN), 0);
        assert_eq!(ts_bind_port(0.0), 0);
        // GHCR int() semantics.
        assert_eq!(python_int_port("3000"), Ok(3000));
        assert_eq!(python_int_port(" 3000 "), Ok(3000));
        assert_eq!(python_int_port("+3000"), Ok(3000));
        assert!(python_int_port("3000.5").is_err());
        assert!(python_int_port("0x10").is_err());
        assert!(python_int_port("abc").is_err());
        assert_eq!(python_int_port("70000"), Ok(70000));
    }

    #[test]
    fn windows_default_is_a_parsing_fixture() {
        let home = Path::new("/home/dev");
        assert_eq!(
            windows_default_gamedata(Some("C:\\Users\\dev\\AppData\\Local"), home),
            PathBuf::from("C:\\Users\\dev\\AppData\\Local/prts-mcp/gamedata")
        );
        assert_eq!(
            windows_default_gamedata(None, home),
            PathBuf::from("/home/dev/AppData/Local/prts-mcp/gamedata")
        );
        // JS `??`: an empty LOCALAPPDATA is used as-is, not treated as unset.
        assert_eq!(
            windows_default_gamedata(Some(""), home),
            PathBuf::from("prts-mcp/gamedata")
        );
    }

    #[test]
    fn debug_and_metrics_flags_parse() {
        let c = cfg(&[
            ("GAMEDATA_PATH", "/tmp/x"),
            ("PRTS_DEBUG_TOKEN", "sekrit"),
            ("PRTS_METRICS_ENABLED", "true"),
        ]);
        assert_eq!(c.debug_token.as_deref(), Some("sekrit"));
        assert!(c.metrics_enabled);
        // TRUE / 1 / empty are NOT true (no envBool reuse).
        for bad in ["TRUE", "1", "", "yes", " true"] {
            let c = cfg(&[("GAMEDATA_PATH", "/tmp/x"), ("PRTS_METRICS_ENABLED", bad)]);
            assert!(!c.metrics_enabled, "{bad:?} must not enable metrics");
        }
        // Empty token disables (JS falsy).
        let c = cfg(&[("GAMEDATA_PATH", "/tmp/x"), ("PRTS_DEBUG_TOKEN", "")]);
        assert_eq!(c.debug_token, None);
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
