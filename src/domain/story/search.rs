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

use super::packed_lines::PackedLines;
use super::reader::{
    format_line_parts, is_memoir_event, load_event_table, py_repr, read_story_from_store,
};
use crate::storage::ZipStore;

pub struct StorySearchChapter {
    pub event_id: String,
    pub story_key: String,
    pub story_code: String,
    pub story_name: String,
    pub lines: PackedLines,
}

pub struct StorySearchIndex {
    pub event_ids: HashSet<String>,
    pub chapters: Vec<StorySearchChapter>,
}

impl StorySearchIndex {
    /// Visit every chapter/line pair in corpus order without a duplicate index.
    pub fn records(&self) -> impl Iterator<Item = (usize, usize)> + '_ {
        self.chapters
            .iter()
            .enumerate()
            .flat_map(|(chapter, data)| (0..data.lines.len()).map(move |line| (chapter, line)))
    }
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
    let meta = std::fs::metadata(zip_path).ok()?;
    // mtime seconds + nanoseconds concatenated — the TS `${stat.mtimeNs}`
    // analogue sufficient for change detection.
    #[cfg(unix)]
    let mtime_ns = {
        use std::os::unix::fs::MetadataExt;
        format!("{}{}", meta.mtime(), meta.mtime_nsec())
    };
    #[cfg(windows)]
    let mtime_ns = {
        use std::os::windows::fs::MetadataExt;
        meta.last_write_time().to_string()
    };
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
    let mut guard = cache().lock().expect("story index lock");
    if let Some(shared) = guard.as_ref() {
        if Some(&shared.descriptor) == descriptor.as_ref() {
            crate::diagnostics::record_hit(SLOT);
            crate::diagnostics::record_loaded(SLOT, shared.index.chapters.len() as u64);
            return Ok(Arc::clone(&shared.index));
        }
    }
    crate::diagnostics::record_miss(SLOT);
    let index = Arc::new(build_story_search_index(store)?);
    let builds = guard.as_ref().map(|s| s.builds + 1).unwrap_or(1);
    crate::diagnostics::record_loaded(SLOT, index.chapters.len() as u64);
    *guard = Some(SharedIndex {
        descriptor: descriptor.unwrap_or_default(),
        index: Arc::clone(&index),
        builds,
    });
    Ok(index)
}

fn build_story_search_index(store: &ZipStore) -> Result<StorySearchIndex, String> {
    let table = load_event_table(store)?;
    let mut event_ids = HashSet::new();
    let mut jobs = Vec::new();

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
            jobs.push((ev_id.as_str(), story_txt, d));
        }
    }
    let chapters = load_index_chapters(store, &jobs)?;
    Ok(StorySearchIndex {
        event_ids,
        chapters,
    })
}

type ChapterJob<'a> = (&'a str, &'a str, &'a Value);

/// At most four readers share serialized ZIP access, then parse independently.
/// Ordinals restore the exact oracle order, including which failure surfaces.
fn load_index_chapters(
    store: &ZipStore,
    jobs: &[ChapterJob<'_>],
) -> Result<Vec<StorySearchChapter>, String> {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let workers = std::thread::available_parallelism()
        .map_or(1, |n| n.get())
        .min(4)
        .min(jobs.len());
    let next = AtomicUsize::new(0);
    let mut results = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..workers)
            .map(|_| {
                scope.spawn(|| {
                    let mut completed = Vec::new();
                    loop {
                        let ordinal = next.fetch_add(1, Ordering::Relaxed);
                        let Some(&(event_id, story_key, data)) = jobs.get(ordinal) else {
                            break;
                        };
                        let result = read_story_from_store(store, story_key, true).map(|chapter| {
                            StorySearchChapter {
                                event_id: event_id.to_owned(),
                                story_key: story_key.to_owned(),
                                story_code: data
                                    .get("storyCode")
                                    .and_then(Value::as_str)
                                    .unwrap_or("")
                                    .to_owned(),
                                story_name: data
                                    .get("storyName")
                                    .and_then(Value::as_str)
                                    .unwrap_or("")
                                    .to_owned(),
                                lines: PackedLines::new(chapter.lines),
                            }
                        });
                        completed.push((ordinal, result));
                    }
                    completed
                })
            })
            .collect();
        handles
            .into_iter()
            .flat_map(|h| h.join().expect("story index reader panicked"))
            .collect::<Vec<_>>()
    });
    results.sort_unstable_by_key(|(ordinal, _)| *ordinal);
    let mut chapters = Vec::with_capacity(results.len());
    for (_, result) in results {
        match result {
            Ok(chapter) => chapters.push(chapter),
            Err(message)
                if message.contains("not found") || message.contains("JSON parse failure") => {}
            Err(message) => return Err(message),
        }
    }
    Ok(chapters)
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

    if crate::storage::sqlite::is_database(zip_path) {
        let db = crate::storage::sqlite::GameDb::open(zip_path)?;
        if db.derived_ready() {
            return super::sqlite_search::search(
                &db,
                pattern,
                &regex,
                character,
                line_type,
                context_lines,
                max_results,
                event_id,
            );
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
    for (chapter_index, line_index) in index.records() {
        if results.len() as i64 >= max_results {
            break;
        }
        let chapter = &index.chapters[chapter_index];
        let line = chapter.lines.get(line_index).expect("index owns its lines");
        if let Some(event_id) = event_id {
            if chapter.event_id != event_id {
                continue;
            }
        }
        if let Some(character_lower) = &character_lower {
            let role = line.role.unwrap_or("");
            if line.line_type != "dialog" || role.to_lowercase() != *character_lower {
                continue;
            }
        }
        if let Some(line_type) = line_type {
            if line.line_type != line_type {
                continue;
            }
        }
        if !regex.is_match(line.text)? {
            continue;
        }

        let start = line_index.saturating_sub(context_lines as usize);
        let end = (line_index + context_lines as usize + 1).min(chapter.lines.len());
        let context: Vec<Value> = (start..end)
            .map(|j| {
                let context_line = chapter.lines.get(j).expect("bounded context");
                json!({
                    "text": format_line_parts(context_line.line_type, context_line.role, context_line.text),
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
