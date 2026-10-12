//! Stage/enemy cross-source fusion — port of TS `data/stageEnemy.ts`.

use std::path::Path;
use std::sync::Arc;

use serde_json::{json, Value};

use crate::app::DataView;
use crate::domain::enemy::{db_levels, handbook, name_to_enemy_id};
use crate::domain::enemy_db::parse_level;
use crate::domain::enemy_stats::{format_stats, overwritten_enemy_name, stage_specific_enemy_data};
use crate::domain::level_parser::{enemy_refs, level_path, spawn_counts};
use crate::domain::messages;
use crate::domain::stage::stages_map;
use crate::storage::{DirectoryStore, JsonStore};

/// TS `levelsStore()`: rooted at `<effectiveLevelsPath>/zh_CN/gamedata/levels`
/// (the view's levels_root IS effectiveLevelsPath — the data root, not the
/// levels subdir).
fn levels_store(view: &DataView) -> Option<DirectoryStore> {
    view.levels_root
        .as_ref()
        .map(|root| DirectoryStore::new(root.join("zh_CN").join("gamedata").join("levels")))
}

/// TS prints the STATIC sync target in the missing message, not the
/// effective generation dir — the tool layer passes it in.
fn load_level_json(view: &DataView, stage: &Value) -> Result<Value, String> {
    let Some(level_id) = stage.get("levelId").and_then(Value::as_str) else {
        return Err("该关卡没有 levelId，可能是非战斗/特殊关卡。".to_string());
    };
    let path = level_path(level_id);
    let Some(store) = levels_store(view) else {
        return Err(format!("未找到关卡战斗文件：{path}。"));
    };
    if !store.exists(&path).unwrap_or(false) {
        return Err(format!("未找到关卡战斗文件：{path}。"));
    }
    let raw = store.read_json(&path).map_err(|e| e.to_string())?;
    if !raw.is_object() {
        return Err(format!("关卡战斗文件格式异常：{path}。"));
    }
    Ok(raw)
}

fn handbook_name(view: &DataView, enemy_id: &str) -> String {
    handbook(view)
        .ok()
        .and_then(|h| {
            h.pointer("/enemyData")
                .and_then(Value::as_object)
                .and_then(|d| d.get(enemy_id))
                .and_then(|e| e.get("name").and_then(Value::as_str).map(str::to_string))
        })
        .unwrap_or_else(|| enemy_id.to_string())
}

fn stage_label(stage: &Value, stage_id: &str) -> String {
    let name = stage
        .get("name")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or("（无名）");
    let code = stage
        .get("code")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or(stage_id);
    format!("{name} {code}（{stage_id}）")
}

/// count desc, then ICU localeCompare on the enemy id (the documented
/// sort-collision divergence from codepoint order).
fn sorted_counts(counts: &crate::domain::enemy_db::OrderedMap<i64>) -> Vec<(String, i64)> {
    let mut entries: Vec<(String, i64)> = counts
        .iter()
        .map(|(id, count)| (id.to_string(), *count))
        .collect();
    entries.sort_by(|a, b| {
        b.1.cmp(&a.1)
            .then_with(|| crate::text::js_compat::locale_compare(&a.0, &b.0))
    });
    entries
}

struct StageEnemySources {
    stage: Value,
    counts: crate::domain::enemy_db::OrderedMap<i64>,
    /// enemyDbRefs keyed by id: (level, overwrittenData) — owned copies so
    /// the struct has no self-borrow.
    owned_refs: std::collections::BTreeMap<String, (Option<Value>, Option<Value>)>,
}

/// Shared load for getStageEnemies / getEnemyStageInfo; `Err` carries the
/// exact message text.
fn load_stage_sources(view: &DataView, stage_id: &str) -> Result<StageEnemySources, String> {
    let stages = stages_map(view).map_err(|message| format!("读取关卡敌人失败：{message}"))?;
    let Some(stage) = stages.get(stage_id) else {
        return Err(format!(
            "未找到关卡：{}。",
            serde_json::to_string(stage_id).unwrap_or_default()
        ));
    };
    let stage = stage.clone();
    let level = load_level_json(view, &stage)?;
    let counts = spawn_counts(&level);
    let owned_refs: std::collections::BTreeMap<String, (Option<Value>, Option<Value>)> =
        enemy_refs(&level)
            .iter()
            .map(|(id, r)| (id.clone(), (r.level.cloned(), r.overwritten_data.cloned())))
            .collect();
    Ok(StageEnemySources {
        stage,
        counts,
        owned_refs,
    })
}

