//! Enemy handbook + database reader — port of TS `data/enemy.ts` +
//! `data/enemyRender.ts` (the handbook card lives there).

use std::path::Path;
use std::sync::Arc;

use serde_json::{json, Value};

use crate::app::DataView;
use crate::domain::enemy_db::{default_entry, normalize_enemy_database, OrderedMap};
use crate::domain::messages;
use crate::storage::{DirectoryStore, JsonStore};
use crate::text::js_compat::compare_ids;

const HANDBOOK_FILE: &str = "enemy_handbook_table.json";
const DATABASE_FILE: &str = "enemydata/enemy_database.json";

const ENEMY_LEVEL_ZH: &[(&str, &str)] = &[("BOSS", "领袖"), ("ELITE", "精英"), ("NORMAL", "普通")];

const DAMAGE_TYPE_ZH: &[(&str, &str)] = &[("PHYSIC", "物理"), ("MAGIC", "法术"), ("HEAL", "治疗")];

fn enemy_level_zh(raw: &str) -> String {
    ENEMY_LEVEL_ZH
        .iter()
        .find(|(k, _)| *k == raw)
        .map(|(_, v)| v.to_string())
        .unwrap_or_else(|| raw.to_string())
}

pub fn has_enemy_data(view: &DataView) -> bool {
    view.excel_root
        .as_ref()
        .map(DirectoryStore::new)
        .is_some_and(|store| store.exists(HANDBOOK_FILE).unwrap_or(false))
}

fn has_database(view: &DataView) -> bool {
    // Same zh_CN/gamedata/levels join as TS levelsStore().
    view.levels_root
        .as_ref()
        .map(|root| DirectoryStore::new(root.join("zh_CN").join("gamedata").join("levels")))
        .is_some_and(|store| store.exists(DATABASE_FILE).unwrap_or(false))
}

pub fn handbook(view: &DataView) -> Result<Arc<Value>, String> {
    let Some(root) = view.excel_root.clone() else {
        return Err(messages::excel_missing_message("敌人图鉴", Path::new("")));
    };
    let store = DirectoryStore::new(&root);
    view.datasets.get_or_load_counted(
        "enemy:enemy_handbook",
        move || {
            if !store.exists(HANDBOOK_FILE).unwrap_or(false) {
                let shown = store
                    .resolve(HANDBOOK_FILE)
                    .map(|p| p.display().to_string())
                    .unwrap_or_else(|_| HANDBOOK_FILE.to_string());
                return Err(format!("敌人图鉴数据文件不存在：{shown}。"));
            }
            store.read_json(HANDBOOK_FILE).map_err(|e| e.to_string())
        },
        |raw| {
            raw.pointer("/enemyData")
                .and_then(serde_json::Value::as_object)
                .map(|m| m.len() as u64)
                .unwrap_or(0)
        },
    )
}

/// Raw normalized levels map (empty when the levels side is absent).
pub fn db_levels(
    view: &DataView,
) -> Result<Arc<OrderedMap<crate::domain::enemy_db::LevelMap>>, String> {
    view.datasets.get_or_load_counted(
        "enemy:enemy_database",
        || {
            if !has_database(view) {
                return Ok(OrderedMap::new());
            }
            let Some(root) = view.levels_root.clone() else {
                return Ok(OrderedMap::new());
            };
            let store = DirectoryStore::new(root.join("zh_CN").join("gamedata").join("levels"));
            let raw = store.read_json(DATABASE_FILE).map_err(|e| e.to_string())?;
            normalize_enemy_database(raw)
        },
        |db| db.len() as u64,
    )
}

/// name → enemyId over the handbook's enemyData (last duplicate wins, first
/// position kept — JS Map).
pub fn name_to_enemy_id(view: &DataView) -> Result<Arc<Vec<(String, String)>>, String> {
    view.datasets.get_or_load_counted(
        "enemy:enemy_name_to_id",
        || {
            let raw = handbook(view)?;
            let mut folded: Vec<(String, String)> = Vec::new();
            let mut index: std::collections::HashMap<String, usize> =
                std::collections::HashMap::new();
            for (eid, info) in raw
                .pointer("/enemyData")
                .and_then(Value::as_object)
                .into_iter()
                .flat_map(|m| m.iter())
            {
                let Some(name) = info.get("name").and_then(Value::as_str) else {
                    continue;
                };
                match index.get(name) {
                    Some(&pos) => folded[pos].1 = eid.clone(),
                    None => {
                        index.insert(name.to_string(), folded.len());
                        folded.push((name.to_string(), eid.clone()));
                    }
                }
            }
            Ok(folded)
        },
        |folded| folded.len() as u64,
    )
}

