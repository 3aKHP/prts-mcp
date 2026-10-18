//! Base-skill (基建技能) data reader — port of TS `data/building.ts`.

use std::path::Path;
use std::sync::Arc;

use serde_json::{json, Value};

use crate::app::DataView;
use crate::domain::messages;
use crate::storage::projection::Projection;
use crate::storage::JsonStore;

const ROOM_ZH: &[(&str, &str)] = &[
    ("CONTROL", "控制中枢"),
    ("POWER", "发电站"),
    ("MANUFACTURE", "制造站"),
    ("TRADING", "贸易站"),
    ("WORKSHOP", "加工站"),
    ("TRAINING", "训练室"),
    ("DORMITORY", "宿舍"),
    ("HIRE", "人力办公室"),
    ("MEETING", "会客室"),
];

fn phase_zh(phase: &str) -> String {
    match phase {
        "PHASE_0" => "精英0".to_string(),
        "PHASE_1" => "精英1".to_string(),
        "PHASE_2" => "精英2".to_string(),
        other => other.to_string(),
    }
}

/// Whether building_data.json exists in the effective excel store.
pub fn has_building_data(view: &DataView) -> bool {
    view.excel_store()
        .is_some_and(|store| store.exists("building_data.json").unwrap_or(false))
}

fn building_table(view: &DataView) -> Result<Arc<Value>, String> {
    let Some(store) = view.excel_store() else {
        return Err("__missing__基建技能".to_string());
    };
    view.datasets.get_or_load_counted("building:building_table", move || {
        if !store.exists("building_data.json").unwrap_or(false) {
            let shown = store
                .resolve("building_data.json")
                .map(|p| p.display().to_string())
                .unwrap_or_else(|_| "building_data.json".to_string());
            return Err(format!(
                "基建技能数据文件不存在：{shown}。数据目录可能为空，或挂载路径有误（GAMEDATA_PATH 应指向游戏数据根目录）。"
            ));
        }
        store.read_json_projected("building_data.json", Projection::Fields(&[
            ("chars", Projection::All), ("buffs", Projection::All),
        ])).map_err(|e| e.to_string())
    }, |raw| raw.pointer("/buffs").and_then(serde_json::Value::as_object).map(|m| m.len() as u64).unwrap_or(0))
}

fn clean_description(desc: &str) -> String {
    if desc.is_empty() {
        return String::new();
    }
    // `<[^>]+>` removal + trim.
    let stripped = crate::text::sanitizer::strip_html_tags(desc);
    stripped.trim().to_string()
}

fn phase_rank(buff_data: &Value) -> i64 {
    let phase = buff_data
        .pointer("/cond/phase")
        .and_then(Value::as_str)
        .unwrap_or("");
    phase
        .strip_prefix("PHASE_")
        .and_then(|n| n.parse::<i64>().ok())
        .unwrap_or(-1)
}

/// An operator's base skills, highest phase per buff slot (payload field
/// order: name, room, description, unlock).
pub fn building_skills_for(view: &DataView, char_id: &str) -> Result<Vec<Value>, String> {
    let table = if let Some(db) = view.database() {
        let chars = db.entity_map("building_data", "chars", Some(char_id), None)?;
        let mut buffs = serde_json::Map::new();
        if let Some(entry) = chars.get(char_id) {
            for slot in entry
                .get("buffChar")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                for data in slot
                    .get("buffData")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    if let Some(id) = data.get("buffId").and_then(Value::as_str) {
                        if let Some(value) = db.entity("building_data", "buffs", id)? {
                            buffs.insert(id.into(), value);
                        }
                    }
                }
            }
        }
        Arc::new(json!({"chars":chars,"buffs":buffs}))
    } else {
        building_table(view)?
    };
    if !table.is_object() {
        return Err("building_data.json 顶层不是 JSON 对象".to_string());
    }
    let chars = table.get("chars").and_then(Value::as_object);
    let buffs = table.get("buffs").and_then(Value::as_object);
    let Some(entry) = chars.and_then(|c| c.get(char_id)) else {
        return Ok(Vec::new());
    };
    let mut skills = Vec::new();
    for slot in entry
        .get("buffChar")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
    {
        // Highest phase wins; lower ones are the weaker variants.
        let mut best: Option<&Value> = None;
        for buff_data in slot
            .get("buffData")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[])
        {
            if best.is_none_or(|b| phase_rank(buff_data) > phase_rank(b)) {
                best = Some(buff_data);
            }
        }
        let Some(best) = best else { continue };
        let buff_id = best.get("buffId").and_then(Value::as_str).unwrap_or("");
        let Some(buff) = buffs.and_then(|b| b.get(buff_id)) else {
            continue;
        };
        let room_raw = buff.get("roomType").and_then(Value::as_str).unwrap_or("");
        let phase = best
            .pointer("/cond/phase")
            .and_then(Value::as_str)
            .unwrap_or("");
        let room = ROOM_ZH
            .iter()
            .find(|(k, _)| *k == room_raw)
            .map(|(_, v)| v.to_string())
            .unwrap_or_else(|| room_raw.to_string());
        skills.push(json!({
            "name": buff.get("buffName").and_then(Value::as_str).unwrap_or(""),
            "room": room,
            "description": clean_description(buff.get("description").and_then(Value::as_str).unwrap_or("")),
            "unlock": phase_zh(phase),
        }));
    }
    Ok(skills)
}

