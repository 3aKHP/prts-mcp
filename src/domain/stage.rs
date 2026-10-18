//! Stage domain — port of TS `data/stage.ts`.
//!
//! stage_table / zone_table load through the per-generation dataset cache;
//! list_stages keeps the P1 port's exact filtering/rendering, now joined by
//! get_stage_info and the stages search records.

use std::path::Path;
use std::sync::Arc;

use serde_json::{json, Map, Value};

use crate::app::DataView;
use crate::domain::messages;
use crate::storage::projection::Projection;
use crate::storage::JsonStore;
use crate::text::js_compat::compare_ids;
use crate::tools::output::ToolOutcome;

const STAGE_FILE: &str = "stage_table.json";
const ZONE_FILE: &str = "zone_table.json";

// All fields consumed by stage tools and stage_enemy; drop/unlock payloads
// remain complete Values because they are returned in structured output.
const STAGE_ENTRY: Projection = Projection::Fields(&[
    ("stageId", Projection::All),
    ("name", Projection::All),
    ("code", Projection::All),
    ("stageType", Projection::All),
    ("difficulty", Projection::All),
    ("zoneId", Projection::All),
    ("apCost", Projection::All),
    ("dangerLevel", Projection::All),
    ("bossMark", Projection::All),
    ("description", Projection::All),
    ("stageDropInfo", Projection::All),
    ("unlockCondition", Projection::All),
    ("hardStagedId", Projection::All),
    ("sixStarStageId", Projection::All),
    ("levelId", Projection::All),
]);

fn stage_type_label(t: &str) -> String {
    match t {
        "MAIN" => "主线".to_string(),
        "ACTIVITY" => "活动".to_string(),
        "SUB" => "支线".to_string(),
        "DAILY" => "每日".to_string(),
        "CAMPAIGN" => "剿灭".to_string(),
        "CLIMB_TOWER" => "爬塔".to_string(),
        "SPECIAL_STORY" => "特殊故事".to_string(),
        "GUIDE" => "教程".to_string(),
        other => other.to_string(),
    }
}

fn difficulty_label(d: &str) -> String {
    match d {
        "NORMAL" => "普通".to_string(),
        "FOUR_STAR" => "突袭".to_string(),
        "SIX_STAR" => "六星".to_string(),
        other => other.to_string(),
    }
}

const STAGE_TYPE_KEYS: [&str; 8] = [
    "MAIN",
    "ACTIVITY",
    "SUB",
    "DAILY",
    "CAMPAIGN",
    "CLIMB_TOWER",
    "SPECIAL_STORY",
    "GUIDE",
];

/// JS `.toUpperCase()` for the narrow input this tool validates (ASCII enum
/// keys); non-ASCII spellings fall through to the invalid-type message.
fn js_to_upper_ascii(s: &str) -> String {
    s.chars().map(|c| c.to_ascii_uppercase()).collect()
}

fn get_str<'a>(entry: &'a Value, key: &str) -> Option<&'a str> {
    entry.get(key).and_then(|v| v.as_str())
}

// ---------------------------------------------------------------------------
// Cached table access
// ---------------------------------------------------------------------------

fn has_stage_data(view: &DataView) -> bool {
    view.excel_store()
        .is_some_and(|store| store.exists(STAGE_FILE).unwrap_or(false))
}

/// The stage mapping (`getStageTable`); Err carries the TS loader
/// wording (`关卡数据文件不存在：stage_table.json` / `stage_table.json 格式异常`).
pub fn stage_table(view: &DataView) -> Result<Arc<Map<String, Value>>, String> {
    let Some(store) = view.excel_store() else {
        return Err(format!("关卡数据文件不存在：{STAGE_FILE}"));
    };
    view.datasets.get_or_load_counted(
        "stage:stage_table",
        move || {
            if !store.exists(STAGE_FILE).unwrap_or(false) {
                return Err(format!("关卡数据文件不存在：{STAGE_FILE}"));
            }
            let mut raw = store
                .read_json_projected(
                    STAGE_FILE,
                    Projection::Fields(&[("stages", Projection::Values(&STAGE_ENTRY))]),
                )
                .map_err(|_| format!("{STAGE_FILE} 格式异常"))?;
            if !raw.pointer("/stages").is_some_and(Value::is_object) {
                return Err(format!("{STAGE_FILE} 格式异常"));
            }
            // Move the required subtree out before dropping unused root fields.
            // JS returns raw.stages by reference; cloning a Value duplicates it.
            let Value::Object(stages) = raw["stages"].take() else {
                unreachable!("validated stages object")
            };
            Ok(stages)
        },
        |stages| stages.len() as u64,
    )
}

