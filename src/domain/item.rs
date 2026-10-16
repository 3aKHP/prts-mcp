//! Item/material data reader — port of TS `data/item.ts`.

use std::path::Path;
use std::sync::Arc;

use serde_json::{json, Map, Value};

use crate::app::DataView;
use crate::domain::messages;
use crate::storage::{DirectoryStore, JsonStore};
use crate::text::js_compat::compare_ids;

const ITEM_FILE: &str = "item_table.json";

const CLASSIFY_LABELS: &[(&str, &str)] = &[
    ("MATERIAL", "材料"),
    ("NORMAL", "普通"),
    ("CONSUME", "消耗品"),
    ("NONE", "其他"),
];

const OCCURRENCE_LABELS: &[(&str, &str)] = &[
    ("ALWAYS", "固定"),
    ("ALMOST", "大概率"),
    ("USUAL", "常规"),
    ("OFTEN", "较高概率"),
    ("SOMETIMES", "小概率"),
];

fn category_alias(raw: &str) -> Option<&'static str> {
    Some(match raw {
        "MATERIALS" | "材料" | "物资" => "MATERIAL",
        "NORMAL" | "普通" => "NORMAL",
        "CONSUME" | "消耗品" => "CONSUME",
        "NONE" | "其他" => "NONE",
        _ => return None,
    })
}

fn normalize_category(category: &str) -> String {
    let raw = category.trim();
    let upper = raw.to_uppercase();
    category_alias(&upper)
        .or_else(|| category_alias(raw))
        .unwrap_or(&upper)
        .to_string()
}

fn rarity_label(raw: &str) -> String {
    raw.strip_prefix("TIER_")
        .map(|rest| format!("T{rest}"))
        .unwrap_or_else(|| raw.to_string())
}

fn classify_label(raw: &str) -> String {
    if raw.is_empty() {
        return "-".to_string();
    }
    CLASSIFY_LABELS
        .iter()
        .find(|(k, _)| *k == raw)
        .map(|(_, v)| v.to_string())
        .unwrap_or_else(|| raw.to_string())
}

fn occurrence_label(raw: &str) -> String {
    if raw.is_empty() {
        return "?".to_string();
    }
    OCCURRENCE_LABELS
        .iter()
        .find(|(k, _)| *k == raw)
        .map(|(_, v)| v.to_string())
        .unwrap_or_else(|| raw.to_string())
}

fn short_text(text: &str, limit: usize) -> String {
    let cleaned: String = text.split_whitespace().collect::<Vec<&str>>().join(" ");
    if cleaned.chars().count() > limit {
        format!(
            "{}...",
            crate::text::js_compat::js_slice(&cleaned, 0, limit)
        )
    } else {
        cleaned
    }
}

// ---------------------------------------------------------------------------
// Cached table access
// ---------------------------------------------------------------------------

fn items(view: &DataView) -> Result<Arc<Map<String, Value>>, String> {
    let Some(root) = view.excel_root.clone() else {
        // TS excelStore() throws this exact wording when the effective path
        // is null; the listing tools append it to the missing-data message.
        return Err("effectiveExcelPath is null — GAMEDATA_PATH may be unset".to_string());
    };
    let store = DirectoryStore::new(&root);
    view.datasets.get_or_load_counted(
        "item:items",
        move || {
            if !store.exists(ITEM_FILE).unwrap_or(false) {
                let shown = store
                    .resolve(ITEM_FILE)
                    .map(|p| p.display().to_string())
                    .unwrap_or_else(|_| ITEM_FILE.to_string());
                return Err(format!("物品数据文件不存在：{shown}。"));
            }
            let mut raw = store.read_json(ITEM_FILE).map_err(|e| e.to_string())?;
            match raw.get_mut("items").map(Value::take) {
                Some(Value::Object(items)) => Ok(items),
                _ => Err(format!("{ITEM_FILE} missing 'items' dict")),
            }
        },
        |items| items.len() as u64,
    )
}

