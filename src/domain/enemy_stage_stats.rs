//! Selective reads of stage overrides: listings consume six attributes, not
//! the entire merged enemy row. The underlying cache stays immutable.

use super::enemy_cache::EnemyDatabase;
use super::enemy_stats::{format_stat_values, merge_defined};
use crate::storage::json_view::JsonView;
use serde_json::Value;

/// A plain subtree or the result of a deferred `merge_defined`. Replacement
/// wrappers resolve immediately; ordinary object merges resolve per field.
#[derive(Clone, Copy)]
enum Merged<'a> {
    Plain(JsonView<'a>),
    Object {
        base: JsonView<'a>,
        overwritten: &'a Value,
    },
}

impl<'a> Merged<'a> {
    fn merge(base: JsonView<'a>, overwritten: &'a Value) -> Self {
        let Some(map) = overwritten.as_object() else {
            return Self::Plain(base);
        };
        if let (Some(defined), Some(value)) = (map.get("m_defined"), map.get("m_value")) {
            return Self::Plain(if defined == &Value::Bool(true) {
                JsonView::Value(value)
            } else {
                base
            });
        }
        Self::Object { base, overwritten }
    }

    fn is_object(self) -> bool {
        match self {
            Self::Plain(v) => v.is_object(),
            Self::Object { .. } => true,
        }
    }

    fn get(self, key: &str) -> Option<Self> {
        match self {
            Self::Plain(v) => v.get(key).map(Self::Plain),
            Self::Object { base, overwritten } => {
                let original = base.get(key);
                match overwritten.get(key) {
                    // Child wrappers with m_defined:false are skipped even
                    // without m_value. Root wrappers follow merge's own rule.
                    Some(v) if v.get("m_defined") != Some(&Value::Bool(false)) => Some(
                        Self::merge(original.unwrap_or(JsonView::Value(&Value::Null)), v),
                    ),
                    _ => original.map(Self::Plain),
                }
            }
        }
    }

    fn to_value(self) -> Value {
        match self {
            Self::Plain(v) => v.to_value(),
            // Malformed/non-scalar attribute values still use the original
            // merge and formatting semantics, including key order.
            Self::Object { base, overwritten } => merge_defined(&base.to_value(), overwritten),
        }
    }
}

