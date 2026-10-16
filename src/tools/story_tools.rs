//! Story tool dispatchers — port of TS `tools/storyTools.ts`.

use std::path::PathBuf;

use serde_json::Value;

use super::output::ToolOutcome;
use super::zodish::{validation_error, Args};
use super::{AppHandle, DispatchResult};
use crate::domain::story::{self, reader};

fn invalid_args(tool: &str, joined: String) -> DispatchResult {
    DispatchResult::Outcome(ToolOutcome::error_text(validation_error(tool, &joined)))
}

/// The missing-story-zip message (text result, no channel wrapping).
fn missing_zip(app: &AppHandle) -> Option<ToolOutcome> {
    let view = app.snapshot();
    match story::require_story_zip(&view, &app.storyjson_path()) {
        Ok(_) => None,
        Err(message) => Some(ToolOutcome::text(message)),
    }
}

fn zip_of(app: &AppHandle) -> PathBuf {
    app.snapshot()
        .story_zip
        .clone()
        .expect("caller checked require")
}

// --- listings ----------------------------------------------------------------

pub fn list_story_events(app: &AppHandle, arguments: &Value) -> DispatchResult {
    let mut args = Args::new(arguments);
    let category = args.string("category");
    if let Err(joined) = args.finish() {
        return invalid_args("list_story_events", joined);
    }
    if let Some(outcome) = missing_zip(app) {
        return DispatchResult::Outcome(outcome);
    }
    let view = app.snapshot();
    let zip = view.story_zip.clone().expect("checked");
    let store = crate::storage::ZipStore::new(&zip);
    match reader::build_story_events_listing(&store, category.as_deref()) {
        Ok(data) => DispatchResult::Outcome(ToolOutcome::structured(
            reader::render_story_events_listing(&data),
            data,
        )),
        Err(message) => {
            DispatchResult::Outcome(ToolOutcome::text(format!("读取剧情数据失败：{message}")))
        }
    }
}

pub fn list_stories(app: &AppHandle, arguments: &Value) -> DispatchResult {
    let mut args = Args::new(arguments);
    let event_id = args.required_string("event_id");
    let include_summaries = args.boolean_default("include_summaries", false);
    if let Err(joined) = args.finish() {
        return invalid_args("list_stories", joined);
    }
    let Some(event_id) = event_id else {
        return invalid_args(
            "list_stories",
            "event_id: Invalid input: expected string, received undefined".to_string(),
        );
    };
    if let Some(outcome) = missing_zip(app) {
        return DispatchResult::Outcome(outcome);
    }
    let zip = zip_of(app);
    let store = crate::storage::ZipStore::new(&zip);
    match reader::build_stories_listing(&store, &event_id, include_summaries) {
        Ok(data) => DispatchResult::Outcome(ToolOutcome::structured(
            reader::render_stories_listing(&data),
            data,
        )),
        Err(message) => {
            if message.contains("not found") {
                return DispatchResult::Outcome(ToolOutcome::text(format!(
                    "未找到活动：\"{event_id}\"。请先调用 list_story_events 确认活动 ID。"
                )));
            }
            DispatchResult::Outcome(ToolOutcome::text(format!("读取章节列表失败：{message}")))
        }
    }
}

pub fn get_story_summary(app: &AppHandle, arguments: &Value) -> DispatchResult {
    let mut args = Args::new(arguments);
    let story_key = args.required_string("story_key");
    if let Err(joined) = args.finish() {
        return invalid_args("get_story_summary", joined);
    }
    let Some(story_key) = story_key else {
        return invalid_args(
            "get_story_summary",
            "story_key: Invalid input: expected string, received undefined".to_string(),
        );
    };
    if let Some(outcome) = missing_zip(app) {
        return DispatchResult::Outcome(outcome);
    }
    let zip = zip_of(app);
    // getStorySummary cannot throw for its own reads (all inner errors
    // degrade to the 未找到梗概 message), so there is no catch branch here.
    DispatchResult::Outcome(ToolOutcome::text(story::summary::get_story_summary(
        &zip, &story_key,
    )))
}