fn resolve_enemy_id(view: &DataView, name: &str) -> Result<Option<String>, String> {
    Ok(name_to_enemy_id(view)?
        .iter()
        .find(|(n, _)| n == name)
        .map(|(_, id)| id.clone()))
}

struct EnemySearchRecord {
    enemy_id: String,
    search_text: String,
}

fn search_records(view: &DataView) -> Result<Arc<Vec<EnemySearchRecord>>, String> {
    view.datasets.get_or_load_counted(
        "enemy:enemy_search_records",
        || {
            let raw = handbook(view)?;
            let mut records = Vec::new();
            for (enemy_id, info) in raw
                .pointer("/enemyData")
                .and_then(Value::as_object)
                .into_iter()
                .flat_map(|m| m.iter())
            {
                if info.get("hideInHandbook") == Some(&Value::Bool(true)) {
                    continue;
                }
                let tags = info
                    .get("enemyTags")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let search_text = [
                    info.get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    info.get("description")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    info.get("ability")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                ]
                .into_iter()
                .chain(tags.iter().filter_map(|t| t.as_str().map(str::to_string)))
                .collect::<Vec<_>>()
                .join(" ");
                records.push(EnemySearchRecord {
                    enemy_id: enemy_id.clone(),
                    search_text,
                });
            }
            Ok(records)
        },
        |records| records.len() as u64,
    )
}

// ---------------------------------------------------------------------------
// list_enemies
// ---------------------------------------------------------------------------

/// `buildEnemiesListing`: Err carries the exact message text.
pub fn build_enemies_listing(
    view: &DataView,
    excel_path: &Path,
    threat_level: Option<&str>,
    limit: i64,
    offset: i64,
    full: bool,
) -> Result<Value, String> {
    if !has_enemy_data(view) {
        return Err(messages::excel_missing_message("敌人图鉴", excel_path));
    }
    if let Some(err) = messages::validate_bounds("limit", limit, Some(1), Some(200))
        .or_else(|| messages::validate_bounds("offset", offset, Some(0), None))
    {
        return Err(err);
    }
    let raw = handbook(view)?;
    let ed = raw.pointer("/enemyData").and_then(Value::as_object);

    let mut entries: Vec<(String, Value)> = ed
        .into_iter()
        .flat_map(|m| m.iter())
        .filter(|(_, info)| {
            info.get("hideInHandbook") != Some(&Value::Bool(true))
                && info
                    .get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|n| !n.is_empty())
        })
        .map(|(eid, info)| (eid.clone(), info.clone()))
        .collect();

    let threat_filter = threat_level.map(|t| t.to_uppercase());
    if let Some(filter) = &threat_filter {
        if !ENEMY_LEVEL_ZH.iter().any(|(k, _)| k == filter) {
            return Err(format!(
                "无效的 threat_level 参数：{}，可选值：boss、elite、normal。",
                serde_json::to_string(threat_level.unwrap_or_default()).unwrap_or_default()
            ));
        }
        entries.retain(|(_, info)| {
            info.get("enemyLevel")
                .and_then(Value::as_str)
                .is_some_and(|l| l.to_uppercase() == *filter)
        });
    }

    entries.sort_by(|a, b| {
        let sa = a.1.get("sortId").and_then(Value::as_i64).unwrap_or(9999);
        let sb = b.1.get("sortId").and_then(Value::as_i64).unwrap_or(9999);
        sa.cmp(&sb).then_with(|| compare_ids(&a.0, &b.0))
    });

    let total = entries.len();
    let filters = json!({
        "threat_level": threat_level.map(|v| Value::String(v.to_string())).unwrap_or(Value::Null),
        "threat_level_filter": threat_filter.map(|v| Value::String(v.to_string())).unwrap_or(Value::Null),
    });

    if !full && offset >= total as i64 && total > 0 {
        return Ok(json!({
            "total": total,
            "offset": offset,
            "limit": limit,
            "full": full,
            "filters": filters,
            "enemies": [],
            "empty_reason": "offset_out_of_range",
        }));
    }

    let displayed: Vec<&(String, Value)> = if full {
        entries.iter().collect()
    } else {
        let start = (offset.max(0) as usize).min(total);
        let end = (offset + limit).max(0).clamp(0, total as i64) as usize;
        entries[start..end].iter().collect()
    };

    let enemies: Vec<Value> = displayed
        .iter()
        .map(|(enemy_id, info)| {
            let level_raw = info.get("enemyLevel").and_then(Value::as_str).unwrap_or("");
            let desc = info
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("")
                .replace('\n', " ");
            json!({
                "enemy_id": enemy_id,
                "name": info.get("name").and_then(Value::as_str).unwrap_or(""),
                "enemy_index": info.get("enemyIndex").and_then(Value::as_str).unwrap_or(""),
                "level_raw": level_raw,
                "level_label": enemy_level_zh(level_raw),
                "description_excerpt": crate::text::js_compat::js_slice(&desc, 0, 60),
            })
        })
        .collect();

    Ok(json!({
        "total": total,
        "offset": offset,
        "limit": limit,
        "full": full,
        "filters": filters,
        "enemies": enemies,
    }))
}

