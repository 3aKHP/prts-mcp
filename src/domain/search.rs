//! Unified full-text search across operator data — port of TS
//! `data/search.ts`.

use std::path::Path;
use std::sync::Arc;

use serde_json::{json, Value};

use crate::app::DataView;
use crate::domain::messages;
use crate::domain::operator::{character_table, charword_table, handbook_table, name_to_char_id};
use crate::text::sanitizer::strip_wikitext;

struct OperatorSearchRecord {
    operator: String,
    category: String,
    field: String,
    text: String,
}

fn operator_search_records(view: &DataView) -> Result<Arc<Vec<OperatorSearchRecord>>, String> {
    view.datasets.get_or_load_counted(
        "search:search_records",
        || {
            let ct = character_table(view)?;
            let handbook = handbook_table(view)?;
            let charwords = charword_table(view)?;

            // charId → voice entries with text (insertion order).
            let mut charid_to_voices: std::collections::HashMap<String, Vec<&Value>> =
                std::collections::HashMap::new();
            let mut voice_order: Vec<String> = Vec::new();
            if let Some(words) = charwords.pointer("/charWords").and_then(Value::as_object) {
                for entry in words.values() {
                    let Some(char_id) = entry.get("charId").and_then(Value::as_str) else {
                        continue;
                    };
                    if entry.get("voiceText").and_then(Value::as_str).is_none() {
                        continue;
                    }
                    if !charid_to_voices.contains_key(char_id) {
                        voice_order.push(char_id.to_string());
                    }
                    charid_to_voices
                        .entry(char_id.to_string())
                        .or_default()
                        .push(entry);
                }
            }

            let mut records = Vec::new();
            for (name, char_id) in name_to_char_id(view)?.iter() {
                let Some(info) = ct.as_object().and_then(|m| m.get(char_id)) else {
                    continue;
                };
                records.push(OperatorSearchRecord {
                    operator: name.clone(),
                    category: "basic".to_string(),
                    field: "干员名称".to_string(),
                    text: name.clone(),
                });
                if let Some(desc) = info.get("description").and_then(Value::as_str) {
                    if !desc.is_empty() {
                        records.push(OperatorSearchRecord {
                            operator: name.clone(),
                            category: "basic".to_string(),
                            field: "攻击属性".to_string(),
                            text: strip_wikitext(desc),
                        });
                    }
                }
                if let Some(hb) = handbook
                    .pointer("/handbookDict")
                    .and_then(Value::as_object)
                    .and_then(|d| d.get(char_id))
                {
                    for story in hb
                        .get("storyTextAudio")
                        .and_then(Value::as_array)
                        .map(Vec::as_slice)
                        .unwrap_or(&[])
                    {
                        let title = story
                            .get("storyTitle")
                            .and_then(Value::as_str)
                            .unwrap_or("");
                        for s in story
                            .get("stories")
                            .and_then(Value::as_array)
                            .map(Vec::as_slice)
                            .unwrap_or(&[])
                        {
                            let text = s.get("storyText").and_then(Value::as_str).unwrap_or("");
                            if !text.is_empty() {
                                records.push(OperatorSearchRecord {
                                    operator: name.clone(),
                                    category: "archives".to_string(),
                                    field: title.to_string(),
                                    text: text.to_string(),
                                });
                            }
                        }
                    }
                }
                for v in charid_to_voices.get(char_id).into_iter().flatten() {
                    records.push(OperatorSearchRecord {
                        operator: name.clone(),
                        category: "voicelines".to_string(),
                        field: v
                            .get("voiceTitle")
                            .and_then(Value::as_str)
                            .unwrap_or("未知")
                            .to_string(),
                        text: v
                            .get("voiceText")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                    });
                }
            }
            Ok(records)
        },
        |records| records.len() as u64,
    )
}

/// `buildOperatorSearch`: Err carries the exact message text.
pub fn build_operator_search(
    view: &DataView,
    excel_path: &Path,
    pattern: &str,
    max_results: i64,
) -> Result<Value, String> {
    if let Some(err) = messages::validate_bounds("max_results", max_results, Some(1), Some(100)) {
        return Err(err);
    }
    if view.excel_root.is_none() {
        return Err(messages::excel_missing_message("干员", excel_path));
    }
    let regex = crate::text::regex_compat::JsRegex::compile(pattern)
        .map_err(|e| messages::regex_error_message(&e))?;
    let records = operator_search_records(view)?;
    let mut results: Vec<Value> = Vec::new();
    for record in records.iter() {
        if regex.is_match(&record.text)? {
            results.push(json!({
                "operator": record.operator,
                "category": record.category,
                "field": record.field,
                "text": record.text,
            }));
            if results.len() as i64 >= max_results {
                break;
            }
        }
    }
    let total = results.len();
    Ok(json!({
        "scope": "operators",
        "pattern": pattern,
        "total": total,
        "results": results,
    }))
}

