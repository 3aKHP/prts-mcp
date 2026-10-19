//! Story character tracking — port of TS `data/storyCharacter.ts`.
//!
//! Reuses the shared search index (no separate IO or cache): speaks = dialog
//! role exact match (case-insensitive), mentioned = name substring in any
//! line text.

use std::path::Path;

use serde_json::{json, Value};

use super::reader::py_repr;
use super::search::story_search_index;
use crate::storage::ZipStore;

fn classify_chapter(chapter: &super::search::StorySearchChapter, name_lower: &str) -> (bool, bool) {
    let mut speaks = false;
    let mut mentioned = false;
    for line in chapter.lines.iter() {
        if line.line_type == "dialog" && line.role.unwrap_or("").to_lowercase() == name_lower {
            speaks = true;
        }
        if line.text.to_lowercase().contains(name_lower) {
            mentioned = true;
        }
        if speaks && mentioned {
            break;
        }
    }
    (speaks, mentioned)
}

/// `buildCharacterAppearancesFromStore`: Err is the thrown message.
pub fn build_character_appearances(
    zip_path: &Path,
    name: &str,
    scope: Option<&str>,
    max_events: i64,
) -> Result<Value, String> {
    let store = ZipStore::new(zip_path);
    build_character_appearances_from_store(&store, name, scope, max_events)
}

pub(crate) fn build_character_appearances_from_store(
    store: &ZipStore,
    name: &str,
    scope: Option<&str>,
    max_events: i64,
) -> Result<Value, String> {
    let zip_path = store.zip_path();
    if name.is_empty() {
        return Err("name 不能为空。".to_string());
    }
    if max_events < 1 {
        return Err("max_events 必须 >= 1。".to_string());
    }
    if max_events > 200 {
        return Err("max_events 必须 <= 200。".to_string());
    }
    if let Some(db) = store.database_handle()? {
        if db.derived_ready() {
            return super::sqlite_search::appearances(&db, name, scope, max_events);
        }
    }
    let index = story_search_index(zip_path, store)?;
    if let Some(scope) = scope {
        if !index.event_ids.contains(scope) {
            return Err(format!(
                "未找到匹配的活动：{}。",
                serde_json::to_string(scope).unwrap_or_default()
            ));
        }
    }

    let name_lower = name.to_lowercase();
    let mut appearances: Vec<Value> = Vec::new();
    for chapter in index.chapters.iter() {
        if let Some(scope) = scope {
            if chapter.event_id != scope {
                continue;
            }
        }
        let (speaks, mentioned) = classify_chapter(chapter, &name_lower);
        if !speaks && !mentioned {
            continue;
        }
        appearances.push(json!({
            "event_id": chapter.event_id,
            "story_code": chapter.story_code,
            "story_name": chapter.story_name,
            "story_key": chapter.story_key,
            "speaks": speaks,
            "mentioned": mentioned,
        }));
        if appearances.len() as i64 >= max_events {
            break;
        }
    }

    let total = appearances.len();
    Ok(json!({
        "name": name,
        "total": total,
        "filters": {
            "scope": scope.map(|s| Value::String(s.to_string())).unwrap_or(Value::Null),
        },
        "appearances": appearances,
    }))
}

pub fn render_character_appearances(data: &Value) -> String {
    let appearances = data["appearances"].as_array().cloned().unwrap_or_default();
    if appearances.is_empty() {
        let scope = data.pointer("/filters/scope").and_then(Value::as_str);
        let scope_note = scope
            .map(|s| format!("（限定活动：{}）", py_repr(Some(s))))
            .unwrap_or_default();
        return format!(
            "未找到「{}」的出场记录。{scope_note}",
            data["name"].as_str().unwrap_or("")
        );
    }
    let mut parts = vec![format!(
        "# 「{}」的出场（共 {} 章）",
        data["name"].as_str().unwrap_or(""),
        data["total"].as_i64().unwrap_or(0)
    )];
    for ap in &appearances {
        let mut tags: Vec<&str> = Vec::new();
        if ap["speaks"].as_bool().unwrap_or(false) {
            tags.push("speaks");
        }
        if ap["mentioned"].as_bool().unwrap_or(false) {
            tags.push("mentioned");
        }
        let name_disp = format!(
            "{} {}",
            ap["story_code"].as_str().unwrap_or(""),
            ap["story_name"].as_str().unwrap_or("")
        )
        .trim()
        .to_string();
        parts.push(format!(
            "- [{}] {} / {}（key: {}）",
            tags.join("+"),
            ap["event_id"].as_str().unwrap_or(""),
            name_disp,
            ap["story_key"].as_str().unwrap_or("")
        ));
    }
    parts.join("\n")
}

/// `buildSpeakersInEventFromStore`: Err is the thrown message.
pub fn build_speakers_in_event(zip_path: &Path, event_id: &str) -> Result<Value, String> {
    let store = ZipStore::new(zip_path);
    build_speakers_in_event_from_store(&store, event_id)
}

pub(crate) fn build_speakers_in_event_from_store(
    store: &ZipStore,
    event_id: &str,
) -> Result<Value, String> {
    let zip_path = store.zip_path();
    if let Some(db) = store.database_handle()? {
        if db.derived_ready() {
            return super::sqlite_search::speakers(&db, event_id);
        }
    }
    let index = story_search_index(zip_path, store)?;
    if !index.event_ids.contains(event_id) {
        return Err(format!(
            "未找到匹配的活动：{}。",
            serde_json::to_string(event_id).unwrap_or_default()
        ));
    }

    // Map preserves first-insertion order (JS Map semantics).
    let mut counts: Vec<(String, i64)> = Vec::new();
    let mut pos: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for chapter in index.chapters.iter() {
        if chapter.event_id != event_id {
            continue;
        }
        for line in chapter.lines.iter() {
            if line.line_type == "dialog" {
                if let Some(role) = line.role {
                    match pos.get(role) {
                        Some(&i) => counts[i].1 += 1,
                        None => {
                            pos.insert(role.to_string(), counts.len());
                            counts.push((role.to_string(), 1));
                        }
                    }
                }
            }
        }
    }
    // line count desc, then codepoint name order (JS relational <).
    counts.sort_by(|a, b| {
        b.1.cmp(&a.1)
            .then_with(|| crate::text::js_compat::compare_ids(&a.0, &b.0))
    });
    let total = counts.len();
    Ok(json!({
        "event_id": event_id,
        "total": total,
        "speakers": counts
            .into_iter()
            .map(|(name, line_count)| json!({ "name": name, "line_count": line_count }))
            .collect::<Vec<_>>(),
    }))
}

pub fn render_speakers_in_event(data: &Value) -> String {
    let speakers = data["speakers"].as_array().cloned().unwrap_or_default();
    if speakers.is_empty() {
        return format!(
            "活动 {} 暂无对话发言者数据。",
            py_repr(data["event_id"].as_str())
        );
    }
    let mut parts = vec![format!(
        "# {} 的发言角色（共 {} 位）",
        data["event_id"].as_str().unwrap_or(""),
        data["total"].as_i64().unwrap_or(0)
    )];
    for sp in &speakers {
        parts.push(format!(
            "- {}（{} 句）",
            sp["name"].as_str().unwrap_or(""),
            sp["line_count"].as_i64().unwrap_or(0)
        ));
    }
    parts.join("\n")
}
