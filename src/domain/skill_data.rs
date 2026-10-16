//! Compact generation-owned skill data. Blackboard values are normalized to
//! their rendering semantics; numeric output fields retain arbitrary JSON
//! values because the frozen contract passes malformed non-numbers through.
use crate::storage::projection::Projection;
use serde::de::{DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};
use serde_json::Value;
use std::collections::HashMap;
use std::fmt;

pub enum BlackboardValue {
    Number(f64),
    Text(String),
    Invalid,
}

pub struct SkillLevel {
    pub level: usize,
    pub name: String,
    pub skill_type: String,
    pub duration_type: String,
    pub sp_type: String,
    pub sp_cost: Value,
    pub init_sp: Value,
    pub max_charge_time: Value,
    pub duration: Value,
    pub description: String,
    pub blackboard: HashMap<String, BlackboardValue>,
}

pub struct SkillTable {
    entries: Option<HashMap<String, Vec<SkillLevel>>>,
}

fn take(raw: &mut Value, key: &str) -> Value {
    raw.get_mut(key).map(Value::take).unwrap_or(Value::Null)
}

fn text(raw: &mut Value, key: &str) -> String {
    match take(raw, key) {
        Value::String(s) => s,
        _ => String::new(),
    }
}

fn blackboard(raw: Value) -> HashMap<String, BlackboardValue> {
    let Value::Array(entries) = raw else {
        return HashMap::new();
    };
    let mut values = HashMap::new();
    for mut entry in entries {
        let Value::String(key) = take(&mut entry, "key") else {
            continue;
        };
        // A present non-null valueStr takes precedence even when malformed.
        let value = match take(&mut entry, "valueStr") {
            Value::String(s) => BlackboardValue::Text(s),
            Value::Null => entry
                .get("value")
                .and_then(Value::as_f64)
                .map(BlackboardValue::Number)
                .unwrap_or(BlackboardValue::Invalid),
            _ => BlackboardValue::Invalid,
        };
        values.insert(key, value);
    }
    values
}

impl SkillLevel {
    fn from_json(index: usize, mut raw: Value) -> Option<Self> {
        if !raw.is_object() {
            return None;
        }
        let mut sp = take(&mut raw, "spData");
        Some(Self {
            level: index + 1,
            name: text(&mut raw, "name"),
            skill_type: text(&mut raw, "skillType"),
            duration_type: text(&mut raw, "durationType"),
            sp_type: text(&mut sp, "spType"),
            sp_cost: take(&mut sp, "spCost"),
            init_sp: take(&mut sp, "initSp"),
            max_charge_time: take(&mut sp, "maxChargeTime"),
            duration: take(&mut raw, "duration"),
            description: text(&mut raw, "description"),
            blackboard: blackboard(take(&mut raw, "blackboard")),
        })
    }
}

impl SkillTable {
    #[cfg(test)]
    pub fn from_json(raw: Value) -> Self {
        serde_json::from_value(raw).expect("already parsed JSON")
    }

    pub fn is_object(&self) -> bool {
        self.entries.is_some()
    }
    pub fn len(&self) -> usize {
        self.entries.as_ref().map(HashMap::len).unwrap_or(0)
    }
    pub fn get(&self, id: &str) -> Option<&[SkillLevel]> {
        self.entries.as_ref()?.get(id).map(Vec::as_slice)
    }
}

#[derive(Clone, Copy)]
// Tolerant container visitors preserve the old Value-based shape checks.
// Only one raw level is materialized at a time; unrelated entry metadata is
// validated and discarded without building a second whole-table tree.
enum Shape {
    Table,
    Entry,
    Levels,
}
enum Parsed {
    Table(SkillTable),
    Levels(Vec<SkillLevel>),
}

impl Shape {
    fn empty(self) -> Parsed {
        match self {
            Self::Table => Parsed::Table(SkillTable { entries: None }),
            _ => Parsed::Levels(Vec::new()),
        }
    }
}

impl<'de> Deserialize<'de> for SkillTable {
    fn deserialize<D: Deserializer<'de>>(de: D) -> Result<Self, D::Error> {
        match Shape::Table.deserialize(de)? {
            Parsed::Table(table) => Ok(table),
            _ => unreachable!("table visitor returns a table"),
        }
    }
}

impl<'de> DeserializeSeed<'de> for Shape {
    type Value = Parsed;
    fn deserialize<D: Deserializer<'de>>(self, de: D) -> Result<Parsed, D::Error> {
        de.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for Shape {
    type Value = Parsed;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a JSON value")
    }
    fn visit_unit<E>(self) -> Result<Parsed, E> {
        Ok(self.empty())
    }
    fn visit_bool<E>(self, _: bool) -> Result<Parsed, E> {
        Ok(self.empty())
    }
    fn visit_i64<E>(self, _: i64) -> Result<Parsed, E> {
        Ok(self.empty())
    }
    fn visit_u64<E>(self, _: u64) -> Result<Parsed, E> {
        Ok(self.empty())
    }
    fn visit_f64<E>(self, _: f64) -> Result<Parsed, E> {
        Ok(self.empty())
    }
    fn visit_str<E>(self, _: &str) -> Result<Parsed, E> {
        Ok(self.empty())
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Parsed, A::Error> {
        if matches!(self, Self::Levels) {
            let mut levels = Vec::new();
            let mut index = 0;
            while let Some(raw) = seq.next_element::<Value>()? {
                if let Some(level) = SkillLevel::from_json(index, raw) {
                    levels.push(level);
                }
                index += 1;
            }
            Ok(Parsed::Levels(levels))
        } else {
            while seq.next_element_seed(Projection::Discard)?.is_some() {}
            Ok(self.empty())
        }
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Parsed, A::Error> {
        match self {
            Self::Table => {
                let mut entries = HashMap::new();
                while let Some(key) = map.next_key::<String>()? {
                    let Parsed::Levels(levels) = map.next_value_seed(Self::Entry)? else {
                        unreachable!()
                    };
                    entries.insert(key, levels);
                }
                Ok(Parsed::Table(SkillTable {
                    entries: Some(entries),
                }))
            }
            Self::Entry => {
                let mut levels = Vec::new();
                while let Some(key) = map.next_key::<String>()? {
                    if key == "levels" {
                        let Parsed::Levels(value) = map.next_value_seed(Self::Levels)? else {
                            unreachable!()
                        };
                        levels = value;
                    } else {
                        map.next_value_seed(Projection::Discard)?;
                    }
                }
                Ok(Parsed::Levels(levels))
            }
            Self::Levels => {
                while map.next_key::<String>()?.is_some() {
                    map.next_value_seed(Projection::Discard)?;
                }
                Ok(self.empty())
            }
        }
    }
}
