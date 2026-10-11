//! Tool parameter boundaries, thin dispatch and unified result wrapping.

pub mod list_stages;
pub mod output;

use serde_json::Value;

pub use output::OutputChannel;

/// A registered tool: name + description + input schema published verbatim
/// from the oracle's tools/list capture (contracts/cases/golden), plus the
/// dispatch entry point.
#[derive(Clone)]
pub struct ToolEntry {
    pub name: &'static str,
    pub declaration: Value,
    pub dispatch: fn(&AppHandle, &Value) -> DispatchResult,
}

pub enum DispatchResult {
    /// Tool-level outcome (may itself carry an error text with isError).
    Outcome(crate::tools::output::ToolOutcome),
    /// JSON-RPC level failure (unknown tool, malformed arguments envelope).
    RpcError(i64, String),
}

/// Read-only handle the tool layer needs: dynamic data state + the
/// missing-data wording (built from the static sync-target path, exactly the
/// TS `cfg.excelPath` the oracle prints).
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
}

pub fn registry() -> Vec<ToolEntry> {
    vec![ToolEntry {
        name: "list_stages",
        declaration: serde_json::from_str(include_str!("schemas/list_stages.tool.json"))
            .expect("embedded list_stages declaration parses"),
        dispatch: list_stages::dispatch,
    }]
}