/// Shared alias of the table, retaining the existing cache diagnostics slot.
pub fn stages_map(view: &DataView) -> Result<Arc<Map<String, Value>>, String> {
    let shared = view.datasets.get_or_load_counted(
        "stage:stages_map",
        || stage_table(view),
        |stages| stages.len() as u64,
    )?;
    Ok(Arc::clone(&shared))
}

/// zone table, or None when absent/malformed (loaded-null contract).
fn zone_table(view: &DataView) -> Result<Arc<Option<Map<String, Value>>>, String> {
    let cached = view.datasets.get_or_load_counted(
        "stage:zone_table",
        || {
            let Some(store) = view.excel_store() else {
                return Ok(None);
            };
            if !store.exists(ZONE_FILE).unwrap_or(false) {
                return Ok(None);
            }
            // Malformed zone JSON is a loaded-null, not an error.
            let zones = store.read_json(ZONE_FILE).ok().and_then(|mut raw| {
                match raw.get_mut("zones").map(Value::take) {
                    Some(Value::Object(zones)) => Some(zones),
                    _ => None,
                }
            });
            Ok(zones)
        },
        |z| z.as_ref().map(|m| m.len() as u64).unwrap_or(0),
    )?;
    // TS loaded-null contract: a cached None is NOT "loaded" for the debug
    // projection (datasetAccess snapshotLoaded).
    if cached.is_none() {
        crate::diagnostics::record_loaded_absent("stage:zone_table");
    }
    Ok(cached)
}

fn zone_display(zone_id: &str, zones: Option<&Map<String, Value>>) -> String {
    let Some(z) = zones.and_then(|z| z.get(zone_id)) else {
        return zone_id.to_string();
    };
    let first = get_str(z, "zoneNameFirst").unwrap_or("");
    let second = get_str(z, "zoneNameSecond").unwrap_or("");
    if !first.is_empty() && !second.is_empty() {
        format!("{first}-{second}")
    } else if !first.is_empty() {
        first.to_string()
    } else {
        zone_id.to_string()
    }
}

// ---------------------------------------------------------------------------
// list_stages (P1 port, now over the cached tables)
// ---------------------------------------------------------------------------

pub struct ListingArgs {
    pub chapter: Option<String>,
    pub stage_type: Option<String>,
    pub limit: i64,
    pub offset: i64,
}