pub fn render_enemies_listing(data: &Value) -> String {
    if data["empty_reason"].as_str() == Some("offset_out_of_range") {
        return format!(
            "# 敌人图鉴（共 {} 个）\n\noffset={} 超出范围（总计 {} 条）。",
            data["total"].as_i64().unwrap_or(0),
            data["offset"].as_i64().unwrap_or(0),
            data["total"].as_i64().unwrap_or(0)
        );
    }
    let total = data["total"].as_i64().unwrap_or(0);
    let offset = data["offset"].as_i64().unwrap_or(0);
    let limit = data["limit"].as_i64().unwrap_or(0);
    let full = data["full"].as_bool().unwrap_or(false);
    let mut out = format!("# 敌人图鉴（共 {total} 个）\n");
    for enemy in data["enemies"].as_array().cloned().unwrap_or_default() {
        let mut line = format!(
            "- **{}** [{}] ({})",
            enemy["name"].as_str().unwrap_or(""),
            enemy["level_label"].as_str().unwrap_or(""),
            enemy["enemy_index"].as_str().unwrap_or("")
        );
        let excerpt = enemy["description_excerpt"].as_str().unwrap_or("");
        if !excerpt.is_empty() {
            line += &format!(" — {excerpt}");
        }
        out += &(line + "\n");
    }
    if !full && total > offset + limit {
        out += &format!(
            "\n（显示第 {}–{} 条，共 {total} 条。使用 offset={} 查看下一页）",
            offset + 1,
            (offset + limit).min(total),
            offset + limit
        );
    }
    out.trim().to_string()
}

// ---------------------------------------------------------------------------
// get_enemy_info
// ---------------------------------------------------------------------------

/// `buildEnemyInfo`: Err carries the exact message text.
pub fn build_enemy_info(view: &DataView, excel_path: &Path, name: &str) -> Result<Value, String> {
    if !has_enemy_data(view) {
        return Err(messages::excel_missing_message("敌人图鉴", excel_path));
    }
    let Some(eid) = resolve_enemy_id(view, name)? else {
        return Err(format!("未找到敌人 '{name}'。请使用游戏内名称。"));
    };
    let raw = handbook(view)?;
    let Some(info) = raw
        .pointer("/enemyData")
        .and_then(Value::as_object)
        .and_then(|d| d.get(&eid))
    else {
        return Err(format!("敌人 '{name}' 暂无详细信息。"));
    };

    let level_raw = info.get("enemyLevel").and_then(Value::as_str).unwrap_or("");
    let damage_types_raw: Vec<Value> = info
        .get("damageType")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let damage_types_label = damage_types_raw
        .iter()
        .filter_map(Value::as_str)
        .map(|dt| {
            DAMAGE_TYPE_ZH
                .iter()
                .find(|(k, _)| *k == dt)
                .map(|(_, v)| v.to_string())
                .unwrap_or_else(|| dt.to_string())
        })
        .collect::<Vec<_>>()
        .join("、");
    let payload = json!({
        "name": info.get("name").and_then(Value::as_str).unwrap_or(""),
        "enemy_id": info.get("enemyId").and_then(Value::as_str).unwrap_or(""),
        "enemy_index": info.get("enemyIndex").and_then(Value::as_str).unwrap_or(""),
        "level_raw": level_raw,
        "level_label": enemy_level_zh(level_raw),
        "description": info.get("description").and_then(Value::as_str).unwrap_or(""),
        "attack_type": info.get("attackType").and_then(Value::as_str).unwrap_or(""),
        "ability": info.get("ability").and_then(Value::as_str).unwrap_or(""),
        "damage_types_raw": damage_types_raw,
        "damage_types_label": damage_types_label,
        "enemy_tags": info.get("enemyTags").and_then(Value::as_array).cloned().unwrap_or_default(),
        "stats": Value::Null,
    });
    // The stats join replaces the null when a level-0 database entry exists.
    let mut payload = payload;
    let levels = db_levels(view)?;
    if let Some(db_entry) = default_entry(&levels, &eid) {
        payload["stats"] = crate::domain::enemy_stats::extract_enemy_stats(db_entry);
    }
    Ok(payload)
}