fn item_lookup(view: &DataView) -> Result<Arc<std::collections::HashMap<String, String>>, String> {
    view.datasets.get_or_load_counted(
        "item:item_lookup",
        || {
            let mut lookup = std::collections::HashMap::new();
            for (item_id, info) in items(view)?.iter() {
                lookup.insert(item_id.clone(), item_id.clone());
                if let Some(name) = info.get("name").and_then(Value::as_str) {
                    if !name.is_empty() && !lookup.contains_key(name) {
                        lookup.insert(name.to_string(), item_id.clone());
                    }
                }
            }
            Ok(lookup)
        },
        |lookup| lookup.len() as u64,
    )
}

/// `getItemNameById`: null on missing/empty ids or unreadable tables —
/// never an error (drop rendering is best-effort). Takes the call's view so
/// the join reads the same generation as the rest of the call.
pub fn get_item_name_by_id(view: &DataView, item_id: &str) -> Option<String> {
    if item_id.is_empty() {
        return None;
    }
    let items = items(view).ok()?;
    items
        .get(item_id)?
        .get("name")
        .and_then(Value::as_str)
        .filter(|n| !n.is_empty())
        .map(str::to_string)
}

fn visible_items(items: &Map<String, Value>) -> Vec<(&String, &Value)> {
    items
        .iter()
        .filter(|(_, info)| {
            info.get("hideInItemGet") != Some(&Value::Bool(true))
                && info
                    .get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|n| !n.is_empty())
        })
        .collect()
}

fn sort_entries(entries: &mut [(&String, &Value)]) {
    entries.sort_by(|a, b| {
        let sa = a.1.get("sortId").and_then(Value::as_i64).unwrap_or(999999);
        let sb = b.1.get("sortId").and_then(Value::as_i64).unwrap_or(999999);
        sa.cmp(&sb).then_with(|| compare_ids(a.0, b.0))
    });
}

// ---------------------------------------------------------------------------
// list_items
// ---------------------------------------------------------------------------

/// `buildItemsListing`: Err carries the exact message text.
pub fn build_items_listing(
    view: &DataView,
    excel_path: &Path,
    category: Option<&str>,
    limit: i64,
    offset: i64,
) -> Result<Value, String> {
    if let Some(err) = messages::validate_bounds("limit", limit, Some(1), Some(200))
        .or_else(|| messages::validate_bounds("offset", offset, Some(0), None))
    {
        return Err(err);
    }
    let items = items(view).map_err(|message| {
        format!(
            "{}（{message}）",
            messages::excel_missing_message("物品", excel_path)
        )
    })?;

    let mut entries = visible_items(&items);
    let category_filter = category.map(normalize_category);
    if let Some(filter) = &category_filter {
        entries.retain(|(_, info)| {
            info.get("classifyType").and_then(Value::as_str) == Some(filter.as_str())
                || info.get("itemType").and_then(Value::as_str) == Some(filter.as_str())
        });
    }

    sort_entries(&mut entries);

    let total = entries.len();
    let start = (offset.max(0) as usize).min(total);
    let end = (offset + limit).max(0).clamp(0, total as i64) as usize;
    let page = &entries[start..end];

    if page.is_empty() {
        return Ok(json!({
            "total": total,
            "offset": offset,
            "limit": limit,
            "filters": {
                "category": category.map(|v| Value::String(v.to_string())).unwrap_or(Value::Null),
                "category_filter": category_filter.map(|v| Value::String(v.to_string())).unwrap_or(Value::Null),
            },
            "items": [],
            "empty_reason": if total == 0 { "no_match" } else { "offset_out_of_range" },
        }));
    }

    let items: Vec<Value> = page
        .iter()
        .map(|(item_id, info)| {
            let usage_or_desc = info
                .get("usage")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .or_else(|| info.get("description").and_then(Value::as_str))
                .unwrap_or("");
            let rarity = info.get("rarity").and_then(Value::as_str).unwrap_or("");
            let classify = info
                .get("classifyType")
                .and_then(Value::as_str)
                .unwrap_or("");
            json!({
                "item_id": item_id,
                "name": get_str_or(info, "name", "（无名）"),
                "rarity_raw": rarity,
                "rarity_label": rarity_label(rarity),
                "classify_raw": classify,
                "classify_label": classify_label(classify),
                "item_type": get_str_or(info, "itemType", "-"),
                "usage_excerpt": short_text(usage_or_desc, 80),
            })
        })
        .collect();

    Ok(json!({
        "total": total,
        "offset": offset,
        "limit": limit,
        "filters": {
            "category": category.map(|v| Value::String(v.to_string())).unwrap_or(Value::Null),
            "category_filter": category_filter.map(|v| Value::String(v.to_string())).unwrap_or(Value::Null),
        },
        "items": items,
    }))
}

