//! Enemy combat-stats extraction and m_defined override merging — port of
//! TS `data/enemyStats.ts` + `data/gamedataAttrs.ts`.

use crate::storage::frozen::FrozenValue;
use crate::storage::json_view::JsonView;
use serde_json::{json, Map, Value};

use crate::text::numbers::{format_number, js_truthy, json_value_to_string, python_float_string};

/// TS `mValue`: unwrap `{m_defined, m_value}` when present, else the value
/// itself (nullish callers apply their own defaults).
pub fn m_value(obj: Option<&Value>) -> Option<&Value> {
    let obj = obj?;
    if let Some(map) = obj.as_object() {
        if map.contains_key("m_value") {
            return map.get("m_value");
        }
    }
    Some(obj)
}

/// The immunity label set, in the TS object's declaration order.
const IMMUNITY_LABELS: &[(&str, &str)] = &[
    ("stunImmune", "眩晕"),
    ("silenceImmune", "沉默"),
    ("sleepImmune", "睡眠"),
    ("frozenImmune", "冻结"),
    ("levitateImmune", "浮空"),
    ("disarmedCombatImmune", "缴械"),
    ("fearedImmune", "恐惧"),
    ("palsyImmune", "瘫痪"),
    ("attractImmune", "牵引"),
];

fn attr<'a>(db_entry: JsonView<'a>, key: &str) -> Option<JsonView<'a>> {
    db_entry.get("attributes")?.get(key)
}
fn m_view(value: Option<JsonView<'_>>) -> Option<JsonView<'_>> {
    value.map(|v| v.get("m_value").unwrap_or(v))
}
fn m_number(db_entry: JsonView<'_>, key: &str, default: f64) -> f64 {
    m_view(attr(db_entry, key))
        .and_then(JsonView::as_f64)
        .unwrap_or(default)
}
fn truthy_m_value(db_entry: JsonView<'_>, key: &str) -> bool {
    m_view(attr(db_entry, key)).and_then(JsonView::as_bool) == Some(true)
}

/// `extractEnemyStats`: payload field order mirrors the TS interface.
pub fn extract_enemy_stats(db_entry: &Value) -> Value {
    extract_stats(JsonView::Value(db_entry))
}
pub(crate) fn extract_cached_enemy_stats(db_entry: &FrozenValue) -> Value {
    extract_stats(JsonView::Frozen(db_entry))
}
fn extract_stats(db_entry: JsonView<'_>) -> Value {
    let hp = m_number(db_entry, "maxHp", 0.0);
    let atk = m_number(db_entry, "atk", 0.0);
    let def = m_number(db_entry, "def", 0.0);
    let res = m_view(attr(db_entry, "magicResistance")).map(JsonView::to_value);
    let speed = m_number(db_entry, "moveSpeed", 0.0);
    let atk_time = m_number(db_entry, "baseAttackTime", 0.0);
    let atk_speed = m_number(db_entry, "attackSpeed", 100.0);
    let mass = m_number(db_entry, "massLevel", 0.0);
    let hp_rec = m_number(db_entry, "hpRecoveryPerSec", 0.0);
    let lpr = m_number(db_entry, "lifePointReduce", 0.0);

    let immunities: Vec<&str> = IMMUNITY_LABELS
        .iter()
        .filter(|(key, _)| truthy_m_value(db_entry, key))
        .map(|(_, label)| *label)
        .collect();

    let skills: Vec<Value> = db_entry
        .get("skills")
        .into_iter()
        .flat_map(JsonView::array)
        .map(|s| {
            let prefab = s
                .get("prefabKey")
                .and_then(JsonView::as_str)
                .unwrap_or("未知");
            // `if (cd)` / `if (initCd && initCd !== cd)` / `if (spCost)` are
            // JS truthiness gates, template-literal stringification.
            let cd = s.get("cooldown").filter(|v| v.truthy());
            let init_cd = s.get("initCooldown").filter(|v| v.truthy());
            let sp_cost =
                m_view(s.get("spData").and_then(|v| v.get("spCost"))).filter(|v| v.truthy());
            let mut cd_parts: Vec<String> = Vec::new();
            if let Some(cd) = cd {
                cd_parts.push(format!("冷却 {}s", json_value_to_string(&cd.to_value())));
            }
            if let Some(init_cd) = init_cd {
                let same_as_cd = cd.is_some_and(|c| c.to_value() == init_cd.to_value());
                if !same_as_cd {
                    cd_parts.push(format!(
                        "初始 {}s",
                        json_value_to_string(&init_cd.to_value())
                    ));
                }
            }
            if let Some(sp) = sp_cost {
                cd_parts.push(format!("SP {}", json_value_to_string(&sp.to_value())));
            }
            let bb_strs: Vec<String> = s
                .get("blackboard")
                .into_iter()
                .flat_map(JsonView::array)
                .take(6)
                .filter(|b| !b.get("value").is_none_or(JsonView::is_null))
                .map(|b| {
                    let value = match b.get("value") {
                        Some(n) if n.is_number() => python_float_string(&n.to_value()),
                        Some(other) => json_value_to_string(&other.to_value()),
                        None => String::new(),
                    };
                    format!(
                        "{}={}",
                        b.get("key").and_then(JsonView::as_str).unwrap_or(""),
                        value
                    )
                })
                .collect();
            json!({
                "prefab": prefab,
                "timing": cd_parts.join("，"),
                "blackboard": bb_strs.join("，"),
            })
        })
        .collect();

    let hp_value = if hp != 0.0 {
        json!(with_thousands_str(hp))
    } else {
        Value::Null
    };
    json!({
        "max_hp": hp_value,
        "atk": if atk != 0.0 { json!(num_str(atk)) } else { Value::Null },
        "def": if def != 0.0 { json!(num_str(def)) } else { Value::Null },
        "resistance": match res.as_ref() {
            Some(v) if !v.is_null() => json!(python_float_string(v)),
            _ => Value::Null,
        },
        "move_speed": if speed != 0.0 { json!(python_float_string(&json!(speed))) } else { Value::Null },
        "attack_interval": if atk_time != 0.0 {
            json!(format!("{}s", python_float_string(&json!(atk_time))))
        } else {
            Value::Null
        },
        "attack_speed": if atk_speed != 100.0 { json!(python_float_string(&json!(atk_speed))) } else { Value::Null },
        "mass_level": if mass != 0.0 { json!(num_str(mass)) } else { Value::Null },
        "hp_recovery_per_sec": if hp_rec != 0.0 { json!(python_float_string(&json!(hp_rec))) } else { Value::Null },
        "immunities": immunities,
        "life_point_reduce": if lpr != 0.0 { json!(num_str(lpr)) } else { Value::Null },
        "skills": skills,
    })
}

fn num_str(v: f64) -> String {
    crate::text::numbers::js_number_to_string(v)
}

fn with_thousands_str(v: f64) -> String {
    crate::text::numbers::with_thousands(v)
}

// ---------------------------------------------------------------------------
// m_defined override merging (stageEnemy path)
// ---------------------------------------------------------------------------

/// Deep-merge a stage's overwritten enemyData onto the database baseline:
/// `{m_defined: false}` overrides are skipped, `{m_defined: true}` replaces
/// with m_value, plain objects merge recursively.
pub fn merge_defined(base: &Value, r#override: &Value) -> Value {
    if !r#override.is_object() {
        return base.clone();
    }
    let override_record = r#override.as_object().expect("checked");
    if override_record.contains_key("m_defined") && override_record.contains_key("m_value") {
        if override_record.get("m_defined") == Some(&Value::Bool(true)) {
            return override_record
                .get("m_value")
                .cloned()
                .unwrap_or(Value::Null);
        }
        return base.clone();
    }
    let mut merged = Map::new();
    if let Some(base_map) = base.as_object() {
        for (k, v) in base_map {
            merged.insert(k.clone(), v.clone());
        }
    }
    for (key, value) in override_record {
        // `{m_defined: false}`-shaped values are skipped at any depth.
        if let Some(vm) = value.as_object() {
            if vm.get("m_defined") == Some(&Value::Bool(false)) {
                continue;
            }
        }
        let old = merged.get(key).cloned().unwrap_or(Value::Null);
        merged.insert(key.clone(), merge_defined(&old, value));
    }
    Value::Object(merged)
}

