//! Normalize enemy combat databases — port of TS `data/enemyDatabase.ts`.
//!
//! The legacy archive wraps rows in `{enemies: [{Key, Value}]}` while AKDP
//! releases the equivalent `{enemyId: Value[]}` mapping directly.

use std::collections::{BTreeMap, HashMap};

use crate::storage::projection::Projection;
use serde_json::Value;

// Only combat stats consume normalized enemyData. Stage display names come
// from the handbook or the level's explicit overwrittenData, not this table.
const COMBAT_ATTRIBUTES: Projection = Projection::Fields(&[
    ("maxHp", Projection::All),
    ("atk", Projection::All),
    ("def", Projection::All),
    ("magicResistance", Projection::All),
    ("moveSpeed", Projection::All),
    ("baseAttackTime", Projection::All),
    ("attackSpeed", Projection::All),
    ("massLevel", Projection::All),
    ("hpRecoveryPerSec", Projection::All),
    ("lifePointReduce", Projection::All),
    ("stunImmune", Projection::All),
    ("silenceImmune", Projection::All),
    ("sleepImmune", Projection::All),
    ("frozenImmune", Projection::All),
    ("levitateImmune", Projection::All),
    ("disarmedCombatImmune", Projection::All),
    ("fearedImmune", Projection::All),
    ("palsyImmune", Projection::All),
    ("attractImmune", Projection::All),
]);
const ENEMY_DATA: Projection = Projection::Fields(&[
    ("attributes", COMBAT_ATTRIBUTES),
    ("skills", Projection::All),
]);
const LEVEL_ROW: Projection =
    Projection::Fields(&[("level", Projection::All), ("enemyData", ENEMY_DATA)]);
// Both direct ID -> levels and legacy {enemies: [{Key, Value}]} roots.
const DATABASE_ROW: Projection = Projection::Fields(&[
    ("level", Projection::All),
    ("enemyData", ENEMY_DATA),
    ("Key", Projection::All),
    ("Value", Projection::Elements(&LEVEL_ROW)),
]);
pub(crate) const DATABASE_PROJECTION: Projection =
    Projection::Values(&Projection::Elements(&DATABASE_ROW));

/// Best-effort int conversion for level numbers (bad values → 0) — TS
/// `parseLevel`: Number(value ?? 0), truncated when finite.
pub fn parse_level(value: Option<&Value>) -> i64 {
    let n = match value {
        None | Some(Value::Null) => 0.0,
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => s.parse::<f64>().unwrap_or(f64::NAN),
        Some(Value::Bool(b)) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        // Objects/arrays coerce to NaN in JS; game data only exercises
        // numbers/strings/null here.
        Some(_) => f64::NAN,
    };
    if n.is_finite() {
        n.trunc() as i64
    } else {
        0
    }
}

/// Insertion-ordered String-keyed map — JS object iteration order for the
/// appearance/handbook walks that inherit the JSON file's key order.
#[derive(Debug, Clone, Default)]
pub struct OrderedMap<V> {
    entries: Vec<(String, V)>,
    index: HashMap<String, usize>,
}

impl<V> OrderedMap<V> {
    pub fn new() -> Self {
        Self {
            entries: Vec::new(),
            index: HashMap::new(),
        }
    }

    pub fn insert(&mut self, key: impl Into<String>, value: V) -> Option<V> {
        let key = key.into();
        match self.index.get(&key) {
            Some(&pos) => Some(std::mem::replace(&mut self.entries[pos].1, value)),
            None => {
                self.index.insert(key.clone(), self.entries.len());
                self.entries.push((key, value));
                None
            }
        }
    }

    pub fn get(&self, key: &str) -> Option<&V> {
        self.index.get(key).map(|&pos| &self.entries[pos].1)
    }

    pub fn get_mut(&mut self, key: &str) -> Option<&mut V> {
        let pos = *self.index.get(key)?;
        Some(&mut self.entries[pos].1)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &V)> {
        self.entries.iter().map(|(k, v)| (k.as_str(), v))
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// Per-enemy level → enemyData map. JS integer-like object keys iterate in
/// ascending numeric order, which BTreeMap reproduces exactly.
pub type LevelMap = BTreeMap<i64, Value>;

/// Normalize a supported enemy_database.json payload into an ID/level index.
pub fn normalize_enemy_database(raw: Value) -> Result<OrderedMap<LevelMap>, String> {
    let Value::Object(mut root) = raw else {
        return Err("enemy_database.json 格式异常：根节点必须是对象。".to_string());
    };

    let mut index = OrderedMap::new();
    if root.get("enemies").is_some_and(Value::is_array) {
        let Value::Array(rows) = root["enemies"].take() else {
            unreachable!("validated enemies array")
        };
        for row in rows {
            // `if (!row?.Key) continue` — empty keys are falsy and skip.
            let Some(key) = row
                .get("Key")
                .and_then(Value::as_str)
                .filter(|k| !k.is_empty())
            else {
                continue;
            };
            let key = key.to_string();
            let mut row = row;
            let values = row.get_mut("Value").map(Value::take);
            add_row(&mut index, &key, values);
        }
        return Ok(index);
    }

    for (enemy_id, values) in root {
        add_row(&mut index, &enemy_id, Some(values));
    }
    if index.is_empty() {
        return Err("enemy_database.json 格式异常：未找到敌人等级数据。".to_string());
    }
    Ok(index)
}

fn add_row(index: &mut OrderedMap<LevelMap>, enemy_id: &str, values: Option<Value>) {
    let Some(Value::Array(values)) = values else {
        return;
    };
    let mut level_map = LevelMap::new();
    for mut value in values {
        if !value.is_object() {
            continue;
        }
        let level = parse_level(value.get("level"));
        let Some(enemy_data) = value.get_mut("enemyData").filter(|d| d.is_object()) else {
            continue;
        };
        level_map.insert(level, enemy_data.take());
    }
    if !level_map.is_empty() {
        index.insert(enemy_id, level_map);
    }
}

/// Borrow the default (level-0) entry for one enemy.
/// Selection semantics replicate the historical projection verbatim
/// (nullish `??`): level 0 falls back to the FIRST value in ascending key
/// order — JS integer-key objects iterate that way.
pub fn default_entry<'a>(levels: &'a OrderedMap<LevelMap>, enemy_id: &str) -> Option<&'a Value> {
    let level_map = levels.get(enemy_id)?;
    level_map
        .get(&0)
        .or_else(|| level_map.values().next())
        .filter(|v| v.is_object())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_legacy_and_direct_shapes() {
        let legacy = json!({"enemies": [
            {"Key": "e1", "Value": [{"level": 0, "enemyData": {"attributes": {}}}]},
            {"Key": "", "Value": [{"level": 0, "enemyData": {"x": 1}}]},
            {"Value": [{"level": 0, "enemyData": {}}]},
        ]});
        let idx = normalize_enemy_database(legacy).unwrap();
        assert_eq!(idx.len(), 1);

        let direct = json!({"e1": [{"level": "bad", "enemyData": {"a": 1}}]});
        let idx = normalize_enemy_database(direct).unwrap();
        let levels = idx.get("e1").unwrap();
        assert!(levels.contains_key(&0)); // "bad" → 0

        let bad = json!([1, 2]);
        assert!(normalize_enemy_database(bad).is_err());
        let empty = json!({});
        assert!(normalize_enemy_database(empty).is_err());
    }