pub(crate) fn format_cached_stage_stats(
    levels: Option<&EnemyDatabase>,
    enemy_id: &str,
    level: i64,
    overwritten: Option<&Value>,
) -> String {
    let base = levels
        .and_then(|db| db.stage_entry(enemy_id, level))
        .map(JsonView::Frozen);
    let data = match base {
        Some(base) => {
            let merged = Merged::merge(base, overwritten.unwrap_or(&Value::Null));
            // A non-object whole-row replacement falls back to the base.
            Some(if merged.is_object() {
                merged
            } else {
                Merged::Plain(base)
            })
        }
        // Without a database entry, the original API uses the overwrite raw,
        // without interpreting its root m_defined wrapper.
        None => overwritten
            .filter(|v| v.is_object())
            .map(|v| Merged::Plain(JsonView::Value(v))),
    };
    let Some(data) = data else {
        return "无数据库记录".to_owned();
    };
    let attrs = data.get("attributes");
    let values = [
        "maxHp",
        "atk",
        "def",
        "magicResistance",
        "moveSpeed",
        "baseAttackTime",
    ]
    .map(|key| {
        attrs
            .and_then(|a| a.get(key))
            .map(|v| v.get("m_value").unwrap_or(v).to_value())
    });
    format_stat_values(values)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::enemy_db::{normalize_enemy_database, DATABASE_PROJECTION};
    use crate::domain::enemy_stats::{format_stats, stage_specific_enemy_data};
    use crate::storage::{frozen, projection::Projection};
    use serde_json::json;

    fn shapes() -> Vec<Value> {
        let leaves = [
            json!(null),
            json!(false),
            json!(true),
            json!(0),
            json!(-0.0),
            json!(2.5),
            json!("4"),
            json!([]),
            json!([1, null]),
            json!({}),
            json!({"b": 2, "a": 1}),
            json!({"m_value": 9}),
            json!({"m_defined": false}),
            json!({"m_defined": true}),
        ];
        let mut shapes = leaves.to_vec();
        for leaf in leaves {
            for defined in [json!(false), json!(true), json!(null), json!(1)] {
                shapes.push(json!({"m_defined": defined, "m_value": leaf}));
            }
        }
        shapes
    }

    #[test]
    fn deferred_fields_match_eager_merge_including_missing_and_wrappers() {
        let shapes = shapes();
        let keys = ["attributes", "maxHp", "m_value", "m_defined", "b", "absent"];
        for base in &shapes {
            let frozen = frozen::from_str(&base.to_string(), Projection::All).unwrap();
            for overwrite in &shapes {
                for (base, overwrite) in [
                    (base.clone(), overwrite.clone()),
                    (
                        json!({"attributes": base}),
                        json!({"attributes": overwrite}),
                    ),
                    (
                        json!({"attributes": {"maxHp": base}}),
                        json!({"attributes": {"maxHp": overwrite}}),
                    ),
                ] {
                    let cached = frozen::from_str(&base.to_string(), Projection::All).unwrap();
                    let expected = merge_defined(&base, &overwrite);
                    let lazy = Merged::merge(JsonView::Frozen(&cached), &overwrite);
                    // Compare existence and order too, not just JSON equality.
                    for key in keys {
                        let a = expected.get(key);
                        let b = lazy.get(key);
                        assert_eq!(
                            a.map(Value::to_string),
                            b.map(|v| v.to_value().to_string()),
                            "base={base} overwrite={overwrite} key={key}"
                        );
                        for nested in keys {
                            assert_eq!(
                                a.and_then(|v| v.get(nested)).map(Value::to_string),
                                b.and_then(|v| v.get(nested))
                                    .map(|v| v.to_value().to_string()),
                                "base={base} overwrite={overwrite} key={key}/{nested}"
                            );
                        }
                    }
                }
            }
            assert_eq!(frozen.to_value(), *base);
        }
    }

    #[test]
    fn stage_summaries_match_eager_merge_and_level_fallbacks() {
        let shapes = shapes();
        let mut overwrites = vec![None];
        for shape in &shapes {
            overwrites.extend([
                Some(shape.clone()),
                Some(json!({"attributes": shape})),
                Some(
                    json!({"attributes": {"maxHp": shape, "atk": shape, "def": shape,
                    "magicResistance": shape, "moveSpeed": shape, "baseAttackTime": shape}}),
                ),
            ]);
        }
        for shape in &shapes {
            let source = json!({"enemy": [{"level": 0, "enemyData": {"attributes": shape}},
                {"level": 2, "enemyData": {"attributes": {"maxHp": shape, "atk": shape, "def": shape,
                    "magicResistance": shape, "moveSpeed": shape, "baseAttackTime": shape}}}],
                "no_zero": [{"level": 2, "enemyData": {"attributes": {"maxHp": 777}}}]});
            let full = normalize_enemy_database(source.clone()).unwrap();
            let compact = EnemyDatabase::from_json(
                frozen::from_str(&source.to_string(), DATABASE_PROJECTION).unwrap(),
            )
            .unwrap();
            for id in ["enemy", "missing", "no_zero"] {
                for level in [0, 2, 99] {
                    for overwrite in &overwrites {
                        let eager =
                            stage_specific_enemy_data(Some(&full), id, level, overwrite.as_ref());
                        assert_eq!(
                            format_cached_stage_stats(
                                Some(&compact),
                                id,
                                level,
                                overwrite.as_ref()
                            ),
                            format_stats(eager.as_ref()),
                            "base={shape} overwrite={overwrite:?} id={id} level={level}"
                        );
                    }
                }
            }
        }
        assert_eq!(
            format_cached_stage_stats(None, "missing", 0, None),
            "无数据库记录"
        );
    }
}