/// Resolve the effective enemyData for one enemy at one stage level.
pub fn stage_specific_enemy_data(
    levels: Option<&crate::domain::enemy_db::OrderedMap<crate::domain::enemy_db::LevelMap>>,
    enemy_id: &str,
    level: i64,
    overwritten: Option<&Value>,
) -> Option<Value> {
    let db_entry = levels.and_then(|l| l.get(enemy_id));
    let base = db_entry
        .and_then(|m| m.get(&level).or_else(|| m.get(&0)))
        .filter(|v| v.is_object());
    merge_selected_enemy_data(base, overwritten)
}

pub(crate) fn cached_stage_specific_enemy_data(
    levels: Option<&super::enemy_cache::EnemyDatabase>,
    enemy_id: &str,
    level: i64,
    overwritten: Option<&Value>,
) -> Option<Value> {
    let base = levels
        .and_then(|db| db.stage_entry(enemy_id, level))
        .map(FrozenValue::to_value);
    merge_selected_enemy_data(base.as_ref(), overwritten)
}

fn merge_selected_enemy_data(base: Option<&Value>, overwritten: Option<&Value>) -> Option<Value> {
    let Some(base) = base else {
        return overwritten.filter(|v| v.is_object()).cloned();
    };
    let overwritten = overwritten.unwrap_or(&Value::Null);
    let merged = merge_defined(base, overwritten);
    if merged.is_object() {
        Some(merged)
    } else {
        Some(base.clone())
    }
}