fn get_str_or(info: &Value, key: &str, fallback: &str) -> String {
    info.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

pub fn render_items_listing(data: &Value) -> String {
    if data["empty_reason"].as_str() == Some("no_match") {
        let category = data
            .pointer("/filters/category")
            .and_then(Value::as_str)
            .unwrap_or("none");
        return format!("没有匹配的物品（category={category}）。");
    }
    if data["empty_reason"].as_str() == Some("offset_out_of_range") {
        return format!(
            "offset {} 超出范围（共 {} 条）。",
            data["offset"].as_i64().unwrap_or(0),
            data["total"].as_i64().unwrap_or(0)
        );
    }
    let total = data["total"].as_i64().unwrap_or(0);
    let offset = data["offset"].as_i64().unwrap_or(0);
    let limit = data["limit"].as_i64().unwrap_or(0);
    let category = data.pointer("/filters/category").and_then(Value::as_str);
    let title = match category {
        Some(c) => format!("# 物品列表：{c}（共 {total} 个）"),
        None => format!("# 物品列表（共 {total} 个）"),
    };
    let mut lines = vec![title];
    for item in data["items"].as_array().cloned().unwrap_or_default() {
        let mut line = format!(
            "- **{}** [{}/{}] {}（id: {}）",
            item["name"].as_str().unwrap_or(""),
            item["classify_label"].as_str().unwrap_or(""),
            item["item_type"].as_str().unwrap_or(""),
            item["rarity_label"].as_str().unwrap_or(""),
            item["item_id"].as_str().unwrap_or("")
        );
        let excerpt = item["usage_excerpt"].as_str().unwrap_or("");
        if !excerpt.is_empty() {
            line += &format!(" — {excerpt}");
        }
        lines.push(line);
    }
    lines.push(format!(
        "\n（显示第 {}–{} 条，共 {total} 条。使用 offset={} 查看下一页）",
        offset + 1,
        (offset + limit).min(total),
        offset + limit
    ));
    lines.join("\n")
}

// ---------------------------------------------------------------------------
// get_item_info
// ---------------------------------------------------------------------------

/// `buildItemInfo`: Err carries the exact message text.
pub fn build_item_info(view: &DataView, excel_path: &Path, name: &str) -> Result<Value, String> {
    let item_id = item_lookup(view).map_err(|message| {
        format!(
            "{}（{message}）",
            messages::excel_missing_message("物品", excel_path)
        )
    })?;
    let Some(item_id) = item_id.get(name).cloned() else {
        return Err(format!(
            "未找到物品：{}。",
            serde_json::to_string(name).unwrap_or_default()
        ));
    };
    let Some(info) = items(view)?.get(&item_id).cloned() else {
        return Err(format!(
            "物品 {} 暂无详细信息。",
            serde_json::to_string(name).unwrap_or_default()
        ));
    };

    let get_s = |key: &str| info.get(key).and_then(Value::as_str).unwrap_or("");
    Ok(json!({
        "name": if get_s("name").is_empty() { name.to_string() } else { get_s("name").to_string() },
        "item_id": item_id,
        "rarity_raw": get_s("rarity"),
        "rarity_label": rarity_label(get_s("rarity")),
        "classify_raw": get_s("classifyType"),
        "classify_label": classify_label(get_s("classifyType")),
        "item_type": if get_s("itemType").is_empty() { "-".to_string() } else { get_s("itemType").to_string() },
        "icon_id": non_empty_str(&info, "iconId"),
        "obtain_approach": non_empty_str(&info, "obtainApproach"),
        "description": non_empty_str(&info, "description"),
        "usage": non_empty_str(&info, "usage"),
        "stage_drop_list": info.get("stageDropList").and_then(Value::as_array).cloned().unwrap_or_default(),
        "building_product_list": info.get("buildingProductList").filter(|v| !v.is_null()).cloned().unwrap_or(Value::Null),
        "shop_relate_list": info.get("shopRelateInfoList").filter(|v| !v.is_null()).cloned().unwrap_or(Value::Null),
        "voucher_relate_list": info.get("voucherRelateList").filter(|v| !v.is_null()).cloned().unwrap_or(Value::Null),
    }))
}

fn non_empty_str(info: &Value, key: &str) -> Value {
    info.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(|v| Value::String(v.to_string()))
        .unwrap_or(Value::Null)
}

fn format_stage_drops(drop_list: &Value) -> String {
    let Some(list) = drop_list.as_array() else {
        return "（无）".to_string();
    };
    if list.is_empty() {
        return "（无）".to_string();
    }
    const MAX_ENTRIES: usize = 12;
    let mut sorted: Vec<&Value> = list.iter().collect();
    sorted.sort_by_key(|entry| entry.get("sortId").and_then(Value::as_i64).unwrap_or(9999));
    let mut lines: Vec<String> = sorted
        .iter()
        .take(MAX_ENTRIES)
        .map(|entry| {
            let stage_id = entry
                .get("stageId")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .unwrap_or("?");
            format!(
                "- {stage_id}（{}）",
                occurrence_label(entry.get("occPer").and_then(Value::as_str).unwrap_or(""))
            )
        })
        .collect();
    if list.len() > MAX_ENTRIES {
        lines.push(format!("- ...另有 {} 个关卡", list.len() - MAX_ENTRIES));
    }
    lines.join("\n")
}

fn format_related(label: &str, entries: &Value) -> Vec<String> {
    let Some(list) = entries.as_array() else {
        return Vec::new();
    };
    if list.is_empty() {
        return Vec::new();
    }
    let mut lines = vec![format!("\n## {label}")];
    for entry in list.iter().take(10) {
        let bits: Vec<String> = entry
            .as_object()
            .map(|obj| {
                obj.iter()
                    .filter(|(_, value)| {
                        !matches!(value, Value::Null) && value.as_str() != Some("")
                    })
                    .map(|(key, value)| {
                        format!(
                            "{key}={}",
                            match value {
                                Value::String(s) => s.clone(),
                                other => crate::text::numbers::json_value_to_string(other),
                            }
                        )
                    })
                    .collect()
            })
            .unwrap_or_default();
        if bits.is_empty() {
            lines.push("- （空）".to_string());
        } else {
            lines.push(format!("- {}", bits.join("，")));
        }
    }
    if list.len() > 10 {
        lines.push(format!("- ...另有 {} 条", list.len() - 10));
    }
    lines
}

pub fn render_item_info(data: &Value) -> String {
    let mut parts = vec![
        format!(
            "{} — 物品信息",
            format!("# {}", data["name"].as_str().unwrap_or(""))
        ),
        String::new(),
        "## 基本信息".to_string(),
    ];
    parts.push(format!(
        "- **ID**：{}",
        data["item_id"].as_str().unwrap_or("")
    ));
    parts.push(format!(
        "- **稀有度**：{}",
        data["rarity_label"].as_str().unwrap_or("")
    ));
    parts.push(format!(
        "- **分类**：{}",
        data["classify_label"].as_str().unwrap_or("")
    ));
    parts.push(format!(
        "- **类型**：{}",
        data["item_type"].as_str().unwrap_or("")
    ));
    if let Some(icon) = data["icon_id"].as_str() {
        if !icon.is_empty() {
            parts.push(format!("- **图标**：{icon}"));
        }
    }
    if let Some(obtain) = data["obtain_approach"].as_str() {
        if !obtain.is_empty() {
            parts.push(format!("- **获取方式**：{obtain}"));
        }
    }
    if let Some(desc) = data["description"].as_str() {
        if !desc.is_empty() {
            parts.push(String::new());
            parts.push("## 描述".to_string());
            parts.push(desc.to_string());
        }
    }
    if let Some(usage) = data["usage"].as_str() {
        if !usage.is_empty() {
            parts.push(String::new());
            parts.push("## 用途".to_string());
            parts.push(usage.to_string());
        }
    }
    parts.push(String::new());
    parts.push("## 掉落关卡".to_string());
    parts.push(format_stage_drops(&data["stage_drop_list"]));
    parts.extend(format_related("基建产出", &data["building_product_list"]));
    parts.extend(format_related("商店关联", &data["shop_relate_list"]));
    parts.extend(format_related("凭证关联", &data["voucher_relate_list"]));
    parts.join("\n")
}

// ---------------------------------------------------------------------------
// search scope=items
// ---------------------------------------------------------------------------

struct ItemSearchRecord {
    item_id: String,
    search_text: String,
}

fn item_search_records(view: &DataView) -> Result<Arc<Vec<ItemSearchRecord>>, String> {
    view.datasets.get_or_load_counted(
        "item:item_search_records",
        || {
            let items = items(view)?;
            let mut entries = visible_items(&items);
            sort_entries(&mut entries);
            Ok(entries
                .into_iter()
                .map(|(item_id, info)| {
                    let mut parts: Vec<String> = [
                        "name",
                        "description",
                        "usage",
                        "obtainApproach",
                        "classifyType",
                        "itemType",
                    ]
                    .iter()
                    .filter_map(|key| info.get(*key).and_then(Value::as_str))
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .collect();
                    parts.push(item_id.clone());
                    ItemSearchRecord {
                        item_id: item_id.clone(),
                        search_text: parts.join(" "),
                    }
                })
                .collect())
        },
        |records: &Vec<ItemSearchRecord>| records.len() as u64,
    )
}

/// `buildItemSearch`: Err carries the exact message text.
pub fn build_item_search(
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
    let records = item_search_records(view).map_err(|message| {
        format!(
            "{}（{message}）",
            messages::excel_missing_message("物品", excel_path)
        )
    })?;
    let items = items(view)?;
    let mut results: Vec<Value> = Vec::new();
    for record in records.iter() {
        if regex.is_match(&record.search_text)? {
            results.push(item_search_entry(&items[&record.item_id], &record.item_id));
            if results.len() as i64 >= max_results {
                break;
            }
        }
    }
    let total = results.len();
    Ok(json!({
        "scope": "items",
        "pattern": pattern,
        "total": total,
        "results": results,
    }))
}

fn item_search_entry(info: &Value, item_id: &str) -> Value {
    let usage_or_desc = info
        .get("usage")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .or_else(|| info.get("description").and_then(Value::as_str))
        .unwrap_or("");
    let rarity = info.get("rarity").and_then(Value::as_str).unwrap_or("");
    let classify = info
        .get("classifyType")
        .and_then(Value::as_str)
        .unwrap_or("");
    json!({
        "item_id": item_id,
        "name": get_str_or(info, "name", "（无名）"),
        "classify_raw": classify,
        "classify_label": classify_label(classify),
        "item_type": get_str_or(info, "itemType", "-"),
        "rarity_raw": rarity,
        "rarity_label": rarity_label(rarity),
        "usage": short_text(usage_or_desc, 120),
        "obtain_approach": info.get("obtainApproach").and_then(Value::as_str).unwrap_or(""),
    })
}

pub fn render_item_search(data: &Value) -> String {
    let pattern = data["pattern"].as_str().unwrap_or("");
    let results = data["results"].as_array().cloned().unwrap_or_default();
    if results.is_empty() {
        return format!("未找到匹配 '{pattern}' 的物品。");
    }
    let mut lines = vec![format!(
        "# 搜索结果：{pattern}（共 {} 个）",
        data["total"].as_i64().unwrap_or(0)
    )];
    for item in &results {
        lines.push(format!(
            "\n## {} [{}/{}] {}（id: {}）",
            item["name"].as_str().unwrap_or(""),
            item["classify_label"].as_str().unwrap_or(""),
            item["item_type"].as_str().unwrap_or(""),
            item["rarity_label"].as_str().unwrap_or(""),
            item["item_id"].as_str().unwrap_or("")
        ));
        if let Some(usage) = item["usage"].as_str() {
            if !usage.is_empty() {
                lines.push(format!("- **用途**：{usage}"));
            }
        }
        if let Some(obtain) = item["obtain_approach"].as_str() {
            if !obtain.is_empty() {
                lines.push(format!("- **获取方式**：{obtain}"));
            }
        }
    }
    lines.join("\n")
}
