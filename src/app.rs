//! Application assembly: shared state, transports, shutdown.
//!
//! P2 splits the TS `config.ts ↔ activation.ts` cycle by construction:
//! `RuntimeConfig` (startup, static) lives in config.rs; the dynamic
//! generation-pointer resolution lives here as `DataState`/`DataView`. A
//! tool call takes one `Arc<DataView>` snapshot and reads that generation
//! for the whole call; sync publishes new pointers and later calls take the
//! new snapshot while in-flight calls keep reading the retained old tree.

use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use crate::config::{DataBackend, RuntimeConfig};

mod json;
use crate::diagnostics::RuntimeMetrics;
use crate::protocol::http::{self, Shared};
use crate::protocol::session::SessionTable;
use crate::protocol::stdio;

use crate::sync::scheduler::start_background_sync;
use crate::sync::transport::ReqwestTransport;
use crate::tools::{registry_for, AppHandle};

/// The dynamic data view: what each dataset should actually read right now.
/// `datasets` is the per-generation parsed-table cache (TS datasetAccess
/// slots keyed by activation generation): swapping the view swaps the cache,
/// releasing the old generation's parsed tables with the last reference.
#[derive(Clone)]
pub struct DataView {
    pub excel_root: Option<PathBuf>,
    pub levels_root: Option<PathBuf>,
    pub story_zip: Option<PathBuf>,
    pub datasets: Arc<crate::domain::datasets::Datasets>,
    pub database: Option<Arc<crate::storage::sqlite::GameDb>>,
}

impl DataView {
    pub fn from_database(
        db: Arc<crate::storage::sqlite::GameDb>,
        excel: PathBuf,
        levels: PathBuf,
    ) -> Result<Self, String> {
        let has = |key| db.metadata(key).map(|value| value.as_deref() == Some("1"));
        Ok(Self {
            excel_root: has("excel_available")?.then_some(excel),
            levels_root: has("levels_available")?.then_some(levels),
            story_zip: has("story_available")?.then(|| db.path.clone()),
            datasets: Arc::new(crate::domain::datasets::Datasets::new()),
            database: Some(db),
        })
    }

    pub fn database(&self) -> Option<Arc<crate::storage::sqlite::GameDb>> {
        self.database.clone()
    }

    pub fn excel_store(&self) -> Option<crate::storage::DirectoryStore> {
        let root = self.excel_root.clone()?;
        Some(match &self.database {
            Some(db) => crate::storage::DirectoryStore::database(root, Arc::clone(db), "excel"),
            None => crate::storage::DirectoryStore::new(root),
        })
    }

    pub fn levels_store(&self) -> Option<crate::storage::DirectoryStore> {
        let root = self.levels_root.as_ref()?.join("zh_CN/gamedata/levels");
        Some(match &self.database {
            Some(db) => crate::storage::DirectoryStore::database(root, Arc::clone(db), "levels"),
            None => crate::storage::DirectoryStore::new(root),
        })
    }
}

/// Resolve only database files: explicit path, active/previous cache, bundle.
fn resolve_database_view(config: &RuntimeConfig) -> DataView {
    let paths = crate::storage::database::candidates(
        config.custom_database.as_deref(),
        &config.database_dir,
        config.bundle_root.as_deref(),
    );
    for path in paths {
        if !path.is_file() {
            if config.custom_database.is_some() {
                crate::log_warn(&format!(
                    "Explicit SQLite dataset missing: {}",
                    path.display()
                ));
            }
            continue;
        }
        match crate::storage::database::open_ready(&path).and_then(|db| {
            DataView::from_database(db, config.excel_path.clone(), config.levels_path.clone())
        }) {
            Ok(view) => {
                if config.custom_database.is_none()
                    && view.excel_root.is_none()
                    && view.levels_root.is_none()
                    && view.story_zip.is_none()
                {
                    continue;
                }
                return view;
            }
            Err(error) => crate::log_warn(&format!(
                "SQLite dataset unavailable ({}): {error}",
                path.display()
            )),
        }
    }
    DataView {
        excel_root: None,
        levels_root: None,
        story_zip: None,
        datasets: Arc::new(crate::domain::datasets::Datasets::new()),
        database: None,
    }
}

/// File identity invalidates cached snapshots when a pointer or DB changes.
fn path_token(path: &std::path::Path) -> String {
    let token = crate::storage::identity::path_token(path).unwrap_or_else(|| "null".into());
    format!("{path:?}|{token}")
}

fn database_signature(config: &RuntimeConfig) -> String {
    let mut tokens = vec![
        path_token(&config.database_dir.join("active")),
        path_token(&config.database_dir.join("previous")),
    ];
    for path in crate::storage::database::candidates(
        config.custom_database.as_deref(),
        &config.database_dir,
        config.bundle_root.as_deref(),
    ) {
        tokens.push(path_token(&path));
    }
    tokens.join(";")
}