// ---------------------------------------------------------------------------
// renderHandbookCard + renderStatsBlock (enemyRender.ts)
// ---------------------------------------------------------------------------

pub fn render_handbook_card(entry: &Value, include_enemy_id: bool) -> Vec<String> {
    let mut lines = Vec::new();
    let name = entry["name"].as_str().unwrap_or("");
    if !name.is_empty() {
        lines.push(format!("# {name} - 敌人图鉴\n"));
        if include_enemy_id {
            lines.push(format!(
                "- **ID**：{}",
                entry["enemy_id"].as_str().unwrap_or("")
            ));
        }
    }
    let push = |lines: &mut Vec<String>, label: &str, key: &str| {
        let value = entry[key].as_str().unwrap_or("");
        if !value.is_empty() {
            lines.push(format!("- **{label}**：{value}"));
        }
    };
    push(&mut lines, "编号", "enemy_index");
    push(&mut lines, "威胁等级", "level_label");
    push(&mut lines, "描述", "description");
    push(&mut lines, "攻击方式", "attack_type");
    push(&mut lines, "特殊能力", "ability");
    push(&mut lines, "伤害类型", "damage_types_label");
    if let Some(tags) = entry["enemy_tags"].as_array() {
        if !tags.is_empty() {
            let names: Vec<&str> = tags.iter().filter_map(Value::as_str).collect();
            lines.push(format!("- **标签**：{}", names.join("、")));
        }
    }
    lines
}

fn has_enemy_stats_content(stats: &Value) -> bool {
    const SCALAR_FIELDS: &[&str] = &[
        "max_hp",
        "atk",
        "def",
        "resistance",
        "move_speed",
        "attack_interval",
        "attack_speed",
        "mass_level",
        "hp_recovery_per_sec",
        "life_point_reduce",
    ];
    SCALAR_FIELDS
        .iter()
        .any(|f| stats[*f].as_str().is_some_and(|s| !s.is_empty()))
        || !stats["immunities"].as_array().is_none_or(|a| a.is_empty())
        || !stats["skills"].as_array().is_none_or(|a| a.is_empty())
}

pub fn render_stats_block(stats: &Value) -> Vec<String> {
    if !has_enemy_stats_content(stats) {
        return Vec::new();
    }
    let mut lines = vec!["## 战斗属性".to_string()];
    for (field, label) in [
        ("max_hp", "最大生命"),
        ("atk", "攻击力"),
        ("def", "防御力"),
        ("resistance", "法术抗性"),
        ("move_speed", "移动速度"),
        ("attack_interval", "攻击间隔"),
        ("attack_speed", "攻击速度"),
        ("mass_level", "重量等级"),
        ("hp_recovery_per_sec", "每秒生命回复"),
    ] {
        if let Some(val) = stats[field].as_str() {
            if !val.is_empty() {
                lines.push(format!("- **{label}**：{val}"));
            }
        }
    }
    if let Some(immunities) = stats["immunities"].as_array() {
        if !immunities.is_empty() {
            let names: Vec<&str> = immunities.iter().filter_map(Value::as_str).collect();
            lines.push(format!("- **免疫**：{}", names.join("、")));
        }
    }
    if let Some(lpr) = stats["life_point_reduce"].as_str() {
        if !lpr.is_empty() {
            lines.push(format!("- **生命值扣除**：{lpr}"));
        }
    }
    if let Some(skills) = stats["skills"].as_array() {
        if !skills.is_empty() {
            lines.push("\n## 技能".to_string());
            for skill in skills {
                let mut parts = vec![format!("- **{}**", skill["prefab"].as_str().unwrap_or(""))];
                if let Some(timing) = skill["timing"].as_str() {
                    if !timing.is_empty() {
                        parts.push(format!("（{timing}）"));
                    }
                }
                if let Some(blackboard) = skill["blackboard"].as_str() {
                    if !blackboard.is_empty() {
                        parts.push(format!(": {blackboard}"));
                    }
                }
                lines.push(parts.join(""));
            }
        }
    }
    lines
}

