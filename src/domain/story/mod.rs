//! Story domain — reader, shared search index, character tracking, memoirs,
//! summaries (port of the TS story* module family).

pub mod character;
pub mod memoir;
mod packed_lines;
pub mod reader;
pub mod search;
mod sqlite_blocks;
mod sqlite_search;
pub mod summary;

use std::path::Path;

use crate::app::DataView;

/// `requireStoryZip`: Err is the oracle's exact missing-data message (the
/// static configured path, not the effective one).
pub fn require_story_zip(
    view: &DataView,
    storyjson_path: &Path,
) -> Result<std::path::PathBuf, String> {
    match &view.story_zip {
        Some(zip) => Ok(zip.clone()),
        None => Err(format!(
            "剧情数据暂不可用。容器启动时的 auto-sync 可能仍在进行中，请稍后重试；\
若持续出现此提示，请检查网络连接，或提供 STORYJSON_PATH 指向本地 zh_CN.zip。（当前同步目标路径：{}）",
            storyjson_path.display()
        )),
    }
}
