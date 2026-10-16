//! Combat-skill reader — port of TS `data/skill.ts`.
//!
//! Joins character_table skill refs against skill_table per-level entries
//! and renders level descriptions by substituting blackboard placeholders
//! (`{key}` plain and `{key:0%}` .NET-style formats).

use std::path::Path;
use std::sync::Arc;

use super::skill_data::{BlackboardValue, SkillLevel, SkillTable};
use serde_json::{json, Value};
use std::collections::HashMap;

use crate::app::DataView;
use crate::domain::messages;
use crate::domain::operator::{character_table, name_to_char_id, resolve_char_id};
use crate::storage::{DirectoryStore, JsonStore};
use crate::text::numbers::{is_js_integer, js_number_to_string, js_to_fixed, round_half_away};
use crate::text::sanitizer::strip_wikitext;

const SKILL_TYPE_ZH: &[(&str, &str)] = &[("MANUAL", "手动"), ("AUTO", "自动"), ("PASSIVE", "被动")];

const SP_TYPE_ZH: &[(&str, &str)] = &[
    ("INCREASE_WITH_TIME", "自动回复"),
    ("INCREASE_WHEN_ATTACK", "攻击回复"),
    ("INCREASE_WHEN_TAKEN_DAMAGE", "受击回复"),
];

/// Whether skill_table.json exists in the effective excel store.
pub fn has_skill_data(view: &DataView) -> bool {
    view.excel_root
        .as_ref()
        .map(DirectoryStore::new)
        .is_some_and(|store| store.exists("skill_table.json").unwrap_or(false))
}

fn skill_table(view: &DataView) -> Result<Arc<SkillTable>, String> {
    let Some(root) = view.excel_root.clone() else {
        return Err("__missing__战斗技能".to_string());
    };
    let store = DirectoryStore::new(&root);
    view.datasets.get_or_load_counted("skill:skill_table", move || {
        if !store.exists("skill_table.json").unwrap_or(false) {
            let shown = store
                .resolve("skill_table.json")
                .map(|p| p.display().to_string())
                .unwrap_or_else(|_| "skill_table.json".to_string());
            return Err(format!(
                "战斗技能数据文件不存在：{shown}。数据目录可能为空，或挂载路径有误（GAMEDATA_PATH 应指向游戏数据根目录）。"
            ));
        }
        store.read_json_as::<SkillTable>("skill_table.json").map_err(|e| e.to_string())
    }, |table| table.len() as u64)
}

// ---------------------------------------------------------------------------
// Blackboard placeholder rendering
// ---------------------------------------------------------------------------

/// Placeholder value formats: "", "0", "0.0", "0%", "0.0%" (the closed set
/// observed across all 1795 skill_table entries as of the 2.8.0 scan).
fn known_format(fmt: &str) -> bool {
    fmt == "0" || fmt == "0.0" || fmt == "0%" || fmt == "0.0%" || fmt.is_empty()
}

pub fn format_placeholder_value(value: f64, fmt: &str) -> Option<String> {
    if fmt.is_empty() {
        if is_js_integer(value) {
            return Some(js_number_to_string(value));
        }
        // value.toFixed(6) with trailing zeros / trailing dot stripped.
        let fixed = js_to_fixed(value, 6);
        let trimmed = fixed.trim_end_matches('0');
        let trimmed = trimmed.strip_suffix('.').unwrap_or(trimmed);
        return Some(trimmed.to_string());
    }
    if !known_format(fmt) {
        return None;
    }
    let mut v = value;
    let mut fmt_owned = fmt.to_string();
    let percent = fmt_owned.ends_with('%');
    if percent {
        fmt_owned.pop();
        v *= 100.0;
    }
    let decimals = fmt_owned.split_once('.').map(|(_, d)| d.len()).unwrap_or(0);
    let rendered = js_to_fixed(round_half_away(v, decimals as i32), decimals);
    Some(if percent {
        format!("{rendered}%")
    } else {
        rendered
    })
}

/// Scan the description for `{key}` / `{key:fmt}` tokens; non-ASCII keys and
/// colons inside keys follow the TS regex `[^{}:]+` and `[^{}]*`.
fn render_skill_description(
    description: &str,
    values: &HashMap<String, BlackboardValue>,
) -> String {
    let chars: Vec<char> = description.chars().collect();
    let mut out = String::with_capacity(description.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] != '{' {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        // Try `{key}` or `{key:fmt}`; key = [^{}:]+, fmt = [^{}]*.
        let Some(close) = find_close(&chars, i + 1) else {
            out.push(chars[i]);
            i += 1;
            continue;
        };
        let inner: String = chars[i + 1..close].iter().collect();
        let rendered = match inner.split_once(':') {
            Some((key, fmt)) => substitute(values, key, Some(fmt)),
            None => substitute(values, &inner, None),
        };
        match rendered {
            Some(text) => {
                out.push_str(&text);
                i = close + 1;
            }
            None => {
                out.push(chars[i]);
                i += 1;
            }
        }
    }
    strip_wikitext(&out)
}