/// The overwritten display name (`name` or `prefabKey`, m_value unwrapped).
pub fn overwritten_enemy_name(overwritten: Option<&Value>) -> Option<String> {
    let record = overwritten.filter(|v| v.is_object())?;
    let name = record.get("name").or_else(|| record.get("prefabKey"))?;
    let value = m_value(Some(name))?;
    // `return value ? String(value) : null` — truthiness gate.
    js_truthy(value).then(|| json_value_to_string(value))
}

/// One-line compact stat summary for stage-enemies listings.
pub fn format_stats(enemy_data: Option<&Value>) -> String {
    let Some(data) = enemy_data else {
        return "无数据库记录".to_string();
    };
    let attrs = data.get("attributes").cloned().unwrap_or(json!({}));
    let get_m = |key: &str| m_value(attrs.get(key)).cloned();
    let hp = get_m("maxHp");
    let atk = get_m("atk");
    let defense = get_m("def");
    let res = get_m("magicResistance");
    let speed = get_m("moveSpeed");
    let atk_time = get_m("baseAttackTime");
    let as_str = |v: Option<Value>| format_number(&v.unwrap_or(Value::Null));
    let mut parts = vec![
        format!("HP {}", as_str(hp.clone())),
        format!("ATK {}", as_str(atk.clone())),
        format!("DEF {}", as_str(defense.clone())),
        format!("RES {}", as_str(res.clone())),
    ];
    if let Some(speed) = speed {
        if speed.as_f64().is_some_and(|s| s != 0.0) {
            parts.push(format!("移速 {}", python_float_string(&speed)));
        }
    }
    if let Some(atk_time) = atk_time {
        if atk_time.as_f64().is_some_and(|t| t != 0.0) {
            parts.push(format!("攻击间隔 {}s", python_float_string(&atk_time)));
        }
    }
    parts.join("；")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_stats_payload() {
        let entry = json!({
            "attributes": {
                "maxHp": {"m_defined": true, "m_value": 25000},
                "atk": {"m_defined": true, "m_value": 420},
                "def": {"m_defined": true, "m_value": 250},
                "magicResistance": {"m_defined": true, "m_value": 50.0},
                "moveSpeed": {"m_defined": true, "m_value": 0.5},
                "baseAttackTime": {"m_defined": true, "m_value": 3.7},
                "stunImmune": {"m_defined": true, "m_value": true},
                "frozenImmune": {"m_defined": true, "m_value": true},
            },
            "skills": [{
                "prefabKey": "ArcticBlast",
                "cooldown": 8.5,
                "blackboard": [
                    {"key": "duration", "value": 8.0},
                    {"key": "atk_scale", "value": 1.5},
                ],
            }],
        });
        let stats = extract_enemy_stats(&entry);
        assert_eq!(stats["max_hp"], "25,000");
        assert_eq!(stats["atk"], "420");
        assert_eq!(stats["resistance"], "50.0");
        assert_eq!(stats["move_speed"], "0.5");
        assert_eq!(stats["attack_interval"], "3.7s");
        assert_eq!(stats["attack_speed"], Value::Null);
        assert_eq!(stats["immunities"], json!(["眩晕", "冻结"]));
        assert_eq!(stats["skills"][0]["prefab"], "ArcticBlast");
        assert_eq!(stats["skills"][0]["timing"], "冷却 8.5s");
        assert_eq!(
            stats["skills"][0]["blackboard"],
            "duration=8.0，atk_scale=1.5"
        );
    }

    #[test]
    fn merge_defined_semantics() {
        let base = json!({"attributes": {"maxHp": 550, "atk": 130, "def": 0}});
        let r#override = json!({"attributes": {
            "def": {"m_defined": true, "m_value": 30},
            "atk": {"m_defined": false, "m_value": 0},
        }});
        let merged = merge_defined(&base, &r#override);
        assert_eq!(merged["attributes"]["def"], 30);
        assert_eq!(merged["attributes"]["atk"], 130); // m_defined:false skipped
        assert_eq!(merged["attributes"]["maxHp"], 550);
    }

    #[test]
    fn format_stats_compact() {
        let data = json!({"attributes": {
            "maxHp": {"m_defined": true, "m_value": 1234},
            "atk": {"m_defined": true, "m_value": 321},
            "def": {"m_defined": true, "m_value": 45},
            "magicResistance": {"m_defined": true, "m_value": 10},
        }});
        assert_eq!(
            format_stats(Some(&data)),
            "HP 1,234；ATK 321；DEF 45；RES 10"
        );
        assert_eq!(format_stats(None), "无数据库记录");
    }
}
