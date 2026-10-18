//! Core story reader — port of TS `data/storyReader.ts`.
//!
//! Zip path constants, rich-text cleaning, the supplement-merged event table,
//! chapter/line parsing, listings and reading. The shared search index and
//! caches live in `search.rs`/`memoir.rs`.

use serde_json::{json, Map, Value};
use std::borrow::Cow;
use std::sync::Arc;

use crate::storage::{JsonStore, ZipStore};

pub const STORY_REVIEW_TABLE: &str = "zh_CN/gamedata/excel/story_review_table.json";
pub const STORY_SUPPLEMENT: &str = "zh_CN/story_supplement.json";
pub const STORYINFO: &str = "zh_CN/storyinfo.json";
pub const SUMMARIES: &str = "zh_CN/summaries.json";
pub const EVENT_SUMMARIES: &str = "zh_CN/event_summaries.json";
pub const CHARDICT: &str = "zh_CN/chardict.json";

pub fn story_zip_path(story_key: &str) -> String {
    format!("zh_CN/gamedata/story/{story_key}.json")
}

/// entryType → category filter mapping.
pub fn category_types(category: &str) -> Option<&'static [&'static str]> {
    match category {
        "main" => Some(&["MAINLINE"]),
        "activities" => Some(&["ACTIVITY", "MINI_ACTIVITY"]),
        "memoirs" => Some(&["NONE"]),
        "roguelike" => Some(&["ROGUELIKE"]),
        _ => None,
    }
}

/// `{@nickname}` → 博士, strip rich tags, trim.
pub fn clean_text(text: &str) -> String {
    let replaced = if text.contains("{@nickname}") {
        Cow::Owned(text.replace("{@nickname}", "博士"))
    } else {
        Cow::Borrowed(text)
    };
    if !replaced.contains('<') {
        return replaced.trim().to_string();
    }
    crate::text::sanitizer::strip_html_tags(&replaced)
        .trim()
        .to_string()
}

/// `^story_([a-z0-9_]+)_set_\d+$` — plain regex over ASCII classes.
pub fn is_memoir_event(event_id: &str) -> bool {
    let Some(rest) = event_id.strip_prefix("story_") else {
        return false;
    };
    let Some(idx) = rest.rfind("_set_") else {
        return false;
    };
    let (code, tail) = rest.split_at(idx);
    let digits = &tail["_set_".len()..];
    !code.is_empty()
        && code
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
        && !digits.is_empty()
        && digits.chars().all(|c| c.is_ascii_digit())
}

