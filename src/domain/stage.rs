//! Stage listing — port of the TS `data/stage.ts` list path (P1 scope).
//!
//! Reads `stage_table.json` / `zone_table.json` through the store abstraction,
//! filters and paginates exactly like `buildStagesListing`, and renders the
//! oracle's Markdown verbatim.

use serde_json::{json, Map, Value};

use crate::storage::{DirectoryStore, JsonStore};
use crate::text::js_compat::compare_ids;
use crate::tools::output::ToolOutcome;

const STAGE_FILE: &str = "stage_table.json";
const ZONE_FILE: &str = "zone_table.json";

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

fn zone_display(zone_id: &str, zones: Option<&Value>) -> String {
    let Some(zones) = zones else {
        return zone_id.to_string();
    };
    let Some(z) = zones.get(zone_id) else {
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

pub struct ListingArgs {
    pub chapter: Option<String>,
    pub stage_type: Option<String>,
    pub limit: i64,
    pub offset: i64,
}

/// `buildStagesListing` + `renderStagesListing` in one: either the wrapped
/// outcome (payload + Markdown) or a plain error/narrative text result.
pub fn list_stages(
    store: &DirectoryStore,
    missing_message: &str,
    args: &ListingArgs,
) -> ToolOutcome {
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

    let table = match load_stage_table(store) {
        Ok(t) => t,
        Err(message) => {
            // missingMessage() + （<loader error>） — the TS loader throws the
            // Chinese file-missing wording, not the store's English one.
            return ToolOutcome::text(format!("{missing_message}（{message}）"));
        }
    };
    let zones = load_zone_table(store);

    // Object.entries insertion order, then compareIds (UTF-16) ordering.
    let mut entries: Vec<(&String, &Value)> = table
        .as_object()
        .map(|m| m.iter().collect())
        .unwrap_or_default();
    entries.sort_by(|a, b| compare_ids(a.0, b.0));

    let filtered: Vec<(String, Value)> = entries
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
        .map(|(id, entry)| (id.clone(), entry.clone()))
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
            "zone_display": zone_display(zone_id, zones.as_ref()),
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
            .map(Value::String)
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

fn load_stage_table(store: &DirectoryStore) -> Result<Value, String> {
    // Dataset paths here are fixed file names, so `exists` cannot be an
    // unsafe-path error; only presence matters.
    if !store.exists(STAGE_FILE).unwrap_or(false) {
        return Err(format!("关卡数据文件不存在：{STAGE_FILE}"));
    }
    let raw = store
        .read_json(STAGE_FILE)
        .map_err(|_| format!("关卡数据文件不存在：{STAGE_FILE}"))?;
    match raw.get("stages") {
        Some(Value::Object(_)) => Ok(raw["stages"].clone()),
        _ => Err(format!("{STAGE_FILE} 格式异常")),
    }
}

fn load_zone_table(store: &DirectoryStore) -> Option<Value> {
    if !store.exists(ZONE_FILE).unwrap_or(false) {
        return None;
    }
    let raw = store.read_json(ZONE_FILE).ok()?;
    match raw.get("zones") {
        Some(Value::Object(_)) => Some(raw["zones"].clone()),
        _ => None,
    }
}
