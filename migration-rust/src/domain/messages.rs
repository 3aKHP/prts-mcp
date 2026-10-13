//! Shared user-facing message builders — port of TS `data/messages.ts`.
//!
//! Canonical families so every domain renders missing-data and validation
//! messages identically. The path each message prints is the STATIC sync
//! target from the startup config (TS prints `cfg.excelPath`/`cfg.levelsPath`
//! — not the effective generation directory).

use std::path::Path;

pub fn excel_missing_message(label: &str, excel_path: &Path) -> String {
    format!(
        "{label}数据暂不可用。容器启动时的 auto-sync 可能仍在进行中，请稍后重试；\
若持续出现此提示，请检查网络连接或提供 GITHUB_TOKEN 以降低限速风险。（当前同步目标路径：{}）",
        excel_path.display()
    )
}

pub fn levels_missing_message(label: &str, levels_path: &Path) -> String {
    format!(
        "{label}数据暂不可用。请等待服务器自动从 GitHub Release 同步 zh_CN-levels.zip 完成后重试。\
（当前同步目标路径：{}）",
        levels_path.display()
    )
}

/// `validateBounds`: null when in range, else the exact Chinese wording.
pub fn validate_bounds(
    name: &str,
    value: i64,
    minimum: Option<i64>,
    maximum: Option<i64>,
) -> Option<String> {
    if let Some(min) = minimum {
        if value < min {
            return Some(format!("{name} 必须 >= {min}。"));
        }
    }
    if let Some(max) = maximum {
        if value > max {
            return Some(format!("{name} 必须 <= {max}。"));
        }
    }
    None
}

/// `regexErrorMessage`: prefix + the JS engine's own message (our QuickJS
/// compile error text already mirrors what the oracle's engines print).
pub fn regex_error_message(detail: &str) -> String {
    format!("正则表达式无效：{detail}")
}