fn resolve_view(config: &RuntimeConfig) -> DataView {
    match config.data_backend {
        DataBackend::Json => json::resolve_view(config),
        DataBackend::Sqlite => resolve_database_view(config),
    }
}

fn activation_signature(config: &RuntimeConfig) -> String {
    match config.data_backend {
        DataBackend::Json => json::activation_signature(config),
        DataBackend::Sqlite => database_signature(config),
    }
}

/// Shared dynamic data state with signature-keyed snapshot caching: same
/// pointer files → same `Arc<DataView>` (cheap steady state); a changed
/// signature re-resolves. In-flight callers keep their old snapshot.
type CachedView = Option<(String, Arc<DataView>)>;

pub struct DataState {
    config: Arc<RuntimeConfig>,
    cache: Arc<RwLock<CachedView>>,
}

impl DataState {
    pub fn new(config: Arc<RuntimeConfig>) -> Self {
        Self {
            config,
            cache: Arc::new(RwLock::new(None)),
        }
    }

    /// One consistent generation snapshot for a complete tool call.
    pub fn snapshot(&self) -> Arc<DataView> {
        let signature = activation_signature(&self.config);
        if let Some((cached_signature, view)) = self.cache.read().expect("DataState lock").as_ref()
        {
            if cached_signature == &signature {
                return Arc::clone(view);
            }
        }
        let mut guard = self.cache.write().expect("DataState lock");
        if let Some((cached_signature, view)) = guard.as_ref() {
            if cached_signature == &signature {
                return Arc::clone(view);
            }
        }
        let view = Arc::new(resolve_view(&self.config));
        *guard = Some((signature, Arc::clone(&view)));
        Arc::clone(&view)
    }

    /// Test/refresh hook: force the next snapshot to re-resolve.
    pub fn invalidate(&self) {
        *self.cache.write().expect("DataState lock") = None;
    }

    pub fn config(&self) -> &Arc<RuntimeConfig> {
        &self.config
    }
}

/// Which HTTP entry flavor is starting (docs/04).
pub enum HttpProfile {
    /// `prts-mcp-rust` / `prts-mcp-ts` / `prts-mcp-ts-bun`.
    Ts,
    /// GHCR-compatible `prts-mcp` with PRTS_TRANSPORT=http.
    Ghcr,
}

pub struct App {
    pub config: Arc<RuntimeConfig>,
    pub data: Arc<DataState>,
    pub handle: AppHandle,
    pub tools: Arc<Vec<crate::tools::ToolEntry>>,
}

impl App {
    pub fn from_env() -> Self {
        crate::launcher::watch_parent();
        Self::with_config(RuntimeConfig::from_env_with_bundle())
    }

    pub fn with_config(config: RuntimeConfig) -> Self {
        let config = Arc::new(config);
        let data = Arc::new(DataState::new(Arc::clone(&config)));
        let handle = AppHandle::from_parts(Arc::clone(&data), &config);
        Self {
            handle,
            tools: Arc::new(registry_for(config.images_enabled)),
            config,
            data,
        }
    }

    /// Background sync tasks (startup cycle + retries + periodic loop).
    /// Spawned on the ambient runtime; cancelled when the process exits.
    fn spawn_background_sync(&self) {
        let transport = Arc::new(ReqwestTransport::new(
            self.config.github_mirrors.clone(),
            self.config.github_token.clone(),
        ));
        start_background_sync(Arc::clone(&self.config), transport);
    }

    pub fn run_http(self) -> std::io::Result<()> {
        self.run_http_profile(HttpProfile::Ts)
    }

    /// HTTP entry flavors (docs/04 入口 profiles): TS-profile bins keep
    /// `Number(PORT)` + the server.ts startup line; the GHCR-compatible
    /// `prts-mcp` bin parses PORT like python `int()` and exits 1 on a
    /// non-numeric value (only reached when PRTS_TRANSPORT=http).
    pub fn run_http_profile(self, profile: HttpProfile) -> std::io::Result<()> {
        let mut builder = tokio::runtime::Builder::new_multi_thread();
        if self.config.data_backend == DataBackend::Sqlite {
            // Six query slots plus room for sync and async filesystem work.
            builder.max_blocking_threads(8);
        }
        let runtime = builder.enable_all().build()?;
        runtime.block_on(async move {
            self.spawn_background_sync();
            let metrics = self.config.metrics_enabled.then(|| {
                Arc::new(RuntimeMetrics::new(
                    self.tools.iter().map(|t| t.name.to_string()),
                ))
            });
            let shared = Arc::new(Shared {
                app: self.handle,
                sessions: Arc::new(SessionTable::with_metrics(
                    self.config.session_idle_timeout_ms,
                    metrics.clone(),
                )),
                env_channel: self.config.output_channel,
                metrics,
                debug_token: self.config.debug_token.clone(),
                tools: self.tools,
            });
            let host = self.config.host.clone();
            let (bind_port, startup_line) = match profile {
                HttpProfile::Ts => {
                    let value = self
                        .config
                        .port_raw
                        .as_deref()
                        .map(crate::config::js_parse_number)
                        .unwrap_or(3000.0);
                    let display = crate::text::numbers::js_number_to_string(value);
                    let bind = crate::config::ts_bind_port(value);
                    let line = format!(
                        "PRTS MCP Server {} listening on {host}:{display} (StreamableHTTP at /mcp)",
                        crate::SERVER_VERSION
                    );
                    (bind, line)
                }
                HttpProfile::Ghcr => {
                    let port: u16 = match self.config.port_raw.as_deref() {
                        None => 3000,
                        Some(raw) => match crate::config::python_int_port(raw) {
                            Ok(v) if (0..=65535).contains(&v) => v as u16,
                            Ok(v) => {
                                return Err(std::io::Error::new(
                                    std::io::ErrorKind::InvalidInput,
                                    format!("invalid port {v}"),
                                ));
                            }
                            Err(_) => {
                                return Err(std::io::Error::new(
                                    std::io::ErrorKind::InvalidInput,
                                    format!("PORT must be numeric, got '{raw}'. Exiting."),
                                ));
                            }
                        },
                    };
                    let line =
                        format!("PRTS-MCP Streamable HTTP listening on {host}:{port} (/mcp)");
                    (port, line)
                }
            };
            http::run_http(shared, &host, bind_port, startup_line).await
        })
    }

