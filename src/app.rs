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

use crate::config::RuntimeConfig;
use crate::protocol::http::{self, Shared};
use crate::protocol::session::SessionTable;
use crate::protocol::stdio;
use crate::storage::generation::{
    activated_pair, activated_root, excel_path_of, gamedata_pair_path_for_read,
};
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
}

/// TS `loadConfig`'s data-path half: pair pointer first, extract_meta
/// fallback, completeness gates. The bundled-data fallback joins in P7 with
/// the package layout.
fn resolve_view(config: &RuntimeConfig) -> DataView {
    let pair = activated_pair(&config.gamedata_path, &config.levels_path);
    let excel_active = pair
        .clone()
        .map(|(excel, _)| excel)
        .unwrap_or_else(|| activated_root(&config.gamedata_path));
    let excel_root = excel_path_of(&excel_active);
    let excel_root = crate::config::files_complete(&excel_root).then_some(excel_root);

    let levels_active = pair
        .map(|(_, levels)| levels)
        .unwrap_or_else(|| activated_root(&config.levels_path));
    let levels_root = crate::config::levels_complete(&levels_active).then_some(levels_active);

    let story_zip = if config.storyjson_zip.is_file() {
        Some(config.storyjson_zip.clone())
    } else if PathBuf::from("/data/storyjson/zh_CN.zip").is_file() {
        Some(PathBuf::from("/data/storyjson/zh_CN.zip"))
    } else {
        None
    };

    DataView {
        excel_root,
        levels_root,
        story_zip,
        datasets: Arc::new(crate::domain::datasets::Datasets::new()),
    }
}

/// TS `activationPathToken`: [path, ino, size, mtime, ctime] of one pointer
/// file; a missing file is [path, null]. The signature covers the pair file
/// and both extract_meta files — exactly the files an activation rewrites.
fn path_token(path: &std::path::Path) -> String {
    match std::fs::metadata(path) {
        Ok(meta) => {
            use std::os::unix::fs::MetadataExt;
            format!(
                "{path:?}|{}|{}|{}|{}",
                meta.ino(),
                meta.len(),
                meta.mtime(),
                meta.ctime()
            )
        }
        Err(_) => format!("{path:?}|null"),
    }
}

fn activation_signature(config: &RuntimeConfig) -> String {
    let pair = gamedata_pair_path_for_read(&config.gamedata_path, &config.levels_path);
    format!(
        "{};{};{}",
        path_token(&pair),
        path_token(&config.gamedata_path.join("archives/extract_meta.json")),
        path_token(&config.levels_path.join("archives/extract_meta.json")),
    )
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

pub struct App {
    pub config: Arc<RuntimeConfig>,
    pub data: Arc<DataState>,
    pub handle: AppHandle,
    pub tools: Arc<Vec<crate::tools::ToolEntry>>,
}

impl App {
    pub fn from_env() -> Self {
        Self::with_config(RuntimeConfig::from_env())
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
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()?;
        runtime.block_on(async move {
            self.spawn_background_sync();
            let shared = Arc::new(Shared {
                app: self.handle,
                tools: self.tools,
                sessions: Arc::new(SessionTable::new(self.config.session_idle_timeout_ms)),
                env_channel: self.config.output_channel,
            });
            http::run_http(shared, &self.config.host, self.config.port).await
        })
    }

    pub fn run_stdio(self) -> i32 {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("tokio runtime builds");
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
            "GAMEDATA_PATH" => Some(root.join("gamedata").to_string_lossy().into_owned()),
            "STORYJSON_PATH" => Some(root.join("nope.zip").to_string_lossy().into_owned()),
            _ => None,
        })
    }

    #[test]
    fn snapshot_tracks_activation_changes() {
        let root = temp_root("swap");
        let config = Arc::new(config_for(&root));
        let state = DataState::new(Arc::clone(&config));

        // Empty volume → no data, but the service still resolves.
        let view = state.snapshot();
        assert!(view.excel_root.is_none());
        assert!(view.levels_root.is_none());

        // Publish a generation via the pair pointer (TS-written format).
        let excel_gen = root.join("gamedata/.releases/g1");
        let levels_gen = root.join("gamedata-levels/.releases/g1");
        for (root_dir, file) in [
            (&excel_gen, "zh_CN/gamedata/excel/stage_table.json"),
            (
                &levels_gen,
                "zh_CN/gamedata/levels/enemydata/enemy_database.json",
            ),
        ] {
            write(&root_dir.join(file), "{}");
        }
        for file in [
            "character_table.json",
            "handbook_info_table.json",
            "charword_table.json",
            "story_review_table.json",
        ] {
            write(&excel_gen.join("zh_CN/gamedata/excel").join(file), "{}");
        }
        write(
            &root.join(".gamedata_pair.json"),
            r#"{"commit_sha":"sha1","excel_data_root":".releases/g1","levels_data_root":".releases/g1"}"#,
        );

        // Same signature → cached view; the cached snapshot stays None until
        // the pointer files change on disk (they just did).
        let view = state.snapshot();
        let expected_excel = excel_gen.join("zh_CN/gamedata/excel");
        assert_eq!(
            view.excel_root.as_deref(),
            Some(expected_excel.canonicalize().unwrap().as_path())
        );
        assert_eq!(
            view.levels_root.as_deref(),
            Some(levels_gen.canonicalize().unwrap().as_path())
        );

        // A second snapshot with unchanged pointers reuses the same Arc.
        assert!(Arc::ptr_eq(&state.snapshot(), &state.snapshot()));

        // Removing the pair pointer degrades to the extract_meta fallback.
        std::fs::remove_file(root.join(".gamedata_pair.json")).unwrap();
        write(
            &root.join("gamedata/archives/extract_meta.json"),
            r#"{"commit_sha":"sha1","data_root":".releases/g1"}"#,
        );
        let view = state.snapshot();
        assert!(view.excel_root.is_some());
        assert!(view.levels_root.is_none()); // levels still resolves via its own root (no meta) → legacy root, incomplete
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn story_zip_resolution_prefers_configured_path() {
        let root = temp_root("story");
        let zip = root.join("storyjson/zh_CN.zip");
        write(&zip, "PK");
        let config = RuntimeConfig::from_lookup(|name| match name {
            "GAMEDATA_PATH" => Some(root.join("gamedata").to_string_lossy().into_owned()),
            "STORYJSON_PATH" => Some(zip.to_string_lossy().into_owned()),
            _ => None,
        });
        let state = DataState::new(Arc::new(config));
        assert_eq!(state.snapshot().story_zip.as_deref(), Some(zip.as_path()));
        let _ = std::fs::remove_dir_all(&root);
    }
}