/// `buildStagesListing` + `renderStagesListing` in one: either the wrapped
/// outcome (payload + Markdown) or a plain error/narrative text result.
pub fn list_stages(view: &DataView, excel_path: &Path, args: &ListingArgs) -> ToolOutcome {
    let missing_message = messages::excel_missing_message("关卡", excel_path);
    // Bounds first (validateBounds), then the type whitelist — same order as
    // the TS function so error precedence matches.
    if args.limit < 1 {
        return ToolOutcome::text("limit 必须 >= 1。");
    }
    if args.limit > 200 {
        return ToolOutcome::text("limit 必须 <= 200。");
    }
    if args.offset < 0 {
        return ToolOutcome::text("offset 必须 >= 0。");
    }
    let type_filter = args.stage_type.as_deref().map(js_to_upper_ascii);
    if let Some(t) = &type_filter {
        if !STAGE_TYPE_KEYS.contains(&t.as_str()) {
            return ToolOutcome::text(format!(
                "无效的 type：{}。可选值：{}。",
                serde_json::to_string(t).unwrap_or_default(),
                STAGE_TYPE_KEYS.join("、")
            ));
        }
    }

    let stages = match stages_map(view) {
        Ok(m) => m,
        Err(message) => {
            return ToolOutcome::text(format!("{missing_message}（{message}）"));
        }
    };
    let zones = zone_table(view).ok();
    let zones = zones.as_deref().and_then(Option::as_ref);

    // Object.entries insertion order, then compareIds (UTF-16) ordering.
    let mut entries: Vec<(&String, &Value)> = stages.iter().collect();
    entries.sort_by(|a, b| compare_ids(a.0, b.0));

    let filtered: Vec<(&String, &Value)> = entries
        .into_iter()
        .filter(|(_, entry)| {
            if let Some(chapter) = &args.chapter {
                if get_str(entry, "zoneId") != Some(chapter.as_str()) {
                    return false;
                }
            }
            if let Some(t) = &type_filter {
                if get_str(entry, "stageType") != Some(t.as_str()) {
                    return false;
                }
            }
            true
        })
        .collect();

    let total = filtered.len();
    // JS Array.slice(offset, offset + limit): indices clamp to [0, len].
    let start = (args.offset.max(0) as usize).min(total);
    let end = (args.offset + args.limit).max(0).clamp(0, total as i64) as usize;
    let page = &filtered[start..end];

    let mut stage_rows = Vec::new();
    for (_id, e) in page {
        let type_raw = get_str(e, "stageType").unwrap_or("");
        let zone_id = get_str(e, "zoneId").unwrap_or("");
        let name = match get_str(e, "name") {
            Some(n) if !n.is_empty() => n.to_string(),
            _ => "（无名）".to_string(),
        };
        let code = match get_str(e, "code") {
            Some(c) if !c.is_empty() => c.to_string(),
            _ => "?".to_string(),
        };
        stage_rows.push(json!({
            "stage_id": get_str(e, "stageId").unwrap_or(""),
            "name": name,
            "code": code,
            "type": type_raw,
            "type_label": stage_type_label(type_raw),
            "difficulty_label": difficulty_label(get_str(e, "difficulty").unwrap_or("")),
            "zone_id": zone_id,
            "zone_display": zone_display(zone_id, zones),
        }));
    }

    let mut payload = Map::new();
    payload.insert("total".into(), json!(total));
    payload.insert("offset".into(), json!(args.offset));
    payload.insert("limit".into(), json!(args.limit));
    let mut filters = Map::new();
    filters.insert(
        "chapter".into(),
        args.chapter
            .clone()
            .map(|v| Value::String(v.to_string()))
            .unwrap_or(Value::Null),
    );
    filters.insert(
        "type".into(),
        type_filter
            .as_deref()
            .filter(|t| !t.is_empty())
            .map(|t| Value::String(t.to_string()))
            .unwrap_or(Value::Null),
    );
    payload.insert("filters".into(), Value::Object(filters));
    payload.insert("stages".into(), Value::Array(stage_rows));

    let markdown = render_listing(
        total,
        args.offset,
        args.limit,
        &args.chapter.clone().unwrap_or_default(),
        type_filter.as_deref().unwrap_or_default(),
        &payload["stages"],
    );
    ToolOutcome::structured(markdown, Value::Object(payload))
}

fn render_listing(
    total: usize,
    offset: i64,
    limit: i64,
    chapter: &str,
    type_filter: &str,
    stages: &Value,
) -> String {
    let rows = stages.as_array().map(|a| a.as_slice()).unwrap_or(&[]);
    if rows.is_empty() {
        if total == 0 {
            let mut filters = Vec::new();
            if !chapter.is_empty() {
                filters.push(format!("zoneId={chapter}"));
            }
            if !type_filter.is_empty() {
                filters.push(format!("stageType={type_filter}"));
            }
            let joined = if filters.is_empty() {
                "none".to_string()
            } else {
                filters.join(", ")
            };
            return format!("没有匹配的关卡（filter: {joined}）。");
        }
        return format!("offset {offset} 超出范围（共 {total} 条）。");
    }

    let mut lines = vec![format!("# 关卡列表（共 {total} 个）")];
    for s in rows {
        lines.push(format!(
            "- **{}** [{}] {} — {} — {}（id: {}）",
            s["name"].as_str().unwrap_or("（无名）"),
            s["type_label"].as_str().unwrap_or(""),
            s["code"].as_str().unwrap_or("?"),
            s["difficulty_label"].as_str().unwrap_or(""),
            s["zone_display"].as_str().unwrap_or(""),
            s["stage_id"].as_str().unwrap_or(""),
        ));
    }
    let start = offset + 1;
    let end = (offset + limit).min(total as i64);
    lines.push(format!(
        "\n（显示第 {start}–{end} 条，共 {total} 条。使用 offset={} 查看下一页）",
        offset + limit
    ));
    lines.join("\n")
}