impl StageEnemySources {
    fn ref_of(&self, enemy_id: &str) -> Option<OwnedEnemyRef<'_>> {
        self.owned_refs
            .get(enemy_id)
            .map(|(level, overwritten)| OwnedEnemyRef {
                level: level.as_ref(),
                overwritten_data: overwritten.as_ref(),
            })
    }
}

struct OwnedEnemyRef<'a> {
    level: Option<&'a Value>,
    overwritten_data: Option<&'a Value>,
}

/// `buildStageEnemies`: Err carries the exact message text.
pub fn build_stage_enemies(
    view: &DataView,
    levels_path: &Path,
    stage_id: &str,
) -> Result<Value, String> {
    if view.levels_root.is_none() {
        return Err(messages::levels_missing_message("关卡战斗", levels_path));
    }
    let sources = load_stage_sources(view, stage_id)?;

    if sources.counts.is_empty() {
        return Ok(json!({
            "stage_id": stage_id,
            "stage_label": stage_label(&sources.stage, stage_id),
            "total": 0,
            "enemies": [],
            "empty_reason": "no_match",
        }));
    }

    let db = db_levels(view)?;
    let enemies: Vec<Value> = sorted_counts(&sources.counts)
        .into_iter()
        .map(|(enemy_id, count)| {
            let r#ref = sources.ref_of(&enemy_id);
            let level_no = parse_level(r#ref.as_ref().and_then(|r| r.level));
            let data = stage_specific_enemy_data(
                Some(&db),
                &enemy_id,
                level_no,
                r#ref.as_ref().and_then(|r| r.overwritten_data),
            );
            let name = overwritten_enemy_name(r#ref.as_ref().and_then(|r| r.overwritten_data))
                .unwrap_or_else(|| handbook_name(view, &enemy_id));
            json!({
                "enemy_id": enemy_id,
                "name": name,
                "count": count,
                "level": level_no,
                "overwritten": r#ref.as_ref().and_then(|r| r.overwritten_data).is_some(),
                "stats_text": format_stats(data.as_ref()),
            })
        })
        .collect();

    Ok(json!({
        "stage_id": stage_id,
        "stage_label": stage_label(&sources.stage, stage_id),
        "total": enemies.len(),
        "enemies": enemies,
    }))
}

pub fn render_stage_enemies(data: &Value) -> String {
    if data["empty_reason"].as_str() == Some("no_match") {
        return format!(
            "关卡 {} 未解析到实际出怪。",
            serde_json::to_string(data["stage_id"].as_str().unwrap_or_default())
                .unwrap_or_default()
        );
    }
    let mut lines = vec![format!(
        "# {} — 敌人列表",
        data["stage_label"].as_str().unwrap_or("")
    )];
    for enemy in data["enemies"].as_array().cloned().unwrap_or_default() {
        lines.push(format!(
            "\n## {}（{}）",
            enemy["name"].as_str().unwrap_or(""),
            enemy["enemy_id"].as_str().unwrap_or("")
        ));
        lines.push(format!(
            "- **出场数量**：{}",
            enemy["count"].as_i64().unwrap_or(0)
        ));
        lines.push(format!(
            "- **敌人等级**：{}",
            enemy["level"].as_i64().unwrap_or(0)
        ));
        if enemy["overwritten"].as_bool().unwrap_or(false) {
            lines.push("- **关卡覆盖**：是".to_string());
        }
        lines.push(format!(
            "- **战斗属性**：{}",
            enemy["stats_text"].as_str().unwrap_or("")
        ));
    }
    lines.join("\n")
}

// ---------------------------------------------------------------------------
// get_enemy_appearances (reverse index)
// ---------------------------------------------------------------------------

fn enemy_appearance_index(view: &DataView) -> Result<Arc<AppearanceIndex>, String> {
    view.datasets.get_or_load_counted(
        "stage_enemy:enemy_appearance_index",
        || {
            let stages = stages_map(view)?;
            let Some(store) = levels_store(view) else {
                return Ok(crate::domain::enemy_db::OrderedMap::new());
            };
            let mut index = crate::domain::enemy_db::OrderedMap::new();
            for (stage_id, stage) in stages.iter() {
                if stage.get("levelId").and_then(Value::as_str).is_none() {
                    continue;
                }
                let path = level_path(
                    stage
                        .get("levelId")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                );
                if !store.exists(&path).unwrap_or(false) {
                    continue;
                }
                let Ok(level) = store.read_json(&path) else {
                    continue;
                };
                if !level.is_object() {
                    continue;
                }
                for (enemy_id, count) in spawn_counts(&level).iter() {
                    let mut entry: Vec<(String, i64)> =
                        index.get(enemy_id).cloned().unwrap_or_default();
                    entry.push((stage_id.clone(), *count));
                    index.insert(enemy_id, entry);
                }
            }
            Ok(index)
        },
        |index| index.len() as u64,
    )
}

/// enemyId → [(stageId, spawn count)] in stage-table + level-file order.
type AppearanceIndex = crate::domain::enemy_db::OrderedMap<Vec<(String, i64)>>;

/// resolveEnemyId: name map first, then a raw enemyData key pass-through.
fn resolve_enemy_id(view: &DataView, name: &str) -> Result<Option<String>, String> {
    if let Some(id) = name_to_enemy_id(view)?
        .iter()
        .find(|(n, _)| n == name)
        .map(|(_, id)| id.clone())
    {
        return Ok(Some(id));
    }
    let handbook = handbook(view)?;
    Ok(handbook
        .pointer("/enemyData")
        .and_then(Value::as_object)
        .is_some_and(|d| d.contains_key(name))
        .then(|| name.to_string()))
}

/// `buildEnemyAppearances`: Err carries the exact message text.
pub fn build_enemy_appearances(
    view: &DataView,
    levels_path: &Path,
    name: &str,
    limit: i64,
    offset: i64,
) -> Result<Value, String> {
    if let Some(err) = messages::validate_bounds("limit", limit, Some(1), Some(200))
        .or_else(|| messages::validate_bounds("offset", offset, Some(0), None))
    {
        return Err(err);
    }
    if view.levels_root.is_none() {
        return Err(messages::levels_missing_message("关卡战斗", levels_path));
    }
    let enemy_id = match resolve_enemy_id(view, name) {
        Ok(Some(id)) => id,
        Ok(None) => {
            return Err(format!(
                "未找到敌人：{}。",
                serde_json::to_string(name).unwrap_or_default()
            ))
        }
        Err(message) => return Err(format!("读取敌人出场关卡失败：{message}")),
    };
    let appearances = match enemy_appearance_index(view) {
        Ok(index) => index.get(&enemy_id).cloned().unwrap_or_default(),
        Err(message) => return Err(format!("读取敌人出场关卡失败：{message}")),
    };
    let stages = match stages_map(view) {
        Ok(s) => s,
        Err(message) => return Err(format!("读取敌人出场关卡失败：{message}")),
    };

    let total = appearances.len();
    let start = (offset.max(0) as usize).min(total);
    let end = (offset + limit).max(0).clamp(0, total as i64) as usize;
    let page = &appearances[start..end];
    let enemy_name = handbook_name(view, &enemy_id);
    if page.is_empty() {
        return Ok(json!({
            "enemy_id": enemy_id,
            "enemy_name": enemy_name,
            "total": total,
            "offset": offset,
            "limit": limit,
            "stages": [],
            "empty_reason": if total == 0 { "no_match" } else { "offset_out_of_range" },
        }));
    }

    let stage_entries: Vec<Value> = page
        .iter()
        .map(|(stage_id, count)| {
            let stage = stages.get(stage_id).cloned().unwrap_or_else(|| json!({}));
            json!({
                "stage_id": stage_id,
                "stage_name": stage.get("name").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or("（无名）"),
                "code": stage.get("code").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or(stage_id),
                "count": count,
            })
        })
        .collect();

    Ok(json!({
        "enemy_id": enemy_id,
        "enemy_name": enemy_name,
        "total": total,
        "offset": offset,
        "limit": limit,
        "stages": stage_entries,
    }))
}

pub fn render_enemy_appearances(data: &Value) -> String {
    if data["empty_reason"].as_str() == Some("no_match") {
        return format!(
            "未找到 {}（{}）的实际出场关卡。",
            data["enemy_name"].as_str().unwrap_or(""),
            data["enemy_id"].as_str().unwrap_or("")
        );
    }
    if data["empty_reason"].as_str() == Some("offset_out_of_range") {
        return format!(
            "offset {} 超出范围（共 {} 条）。",
            data["offset"].as_i64().unwrap_or(0),
            data["total"].as_i64().unwrap_or(0)
        );
    }
    let mut lines = vec![format!(
        "# {}（{}）— 出场关卡（共 {} 个）",
        data["enemy_name"].as_str().unwrap_or(""),
        data["enemy_id"].as_str().unwrap_or(""),
        data["total"].as_i64().unwrap_or(0)
    )];
    for stage in data["stages"].as_array().cloned().unwrap_or_default() {
        lines.push(format!(
            "- **{}** {}（{}）：{} 个",
            stage["stage_name"].as_str().unwrap_or(""),
            stage["code"].as_str().unwrap_or(""),
            stage["stage_id"].as_str().unwrap_or(""),
            stage["count"].as_i64().unwrap_or(0)
        ));
    }
    let offset = data["offset"].as_i64().unwrap_or(0);
    let limit = data["limit"].as_i64().unwrap_or(0);
    let total = data["total"].as_i64().unwrap_or(0);
    lines.push(format!(
        "\n（显示第 {}–{} 条，共 {total} 条。使用 offset={} 查看下一页）",
        offset + 1,
        (offset + limit).min(total),
        offset + limit
    ));
    lines.join("\n")
}

// ---------------------------------------------------------------------------
// getEnemyStageInfo (enemy + stage_id path — pure text result)
// ---------------------------------------------------------------------------

pub fn get_enemy_stage_info(
    view: &DataView,
    levels_path: &Path,
    name: &str,
    stage_id: &str,
) -> String {
    if view.levels_root.is_none() {
        return messages::levels_missing_message("关卡战斗", levels_path);
    }
    let enemy_id = match resolve_enemy_id(view, name) {
        Ok(Some(id)) => id,
        Ok(None) => {
            return format!(
                "未找到敌人：{}。",
                serde_json::to_string(name).unwrap_or_default()
            )
        }
        Err(message) => return format!("读取关卡敌人失败：{message}"),
    };
    let sources = match load_stage_sources(view, stage_id) {
        Ok(s) => s,
        Err(message) => return message,
    };

    let Some(count) = sources.counts.get(&enemy_id).copied() else {
        return format!(
            "{}（{enemy_id}）未在关卡 {} 实际出场。",
            handbook_name(view, &enemy_id),
            serde_json::to_string(stage_id).unwrap_or_default()
        );
    };
    let Some(r#ref) = sources.ref_of(&enemy_id) else {
        return format!(
            "关卡 {} 缺少 {enemy_id} 的 enemyDbRefs。",
            serde_json::to_string(stage_id).unwrap_or_default()
        );
    };

    let level_no = parse_level(r#ref.level);
    let db = match db_levels(view) {
        Ok(db) => db,
        Err(message) => return format!("读取关卡敌人失败：{message}"),
    };
    let data = stage_specific_enemy_data(Some(&db), &enemy_id, level_no, r#ref.overwritten_data);
    let enemy_name = overwritten_enemy_name(r#ref.overwritten_data)
        .unwrap_or_else(|| handbook_name(view, &enemy_id));
    let mut lines = vec![format!(
        "# {enemy_name}（{enemy_id}）@ {}",
        stage_label(&sources.stage, stage_id)
    )];
    lines.push(format!("- **出场数量**：{count}"));
    lines.push(format!("- **敌人等级**：{level_no}"));
    if r#ref.overwritten_data.is_some() {
        lines.push("- **关卡覆盖**：是".to_string());
    }
    lines.push(format!("- **战斗属性**：{}", format_stats(data.as_ref())));
    lines.join("\n")
}
