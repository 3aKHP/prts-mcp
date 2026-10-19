//! Story tool dispatchers — port of TS `tools/storyTools.ts`.

use std::sync::Arc;

use serde_json::Value;

use super::output::ToolOutcome;
use super::zodish::{validation_error, Args};
use super::{AppHandle, DispatchResult};
use crate::app::DataView;
use crate::domain::story::{self, reader};

fn invalid_args(tool: &str, joined: String) -> DispatchResult {
    DispatchResult::Outcome(ToolOutcome::error_text(validation_error(tool, &joined)))
}

/// Validate and retain one generation throughout the entire story dispatch.
fn story_view(app: &AppHandle) -> Result<Arc<DataView>, String> {
    let view = app.snapshot();
    story::require_story_zip(&view, &app.storyjson_path())?;
    Ok(view)
}

// --- listings ----------------------------------------------------------------

pub fn list_story_events(app: &AppHandle, arguments: &Value) -> DispatchResult {
    let mut args = Args::new(arguments);
    let category = args.string("category");
    if let Err(joined) = args.finish() {
        return invalid_args("list_story_events", joined);
    }
    let view = match story_view(app) {
        Ok(view) => view,
        Err(message) => return DispatchResult::Outcome(ToolOutcome::text(message)),
    };
    let store = view.story_store().expect("checked");
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
    let view = match story_view(app) {
        Ok(view) => view,
        Err(message) => return DispatchResult::Outcome(ToolOutcome::text(message)),
    };
    let store = view.story_store().expect("checked");
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
    let view = match story_view(app) {
        Ok(view) => view,
        Err(message) => return DispatchResult::Outcome(ToolOutcome::text(message)),
    };
    // getStorySummary cannot throw for its own reads (all inner errors
    // degrade to the 未找到梗概 message), so there is no catch branch here.
    DispatchResult::Outcome(ToolOutcome::text(
        story::summary::get_story_summary_from_store(
            &view.story_store().expect("checked"),
            &story_key,
        ),
    ))
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
    let view = match story_view(app) {
        Ok(view) => view,
        Err(message) => return DispatchResult::Outcome(ToolOutcome::text(message)),
    };
    let store = view.story_store().expect("checked");
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
    let view = match story_view(app) {
        Ok(view) => view,
        Err(message) => return DispatchResult::Outcome(ToolOutcome::text(message)),
    };
    let store = view.story_store().expect("checked");
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
    let view = match story_view(app) {
        Ok(view) => view,
        Err(message) => return DispatchResult::Outcome(ToolOutcome::text(message)),
    };
    match story::search::build_story_search_from_store(
        &view.story_store().expect("checked"),
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
    let view = match story_view(app) {
        Ok(view) => view,
        Err(message) => return DispatchResult::Outcome(ToolOutcome::text(message)),
    };
    match story::memoir::build_operator_memoirs_from_store(
        &view.story_store().expect("checked"),
        &name,
    ) {
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
    let view = match story_view(app) {
        Ok(view) => view,
        Err(message) => return DispatchResult::Outcome(ToolOutcome::text(message)),
    };
    match story::character::build_character_appearances_from_store(
        &view.story_store().expect("checked"),
        &name,
        scope.as_deref(),
        max_events,
    ) {
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
    let view = match story_view(app) {
        Ok(view) => view,
        Err(message) => return DispatchResult::Outcome(ToolOutcome::text(message)),
    };
    match story::character::build_speakers_in_event_from_store(
        &view.story_store().expect("checked"),
        &event_id,
    ) {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::RuntimeConfig;
    use crate::storage::{database::lease_path, database::ActiveDatabase, JsonStore};
    use crate::sync::database_io::prune;
    use std::io::Write;

    #[test]
    fn story_view_keeps_its_generation_readable_across_two_updates() {
        let root = std::env::temp_dir().join(format!("prts-story-lease-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let source_path = "zh_CN/gamedata/excel/story_review_table.json";
        let source = serde_json::json!({"retained": true});
        let mut encoder =
            flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        let source_bytes = serde_json::to_vec(&source).unwrap();
        encoder.write_all(&source_bytes).unwrap();
        let body = encoder.finish().unwrap();
        let mut pointers = Vec::new();
        for revision in 1..=3 {
            let mut pointer = ActiveDatabase {
                file_name: format!("{}-{revision:032x}.sqlite", "a".repeat(64)),
                source_version: "fixture".into(),
                revision,
                sha256: "a".repeat(64),
            };
            let connection = rusqlite::Connection::open(pointer.path(&root)).unwrap();
            connection
                .execute_batch(include_str!("../../contracts/sqlite-schema-v1.sql"))
                .unwrap();
            for (key, value) in [
                ("contract", crate::storage::sqlite::CONTRACT),
                ("index_version", "1"),
                ("language", "zh_CN"),
                ("sources_complete", "1"),
                ("derived_complete", "1"),
                ("story_available", "1"),
            ] {
                connection
                    .execute("INSERT INTO meta VALUES(?1,?2)", [key, value])
                    .unwrap();
            }
            connection
                .execute(
                    "INSERT INTO source_blobs VALUES('fixture',?1,?2)",
                    rusqlite::params![source_bytes.len() as i64, body],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO sources VALUES('story',?1,'fixture')",
                    [source_path],
                )
                .unwrap();
            connection
                .execute("INSERT INTO meta VALUES('source_version','fixture')", [])
                .unwrap();
            connection
                .execute(
                    "INSERT INTO meta VALUES('publication_revision',?1)",
                    [revision.to_string()],
                )
                .unwrap();
            drop(connection);
            pointer.sha256 = crate::storage::digest::hash_file(&pointer.path(&root)).unwrap();
            std::fs::File::create(lease_path(&pointer.path(&root))).unwrap();
            pointers.push(pointer);
        }
        std::fs::write(root.join("active"), pointers[0].encode().unwrap()).unwrap();
        let config = RuntimeConfig::from_lookup(|key| match key {
            "PRTS_DATA_BACKEND" => Some("sqlite".into()),
            "PRTS_DATA_DIR" => Some(root.to_string_lossy().into_owned()),
            _ => None,
        });
        let app = AppHandle::from_config(&config);
        let view = story_view(&app).ok().unwrap();
        let old_path = view.story_zip.as_ref().unwrap().clone();
        let store = view.story_store().unwrap();
        assert_eq!(store.read_json(source_path).unwrap(), source);
        for pointer in &pointers[1..] {
            std::fs::write(root.join("active"), pointer.encode().unwrap()).unwrap();
            drop(app.snapshot());
        }
        std::fs::write(root.join("previous"), pointers[1].encode().unwrap()).unwrap();
        prune(&root, &pointers[2]);
        assert!(old_path.exists());
        assert_eq!(store.read_json(source_path).unwrap(), source);
        drop(view);
        prune(&root, &pointers[2]);
        assert!(old_path.exists());
        assert_eq!(store.read_json(source_path).unwrap(), source);
        drop(store);
        prune(&root, &pointers[2]);
        assert!(!old_path.exists());
        drop(app);
        std::fs::remove_dir_all(root).unwrap();
    }
}