// ---------------------------------------------------------------------------
// get_stage_info
// ---------------------------------------------------------------------------

/// `buildStageInfo`: Err carries the exact message text.
pub fn build_stage_info(
    view: &DataView,
    excel_path: &Path,
    stage_id: &str,
) -> Result<Value, String> {
    let stages = match stages_map(view) {
        Ok(s) => s,
        Err(message) => {
            return Err(format!(
                "{}（{message}）",
                messages::excel_missing_message("关卡", excel_path)
            ));
        }
    };
    let Some(entry) = stages.get(stage_id) else {
        return Err(format!(
            "未找到关卡：{}。",
            serde_json::to_string(stage_id).unwrap_or_default()
        ));
    };

    let name = match get_str(entry, "name") {
        Some(n) if !n.is_empty() => n.to_string(),
        _ => "（无名）".to_string(),
    };
    let code = match get_str(entry, "code") {
        Some(c) if !c.is_empty() => c.to_string(),
        _ => "?".to_string(),
    };
    let type_raw = get_str(entry, "stageType").unwrap_or("");
    let difficulty_raw = get_str(entry, "difficulty").unwrap_or("");
    let zone_id = get_str(entry, "zoneId").unwrap_or("");
    let zones = zone_table(view).ok();
    let zones = zones.as_deref().and_then(Option::as_ref);
    let zd = zone_display(zone_id, zones);
    let ap = entry
        .get("apCost")
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or(json!("?"));
    let danger = get_str(entry, "dangerLevel")
        .filter(|s| !s.is_empty())
        .unwrap_or("?");
    let boss = entry.get("bossMark") == Some(&Value::Bool(true));
    let raw_desc = get_str(entry, "description").unwrap_or("");
    let desc = clean_description(raw_desc);
    let desc = if desc.is_empty() {
        "（无描述）".to_string()
    } else {
        desc
    };
    let drops = entry
        .get("stageDropInfo")
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or(Value::Null);
    let unlocks = entry
        .get("unlockCondition")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let hard_id = get_str(entry, "hardStagedId").filter(|s| !s.is_empty());
    let level_id = get_str(entry, "levelId").filter(|s| !s.is_empty());
    let six_star_id = get_str(entry, "sixStarStageId").filter(|s| !s.is_empty());
    let stage_name_of = |id: &str| -> Value {
        stages
            .get(id)
            .and_then(|e| get_str(e, "name"))
            .map(|v| Value::String(v.to_string()))
            .unwrap_or(Value::Null)
    };

    Ok(json!({
        "stage_id": stage_id,
        "name": name,
        "code": code,
        "type_raw": type_raw,
        "type_label": stage_type_label(type_raw),
        "difficulty_raw": difficulty_raw,
        "difficulty_label": difficulty_label(difficulty_raw),
        "zone_id": zone_id,
        "zone_display": zd,
        "ap_cost": ap,
        "danger_level": danger,
        "boss_mark": boss,
        "description": desc,
        "drop_info": drops,
        "unlock_conditions": unlocks,
        "level_id": level_id.map(|v| Value::String(v.to_string())).unwrap_or(Value::Null),
        "hard_stage": {
            "id": hard_id.map(|v| Value::String(v.to_string())).unwrap_or(Value::Null),
            "name": hard_id.map(&stage_name_of).unwrap_or(Value::Null),
        },
        "six_star_stage": {
            "id": six_star_id.map(|v| Value::String(v.to_string())).unwrap_or(Value::Null),
            "name": six_star_id.map(stage_name_of).unwrap_or(Value::Null),
        },
    }))
}

