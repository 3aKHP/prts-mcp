//! Pure parsing of zh_CN-levels per-stage level JSON — port of TS
//! `data/levelParser.ts`.

use std::collections::BTreeMap;

use serde_json::Value;

use crate::domain::enemy_db::OrderedMap;

pub struct EnemyRef<'a> {
    pub level: Option<&'a Value>,
    pub overwritten_data: Option<&'a Value>,
}

/// `levelId.toLowerCase().replace(/\\/g, "/") + ".json"` — JS toLowerCase is
/// full Unicode; level ids are ASCII in practice, so ASCII folding matches.
pub fn level_path(level_id: &str) -> String {
    let lowered: String = level_id.chars().map(|c| c.to_ascii_lowercase()).collect();
    format!("{}.json", lowered.replace('\\', "/"))
}

/// Count SPAWN actions per enemy key across waves→fragments→actions.
/// Insertion order follows first appearance (JS Map).
pub fn spawn_counts(level: &Value) -> OrderedMap<i64> {
    let mut counts = OrderedMap::new();
    for wave in level
        .get("waves")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
    {
        for fragment in wave
            .get("fragments")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[])
        {
            for action in fragment
                .get("actions")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or(&[])
            {
                let action_type = action.get("actionType");
                let is_spawn = matches!(action_type, Some(Value::String(s)) if s == "SPAWN")
                    || matches!(action_type, Some(Value::Number(n)) if n.as_i64() == Some(0));
                if !is_spawn {
                    continue;
                }
                // `if (!action.key) continue` — empty keys are falsy.
                let Some(key) = action
                    .get("key")
                    .and_then(Value::as_str)
                    .filter(|k| !k.is_empty())
                else {
                    continue;
                };
                let count = match action.get("count") {
                    None | Some(Value::Null) => 1.0,
                    Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
                    Some(Value::String(s)) => s.parse().unwrap_or(f64::NAN),
                    Some(_) => f64::NAN,
                };
                let count = if count.is_finite() {
                    count.trunc()
                } else {
                    1.0
                };
                let count = count.max(1.0) as i64;
                let next = counts.get(key).copied().unwrap_or(0) + count;
                counts.insert(key, next);
            }
        }
    }
    counts
}

/// Key `enemyDbRefs` entries by enemy id (first ref wins, JS Map.set
/// overwrite keeps first insertion position — but TS `refs.set(ref.id, ref)`
/// LAST-wins for the value while keeping first position).
pub fn enemy_refs<'a>(level: &'a Value) -> BTreeMap<String, EnemyRef<'a>> {
    let mut refs = BTreeMap::new();
    for r#ref in level
        .get("enemyDbRefs")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
    {
        let Some(id) = r#ref.get("id").and_then(Value::as_str) else {
            continue;
        };
        refs.insert(
            id.to_string(),
            EnemyRef {
                level: r#ref.get("level"),
                overwritten_data: r#ref.get("overwrittenData").filter(|v| !v.is_null()),
            },
        );
    }
    refs
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn spawn_counting_across_waves() {
        let level = json!({
            "enemyDbRefs": [
                {"id": "e1", "level": 0, "overwrittenData": null},
                {"id": "e1", "level": 5},
                {"id": "e2"},
            ],
            "waves": [
                {"fragments": [{"actions": [
                    {"actionType": "SPAWN", "key": "e1", "count": 6},
                    {"actionType": 0, "key": "e2"},
                    {"actionType": "SPAWN", "key": "e2", "count": 0},
                    {"actionType": "OTHER", "key": "e3", "count": 9},
                    {"actionType": "SPAWN", "key": "", "count": 3},
                    {"actionType": "SPAWN", "count": 3},
                ]}]},
                {"fragments": [{"actions": [
                    {"actionType": "SPAWN", "key": "e1", "count": 2.9},
                ]}]},
                {"fragments": {}},
            ],
        });
        let counts = spawn_counts(&level);
        assert_eq!(counts.get("e1"), Some(&8)); // 6 + trunc(2.9)=2
        assert_eq!(counts.get("e2"), Some(&2)); // default 1 + max(0,1)=1
        assert_eq!(counts.len(), 2);

        let refs = enemy_refs(&level);
        assert_eq!(refs.len(), 2);
        assert_eq!(
            refs.get("e1").unwrap().overwritten_data,
            None // null overwrittenData filtered
        );
        // Last ref wins the value (level 5 replaces level 0).
        assert_eq!(refs.get("e1").unwrap().level, Some(&json!(5)));
    }

    #[test]
    fn level_path_lowers_and_slashes() {
        assert_eq!(
            level_path("Obt/Main/level_main_00-01"),
            "obt/main/level_main_00-01.json"
        );
        assert_eq!(level_path("A\\B"), "a/b.json");
    }
}