pub fn render_operator_search(data: &Value) -> String {
    let pattern = data["pattern"].as_str().unwrap_or("");
    let results = data["results"].as_array().cloned().unwrap_or_default();
    if results.is_empty() {
        return format!("未找到匹配 '{pattern}' 的干员数据。");
    }
    let mut blocks = vec![format!(
        "# 搜索 \"{}\" 的结果（共 {} 条）",
        pattern,
        data["total"].as_i64().unwrap_or(0)
    )];
    for r in &results {
        blocks.push(format!(
            "\n---\n\n[operators/{}/{}]\n匹配：{}\n{}",
            r["category"].as_str().unwrap_or(""),
            r["operator"].as_str().unwrap_or(""),
            r["field"].as_str().unwrap_or(""),
            r["text"].as_str().unwrap_or("")
        ));
    }
    blocks.join("")
}

/// `buildSearch`: dispatch across the six scopes.
pub fn build_search(
    view: &DataView,
    excel_path: &Path,
    scope: &str,
    pattern: &str,
    max_results: i64,
) -> Result<Value, String> {
    if let Some(db) = view.database() {
        if db.derived_ready()
            && db
                .metadata(&format!("search_unavailable:{scope}"))?
                .as_deref()
                != Some("1")
            && [
                "operators",
                "enemies",
                "stages",
                "items",
                "building_skills",
                "skills",
            ]
            .contains(&scope)
        {
            if let Some(error) =
                messages::validate_bounds("max_results", max_results, Some(1), Some(100))
            {
                return Err(error);
            }
            return database_search(&db, scope, pattern, max_results);
        }
    }
    match scope {
        "operators" => build_operator_search(view, excel_path, pattern, max_results),
        "enemies" => crate::domain::enemy::build_enemy_search(view, excel_path, pattern, max_results),
        "stages" => crate::domain::stage::build_stage_search(view, excel_path, pattern, max_results),
        "items" => crate::domain::item::build_item_search(view, excel_path, pattern, max_results),
        "building_skills" => {
            crate::domain::building::build_building_skill_search(view, excel_path, pattern, max_results)
        }
        "skills" => crate::domain::skill::build_skill_search(view, excel_path, pattern, max_results),
        other => Err(format!(
            "不支持的搜索域：'{other}'。可选：operators、enemies、stages、items、building_skills、skills。"
        )),
    }
}

pub fn render_search(data: &Value) -> String {
    match data["scope"].as_str().unwrap_or_default() {
        "operators" => render_operator_search(data),
        "enemies" => crate::domain::enemy::render_enemy_search(data),
        "stages" => crate::domain::stage::render_stage_search(data),
        "items" => crate::domain::item::render_item_search(data),
        "building_skills" => crate::domain::building::render_building_skill_search(data),
        "skills" => crate::domain::skill::render_skill_search(data),
        other => unreachable!("unregistered scope {other} cannot reach render"),
    }
}

pub fn sqlite_export(view: &DataView) -> Result<Vec<(String, Value)>, String> {
    Ok(operator_search_records(view)?
        .iter()
        .map(|r| {
            (
                r.text.clone(),
                json!({"operator":r.operator,"category":r.category,"field":r.field,"text":r.text}),
            )
        })
        .collect())
}

fn database_search(
    db: &crate::storage::sqlite::GameDb,
    scope: &str,
    pattern: &str,
    max_results: i64,
) -> Result<Value, String> {
    let regex = crate::text::regex_compat::JsRegex::compile(pattern)
        .map_err(|e| crate::domain::messages::regex_error_message(&e))?;
    let connection = db.scan_connection()?;
    let mut results = Vec::new();
    let mut statement=connection.prepare_cached("SELECT first_ordinal,last_ordinal,payload FROM search_blocks WHERE scope=?1 ORDER BY block").map_err(|e| e.to_string())?;
    let mut blocks = statement.query([scope]).map_err(|e| e.to_string())?;
    'blocks: while let Some(block) = blocks.next().map_err(|e| e.to_string())? {
        crate::text::cancellation::check()?;
        if !regex.may_match_bytes(
            block
                .get_ref(2)
                .map_err(|e| e.to_string())?
                .as_blob()
                .map_err(|e| e.to_string())?,
        ) {
            continue;
        }
        let first: i64 = block.get(0).map_err(|e| e.to_string())?;
        let last: i64 = block.get(1).map_err(|e| e.to_string())?;
        let mut entries=connection.prepare_cached("SELECT text,payload FROM searches WHERE scope=?1 AND ordinal BETWEEN ?2 AND ?3 ORDER BY ordinal").map_err(|e| e.to_string())?;
        let mut rows = entries
            .query(rusqlite::params![scope, first, last])
            .map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            crate::text::cancellation::check()?;
            let text = row
                .get_ref(0)
                .map_err(|e| e.to_string())?
                .as_str()
                .map_err(|e| e.to_string())?;
            if regex.is_match(text)? {
                results.push(
                    serde_json::from_str::<Value>(
                        row.get_ref(1)
                            .map_err(|e| e.to_string())?
                            .as_str()
                            .map_err(|e| e.to_string())?,
                    )
                    .map_err(|e| e.to_string())?,
                );
                if results.len() as i64 >= max_results {
                    break 'blocks;
                }
            }
        }
    }
    Ok(serde_json::json!({"scope":scope,"pattern":pattern,"total":results.len(),"results":results}))
}