fn clean_description(desc: &str) -> String {
    if desc.is_empty() {
        return String::new();
    }
    crate::text::sanitizer::strip_html_tags(desc)
        .trim()
        .to_string()
}

fn format_unlock(conditions: &Value) -> String {
    let Some(list) = conditions.as_array() else {
        return "（无条件）".to_string();
    };
    if list.is_empty() {
        return "（无条件）".to_string();
    }
    let parts: Vec<String> = list
        .iter()
        .map(|c| {
            let sid = c.get("stageId").and_then(Value::as_str).unwrap_or("");
            match c.get("completeState").and_then(Value::as_str) {
                Some("PASS") => format!("通关 {sid}"),
                Some("STAR_3") => format!("三星通关 {sid}"),
                Some(other) => format!("{other} {sid}"),
                None => format!(" {sid}"),
            }
        })
        .collect();
    parts.join("；")
}

fn format_drops(view: &DataView, drop_info: &Value) -> String {
    if drop_info.is_null() {
        return "（无）".to_string();
    }
    let display = drop_info
        .get("displayRewards")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if display.is_empty() {
        return "（无）".to_string();
    }
    let parts: Vec<String> = display
        .iter()
        .map(|d| {
            let item_id = d.get("id").and_then(Value::as_str).unwrap_or("");
            let item_name = if item_id.is_empty() {
                None
            } else {
                crate::domain::item::get_item_name_by_id(view, item_id)
            };
            // String(itemName ?? d.type ?? d.dropType ?? itemId ?? "?"):
            // itemId is already ""-coerced, so "?" is dead code and an empty
            // id with no type/dropType renders an empty name.
            let mut name = match (&item_name, d.get("type"), d.get("dropType")) {
                (Some(n), _, _) => n.clone(),
                (None, Some(t), _) => crate::text::numbers::json_value_to_string(t),
                (None, None, Some(dt)) => crate::text::numbers::json_value_to_string(dt),
                (None, None, None) => item_id.to_string(),
            };
            if !item_id.is_empty() && (item_name.is_some() || name != item_id) {
                name = format!("{name}（{item_id}）");
            }
            let count = d.get("count").and_then(Value::as_i64).unwrap_or(1);
            let drop_type = d
                .get("dropType")
                .and_then(Value::as_str)
                .map(|dt| format!(" [{dt}]"))
                .unwrap_or_default();
            format!("- {name} ×{count}{drop_type}")
        })
        .collect();
    if parts.is_empty() {
        "（无）".to_string()
    } else {
        parts.join("\n")
    }
}

pub fn render_stage_info(view: &DataView, data: &Value) -> String {
    let mut parts = vec![
        format!("# {} — 关卡详情", data["name"].as_str().unwrap_or("")),
        String::new(),
        "## 基本信息".to_string(),
    ];
    parts.push(format!(
        "- **ID**：{}",
        data["stage_id"].as_str().unwrap_or("")
    ));
    parts.push(format!(
        "- **编号**：{}",
        data["code"].as_str().unwrap_or("")
    ));
    parts.push(format!(
        "- **类型**：{}",
        data["type_label"].as_str().unwrap_or("")
    ));
    parts.push(format!(
        "- **难度**：{}",
        data["difficulty_label"].as_str().unwrap_or("")
    ));
    parts.push(format!(
        "- **所属区域**：{}",
        data["zone_display"].as_str().unwrap_or("")
    ));
    parts.push(format!(
        "- **理智消耗**：{}",
        crate::text::numbers::json_value_to_string(&data["ap_cost"])
    ));
    parts.push(format!(
        "- **危险等级**：{}",
        data["danger_level"].as_str().unwrap_or("")
    ));
    if data["boss_mark"].as_bool().unwrap_or(false) {
        parts.push("- **BOSS标记**：是".to_string());
    }
    if let Some(level_id) = data["level_id"].as_str() {
        parts.push(format!("- **关卡数据**：{level_id}"));
    }

    parts.push(String::new());
    parts.push("## 描述".to_string());
    parts.push(data["description"].as_str().unwrap_or("").to_string());
    parts.push(String::new());
    parts.push("## 掉落信息".to_string());
    parts.push(format_drops(view, &data["drop_info"]));
    parts.push(String::new());
    parts.push("## 解锁条件".to_string());
    parts.push(format_unlock(&data["unlock_conditions"]));

    parts.push(String::new());
    parts.push("## 关联关卡".to_string());
    let hard_id = data
        .pointer("/hard_stage/id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    if let Some(hard_id) = hard_id {
        let name = data
            .pointer("/hard_stage/name")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty());
        parts.push(format!(
            "- 突袭模式：{hard_id}{}",
            name.map(|n| format!("（{n}）")).unwrap_or_default()
        ));
    } else {
        parts.push("- 突袭模式：无".to_string());
    }
    let six_id = data
        .pointer("/six_star_stage/id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    if let Some(six_id) = six_id {
        let name = data
            .pointer("/six_star_stage/name")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty());
        parts.push(format!(
            "- 六星模式：{six_id}{}",
            name.map(|n| format!("（{n}）")).unwrap_or_default()
        ));
    }

    parts.join("\n")
}

