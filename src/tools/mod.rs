//! Tool parameter boundaries, thin dispatch and unified result wrapping.

pub mod gamedata_tools;
pub mod output;
pub mod story_tools;
pub mod wiki_tools;
pub mod zodish;

use std::future::Future;
use std::pin::Pin;

use serde_json::Value;

pub use output::OutputChannel;

/// A tool call's future: the Wiki/image dispatchers await network I/O, so the
/// dispatch entry is an async fn behind a boxed future (TS handlers are
/// async functions on the same boundary).
pub type DispatchFuture<'a> = Pin<Box<dyn Future<Output = DispatchResult> + Send + 'a>>;

pub type DispatchFn = for<'a> fn(&'a AppHandle, &'a Value) -> DispatchFuture<'a>;

/// A registered tool: name + description + input schema published verbatim
/// from the oracle's tools/list capture (contracts/cases/golden), plus the
/// dispatch entry point.
#[derive(Clone)]
pub struct ToolEntry {
    pub name: &'static str,
    pub declaration: Value,
    pub dispatch: DispatchFn,
}

pub enum DispatchResult {
    /// Tool-level outcome (may itself carry an error text with isError).
    Outcome(crate::tools::output::ToolOutcome),
    /// JSON-RPC level failure (unknown tool, malformed arguments envelope).
    RpcError(i64, String),
}

/// Read-only handle the tool layer needs: dynamic data state + the static
/// sync-target paths the missing-data messages print (exactly the TS
/// `cfg.excelPath`/`cfg.levelsPath` the oracle shows, not the effective
/// generation directory).
pub struct AppHandle {
    pub data: std::sync::Arc<crate::app::DataState>,
    pub excel_missing_message: String,
}

impl AppHandle {
    pub fn from_parts(
        data: std::sync::Arc<crate::app::DataState>,
        config: &crate::config::RuntimeConfig,
    ) -> Self {
        let excel_missing_message = format!(
            "关卡数据暂不可用。容器启动时的 auto-sync 可能仍在进行中，请稍后重试；若持续出现此提示，请检查网络连接或提供 GITHUB_TOKEN 以降低限速风险。（当前同步目标路径：{}）",
            config.excel_path.display()
        );
        Self {
            data,
            excel_missing_message,
        }
    }

    pub fn from_config(config: &crate::config::RuntimeConfig) -> Self {
        let data = std::sync::Arc::new(crate::app::DataState::new(std::sync::Arc::new(
            config.clone(),
        )));
        Self::from_parts(data, config)
    }

    /// One generation snapshot for a complete tool call.
    pub fn snapshot(&self) -> std::sync::Arc<crate::app::DataView> {
        self.data.snapshot()
    }

    /// Static sync target for excel (missing-data message wording).
    pub fn excel_path(&self) -> std::path::PathBuf {
        self.data.config().excel_path.clone()
    }

    /// Static sync target for zh_CN-levels.
    pub fn levels_path(&self) -> std::path::PathBuf {
        self.data.config().levels_path.clone()
    }

    /// Static configured story zip path (missing-data message wording).
    pub fn storyjson_path(&self) -> std::path::PathBuf {
        self.data.config().storyjson_zip.clone()
    }
}

/// Embed a tool declaration captured from the oracle (name/description/
/// inputSchema with the captured key order) and wrap a synchronous
/// dispatcher into the boxed-future slot.
macro_rules! tool {
    ($name:literal, $dispatch:path) => {
        ToolEntry {
            name: $name,
            declaration: serde_json::from_str(include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/tools/schemas/",
                $name,
                ".tool.json"
            )))
            .expect(concat!("embedded declaration parses: ", $name)),
            dispatch: |app, args| Box::pin(std::future::ready(($dispatch)(app, args))),
        }
    };
}

/// Same declaration embedding, but `$dispatch` already returns the boxed
/// future itself (async Wiki dispatchers).
macro_rules! tool_async {
    ($name:literal, $dispatch:path) => {
        ToolEntry {
            name: $name,
            declaration: serde_json::from_str(include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/tools/schemas/",
                $name,
                ".tool.json"
            )))
            .expect(concat!("embedded declaration parses: ", $name)),
            dispatch: $dispatch,
        }
    };
}

pub fn registry() -> Vec<ToolEntry> {
    vec![
        // Oracle tools/list order: the two Wiki tools register FIRST (TS
        // server.ts registers prts tools before gamedata/story/artwork).
        tool_async!("search_prts", wiki_tools::search_prts),
        tool_async!("prts_page", wiki_tools::prts_page),
        tool!(
            "get_operator_archives",
            gamedata_tools::get_operator_archives
        ),
        tool!(
            "get_operator_voicelines",
            gamedata_tools::get_operator_voicelines
        ),
        tool!(
            "get_operator_basic_info",
            gamedata_tools::get_operator_basic_info
        ),
        tool!("list_enemies", gamedata_tools::list_enemies),
        tool!("get_enemy_info", gamedata_tools::get_enemy_info),
        tool!("get_stage_enemies", gamedata_tools::get_stage_enemies),
        tool!(
            "get_enemy_appearances",
            gamedata_tools::get_enemy_appearances
        ),
        tool!("list_stages", gamedata_tools::list_stages),
        tool!("get_stage_info", gamedata_tools::get_stage_info),
        tool!("list_items", gamedata_tools::list_items),
        tool!("get_item_info", gamedata_tools::get_item_info),
        tool!("search", gamedata_tools::search),
        tool!("list_story_events", story_tools::list_story_events),
        tool!("list_stories", story_tools::list_stories),
        tool!("get_story_summary", story_tools::get_story_summary),
        tool!("read_story", story_tools::read_story),
        tool!("read_activity", story_tools::read_activity),
        tool!("search_stories", story_tools::search_stories),
        tool!("get_operator_memoirs", story_tools::get_operator_memoirs),
        tool!(
            "find_character_appearances",
            story_tools::find_character_appearances
        ),
        tool!("find_speakers_in", story_tools::find_speakers_in),
    ]
}
