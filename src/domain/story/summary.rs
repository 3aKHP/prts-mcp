//! Story chapter summary — port of TS `data/storySummary.ts`.
//!
//! Three-tier fallback: LLM summaries (summaries.json overriding
//! storyinfo.json) → chapter storyInfo field → message.

use std::path::Path;

use super::reader::{chapter_summary, load_chapter_summaries};
use crate::storage::ZipStore;

pub fn get_story_summary(zip_path: &Path, story_key: &str) -> String {
    let store = ZipStore::new(zip_path);
    get_story_summary_from_store(&store, story_key)
}

pub(crate) fn get_story_summary_from_store(store: &ZipStore, story_key: &str) -> String {
    let summaries = load_chapter_summaries(store);
    let text = chapter_summary(store, story_key, &summaries);
    if text.is_empty() {
        format!("未找到剧情章节 '{story_key}' 的梗概。")
    } else {
        text
    }
}