/// The '}' closing a placeholder: no '{' may appear inside (per `[^{}:]` key
/// and `[^{}]*` fmt classes), so the first '}' after `from` closes — unless
/// a '{' appears first, which invalidates the token.
fn find_close(chars: &[char], from: usize) -> Option<usize> {
    (from..chars.len())
        .find(|&j| chars[j] == '}' || chars[j] == '{')
        .filter(|&j| chars[j] == '}')
}

fn substitute(
    values: &HashMap<String, BlackboardValue>,
    key: &str,
    fmt: Option<&str>,
) -> Option<String> {
    let fmt = fmt.unwrap_or("");
    let (negated, lookup_key) = key
        .strip_prefix('-')
        .map_or((false, key), |rest| (true, rest));
    match values.get(lookup_key)? {
        BlackboardValue::Text(s) if !negated => Some(s.clone()),
        BlackboardValue::Number(value) => {
            format_placeholder_value(if negated { -*value } else { *value }, fmt)
        }
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Per-operator payload (get_operator_basic_info action=skills)
// ---------------------------------------------------------------------------

fn zh_or_raw(table: &[(&str, &str)], raw: &str) -> String {
    table
        .iter()
        .find(|(k, _)| *k == raw)
        .map(|(_, v)| v.to_string())
        .unwrap_or_else(|| raw.to_string())
}

fn skill_levels(entries: &[SkillLevel]) -> Vec<Value> {
    entries
        .iter()
        .map(|level| {
            json!({
                "level":level.level,
                "name":level.name,
                "skill_type":zh_or_raw(SKILL_TYPE_ZH,&level.skill_type),
                "skill_type_raw":level.skill_type,
                "sp_type":zh_or_raw(SP_TYPE_ZH,&level.sp_type),
                "sp_cost":level.sp_cost,
                "init_sp":level.init_sp,
                "max_charge_time":level.max_charge_time,
                "duration":level.duration,
                "duration_type":level.duration_type,
                "description":render_skill_description(&level.description,&level.blackboard),
            })
        })
        .collect()
}

/// The character_table ↔ skill_table join: null refs, dangling ids and empty
/// level lists skip here.
fn skill_entries<'a>(
    info: &'a Value,
    table: &'a SkillTable,
) -> impl Iterator<Item = (&'a str, &'a [SkillLevel])> {
    info.get("skills")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .filter_map(|entry| {
            let id = entry.get("skillId").and_then(Value::as_str)?;
            let levels = table.get(id)?;
            (!levels.is_empty()).then_some((id, levels))
        })
}

/// Top level's name, falling back to Lv1.
fn top_level(levels: &[Value]) -> &Value {
    levels.last().expect("collect keeps non-empty lists")
}

fn skill_display_name(levels: &[SkillLevel]) -> &str {
    let top = &levels.last().expect("non-empty skill levels").name;
    if top.is_empty() {
        &levels[0].name
    } else {
        top
    }
}

/// `buildOperatorSkills`: Err carries the exact message text.
pub fn build_operator_skills(
    view: &DataView,
    excel_path: &Path,
    name: &str,
) -> Result<Value, String> {
    if view.excel_root.is_none() {
        return Err(messages::excel_missing_message("战斗技能", excel_path));
    }
    let char_id = resolve_char_id(view, name)?;
    let table = skill_table(view)?;
    let ct = character_table(view)?;
    let Some(char_id) = char_id else {
        return Err(format!(
            "未找到干员 '{name}'。请使用游戏内中文名称（如'阿米娅'）。"
        ));
    };
    let info = ct
        .as_object()
        .and_then(|m| m.get(&char_id))
        .unwrap_or(&Value::Null);
    if !table.is_object() {
        return Err("skill_table.json 顶层不是 JSON 对象。".to_string());
    }
    let skills: Vec<Value> = skill_entries(info, &table)
        .map(|(skill_id, levels)| {
            json!({
                "skill_id": skill_id,
                "name": skill_display_name(levels),
                "levels": skill_levels(levels),
            })
        })
        .collect();
    if skills.is_empty() {
        return Err(format!("干员 '{name}' 暂无战斗技能数据。"));
    }
    Ok(json!({
        "name": name,
        "char_id": char_id,
        "skills": skills,
    }))
}

fn level_label(level: i64) -> String {
    match level {
        8 => "专一".to_string(),
        9 => "专二".to_string(),
        10 => "专三".to_string(),
        n => format!("Lv{n}"),
    }
}

fn plain_number(value: f64) -> String {
    format_placeholder_value(value, "").unwrap_or_else(|| js_number_to_string(value))
}

fn level_suffix(level: &Value) -> String {
    let mut parts: Vec<String> = Vec::new();
    let skill_type_raw = level["skill_type_raw"].as_str().unwrap_or("");
    let sp_cost = level["sp_cost"].clone();
    if skill_type_raw != "PASSIVE" && !sp_cost.is_null() {
        // TS `SP ${level.sp_cost}` — JS template semantics on the payload
        // value (numbers without .0, strings verbatim).
        parts.push(format!(
            "SP {}",
            match &sp_cost {
                Value::String(s) => s.clone(),
                v => js_number_to_string(v.as_f64().unwrap_or(f64::NAN)),
            }
        ));
        if let Some(init_sp) = level["init_sp"].as_f64() {
            if init_sp != 0.0 {
                parts.push(format!("初始 {}", js_number_to_string(init_sp)));
            }
        }
        if let Some(max_charge) = level["max_charge_time"].as_f64() {
            if max_charge > 1.0 {
                parts.push(format!("可充能 {} 次", plain_number(max_charge)));
            }
        }
    }
    // -1 is the "no duration" sentinel; only positive durations render.
    if let Some(duration) = level["duration"].as_f64() {
        if duration > 0.0 {
            if level["duration_type"].as_str() == Some("AMMO") {
                parts.push(format!("弹药 {} 发", plain_number(duration)));
            } else {
                parts.push(format!("持续 {} 秒", plain_number(duration)));
            }
        }
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!("（{}）", parts.join("，"))
    }
}

pub fn render_operator_skills(data: &Value) -> String {
    let mut lines = vec![format!(
        "# {} - 战斗技能",
        data["name"].as_str().unwrap_or("")
    )];
    for skill in data["skills"].as_array().map(Vec::as_slice).unwrap_or(&[]) {
        let levels = skill["levels"].as_array().map(Vec::as_slice).unwrap_or(&[]);
        let top = top_level(levels);
        let mut heading = skill["name"].as_str().unwrap_or("").to_string();
        let skill_type = top["skill_type"].as_str().unwrap_or("");
        if !skill_type.is_empty() {
            heading += &format!("（{skill_type}");
            let sp_type = top["sp_type"].as_str().unwrap_or("");
            if !sp_type.is_empty() {
                heading += &format!("，{sp_type}");
            }
            heading += "）";
        }
        lines.push(format!("\n## {heading}"));
        for level in levels {
            lines.push(format!(
                "- **{}**：{}{}",
                level_label(level["level"].as_i64().unwrap_or(0)),
                level["description"].as_str().unwrap_or(""),
                level_suffix(level)
            ));
        }
    }
    lines.join("\n")
}

// ---------------------------------------------------------------------------
// Cross-operator search (search tool's skills scope)
// ---------------------------------------------------------------------------

fn skill_search_records(view: &DataView) -> Result<Arc<Vec<Value>>, String> {
    view.datasets.get_or_load_counted(
        "skill:skill_search_records",
        || {
            if !has_skill_data(view) {
                // Older data roots may lack skill_table.json: the scope then
                // reports no matches rather than a data error.
                return Ok(Vec::new());
            }
            let table = skill_table(view)?;
            if !table.is_object() {
                return Err("skill_table.json 顶层不是 JSON 对象".to_string());
            }
            let ct = character_table(view)?;
            let mut records = Vec::new();
            for (op_name, char_id) in name_to_char_id(view)?.iter() {
                let info = ct
                    .as_object()
                    .and_then(|m| m.get(char_id))
                    .unwrap_or(&Value::Null);
                for (_skill_id, levels) in skill_entries(info, &table) {
                    let mut descriptions: Vec<String> = levels
                        .iter()
                        .map(|level| {
                            render_skill_description(&level.description, &level.blackboard)
                        })
                        .collect();
                    let haystack = levels
                        .iter()
                        .zip(&descriptions)
                        .map(|(level, description)| format!("{} {}", level.name, description))
                        .collect::<Vec<_>>()
                        .join(" ");
                    let top_description = descriptions.pop().expect("non-empty skill levels");
                    records.push(json!({
                        "operator": op_name,
                        "skill": skill_display_name(levels),
                        "text": top_description,
                        "haystack": haystack,
                    }));
                }
            }
            Ok(records)
        },
        |records| records.len() as u64,
    )
}

/// `buildSkillSearch`: Err carries the exact message text.
pub fn build_skill_search(
    view: &DataView,
    excel_path: &Path,
    pattern: &str,
    max_results: i64,
) -> Result<Value, String> {
    if let Some(err) = messages::validate_bounds("max_results", max_results, Some(1), Some(100)) {
        return Err(err);
    }
    if view.excel_root.is_none() {
        return Err(messages::excel_missing_message("战斗技能", excel_path));
    }
    let regex = crate::text::regex_compat::JsRegex::compile(pattern)
        .map_err(|e| messages::regex_error_message(&e))?;
    let records = skill_search_records(view)?;
    let mut results = Vec::new();
    for record in records.iter() {
        if regex.is_match(record["haystack"].as_str().unwrap_or(""))? {
            results.push(json!({
                "operator": record["operator"].clone(),
                "skill": record["skill"].clone(),
                "text": record["text"].clone(),
            }));
            if results.len() as i64 >= max_results {
                break;
            }
        }
    }
    let total = results.len();
    Ok(json!({
        "scope": "skills",
        "pattern": pattern,
        "total": total,
        "results": results,
    }))
}

pub fn render_skill_search(data: &Value) -> String {
    let pattern = data["pattern"].as_str().unwrap_or("");
    let results = data["results"].as_array().cloned().unwrap_or_default();
    if results.is_empty() {
        return format!("未找到匹配 '{pattern}' 的干员战斗技能。");
    }
    let mut lines = vec![format!(
        "# 搜索 \"{}\" 的结果（共 {} 条）",
        pattern,
        data["total"].as_i64().unwrap_or(0)
    )];
    for r in &results {
        lines.push(format!(
            "- **{}**｜{}：{}",
            r["operator"].as_str().unwrap_or(""),
            r["skill"].as_str().unwrap_or(""),
            r["text"].as_str().unwrap_or("")
        ));
    }
    lines.join("\n")
}

#[cfg(test)]
mod compact_tests {
    use super::*;

    #[test]
    fn compact_levels_preserve_coercions_indices_and_blackboard_precedence() {
        let table = SkillTable::from_json(json!({"s":{"levels":[null, {
            "name":5,"skillType":false,"durationType":{},
            "duration":{"raw":true},
            "spData":{"spType":8,"spCost":"30","initSp":false,"maxChargeTime":null},
            "description":"{atk:0%} {-atk} {text} {-text} {bad} {duplicate} {badstr}",
            "blackboard":[
                {"key":"atk","value":1.5}, {"key":"text","valueStr":"word","value":3},
                {"key":"bad","value":"2"}, {"key":"duplicate","value":1},
                {"key":"duplicate","value":2}, {"key":"badstr","valueStr":false,"value":3}
            ]
        }]},"invalid":false}));
        assert!(table.is_object());
        assert_eq!(table.len(), 2);
        assert!(table.get("invalid").unwrap().is_empty());
        assert_eq!(
            skill_levels(table.get("s").unwrap()),
            vec![json!({
                "level":2,"name":"","skill_type":"","skill_type_raw":"","sp_type":"",
                "sp_cost":"30","init_sp":false,"max_charge_time":null,"duration":{"raw":true},
                "duration_type":"","description":"150% -1.5 word {-text} {bad} 2 {badstr}"
            })]
        );
        for raw in [json!(null), json!([]), json!(42)] {
            let invalid = SkillTable::from_json(raw);
            assert!(!invalid.is_object());
            assert_eq!(invalid.len(), 0);
        }
    }

    #[test]
    fn streamed_skills_keep_duplicate_keys_and_validate_discarded_fields() {
        let table: SkillTable = serde_json::from_str(r#"{"s":{"levels":[{"name":"old"}]},"s":{"levels":[{"name":"replaced"}],"levels":[false,{"name":"last"}]}}"#).unwrap();
        let levels = skill_levels(table.get("s").unwrap());
        assert_eq!(levels[0]["level"], 2);
        assert_eq!(levels[0]["name"], "last");
        let invalid: SkillTable =
            serde_json::from_str(r#"{"s":{"levels":[{}],"levels":{}}}"#).unwrap();
        assert!(invalid.get("s").unwrap().is_empty());
        for raw in [
            r#"{"s":{"unused":1e999}}"#,
            r#"[1e999]"#,
            r#"{"s":{"levels":{"ignored":1e999}}}"#,
            r#"{"s":[]} trailing"#,
        ] {
            assert!(serde_json::from_str::<SkillTable>(raw).is_err(), "{raw}");
        }
    }
}