pub fn read_story(app: &AppHandle, arguments: &Value) -> DispatchResult {
    let mut args = Args::new(arguments);
    let story_key = args.required_string("story_key");
    let include_narration = args.boolean_default("include_narration", true);
    if let Err(joined) = args.finish() {
        return invalid_args("read_story", joined);
    }
    let Some(story_key) = story_key else {
        return invalid_args(
            "read_story",
            "story_key: Invalid input: expected string, received undefined".to_string(),
        );
    };
    if let Some(outcome) = missing_zip(app) {
        return DispatchResult::Outcome(outcome);
    }
    let zip = zip_of(app);
    let store = crate::storage::ZipStore::new(&zip);
    match reader::read_story_from_store(&store, &story_key, include_narration) {
        Ok(chapter) => DispatchResult::Outcome(ToolOutcome::text(reader::format_chapter(&chapter))),
        Err(message) => {
            if message.contains("not found") || message.contains("Entry not found") {
                return DispatchResult::Outcome(ToolOutcome::text(format!(
                    "未找到剧情：\"{story_key}\"。请通过 list_stories 确认章节 key。"
                )));
            }
            DispatchResult::Outcome(ToolOutcome::text(format!("读取剧情失败：{message}")))
        }
    }
}

pub fn read_activity(app: &AppHandle, arguments: &Value) -> DispatchResult {
    let mut args = Args::new(arguments);
    let event_id = args.required_string("event_id");
    let include_narration = args.boolean_default("include_narration", true);
    let page = args.nullish_int("page", 1, None);
    let page_size = args.int_default("page_size", 1, Some(20), 5);
    if let Err(joined) = args.finish() {
        return invalid_args("read_activity", joined);
    }
    let Some(event_id) = event_id else {
        return invalid_args(
            "read_activity",
            "event_id: Invalid input: expected string, received undefined".to_string(),
        );
    };
    if let Some(outcome) = missing_zip(app) {
        return DispatchResult::Outcome(outcome);
    }
    let zip = zip_of(app);
    let store = crate::storage::ZipStore::new(&zip);
    match reader::read_activity_from_store(&store, &event_id, include_narration, page, page_size) {
        Ok(result) => {
            if result.page_out_of_range {
                let total_pages = (result.total_chapters as f64 / page_size as f64).ceil() as i64;
                return DispatchResult::Outcome(ToolOutcome::text(format!(
                    "页码超出范围：{event_id} 共 {} 章，按 page_size={page_size} 分页共 {total_pages} 页，请求的 page={} 不存在。",
                    result.total_chapters,
                    page.unwrap_or(1),
                )));
            }
            let mut parts: Vec<String> = Vec::new();
            if !result.event_name.is_empty() {
                parts.push(format!(
                    "# {}（共 {} 章{}）",
                    result.event_name,
                    result.total_chapters,
                    if result.has_more {
                        "，当前为部分内容"
                    } else {
                        ""
                    }
                ));
            }
            for chapter in &result.chapters {
                let tag = chapter
                    .avg_tag
                    .as_deref()
                    .filter(|t| !t.is_empty())
                    .map(|t| format!(" [{t}]"))
                    .unwrap_or_default();
                parts.push(format!(
                    "\n=== {}{} {} ===",
                    chapter.story_code, tag, chapter.story_name
                ));
                if !chapter.story_info.is_empty() {
                    parts.push(format!("简介：{}", chapter.story_info));
                }
                for line in &chapter.lines {
                    parts.push(reader::format_line(line));
                }
            }
            if result.chapters.is_empty() {
                parts.push("该活动暂无可读取的章节数据。".to_string());
            }
            if result.has_more {
                let next_page = page.unwrap_or(1) + 1;
                parts.push(format!(
                    "\n[还有更多章节，请调用 read_activity(event_id=\"{event_id}\", page={next_page})]"
                ));
            }
            DispatchResult::Outcome(ToolOutcome::text(parts.join("\n")))
        }
        Err(message) => {
            if message.contains("not found") {
                return DispatchResult::Outcome(ToolOutcome::text(format!(
                    "未找到活动：\"{event_id}\"。请先调用 list_story_events 确认活动 ID。"
                )));
            }
            DispatchResult::Outcome(ToolOutcome::text(format!("读取活动剧情失败：{message}")))
        }
    }
}

// --- search ------------------------------------------------------------------