    pub fn run_stdio(self) -> i32 {
        let mut builder = tokio::runtime::Builder::new_multi_thread();
        if self.config.data_backend == DataBackend::Sqlite {
            // Six query slots plus room for sync and async filesystem work.
            builder.max_blocking_threads(8);
        }
        let runtime = builder.enable_all().build().expect("tokio runtime builds");
        runtime.block_on(async move {
            self.spawn_background_sync();
            stdio::run_stdio(
                self.handle,
                (*self.tools).clone(),
                self.config.output_channel,
            )
            .await
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("prts-view-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &std::path::Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn config_for(root: &std::path::Path) -> RuntimeConfig {
        RuntimeConfig::from_lookup(|name| match name {
            "PRTS_DATA_BACKEND" => Some("sqlite".into()),
            "GAMEDATA_PATH" => Some(root.join("gamedata").to_string_lossy().into_owned()),
            "STORYJSON_PATH" => Some(root.join("nope.zip").to_string_lossy().into_owned()),
            _ => None,
        })
    }

    fn database(path: &std::path::Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let db = rusqlite::Connection::open(path).unwrap();
        db.execute_batch(include_str!("../contracts/sqlite-schema-v1.sql"))
            .unwrap();
        for (key, value) in [
            ("contract", "prts-mcp-sqlite/v1"),
            ("index_version", "1"),
            ("language", "zh_CN"),
            ("sources_complete", "1"),
            ("derived_complete", "1"),
            ("excel_available", "1"),
            ("levels_available", "1"),
            ("story_available", "1"),
        ] {
            db.execute("INSERT INTO meta VALUES(?1,?2)", [key, value])
                .unwrap();
        }
    }

    #[test]
    fn snapshot_tracks_database_activation_and_pins_old_generation() {
        use crate::storage::database::ActiveDatabase;
        let root = temp_root("swap");
        let config = Arc::new(config_for(&root));
        let state = DataState::new(Arc::clone(&config));
        assert!(state.snapshot().database.is_none());
        for name in ["first.sqlite", "second.sqlite"] {
            database(&config.database_dir.join(name));
        }
        let pointer = |file: &str| {
            ActiveDatabase {
                file_name: file.into(),
                source_version: "fixture".into(),
                revision: 1,
                sha256: "a".repeat(64),
            }
            .encode()
            .unwrap()
        };
        write(
            &config.database_dir.join("active"),
            &pointer("first.sqlite"),
        );
        let first = state.snapshot();
        assert!(first.database.is_some());
        assert!(Arc::ptr_eq(&first, &state.snapshot()));
        write(
            &config.database_dir.join("active"),
            &pointer("second.sqlite"),
        );
        let second = state.snapshot();
        assert!(!Arc::ptr_eq(&first, &second));
        assert!(first
            .database
            .as_ref()
            .unwrap()
            .path
            .ends_with("first.sqlite"));
        assert!(second
            .database
            .as_ref()
            .unwrap()
            .path
            .ends_with("second.sqlite"));
        drop((first, second, state));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn raw_files_and_story_zip_are_not_runtime_sources() {
        let root = temp_root("raw");
        write(
            &root.join("gamedata/zh_CN/gamedata/excel/character_table.json"),
            "{}",
        );
        write(&root.join("storyjson/zh_CN.zip"), "PK");
        let state = DataState::new(Arc::new(config_for(&root)));
        assert!(state.snapshot().database.is_none());
        assert!(state.snapshot().story_zip.is_none());
        std::fs::remove_dir_all(root).unwrap();
    }
}
