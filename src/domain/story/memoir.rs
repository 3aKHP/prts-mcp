//! Operator memoir discovery — port of TS `data/storyMemoir.ts`.

use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::{json, Map, Value};

use super::reader::{CHARDICT, STORY_REVIEW_TABLE};
use crate::storage::{JsonStore, ZipStore};

/// Chardict cache: like the index, dataset-scoped and keyed by the zip's
/// stat descriptor (swap → reload once, old map released).
struct SharedCharDict {
    descriptor: String,
    data: Arc<Map<String, Value>>,
}

static CHARDICT_CACHE: OnceLock<Mutex<Option<SharedCharDict>>> = OnceLock::new();

pub fn load_char_dict(zip_path: &Path, store: &ZipStore) -> Arc<Map<String, Value>> {
    let descriptor = super::search::zip_descriptor(zip_path);
    if let Some(descriptor) = &descriptor {
        let guard = CHARDICT_CACHE
            .get_or_init(|| Mutex::new(None))
            .lock()
            .expect("chardict lock");
        if let Some(shared) = guard.as_ref() {
            if &shared.descriptor == descriptor {
                return Arc::clone(&shared.data);
            }
        }
    }
    let data = if !store.exists(CHARDICT).unwrap_or(false) {
        Map::new()
    } else {
        store
            .read_json(CHARDICT)
            .ok()
            .and_then(|raw| raw.as_object().cloned())
            .unwrap_or_default()
    };
    let data = Arc::new(data);
    if let Some(descriptor) = descriptor {
        let mut guard = CHARDICT_CACHE
            .get_or_init(|| Mutex::new(None))
            .lock()
            .expect("chardict lock");
        match guard.as_ref() {
            Some(shared) if shared.descriptor == descriptor => {}
            _ => {
                *guard = Some(SharedCharDict {
                    descriptor,
                    data: Arc::clone(&data),
                });
            }
        }
    }
    data
}

fn resolve_operator_code(char_dict: &Map<String, Value>, operator_name: &str) -> Option<String> {
    char_dict
        .iter()
        .find(|(_, info)| info.get("name").and_then(Value::as_str) == Some(operator_name))
        .map(|(code, _)| code.clone())
}

/// `buildOperatorMemoirsFromStore`: Err is the thrown message.
pub fn build_operator_memoirs(zip_path: &Path, operator_name: &str) -> Result<Value, String> {
    let store = ZipStore::new(zip_path);
    build_operator_memoirs_from_store(&store, operator_name)
}

pub(crate) fn build_operator_memoirs_from_store(
    store: &ZipStore,
    operator_name: &str,
) -> Result<Value, String> {
    let zip_path = store.zip_path();
    let char_dict = load_char_dict(zip_path, store);
    if char_dict.is_empty() {
        return Err("chardict.json 未在 story zip 中找到。".to_string());
    }
    let Some(code) = resolve_operator_code(&char_dict, operator_name) else {
        return Err(format!(
            "未找到干员名称 '{operator_name}' 对应的内部代码。请使用游戏内中文名称。"
        ));
    };
    let operator_id = char_dict
        .get(&code)
        .and_then(|info| info.get("id"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    let table = store
        .read_json(STORY_REVIEW_TABLE)
        .map_err(|e| e.to_string())?;
    let table = table.as_object().cloned().unwrap_or_default();
    let prefix = format!("story_{code}_set_");
    let mut memoir_events: Vec<String> = table
        .keys()
        .filter(|eid| eid.starts_with(&prefix))
        .cloned()
        .collect();
    memoir_events.sort_by_key(|eid| {
        eid.rsplit('_')
            .next()
            .and_then(|n| n.parse::<i64>().ok())
            .unwrap_or(0)
    });

    if memoir_events.is_empty() {
        return Err(format!(
            "干员 '{operator_name}' (code={code}) 暂无密录数据。"
        ));
    }

    let mut chapters: Vec<Value> = Vec::new();
    for event_id in memoir_events {
        let entry = table.get(&event_id).cloned().unwrap_or(json!({}));
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
        for d in datas {
            let story_txt = d.get("storyTxt").and_then(Value::as_str).unwrap_or("");
            if story_txt.is_empty() {
                continue;
            }
            chapters.push(json!({
                "story_code": d.get("storyCode").and_then(Value::as_str).unwrap_or(""),
                "story_name": d.get("storyName").and_then(Value::as_str).unwrap_or(""),
                "story_key": story_txt,
            }));
        }
    }

    let total = chapters.len();
    Ok(json!({
        "operator_name": operator_name,
        "internal_code": code,
        "operator_id": operator_id,
        "total": total,
        "chapters": chapters,
    }))
}

pub fn render_operator_memoirs(data: &Value) -> String {
    let mut lines = vec![
        format!(
            "# {}（code: {}，id: {}）",
            data["operator_name"].as_str().unwrap_or(""),
            data["internal_code"].as_str().unwrap_or(""),
            data["operator_id"].as_str().unwrap_or("")
        ),
        format!("共 {} 章密录\n", data["total"].as_i64().unwrap_or(0)),
    ];
    for ch in data["chapters"].as_array().cloned().unwrap_or_default() {
        lines.push(format!(
            "- {} {}（key: {}）",
            ch["story_code"].as_str().unwrap_or(""),
            ch["story_name"].as_str().unwrap_or(""),
            ch["story_key"].as_str().unwrap_or("")
        ));
    }
    lines.join("\n")
}
