//! Generation-owned, single-flight JSON object cache with a heap budget.
use serde_json::{Map, Value};
use std::{
    collections::VecDeque,
    mem::size_of,
    sync::{Arc, Mutex},
};

const BUDGET: usize = 8 * 1024 * 1024;
type Object = Map<String, Value>;
struct Entry {
    key: &'static str,
    value: Arc<Object>,
    charge: usize,
}
#[derive(Default)]
pub(crate) struct Objects {
    entries: Mutex<VecDeque<Entry>>,
}

// Charge container capacity conservatively, including index buckets and string
// capacities. This bounds retained objects, not process RSS or caller-owned Arcs.
fn object_charge(object: &Object) -> usize {
    let capacity = object
        .len()
        .checked_next_power_of_two()
        .unwrap_or(usize::MAX);
    let entries =
        capacity.saturating_mul(size_of::<String>() + size_of::<Value>() + 4 * size_of::<usize>());
    object.iter().fold(entries, |sum, (key, value)| {
        sum.saturating_add(key.capacity())
            .saturating_add(value_charge(value))
    })
}
fn value_charge(value: &Value) -> usize {
    match value {
        Value::String(s) => s.capacity(),
        Value::Array(values) => values.iter().fold(
            values.capacity().saturating_mul(size_of::<Value>()),
            |sum, v| sum.saturating_add(value_charge(v)),
        ),
        Value::Object(object) => object_charge(object),
        _ => 0,
    }
}
impl Objects {
    pub(crate) fn get_or_load(
        &self,
        key: &'static str,
        load: impl FnOnce() -> Result<Object, String>,
    ) -> Result<Arc<Object>, String> {
        // Loaders read source data only; they must not recursively load a cache
        // entry. One loader at a time avoids duplicate large cold parses.
        let mut entries = self.entries.lock().map_err(|e| e.to_string())?;
        if let Some(entry) = entries.iter().find(|entry| entry.key == key) {
            return Ok(Arc::clone(&entry.value));
        }
        let value = Arc::new(load()?);
        let charge = object_charge(&value);
        if charge <= BUDGET {
            let mut used: usize = entries.iter().map(|entry| entry.charge).sum();
            while used.saturating_add(charge) > BUDGET {
                if let Some(entry) = entries.pop_front() {
                    used -= entry.charge;
                }
            }
            entries.push_back(Entry {
                key,
                value: Arc::clone(&value),
                charge,
            });
        }
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shares_success_retries_failure_and_does_not_retain_oversized_objects() {
        let cache = Objects::default();
        assert!(cache.get_or_load("failed", || Err("retry".into())).is_err());
        let value = cache.get_or_load("failed", || Ok(Map::new())).unwrap();
        assert!(Arc::ptr_eq(
            &value,
            &cache.get_or_load("failed", || panic!("cached")).unwrap()
        ));
        let large = cache
            .get_or_load("large", || {
                Ok(Map::from_iter([(
                    "text".into(),
                    Value::String("x".repeat(BUDGET)),
                )]))
            })
            .unwrap();
        assert_eq!(large["text"].as_str().unwrap().len(), BUDGET);
        assert!(!cache
            .entries
            .lock()
            .unwrap()
            .iter()
            .any(|entry| entry.key == "large"));
        let weak = Arc::downgrade(&value);
        drop(value);
        drop(cache);
        assert!(weak.upgrade().is_none());
    }

    #[test]
    fn eviction_releases_objects_after_their_last_reader() {
        let cache = Objects::default();
        let load = || {
            Ok(Map::from_iter([(
                "text".into(),
                Value::String("x".repeat(BUDGET / 2)),
            )]))
        };
        let old = cache.get_or_load("old", load).unwrap();
        let weak = Arc::downgrade(&old);
        let _new = cache.get_or_load("new", load).unwrap();
        assert_eq!(cache.entries.lock().unwrap().len(), 1);
        assert!(weak.upgrade().is_some());
        drop(old);
        assert!(weak.upgrade().is_none());
    }
}