/// Python `repr()` for one string — the oracle's pyRepr: ' quotes unless the
/// value contains ' and not "; \\, \n, \r, \t, quote escapes; control chars
/// (< 0x20, 0x7F) as \xNN; everything else verbatim.
pub fn py_repr(value: Option<&str>) -> String {
    let Some(value) = value else {
        return "None".to_string();
    };
    let quote = if value.contains('\'') && !value.contains('"') {
        '"'
    } else {
        '\''
    };
    let mut out = String::from(quote);
    for ch in value.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c == quote => {
                out.push('\\');
                out.push(quote);
            }
            c if (c as u32) < 32 || c as u32 == 127 => {
                out.push_str(&format!("\\x{:02x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push(quote);
    out
}

// ---------------------------------------------------------------------------
// Event table (review + supplement overlay)
// ---------------------------------------------------------------------------

/// story_review_table merged with the optional additive supplement overlay:
/// on eventId collision the review entry wins; a missing/invalid supplement
/// degrades to the plain review table.
pub fn load_event_table(store: &ZipStore) -> Result<Arc<Map<String, Value>>, String> {
    if !store.uses_database() {
        return load_event_table_uncached(store, false).map(Arc::new);
    }
    store
        .cached_object("story:events", || {
            load_event_table_uncached(store, true).map(compact_event_table)
        })
        .or_else(|_| load_event_table_uncached(store, false).map(Arc::new))
}

/// Retain every event/chapter and consumed field, including malformed shapes;
/// the complete source is still archived in SQLite. Avoid caching unlock/UI data.
fn compact_event_table(mut table: Map<String, Value>) -> Map<String, Value> {
    for entry in table.values_mut() {
        if let Some(event) = entry.as_object_mut() {
            event.retain(|key, _| matches!(key.as_str(), "entryType" | "name" | "infoUnlockDatas"));
            if let Some(chapters) = event
                .get_mut("infoUnlockDatas")
                .and_then(Value::as_array_mut)
            {
                for chapter in chapters {
                    if let Some(chapter) = chapter.as_object_mut() {
                        chapter.retain(|key, _| {
                            matches!(
                                key.as_str(),
                                "storyCode" | "storyName" | "storyTxt" | "avgTag" | "storySort"
                            )
                        });
                    }
                }
            }
        }
    }
    table
}

fn load_event_table_uncached(store: &ZipStore, strict: bool) -> Result<Map<String, Value>, String> {
    // Caller caches by descriptor; this is the raw build.
    let table = store
        .read_json(STORY_REVIEW_TABLE)
        .map_err(|e| e.to_string())?;
    let Some(mut merged) = table.as_object().cloned() else {
        return Ok(Map::new());
    };
    if !store.exists(STORY_SUPPLEMENT).unwrap_or(false) {
        return Ok(merged);
    }
    let raw = match store.read_json(STORY_SUPPLEMENT) {
        Ok(raw) => raw,
        Err(error) if strict => return Err(error.to_string()),
        Err(_) => return Ok(merged),
    };
    let Some(events) = raw.get("events").and_then(Value::as_array) else {
        return Ok(merged);
    };
    for event in events {
        let Some(ev) = event.as_object() else {
            continue;
        };
        let event_id = ev.get("event_id").and_then(Value::as_str).unwrap_or("");
        if event_id.is_empty() || merged.contains_key(event_id) {
            continue;
        }
        let mut chapters: Vec<Value> = Vec::new();
        for ch in ev
            .get("chapters")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[])
        {
            let Some(c) = ch.as_object() else {
                continue;
            };
            let Some(key) = c
                .get("key")
                .and_then(Value::as_str)
                .filter(|k| !k.is_empty())
            else {
                continue;
            };
            chapters.push(json!({
                "storyTxt": key,
                "storyCode": c.get("code").and_then(Value::as_str).unwrap_or(""),
                "storyName": c.get("name").and_then(Value::as_str).unwrap_or(""),
                "avgTag": c.get("avg_tag").and_then(Value::as_str),
                "storySort": c.get("sort").and_then(Value::as_f64).unwrap_or(0.0),
            }));
        }
        merged.insert(
            event_id.to_string(),
            json!({
                "entryType": ev.get("entry_type").and_then(Value::as_str).unwrap_or("ROGUELIKE"),
                "name": ev.get("name").and_then(Value::as_str).unwrap_or(event_id),
                "infoUnlockDatas": chapters,
            }),
        );
    }
    Ok(merged)
}

// ---------------------------------------------------------------------------
// Line parsing
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct StoryLine {
    pub line_type: &'static str, // "dialog" | "narration" | "choice"
    pub role: Option<String>,
    pub text: String,
}

fn js_string(value: Option<&Value>) -> Cow<'_, str> {
    match value {
        None | Some(Value::Null) => Cow::Borrowed(""),
        Some(Value::String(s)) => Cow::Borrowed(s),
        Some(other) => Cow::Owned(crate::text::numbers::json_value_to_string(other)),
    }
}

pub fn parse_story_list(story_list: &Value, include_narration: bool) -> Vec<StoryLine> {
    let mut lines = Vec::new();
    for item in story_list.as_array().map(Vec::as_slice).unwrap_or(&[]) {
        let prop = item
            .get("prop")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_lowercase();
        let attrs = item.get("attributes").unwrap_or(&Value::Null);

        match prop.as_str() {
            "name" => {
                let name = js_string(attrs.get("name"));
                let content = js_string(attrs.get("content"));
                if !content.is_empty() && (include_narration || !name.is_empty()) {
                    lines.push(StoryLine {
                        line_type: "dialog",
                        role: (!name.is_empty()).then(|| clean_text(&name)),
                        text: clean_text(&content),
                    });
                }
            }
            "sticker" | "subtitle" | "animtext" => {
                if include_narration {
                    // Sticker uses "text" OR "content" — content wins.
                    let content = attrs
                        .get("content")
                        .or_else(|| attrs.get("text"))
                        .map(|v| js_string(Some(v)));
                    if let Some(content) = content {
                        if !content.is_empty() {
                            lines.push(StoryLine {
                                line_type: "narration",
                                role: None,
                                text: clean_text(&content),
                            });
                        }
                    }
                }
            }
            "decision" => {
                let options = match attrs.get("options") {
                    Some(value @ Value::String(_)) => std::slice::from_ref(value),
                    Some(Value::Array(a)) => a.as_slice(),
                    _ => &[],
                };
                for opt in options {
                    let text = match &opt {
                        Value::String(s) => Cow::Borrowed(s.as_str()),
                        other => js_string(other.get("text")),
                    };
                    if !text.is_empty() {
                        lines.push(StoryLine {
                            line_type: "choice",
                            role: None,
                            text: clean_text(&text),
                        });
                    }
                }
            }
            _ => {}
        }
    }
    lines
}

// ---------------------------------------------------------------------------
// Listings
// ---------------------------------------------------------------------------

/// `listStoryEventsFromStore`.
pub fn list_story_events(
    table: &Map<String, Value>,
    category: Option<&str>,
) -> Vec<(String, String, String, usize)> {
    let allowed = category.and_then(category_types);
    let mut events = Vec::new();
    for (event_id, entry) in table.iter() {
        let entry_type = entry
            .get("entryType")
            .and_then(Value::as_str)
            .unwrap_or("NONE");
        if let Some(allowed) = allowed {
            if allowed.len() == 1 && allowed[0] == "NONE" {
                // "memoirs": NONE entries whose id matches the memoir pattern.
                if !is_memoir_event(event_id) {
                    continue;
                }
            } else if !allowed.contains(&entry_type) {
                continue;
            }
        }
        let story_count = entry
            .get("infoUnlockDatas")
            .and_then(Value::as_array)
            .map(|a| a.len())
            .unwrap_or(0);
        events.push((
            event_id.clone(),
            entry
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(event_id)
                .to_string(),
            entry_type.to_string(),
            story_count,
        ));
    }
    events
}

/// `buildStoryEventsListingFromStore`: Err carries the exact message text.
pub fn build_story_events_listing(
    store: &ZipStore,
    category: Option<&str>,
) -> Result<Value, String> {
    let table = load_event_table(store)?;
    let events = list_story_events(&table, category);
    let category_normalized = category
        .filter(|c| category_types(c).is_some())
        .map(str::to_string);
    let total = events.len();
    let events: Vec<Value> = events
        .into_iter()
        .map(|(event_id, name, entry_type, story_count)| {
            json!({
                "event_id": event_id,
                "name": name,
                "entry_type": entry_type,
                "story_count": story_count,
            })
        })
        .collect();
    Ok(json!({
        "total": total,
        "filters": {
            "category": category.map(|c| Value::String(c.to_string())).unwrap_or(Value::Null),
            "category_normalized": category_normalized.map(Value::String).unwrap_or(Value::Null),
        },
        "events": events,
    }))
}

pub fn render_story_events_listing(data: &Value) -> String {
    let events = data["events"].as_array().cloned().unwrap_or_default();
    if events.is_empty() {
        let category = data.pointer("/filters/category").and_then(Value::as_str);
        return format!("未找到符合条件的活动（category={}）。", py_repr(category));
    }
    events
        .iter()
        .map(|ev| {
            format!(
                "- [{}] {}：{}（{} 章）",
                ev["entry_type"].as_str().unwrap_or(""),
                ev["event_id"].as_str().unwrap_or(""),
                ev["name"].as_str().unwrap_or(""),
                ev["story_count"].as_i64().unwrap_or(0)
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// One chapter summary row from an infoUnlockDatas entry.
#[derive(Debug, Clone)]
pub struct ChapterSummary {
    pub story_key: String,
    pub story_code: String,
    pub story_name: String,
    pub avg_tag: Option<String>,
    pub sort_order: f64,
}

fn get_str_field(d: &Value, key: &str) -> String {
    d.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

/// `listStoriesFromStore`; Err is the thrown `Event not found` message.
pub fn list_stories(
    table: &Map<String, Value>,
    event_id: &str,
) -> Result<Vec<ChapterSummary>, String> {
    let Some(entry) = table.get(event_id) else {
        return Err(format!("Event not found: \"{event_id}\""));
    };
    let mut datas: Vec<&Value> = entry
        .get("infoUnlockDatas")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .collect();
    datas.sort_by(|a, b| {
        let sa = a.get("storySort").and_then(Value::as_f64).unwrap_or(0.0);
        let sb = b.get("storySort").and_then(Value::as_f64).unwrap_or(0.0);
        sa.partial_cmp(&sb).unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut chapters = Vec::new();
    for d in datas {
        let story_txt = get_str_field(d, "storyTxt");
        if story_txt.is_empty() {
            continue;
        }
        chapters.push(ChapterSummary {
            story_key: story_txt,
            story_code: get_str_field(d, "storyCode"),
            story_name: get_str_field(d, "storyName"),
            avg_tag: d.get("avgTag").and_then(Value::as_str).map(str::to_string),
            sort_order: d.get("storySort").and_then(Value::as_f64).unwrap_or(0.0),
        });
    }
    Ok(chapters)
}

/// `loadChapterSummariesFromStore`: storyinfo first, summaries overrides.
pub fn load_chapter_summaries(store: &ZipStore) -> Arc<Map<String, Value>> {
    if !store.uses_database() {
        return Arc::new(load_chapter_summaries_uncached(store, false).unwrap_or_default());
    }
    store
        .cached_object("story:summaries", || {
            load_chapter_summaries_uncached(store, true)
        })
        .unwrap_or_else(|_| {
            Arc::new(load_chapter_summaries_uncached(store, false).unwrap_or_default())
        })
}

fn load_chapter_summaries_uncached(
    store: &ZipStore,
    strict: bool,
) -> Result<Map<String, Value>, String> {
    let mut summaries = Map::new();
    for path in [STORYINFO, SUMMARIES] {
        if !store.exists(path).unwrap_or(false) {
            continue;
        }
        let raw = match store.read_json(path) {
            Ok(raw) => raw,
            Err(error) if strict => return Err(error.to_string()),
            Err(_) => continue,
        };
        let Some(obj) = raw.as_object() else {
            continue;
        };
        for (key, value) in obj {
            if let Some(text) = value.as_str() {
                if !text.trim().is_empty() {
                    summaries.insert(key.clone(), Value::String(text.trim().to_string()));
                }
            }
        }
    }
    Ok(summaries)
}

/// `chapterSummaryFromStore`: summaries → chapter storyInfo → "".
pub fn chapter_summary(
    store: &ZipStore,
    story_key: &str,
    summaries: &Map<String, Value>,
) -> String {
    if let Some(text) = summaries.get(story_key).and_then(Value::as_str) {
        return text.to_string();
    }
    let path = story_zip_path(story_key);
    if store.exists(&path).unwrap_or(false) {
        if let Ok(raw) = store.read_json(&path) {
            if let Some(info) = raw.get("storyInfo").and_then(Value::as_str) {
                return info.trim().to_string();
            }
        }
    }
    String::new()
}

/// `buildStoriesListingFromStore`.
pub fn build_stories_listing(
    store: &ZipStore,
    event_id: &str,
    include_summaries: bool,
) -> Result<Value, String> {
    let table = load_event_table(store)?;
    let chapters = list_stories(&table, event_id)?;
    let mut chapter_summaries = Arc::new(Map::new());
    let mut event_summary = String::new();
    if include_summaries {
        chapter_summaries = load_chapter_summaries(store);
        if store.exists(EVENT_SUMMARIES).unwrap_or(false) {
            if let Ok(raw) = store.cached_object("story:event-summaries", || {
                let value = store
                    .read_json(EVENT_SUMMARIES)
                    .map_err(|e| e.to_string())?;
                Ok(value.as_object().cloned().unwrap_or_default())
            }) {
                if let Some(text) = raw.get(event_id).and_then(Value::as_str) {
                    event_summary = text.trim().to_string();
                }
            }
        }
    }
    let chapter_values: Vec<Value> = chapters
        .iter()
        .map(|ch| {
            let mut obj = Map::new();
            obj.insert("story_code".into(), json!(ch.story_code));
            obj.insert("story_name".into(), json!(ch.story_name));
            obj.insert("story_key".into(), json!(ch.story_key));
            obj.insert(
                "avg_tag".into(),
                ch.avg_tag.clone().map(Value::String).unwrap_or(Value::Null),
            );
            if include_summaries {
                obj.insert(
                    "summary".into(),
                    json!(chapter_summary(store, &ch.story_key, &chapter_summaries)),
                );
            }
            Value::Object(obj)
        })
        .collect();
    let mut payload = Map::new();
    payload.insert("event_id".into(), json!(event_id));
    payload.insert("total".into(), json!(chapters.len()));
    payload.insert("include_summaries".into(), json!(include_summaries));
    payload.insert("chapters".into(), Value::Array(chapter_values));
    if !event_summary.is_empty() {
        payload.insert("event_summary".into(), json!(event_summary));
    }
    Ok(Value::Object(payload))
}

pub fn render_stories_listing(data: &Value) -> String {
    let chapters = data["chapters"].as_array().cloned().unwrap_or_default();
    if chapters.is_empty() {
        return format!("活动 {} 暂无剧情章节。", py_repr(data["event_id"].as_str()));
    }
    let mut lines: Vec<String> = Vec::new();
    if let Some(summary) = data["event_summary"].as_str() {
        lines.push(summary.to_string());
        lines.push(String::new());
    }
    for ch in &chapters {
        let tag = ch["avg_tag"]
            .as_str()
            .filter(|t| !t.is_empty())
            .map(|t| format!("[{t}] "))
            .unwrap_or_default();
        lines.push(format!(
            "- {} {}{}（key: {}）",
            ch["story_code"].as_str().unwrap_or(""),
            tag,
            ch["story_name"].as_str().unwrap_or(""),
            ch["story_key"].as_str().unwrap_or("")
        ));
        if data["include_summaries"].as_bool().unwrap_or(false) {
            if let Some(summary) = ch["summary"].as_str() {
                if !summary.is_empty() {
                    lines.push(format!("  {summary}"));
                }
            }
        }
    }
    lines.join("\n")
}

// ---------------------------------------------------------------------------
// Chapter reading
// ---------------------------------------------------------------------------

pub struct StoryChapter {
    pub story_key: String,
    pub story_code: String,
    pub story_name: String,
    pub avg_tag: Option<String>,
    pub event_name: String,
    pub story_info: String,
    pub lines: Vec<StoryLine>,
}

/// `readStoryFromStore`; Err is the thrown message (callers classify
/// "not found"/corrupt vs other).
pub fn read_story_from_store(
    store: &ZipStore,
    story_key: &str,
    include_narration: bool,
) -> Result<StoryChapter, String> {
    let inner_path = story_zip_path(story_key);
    if !store.exists(&inner_path).unwrap_or(false) {
        return Err(format!("Story not found in store: \"{story_key}\""));
    }
    let raw = store.read_json(&inner_path).map_err(|e| e.to_string())?;
    let lines = parse_story_list(
        raw.get("storyList").unwrap_or(&Value::Null),
        include_narration,
    );
    Ok(StoryChapter {
        story_key: story_key.to_string(),
        story_code: raw
            .get("storyCode")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        story_name: raw
            .get("storyName")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        avg_tag: raw
            .get("avgTag")
            .and_then(Value::as_str)
            .map(str::to_string),
        event_name: raw
            .get("eventName")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        story_info: raw
            .get("storyInfo")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        lines,
    })
}

pub struct ActivityResult {
    pub event_id: String,
    pub event_name: String,
    pub total_chapters: usize,
    pub has_more: bool,
    pub page_out_of_range: bool,
    pub chapters: Vec<StoryChapter>,
}

/// `readActivityFromStore`; Err is the thrown message.
pub fn read_activity_from_store(
    store: &ZipStore,
    event_id: &str,
    include_narration: bool,
    page: Option<i64>,
    page_size: i64,
) -> Result<ActivityResult, String> {
    let table = load_event_table(store)?;
    let summaries = list_stories(&table, event_id)?;
    let total = summaries.len();

    if !(1..=20).contains(&page_size) {
        return Err("page_size 参数必须在 1 到 20 之间".to_string());
    }

    let (selected, has_more, page_out_of_range) = match page {
        Some(page) => {
            if page < 1 {
                return Err("page 参数必须 >= 1".to_string());
            }
            let start = ((page - 1) * page_size).max(0) as usize;
            let end = start + page_size as usize;
            let selected = summaries.get(start..end.min(total)).unwrap_or(&[]).to_vec();
            let has_more = end < total;
            let out = total > 0 && start >= total;
            (selected, has_more, out)
        }
        None => (summaries.clone(), false, false),
    };

    let mut chapters = Vec::new();
    let mut event_name = String::new();
    for summary in &selected {
        match read_story_from_store(store, &summary.story_key, include_narration) {
            Ok(chapter) => {
                if event_name.is_empty() {
                    event_name = chapter.event_name.clone();
                }
                chapters.push(chapter);
            }
            Err(message) => {
                // Corrupt JSON and missing chapters skip; other errors
                // propagate (mirrors SyntaxError / "not found" classes).
                if message.contains("not found") {
                    continue;
                }
                if message.contains("JSON parse failure") {
                    continue;
                }
                return Err(message);
            }
        }
    }
    Ok(ActivityResult {
        event_id: event_id.to_string(),
        event_name,
        total_chapters: total,
        has_more,
        page_out_of_range,
        chapters,
    })
}

/// The tool layer's chapter formatter (【活动名】章节 + lines).
pub fn format_line(line: &StoryLine) -> String {
    format_line_parts(line.line_type, line.role.as_deref(), &line.text)
}

pub(super) fn format_line_parts(line_type: &str, role: Option<&str>, text: &str) -> String {
    match line_type {
        "dialog" => format!("{}：{text}", role.unwrap_or("（旁白）")),
        "narration" => format!("*{text}*"),
        _ => format!("【选项】{text}"),
    }
}

pub fn format_chapter(chapter: &StoryChapter) -> String {
    let mut parts = vec![format!("【{}】{}", chapter.event_name, chapter.story_name)];
    if !chapter.story_info.is_empty() {
        parts.push(format!("简介：{}\n", chapter.story_info));
    }
    for line in &chapter.lines {
        parts.push(format_line(line));
    }
    parts.join("\n")
}

#[cfg(test)]
mod projection_tests {
    use super::*;

    #[test]
    fn compact_metadata_preserves_listings_order_and_malformed_shapes() {
        let table = json!({
            "main": {"entryType":"MAINLINE", "name":"主线", "unused":{"large":[1,2,3]},
                "infoUnlockDatas":[
                    {"storyTxt":"later", "storyCode":"2", "storyName":"后", "storySort":2,
                     "avgTag":"行动后", "unlock":true},
                    null, 42, {"storyTxt":false},
                    {"storyTxt":"first", "storyCode":"1", "storyName":"前", "storySort":-1,
                     "avgTag":null},
                    {"storyTxt":"equal", "storyCode":false, "storyName":{}, "storySort":2}
                ]},
            "story_op_set_1":{"entryType":"NONE", "name":null, "infoUnlockDatas":[]},
            "wrong_chapters":{"entryType":42, "infoUnlockDatas":{"unexpected":true}},
            "scalar":false
        })
        .as_object()
        .unwrap()
        .clone();
        let compact = compact_event_table(table.clone());
        assert_eq!(
            compact.keys().collect::<Vec<_>>(),
            table.keys().collect::<Vec<_>>()
        );
        for category in [
            None,
            Some("main"),
            Some("activities"),
            Some("memoirs"),
            Some("roguelike"),
            Some("unknown"),
        ] {
            assert_eq!(
                list_story_events(&compact, category),
                list_story_events(&table, category)
            );
        }
        let rows = |table: &Map<String, Value>, event| {
            list_stories(table, event).map(|rows| {
                rows.into_iter()
                    .map(|row| {
                        (
                            row.story_key,
                            row.story_code,
                            row.story_name,
                            row.avg_tag,
                            row.sort_order,
                        )
                    })
                    .collect::<Vec<_>>()
            })
        };
        for event in [
            "main",
            "story_op_set_1",
            "wrong_chapters",
            "scalar",
            "missing",
        ] {
            assert_eq!(rows(&compact, event), rows(&table, event));
        }
        assert_eq!(compact["wrong_chapters"], table["wrong_chapters"]);
        assert_eq!(compact["scalar"], table["scalar"]);
    }
}