    #[test]
    fn level0_projection_uses_first_value_aside_from_zero() {
        let mut levels = LevelMap::new();
        levels.insert(2, json!({"hi": 2}));
        levels.insert(5, json!({"hi": 5}));
        let mut idx = OrderedMap::new();
        idx.insert("e", levels);
        assert_eq!(default_entry(&idx, "e").unwrap(), &json!({"hi": 2}));
        assert!(default_entry(&idx, "missing").is_none());

        let mut levels = LevelMap::new();
        levels.insert(3, json!({"hi": 3}));
        levels.insert(0, json!({"hi": 0}));
        let mut idx = OrderedMap::new();
        idx.insert("e", levels);
        assert_eq!(default_entry(&idx, "e").unwrap(), &json!({"hi": 0}));
    }

    #[test]
    fn normalization_keeps_order_last_duplicate_and_malformed_row_rules() {
        let raw = json!({"enemies": [
            {"Key":"b","Value":[{"level":0,"enemyData":{"old":true}}]},
            {"Key":"a","Value":[{"level":2,"enemyData":{"value":2}}]},
            {"Key":"b","Value":[null, {"level":0,"enemyData":[]},
                {"level":0,"enemyData":{"value":3}},
                {"level":0,"enemyData":{"value":4}},
                {"level":2,"enemyData":{"value":5}}]},
            {"Key":"b","Value":null},
            {"Key":"invalid","Value":[{"enemyData":null}]}
        ]});
        let normalized = normalize_enemy_database(raw).unwrap();
        assert_eq!(
            normalized.iter().map(|(id, _)| id).collect::<Vec<_>>(),
            ["b", "a"]
        );
        assert_eq!(default_entry(&normalized, "b"), Some(&json!({"value":4})));
        assert_eq!(default_entry(&normalized, "a"), Some(&json!({"value":2})));
        assert_eq!(
            normalized.get("b").unwrap().get(&2),
            Some(&json!({"value":5}))
        );
        assert!(normalize_enemy_database(json!({"enemies":[]}))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn combat_projection_preserves_default_and_stage_override_stats() {
        use crate::domain::enemy_stats::{extract_enemy_stats, stage_specific_enemy_data};
        let levels = json!([
            {"level":0,"enemyData":{"name":{"m_value":"unused"},"attributes":{
                "maxHp":{"m_defined":true,"m_value":200},
                "atk":{"m_value":40},"stunImmune":{"m_value":true},
                "unused":{"nested":[1,2,3]}},"skills":[{"prefabKey":"test","blackboard":[]}]}},
            {"level":2,"enemyData":{"attributes":{"maxHp":{"m_value":500}},"skills":null}},
            {"level":9,"enemyData":null},
            null
        ]);
        for raw in [
            json!({"enemy":levels}),
            json!({"enemies":[{"Key":"enemy","Value":levels}]}),
        ] {
            let full = normalize_enemy_database(raw.clone()).unwrap();
            let projected =
                crate::storage::projection::from_str(&raw.to_string(), DATABASE_PROJECTION)
                    .unwrap();
            let compact = normalize_enemy_database(projected).unwrap();
            assert_eq!(
                extract_enemy_stats(default_entry(&full, "enemy").unwrap()),
                extract_enemy_stats(default_entry(&compact, "enemy").unwrap())
            );
            for level in [0, 2, 8] {
                for overrides in [
                    json!(null),
                    json!({"attributes":{"maxHp":{"m_defined":true,"m_value":123},"atk":{"m_defined":false,"m_value":9}}}),
                    json!({"skills":[]}),
                ] {
                    let a =
                        stage_specific_enemy_data(Some(&full), "enemy", level, Some(&overrides))
                            .unwrap();
                    let b =
                        stage_specific_enemy_data(Some(&compact), "enemy", level, Some(&overrides))
                            .unwrap();
                    assert_eq!(extract_enemy_stats(&a), extract_enemy_stats(&b));
                }
            }
        }
    }
}
