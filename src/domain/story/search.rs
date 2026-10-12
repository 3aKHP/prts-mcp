//! Story full-text search — port of TS `data/storySearch.ts`.
//!
//! The index belongs to the DATASET, not a session: one global cache keyed
//! by the story zip's stat descriptor. A package swap changes the
//! descriptor, so the next call rebuilds ONCE and the old index releases
//! with its last reader (docs/03 索引属于数据集; docs/07 换包重新构建一次并可
//! 释放旧索引). The build holds the cache mutex, giving single-flight for
//! free — concurrent callers share one rebuild.

use std::collections::HashSet;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::{json, Value};

use super::reader::{
    format_line, is_memoir_event, load_event_table, py_repr, read_story_from_store, StoryLine,
};
use crate::storage::ZipStore;

pub struct StorySearchChapter {
    pub event_id: String,
    pub story_key: String,
    pub story_code: String,
    pub story_name: String,
    pub lines: Vec<StoryLine>,
}

pub struct StorySearchIndex {
    pub event_ids: HashSet<String>,
    pub chapters: Vec<StorySearchChapter>,
    /// (chapter_index, line_index) per record, in build order.
    pub records: Vec<(usize, usize)>,
}

struct SharedIndex {
    descriptor: String,
    index: Arc<StorySearchIndex>,
    builds: u64,
}

static INDEX_CACHE: OnceLock<Mutex<Option<SharedIndex>>> = OnceLock::new();

fn cache() -> &'static Mutex<Option<SharedIndex>> {
    INDEX_CACHE.get_or_init(|| Mutex::new(None))
}

/// `zip:{path}:{size}:{mtime_ns}` — the TS ZipStore descriptor.
pub fn zip_descriptor(zip_path: &Path) -> Option<String> {
    use std::os::unix::fs::MetadataExt;
    let meta = std::fs::metadata(zip_path).ok()?;
    // mtime seconds + nanoseconds concatenated — the TS `${stat.mtimeNs}`
    // analogue sufficient for change detection.
    let mtime_ns = format!("{}{}", meta.mtime(), meta.mtime_nsec());
    Some(format!(
        "zip:{}:{}:{}",
        zip_path.display(),
        meta.len(),
        mtime_ns
    ))
}

/// Total index builds since process start (diagnostics/bench evidence).
pub fn index_build_count() -> u64 {
    cache()
        .lock()
        .expect("story index lock")
        .as_ref()
        .map(|s| s.builds)
        .unwrap_or(0)
}

/// The shared index: cached by descriptor, rebuilt once per zip identity.
pub fn story_search_index(
    zip_path: &Path,
    store: &ZipStore,
) -> Result<Arc<StorySearchIndex>, String> {
    const SLOT: &str = "story_search:story_search_index";
    let descriptor = zip_descriptor(zip_path);
    {
        let guard = cache().lock().expect("story index lock");
        if let Some(shared) = guard.as_ref() {
            if Some(&shared.descriptor) == descriptor.as_ref() {
                crate::diagnostics::record_hit(SLOT);
                crate::diagnostics::record_loaded(SLOT, shared.index.chapters.len() as u64);
                return Ok(Arc::clone(&shared.index));
            }
        }
    }
    crate::diagnostics::record_miss(SLOT);
    let index = Arc::new(build_story_search_index(store)?);
    let mut guard = cache().lock().expect("story index lock");
    // Another thread may have won the race — first builder's index stays.
    match guard.as_ref() {
        Some(shared) if Some(&shared.descriptor) == descriptor.as_ref() => {
            crate::diagnostics::record_hit(SLOT);
            Ok(Arc::clone(&shared.index))
        }
        _ => {
            let builds = guard.as_ref().map(|s| s.builds + 1).unwrap_or(1);
            crate::diagnostics::record_loaded(SLOT, index.chapters.len() as u64);
            *guard = Some(SharedIndex {
                descriptor: descriptor.unwrap_or_default(),
                index: Arc::clone(&index),
                builds,
            });
            Ok(index)
        }
    }
}

