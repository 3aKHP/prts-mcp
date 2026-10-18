//! Full-field entity indexes in source order.
use super::Result;
use rusqlite::{params, Connection};
use serde_json::Value;
use std::path::Path;
const CORE: &[&str] = &[
    "character_table",
    "handbook_info_table",
    "charword_table",
    "story_review_table",
    "enemy_handbook_table",
    "stage_table",
    "zone_table",
    "item_table",
    "building_data",
    "skin_table",
    "skill_table",
    "enemy_database",
];
const DIRECT: &[&str] = &["character_table", "skill_table", "story_review_table"];

fn entity(
    db: &Connection,
    dataset: &str,
    bucket: &str,
    key: &str,
    ordinal: usize,
    value: &Value,
    aux: Option<&str>,
) -> Result<()> {
    db.execute("INSERT INTO entities VALUES(?,?,?,?,?,?) ON CONFLICT(dataset,bucket,key) DO UPDATE SET payload=excluded.payload,aux=excluded.aux",
        params![dataset,bucket,key,ordinal as i64,serde_json::to_string(value)?,aux])?;
    Ok(())
}

fn name(db: &Connection, dataset: &str, key: &str, ordinal: usize, value: &Value) -> Result<()> {
    if let Some(name) = value.get("name").and_then(Value::as_str) {
        db.execute("INSERT INTO names VALUES(?,?,?,?) ON CONFLICT(dataset,name) DO UPDATE SET key=excluded.key",
            params![dataset,name,key,ordinal as i64])?;
    }
    Ok(())
}

pub(super) fn capture(db: &Connection, namespace: &str, path: &str, raw: &[u8]) -> Result<()> {
    if !matches!(namespace, "excel" | "levels") {
        return Ok(());
    }
    let Some(dataset) = Path::new(path).file_stem().and_then(|s| s.to_str()) else {
        return Ok(());
    };
    if (namespace == "excel" && path != format!("{dataset}.json"))
        || (namespace == "levels" && path != "enemydata/enemy_database.json")
    {
        return Ok(());
    }
    if !CORE.contains(&dataset) {
        return Ok(());
    }
    let root: Value =
        serde_json::from_slice(raw).map_err(|e| format!("Invalid {namespace}/{path}: {e}"))?;
    let root = root
        .as_object()
        .ok_or_else(|| format!("Expected object in {namespace}/{path}"))?;
    if dataset == "enemy_database" {
        if let Some(rows) = root.get("enemies").and_then(Value::as_array) {
            for (ordinal, row) in rows.iter().enumerate() {
                if let (Some(key), Some(value)) =
                    (row.get("Key").and_then(Value::as_str), row.get("Value"))
                {
                    if !key.is_empty() {
                        entity(db, dataset, "", key, ordinal, value, None)?;
                    }
                }
            }
        } else {
            for (ordinal, (key, value)) in root.iter().enumerate() {
                entity(db, dataset, "", key, ordinal, value, None)?;
            }
        }
        return Ok(());
    }
    for (ordinal, (key, value)) in root.iter().enumerate() {
        if DIRECT.contains(&dataset) {
            entity(
                db,
                dataset,
                "",
                key,
                ordinal,
                value,
                value.get("name").and_then(Value::as_str),
            )?;
            if dataset == "character_table" && key.starts_with("char_") {
                name(db, dataset, key, ordinal, value)?;
            }
        } else if let Some(map) = value.as_object() {
            for (subordinal, (subkey, subvalue)) in map.iter().enumerate() {
                let aux = subvalue
                    .get("charId")
                    .or_else(|| subvalue.get("zoneId"))
                    .and_then(Value::as_str);
                entity(db, dataset, key, subkey, subordinal, subvalue, aux)?;
                if dataset == "enemy_handbook_table" && key == "enemyData" {
                    name(db, dataset, subkey, subordinal, subvalue)?;
                }
                if dataset == "item_table" && key == "items" {
                    name(db, dataset, subkey, subordinal, subvalue)?;
                }
            }
        } else {
            entity(db, dataset, "", key, ordinal, value, None)?;
        }
    }
    Ok(())
}