pub fn search_stories(app: &AppHandle, arguments: &Value) -> DispatchResult {
    let mut args = Args::new(arguments);
    let pattern = args.required_string("pattern");
    let character = args.string("character");
    let line_type = args.string("line_type");
    let context_lines = args.int_default("context_lines", 0, Some(5), 1);
    let max_results = args.int_default("max_results", 1, Some(100), 30);
    let event_id = args.string("event_id");
    if let Err(joined) = args.finish() {
        return invalid_args("search_stories", joined);
    }
    let Some(pattern) = pattern else {
        return invalid_args(
            "search_stories",
            "pattern: Invalid input: expected string, received undefined".to_string(),
        );
    };
    if let Some(outcome) = missing_zip(app) {
        return DispatchResult::Outcome(outcome);
    }
    let zip = zip_of(app);
    match story::search::build_story_search(
        &zip,
        &pattern,
        character.as_deref(),
        line_type.as_deref(),
        context_lines,
        max_results,
        event_id.as_deref(),
    ) {
        Ok(data) => DispatchResult::Outcome(ToolOutcome::structured(
            story::search::render_story_search(&data),
            data,
        )),
        // buildStorySearchFromStore returns message strings (validation,
        // index errors) — they render bare, like the TS string-return path.
        Err(message) => DispatchResult::Outcome(ToolOutcome::text(message)),
    }
}

// --- memoirs / characters ----------------------------------------------------

pub fn get_operator_memoirs(app: &AppHandle, arguments: &Value) -> DispatchResult {
    let mut args = Args::new(arguments);
    let name = args.required_string("name");
    if let Err(joined) = args.finish() {
        return invalid_args("get_operator_memoirs", joined);
    }
    let Some(name) = name else {
        return invalid_args(
            "get_operator_memoirs",
            "name: Invalid input: expected string, received undefined".to_string(),
        );
    };
    if let Some(outcome) = missing_zip(app) {
        return DispatchResult::Outcome(outcome);
    }
    let zip = zip_of(app);
    match story::memoir::build_operator_memoirs(&zip, &name) {
        Ok(data) => DispatchResult::Outcome(ToolOutcome {
            summary_override: Some(format!(
                "{} 的密录列表（共 {} 章）",
                data["operator_name"].as_str().unwrap_or(""),
                data["total"].as_i64().unwrap_or(0)
            )),
            ..ToolOutcome::structured(story::memoir::render_operator_memoirs(&data), data)
        }),
        Err(message) => {
            if message.contains("未找到干员名称") || message.contains("暂无密录数据") {
                return DispatchResult::Outcome(ToolOutcome::text(message));
            }
            DispatchResult::Outcome(ToolOutcome::text(format!("查询干员密录失败：{message}")))
        }
    }
}

pub fn find_character_appearances(app: &AppHandle, arguments: &Value) -> DispatchResult {
    let mut args = Args::new(arguments);
    let name = args.required_string("name");
    let scope = args.string("scope");
    let max_events = args.int_default("max_events", 1, Some(200), 50);
    if let Err(joined) = args.finish() {
        return invalid_args("find_character_appearances", joined);
    }
    let Some(name) = name else {
        return invalid_args(
            "find_character_appearances",
            "name: Invalid input: expected string, received undefined".to_string(),
        );
    };
    if let Some(outcome) = missing_zip(app) {
        return DispatchResult::Outcome(outcome);
    }
    let zip = zip_of(app);
    match story::character::build_character_appearances(&zip, &name, scope.as_deref(), max_events) {
        Ok(data) => DispatchResult::Outcome(ToolOutcome::structured(
            story::character::render_character_appearances(&data),
            data,
        )),
        Err(message) => {
            let is_user_facing = message.contains("未找到")
                || message.contains("不能为空")
                || message.contains("必须");
            if is_user_facing {
                return DispatchResult::Outcome(ToolOutcome::text(message));
            }
            DispatchResult::Outcome(ToolOutcome::text(format!("查询角色出场失败：{message}")))
        }
    }
}

pub fn find_speakers_in(app: &AppHandle, arguments: &Value) -> DispatchResult {
    let mut args = Args::new(arguments);
    let event_id = args.required_string("event_id");
    if let Err(joined) = args.finish() {
        return invalid_args("find_speakers_in", joined);
    }
    let Some(event_id) = event_id else {
        return invalid_args(
            "find_speakers_in",
            "event_id: Invalid input: expected string, received undefined".to_string(),
        );
    };
    if let Some(outcome) = missing_zip(app) {
        return DispatchResult::Outcome(outcome);
    }
    let zip = zip_of(app);
    match story::character::build_speakers_in_event(&zip, &event_id) {
        Ok(data) => DispatchResult::Outcome(ToolOutcome::structured(
            story::character::render_speakers_in_event(&data),
            data,
        )),
        Err(message) => {
            if message.contains("未找到") {
                return DispatchResult::Outcome(ToolOutcome::text(message));
            }
            DispatchResult::Outcome(ToolOutcome::text(format!("查询发言角色失败：{message}")))
        }
    }
}