fn build_story_search_index(store: &ZipStore) -> Result<StorySearchIndex, String> {
    let table = load_event_table(store)?;
    let mut event_ids = HashSet::new();
    let mut chapters: Vec<StorySearchChapter> = Vec::new();
    let mut records: Vec<(usize, usize)> = Vec::new();

    for (ev_id, entry) in table.iter() {
        let Some(datas) = entry
            .get("infoUnlockDatas")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
        else {
            continue;
        };
        if datas.is_empty() {
            continue;
        }
        // Only NONE entries that are operator memoirs join the corpus.
        let entry_type = entry
            .get("entryType")
            .and_then(Value::as_str)
            .unwrap_or("NONE");
        if entry_type == "NONE" && !is_memoir_event(ev_id) {
            continue;
        }
        event_ids.insert(ev_id.clone());
        let mut sorted: Vec<&Value> = datas.iter().collect();
        sorted.sort_by(|a, b| {
            let sa = a.get("storySort").and_then(Value::as_f64).unwrap_or(0.0);
            let sb = b.get("storySort").and_then(Value::as_f64).unwrap_or(0.0);
            sa.partial_cmp(&sb).unwrap_or(std::cmp::Ordering::Equal)
        });
        for d in sorted {
            let story_txt = d.get("storyTxt").and_then(Value::as_str).unwrap_or("");
            if story_txt.is_empty() {
                continue;
            }
            let chapter = match read_story_from_store(store, story_txt, true) {
                Ok(chapter) => chapter,
                Err(message) => {
                    // Corrupt JSON and missing chapters skip silently.
                    if message.contains("not found") || message.contains("JSON parse failure") {
                        continue;
                    }
                    return Err(message);
                }
            };
            let chapter_index = chapters.len();
            chapters.push(StorySearchChapter {
                event_id: ev_id.clone(),
                story_key: story_txt.to_string(),
                story_code: d
                    .get("storyCode")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                story_name: d
                    .get("storyName")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                lines: chapter.lines,
            });
            for i in 0..chapters[chapter_index].lines.len() {
                records.push((chapter_index, i));
            }
        }
    }
    Ok(StorySearchIndex {
        event_ids,
        chapters,
        records,
    })
}

const VALID_LINE_TYPES: [&str; 3] = ["dialog", "narration", "choice"];

