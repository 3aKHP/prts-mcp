//! The same enemy ID/level selection as enemy_db, backed by immutable JSON.
use super::enemy_db::{parse_level, OrderedMap};
use crate::storage::frozen::FrozenValue;
use std::collections::BTreeMap;

type Levels = BTreeMap<i64, FrozenValue>;
pub struct EnemyDatabase {
    entries: OrderedMap<Levels>,
}
impl EnemyDatabase {
    pub fn empty() -> Self {
        Self {
            entries: OrderedMap::new(),
        }
    }
    pub fn len(&self) -> usize {
        self.entries.len()
    }
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
    pub(crate) fn from_json(raw: FrozenValue) -> Result<Self, String> {
        let legacy = raw.get("enemies").is_some_and(FrozenValue::is_array);
        let FrozenValue::Object(root) = raw else {
            return Err("enemy_database.json 格式异常：根节点必须是对象。".into());
        };
        let mut db = Self::empty();
        if legacy {
            let (_, FrozenValue::Array(rows)) = root
                .into_vec()
                .into_iter()
                .find(|(k, _)| k.as_ref() == "enemies")
                .expect("legacy array")
            else {
                unreachable!()
            };
            for mut row in rows {
                let Some(key) = row
                    .get("Key")
                    .and_then(FrozenValue::as_str)
                    .filter(|k| !k.is_empty())
                    .map(str::to_owned)
                else {
                    continue;
                };
                db.add(&key, row.take("Value"));
            }
        } else {
            for (key, values) in root {
                db.add(&key, values);
            }
            if db.is_empty() {
                return Err("enemy_database.json 格式异常：未找到敌人等级数据。".into());
            }
        }
        Ok(db)
    }
    fn add(&mut self, id: &str, values: FrozenValue) {
        let FrozenValue::Array(values) = values else {
            return;
        };
        let mut levels = BTreeMap::new();
        for mut value in values {
            let level = parse_level(value.get("level").map(FrozenValue::to_value).as_ref());
            if value.get("enemyData").is_some_and(FrozenValue::is_object) {
                levels.insert(level, value.take("enemyData"));
            }
        }
        if !levels.is_empty() {
            self.entries.insert(id, levels);
        }
    }
    pub(crate) fn default_entry(&self, id: &str) -> Option<&FrozenValue> {
        let levels = self.entries.get(id)?;
        levels.get(&0).or_else(|| levels.values().next())
    }
    pub(crate) fn stage_entry(&self, id: &str, level: i64) -> Option<&FrozenValue> {
        let levels = self.entries.get(id)?;
        levels.get(&level).or_else(|| levels.get(&0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::enemy_db::{default_entry, normalize_enemy_database, DATABASE_PROJECTION};
    use crate::domain::enemy_stats::{
        cached_stage_specific_enemy_data, extract_cached_enemy_stats, extract_enemy_stats,
        stage_specific_enemy_data,
    };
    use crate::storage::{frozen, projection};
    use serde_json::{json, Value};

    #[test]
    fn matches_normalization_defaults_and_overrides_for_both_formats() {
        let shapes = [
            json!(null),
            json!(false),
            json!(5),
            json!("5"),
            json!([]),
            json!({}),
            json!({"m_value":null}),
            json!({"m_value":12.5,"m_defined":false}),
            json!({"b":2,"a":1}),
        ];
        for shape in shapes {
            let data = json!({"attributes":{"maxHp":shape,"magicResistance":shape,"stunImmune":shape},"skills":[null,{
                "prefabKey":"test","cooldown":shape,"initCooldown":shape,"spData":{"spCost":shape},"blackboard":[{"key":"x","value":shape}]
            }]});
            let rows = json!([{"level":2,"enemyData":data},{"level":"bad","enemyData":data},{"level":2,"enemyData":{"attributes":{"atk":3}}},null,{"level":8,"enemyData":false}]);
            for source in [
                json!({"enemy":rows,"empty":[]}),
                json!({"enemies":[{"Key":"enemy","Value":rows},{"Key":"enemy","Value":[]},{"Key":"","Value":rows}]}),
            ] {
                let text = source.to_string();
                let full = normalize_enemy_database(
                    projection::from_str(&text, DATABASE_PROJECTION).unwrap(),
                )
                .unwrap();
                let compact =
                    EnemyDatabase::from_json(frozen::from_str(&text, DATABASE_PROJECTION).unwrap())
                        .unwrap();
                assert_eq!(full.len(), compact.len());
                assert_eq!(
                    full.iter().map(|(k, _)| k).collect::<Vec<_>>(),
                    compact.entries.iter().map(|(k, _)| k).collect::<Vec<_>>()
                );
                for (id, levels) in full.iter() {
                    let cached = compact.entries.get(id).unwrap();
                    assert_eq!(
                        levels.keys().collect::<Vec<_>>(),
                        cached.keys().collect::<Vec<_>>()
                    );
                    for (level, data) in levels {
                        assert_eq!(data, &cached[level].to_value());
                    }
                    assert_eq!(
                        extract_enemy_stats(default_entry(&full, id).unwrap()),
                        extract_cached_enemy_stats(compact.default_entry(id).unwrap())
                    );
                }
                for id in ["enemy", "missing"] {
                    for level in [0, 2, 99] {
                        for overwrite in [
                            Value::Null,
                            json!({}),
                            json!({"m_defined":true,"m_value":false}),
                            json!({"attributes":{"maxHp":{"m_defined":false,"m_value":99},"atk":{"m_defined":true,"m_value":17}},"skills":{"unexpected":true}}),
                            json!({"attributes":{"maxHp":{"m_value":{"a":1}}}}),
                        ] {
                            assert_eq!(
                                stage_specific_enemy_data(Some(&full), id, level, Some(&overwrite)),
                                cached_stage_specific_enemy_data(
                                    Some(&compact),
                                    id,
                                    level,
                                    Some(&overwrite)
                                )
                            );
                        }
                    }
                }
            }
        }
        for text in [
            "null",
            "[]",
            "{}",
            r#"{"enemies":[]}"#,
            r#"{"enemies":7}"#,
            r#"{"enemies":[{"Key":"a","Value":[{"enemyData":{}}]},{"Key":"a","Value":null}]}"#,
        ] {
            let old =
                normalize_enemy_database(serde_json::from_str(text).unwrap()).map(|v| v.len());
            let new =
                EnemyDatabase::from_json(frozen::from_str(text, DATABASE_PROJECTION).unwrap())
                    .map(|v| v.len());
            assert_eq!(old, new, "{text}");
        }
    }
}