// ---------------------------------------------------------------------------
// Cross-operator search (search tool's building_skills scope)
// ---------------------------------------------------------------------------

fn building_skill_records(view: &DataView) -> Result<Arc<Vec<Value>>, String> {
    view.datasets.get_or_load_counted(
        "building:building_skill_records",
        || {
            if !has_building_data(view) {
                // Older data roots lack building_data.json: the scope reports no
                // matches rather than a data error.
                return Ok(Vec::new());
            }
            let _ct = crate::domain::operator::character_table(view)?;
            let mut records = Vec::new();
            for (name, char_id) in crate::domain::operator::name_to_char_id(view)?.iter() {
                for s in building_skills_for(view, char_id)? {
                    records.push(json!({
                        "operator": name,
                        "skill": s["name"].clone(),
                        "room": s["room"].clone(),
                        "unlock": s["unlock"].clone(),
                        "text": s["description"].clone(),
                    }));
                }
            }
            Ok(records)
        },
        |records| records.len() as u64,
    )
}

/// `buildBuildingSkillSearch`: Err carries the exact message text.
pub fn build_building_skill_search(
    view: &DataView,
    excel_path: &Path,
    pattern: &str,
    max_results: i64,
) -> Result<Value, String> {
    if let Some(err) = messages::validate_bounds("max_results", max_results, Some(1), Some(100)) {
        return Err(err);
    }
    if view.excel_root.is_none() {
        return Err(messages::excel_missing_message("基建技能", excel_path));
    }
    let regex = crate::text::regex_compat::JsRegex::compile(pattern)
        .map_err(|e| messages::regex_error_message(&e))?;

    let records = building_skill_records(view)?;
    let mut results: Vec<Value> = Vec::new();
    for record in records.iter() {
        let haystack = format!(
            "{} {} {}",
            record["skill"].as_str().unwrap_or(""),
            record["room"].as_str().unwrap_or(""),
            record["text"].as_str().unwrap_or("")
        );
        if regex.is_match(&haystack)? {
            results.push(record.clone());
            if results.len() as i64 >= max_results {
                break;
            }
        }
    }
    let total = results.len();
    Ok(json!({
        "scope": "building_skills",
        "pattern": pattern,
        "total": total,
        "results": results,
    }))
}

pub fn render_building_skill_search(data: &Value) -> String {
    let pattern = data["pattern"].as_str().unwrap_or("");
    let results = data["results"].as_array().cloned().unwrap_or_default();
    if results.is_empty() {
        return format!("未找到匹配 '{pattern}' 的干员基建技能。");
    }
    let mut lines = vec![format!(
        "# 搜索 \"{}\" 的结果（共 {} 条）",
        pattern,
        data["total"].as_i64().unwrap_or(0)
    )];
    for r in &results {
        lines.push(format!(
            "- **{}**｜{}（{}，{}解锁）：{}",
            r["operator"].as_str().unwrap_or(""),
            r["skill"].as_str().unwrap_or(""),
            r["room"].as_str().unwrap_or(""),
            r["unlock"].as_str().unwrap_or(""),
            r["text"].as_str().unwrap_or("")
        ));
    }
    lines.join("\n")
}

pub fn sqlite_export(view: &DataView) -> Result<Vec<(String, Value)>, String> {
    Ok(building_skill_records(view)?
        .iter()
        .map(|r| {
            (
                format!(
                    "{} {} {}",
                    r["skill"].as_str().unwrap_or(""),
                    r["room"].as_str().unwrap_or(""),
                    r["text"].as_str().unwrap_or("")
                ),
                r.clone(),
            )
        })
        .collect())
}