/// `buildStorySearchFromStore`: Err carries the exact message text.
pub fn build_story_search(
    zip_path: &Path,
    pattern: &str,
    character: Option<&str>,
    line_type: Option<&str>,
    context_lines: i64,
    max_results: i64,
    event_id: Option<&str>,
) -> Result<Value, String> {
    if max_results < 1 {
        return Err("max_results 必须 >= 1。".to_string());
    }
    if max_results > 100 {
        return Err("max_results 必须 <= 100。".to_string());
    }
    if context_lines < 0 {
        return Err("context_lines 必须 >= 0。".to_string());
    }
    if context_lines > 5 {
        return Err("context_lines 必须 <= 5。".to_string());
    }
    let regex = crate::text::regex_compat::JsRegex::compile(pattern)
        .map_err(|e| format!("正则表达式无效：{e}"))?;

    if let Some(line_type) = line_type {
        // Sorted valid set, joined with ", " — matches TS Set iteration.
        if !VALID_LINE_TYPES.contains(&line_type) {
            // TS Array.from(Set).sort() — alphabetical valid-set listing.
            let mut valid: Vec<&str> = VALID_LINE_TYPES.to_vec();
            valid.sort_unstable();
            let valid = valid.join(", ");
            return Err(format!(
                "无效的 line_type：{}，可选值：{valid}",
                py_repr(Some(line_type))
            ));
        }
    }

    let store = ZipStore::new(zip_path);
    let index =
        story_search_index(zip_path, &store).map_err(|e| format!("读取剧情数据索引失败：{e}"))?;

    if let Some(event_id) = event_id {
        if !index.event_ids.contains(event_id) {
            return Err(format!("未找到匹配的活动：{}。", py_repr(Some(event_id))));
        }
    }

    let mut results: Vec<Value> = Vec::new();
    let character_lower = character.map(str::to_lowercase);
    for &(chapter_index, line_index) in index.records.iter() {
        if results.len() as i64 >= max_results {
            break;
        }
        let chapter = &index.chapters[chapter_index];
        let line = &chapter.lines[line_index];
        if let Some(event_id) = event_id {
            if chapter.event_id != event_id {
                continue;
            }
        }
        if let Some(character_lower) = &character_lower {
            let role = line.role.as_deref().unwrap_or("");
            if line.line_type != "dialog" || role.to_lowercase() != *character_lower {
                continue;
            }
        }
        if let Some(line_type) = line_type {
            if line.line_type != line_type {
                continue;
            }
        }
        if !regex.is_match(&line.text)? {
            continue;
        }

        let start = line_index.saturating_sub(context_lines as usize);
        let end = (line_index + context_lines as usize + 1).min(chapter.lines.len());
        let context: Vec<Value> = (start..end)
            .map(|j| {
                json!({
                    "text": format_line(&chapter.lines[j]),
                    "is_match": j == line_index,
                })
            })
            .collect();
        results.push(json!({
            "event_id": chapter.event_id,
            "story_key": chapter.story_key,
            "story_code": chapter.story_code,
            "line_number": line_index + 1,
            "context": context,
        }));
    }

    Ok(json!({
        "pattern": pattern,
        "filters": {
            "character": character.map(|c| Value::String(c.to_string())).unwrap_or(Value::Null),
            "line_type": line_type.map(|c| Value::String(c.to_string())).unwrap_or(Value::Null),
            "context_lines": context_lines,
            "event_id": event_id.map(|c| Value::String(c.to_string())).unwrap_or(Value::Null),
        },
        "total": results.len(),
        "results": results,
    }))
}

pub fn render_story_search(data: &Value) -> String {
    let pattern = data["pattern"].as_str().unwrap_or("");
    let results = data["results"].as_array().cloned().unwrap_or_default();
    if results.is_empty() {
        let filters = &data["filters"];
        let mut filter_parts: Vec<String> = Vec::new();
        if let Some(ev) = filters["event_id"].as_str() {
            filter_parts.push(format!("event_id={}", py_repr(Some(ev))));
        }
        if let Some(ch) = filters["character"].as_str() {
            filter_parts.push(format!("character={}", py_repr(Some(ch))));
        }
        if let Some(lt) = filters["line_type"].as_str() {
            filter_parts.push(format!("line_type={}", py_repr(Some(lt))));
        }
        let suffix = if filter_parts.is_empty() {
            String::new()
        } else {
            format!("（过滤条件：{}）", filter_parts.join("。"))
        };
        return format!("未找到匹配 '{pattern}' 的剧情台词。{suffix}");
    }
    let mut parts = vec![format!(
        "# 搜索 \"{}\" 的结果（共 {} 条）",
        pattern,
        data["total"].as_i64().unwrap_or(0)
    )];
    for r in &results {
        let context = r["context"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .map(|item| {
                format!(
                    "{}{}",
                    if item["is_match"].as_bool().unwrap_or(false) {
                        ">>> "
                    } else {
                        "    "
                    },
                    item["text"].as_str().unwrap_or("")
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        parts.push(format!(
            "\n---\n\n[stories/{}/{} L{}]\n{context}",
            r["event_id"].as_str().unwrap_or(""),
            r["story_code"].as_str().unwrap_or(""),
            r["line_number"].as_i64().unwrap_or(0)
        ));
    }
    parts.join("\n")
}