pub fn render_enemy_info(data: &Value) -> String {
    let mut lines = render_handbook_card(data, true);
    if !data["stats"].is_null() {
        lines.extend(render_stats_block(&data["stats"]));
    }
    lines.join("\n")
}

// ---------------------------------------------------------------------------
// search scope=enemies
// ---------------------------------------------------------------------------

/// `buildEnemySearch`: Err carries the exact message text.
pub fn build_enemy_search(
    view: &DataView,
    excel_path: &Path,
    pattern: &str,
    max_results: i64,
) -> Result<Value, String> {
    if !has_enemy_data(view) {
        return Err(messages::excel_missing_message("敌人图鉴", excel_path));
    }
    if let Some(err) = messages::validate_bounds("max_results", max_results, Some(1), Some(100)) {
        return Err(err);
    }
    let regex = crate::text::regex_compat::JsRegex::compile(pattern)
        .map_err(|e| messages::regex_error_message(&e))?;
    let records = search_records(view)?;
    let raw = handbook(view)?;
    let mut matches = Vec::new();
    for record in records.iter() {
        if regex.is_match(&record.search_text)? {
            matches.push(record);
            if matches.len() as i64 >= max_results {
                break;
            }
        }
    }
    let total = matches.len();
    let results: Vec<Value> = matches
        .iter()
        .map(|record| enemy_search_entry(&raw["enemyData"][&record.enemy_id], &record.enemy_id))
        .collect();
    Ok(json!({
        "scope": "enemies",
        "pattern": pattern,
        "total": total,
        "results": results,
    }))
}

fn enemy_search_entry(info: &Value, enemy_id: &str) -> Value {
    let level_raw = info.get("enemyLevel").and_then(Value::as_str).unwrap_or("");
    let damage_types_raw: Vec<Value> = info
        .get("damageType")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let damage_types_label = damage_types_raw
        .iter()
        .filter_map(Value::as_str)
        .map(|dt| {
            DAMAGE_TYPE_ZH
                .iter()
                .find(|(k, _)| *k == dt)
                .map(|(_, v)| v.to_string())
                .unwrap_or_else(|| dt.to_string())
        })
        .collect::<Vec<_>>()
        .join("、");
    json!({
        "enemy_id": enemy_id,
        "name": info.get("name").and_then(Value::as_str).unwrap_or(""),
        "enemy_index": info.get("enemyIndex").and_then(Value::as_str).unwrap_or(""),
        "level_raw": level_raw,
        "level_label": enemy_level_zh(level_raw),
        "description": info.get("description").and_then(Value::as_str).unwrap_or(""),
        "attack_type": info.get("attackType").and_then(Value::as_str).unwrap_or(""),
        "ability": info.get("ability").and_then(Value::as_str).unwrap_or(""),
        "damage_types_raw": damage_types_raw,
        "damage_types_label": damage_types_label,
        "enemy_tags": info.get("enemyTags").and_then(Value::as_array).cloned().unwrap_or_default(),
    })
}

pub fn render_enemy_search(data: &Value) -> String {
    let pattern = data["pattern"].as_str().unwrap_or("");
    let results = data["results"].as_array().cloned().unwrap_or_default();
    if results.is_empty() {
        return format!("未找到匹配 '{pattern}' 的敌人。");
    }
    let mut lines = vec![format!(
        "# 搜索结果：{pattern}（共 {} 个）\n",
        data["total"].as_i64().unwrap_or(0)
    )];
    for entry in &results {
        lines.push(render_handbook_card(entry, false).join("\n"));
        lines.push(String::new());
    }
    lines.join("\n").trim().to_string()
}