// ---------------------------------------------------------------------------
// search scope=stages
// ---------------------------------------------------------------------------

struct StageSearchRecord {
    stage_id: String,
    search_text: String,
}

fn stage_search_records(view: &DataView) -> Result<Arc<Vec<StageSearchRecord>>, String> {
    view.datasets.get_or_load_counted(
        "stage:stage_search_records",
        || {
            let stages = stages_map(view)?;
            let mut entries: Vec<(&String, &Value)> = stages.iter().collect();
            entries.sort_by(|a, b| compare_ids(a.0, b.0));
            Ok(entries
                .into_iter()
                .map(|(stage_id, entry)| StageSearchRecord {
                    stage_id: stage_id.clone(),
                    search_text: [
                        get_str(entry, "name").unwrap_or(""),
                        get_str(entry, "code").unwrap_or(""),
                        &clean_description(get_str(entry, "description").unwrap_or("")),
                        get_str(entry, "stageType").unwrap_or(""),
                        stage_id,
                    ]
                    .join(" "),
                })
                .collect())
        },
        |records: &Vec<StageSearchRecord>| records.len() as u64,
    )
}

/// `buildStageSearch`: Err carries the exact message text.
pub fn build_stage_search(
    view: &DataView,
    excel_path: &Path,
    pattern: &str,
    max_results: i64,
) -> Result<Value, String> {
    if let Some(err) = messages::validate_bounds("max_results", max_results, Some(1), Some(100)) {
        return Err(err);
    }
    let regex = crate::text::regex_compat::JsRegex::compile(pattern)
        .map_err(|e| messages::regex_error_message(&e))?;
    let records = stage_search_records(view).map_err(|message| {
        format!(
            "{}（{message}）",
            messages::excel_missing_message("关卡", excel_path)
        )
    })?;
    let zones = zone_table(view).ok();
    let zones = zones.as_deref().and_then(Option::as_ref);
    let mut matched: Vec<&StageSearchRecord> = Vec::new();
    for record in records.iter() {
        if regex.is_match(&record.search_text)? {
            matched.push(record);
            if matched.len() as i64 >= max_results {
                break;
            }
        }
    }
    let stages = stages_map(view)?;
    let total = matched.len();
    let results: Vec<Value> = matched
        .iter()
        .map(|record| stage_search_entry(&stages[&record.stage_id], &record.stage_id, zones))
        .collect();
    Ok(json!({
        "scope": "stages",
        "pattern": pattern,
        "total": total,
        "results": results,
    }))
}

fn stage_search_entry(entry: &Value, stage_id: &str, zones: Option<&Map<String, Value>>) -> Value {
    let type_raw = get_str(entry, "stageType").unwrap_or("");
    let difficulty_raw = get_str(entry, "difficulty").unwrap_or("");
    let zone_id = get_str(entry, "zoneId").unwrap_or("");
    json!({
        "stage_id": stage_id,
        "name": get_str(entry, "name").filter(|s| !s.is_empty()).unwrap_or("（无名）"),
        "code": get_str(entry, "code").filter(|s| !s.is_empty()).unwrap_or("?"),
        "type": type_raw,
        "type_label": stage_type_label(type_raw),
        "difficulty": difficulty_raw,
        "difficulty_label": difficulty_label(difficulty_raw),
        "zone_id": zone_id,
        "zone_display": zone_display(zone_id, zones),
        "ap": entry.get("apCost").filter(|v| !v.is_null()).cloned().unwrap_or(json!("?")),
        "description": clean_description(get_str(entry, "description").unwrap_or("")),
    })
}

pub fn render_stage_search(data: &Value) -> String {
    let pattern = data["pattern"].as_str().unwrap_or("");
    let results = data["results"].as_array().cloned().unwrap_or_default();
    if results.is_empty() {
        return format!("未找到匹配 '{pattern}' 的关卡。");
    }
    let mut lines = vec![format!(
        "# 搜索结果：{pattern}（共 {} 个）",
        data["total"].as_i64().unwrap_or(0)
    )];
    for entry in &results {
        lines.push(format!(
            "\n## {} [{}] {}（id: {}）",
            entry["name"].as_str().unwrap_or(""),
            entry["type_label"].as_str().unwrap_or(""),
            entry["code"].as_str().unwrap_or(""),
            entry["stage_id"].as_str().unwrap_or("")
        ));
        lines.push(format!(
            "- **区域**：{}",
            entry["zone_display"].as_str().unwrap_or("")
        ));
        lines.push(format!(
            "- **难度**：{}",
            entry["difficulty_label"].as_str().unwrap_or("")
        ));
        lines.push(format!(
            "- **理智**：{}",
            crate::text::numbers::json_value_to_string(&entry["ap"])
        ));
        let description = entry["description"].as_str().unwrap_or("");
        if !description.is_empty() {
            let excerpt = crate::text::js_compat::js_slice(description, 0, 120);
            // JS .length is UTF-16 code units.
            let units = description.encode_utf16().count();
            lines.push(format!(
                "- **描述**：{excerpt}{}",
                if units > 120 { "..." } else { "" }
            ));
        }
    }
    lines.join("\n")
}

/// Exposed for the diagnostics/tests: whether the stage dataset is available.
pub fn stage_available(view: &DataView) -> bool {
    has_stage_data(view)
}

pub fn sqlite_export(view: &DataView) -> Result<Vec<(String, Value)>, String> {
    let stages = stages_map(view)?;
    let zones = zone_table(view).ok();
    let zones = zones.as_deref().and_then(Option::as_ref);
    Ok(stage_search_records(view)?
        .iter()
        .map(|r| {
            (
                r.search_text.clone(),
                stage_search_entry(&stages[&r.stage_id], &r.stage_id, zones),
            )
        })
        .collect())
}

#[cfg(test)]
mod cache_tests {
    use super::*;

    #[test]
    fn stage_alias_shares_ownership_and_failed_load_retries() {
        let root = std::env::temp_dir().join(format!("prts-stage-cache-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join(STAGE_FILE);
        let view = DataView {
            excel_root: Some(root.clone()),
            levels_root: None,
            story_zip: None,
            datasets: Arc::new(crate::domain::datasets::Datasets::new()),
            database: None,
        };
        std::fs::write(&file, r#"{"stages":null}"#).unwrap();
        assert_eq!(stages_map(&view).unwrap_err(), "stage_table.json 格式异常");
        std::fs::write(&file, r#"{"stages":{"b":{"name":"B","stageDropInfo":{"unknown":7}},"a":{"name":"A"}},"unused":[1,2,3]}"#).unwrap();
        let stages = stages_map(&view).unwrap();
        let table = stage_table(&view).unwrap();
        assert!(Arc::ptr_eq(&stages, &table));
        assert_eq!(
            stages.keys().map(String::as_str).collect::<Vec<_>>(),
            ["b", "a"]
        );
        assert_eq!(stages["b"]["stageDropInfo"]["unknown"], 7);
        let weak = Arc::downgrade(&stages);
        drop(view);
        assert!(weak.upgrade().is_some()); // in-flight callers retain their generation
        drop(table);
        drop(stages);
        assert!(weak.upgrade().is_none());
        std::fs::remove_dir_all(root).unwrap();
    }
}
