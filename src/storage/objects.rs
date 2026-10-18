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

// serde_json does not expose object capacity. Rebuild maps after projection or
// merging so the charge cannot miss buckets retained by removed source fields.
fn compact_objects(object: Object) -> Object {
    fn compact(value: Value) -> Value {
        match value {
            Value::Object(object) => Value::Object(compact_objects(object)),
            Value::Array(mut values) => {
                for value in &mut values {
                    *value = compact(std::mem::take(value));
                }
                Value::Array(values)
            }
            value => value,
        }
    }
    object
        .into_iter()
        .map(|(key, value)| (key, compact(value)))
        .collect()
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
        let value = Arc::new(compact_objects(load()?));
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
    fn concurrent_cold_readers_share_one_load() {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Barrier,
        };
        let cache = Objects::default();
        let loads = AtomicUsize::new(0);
        let barrier = Barrier::new(8);
        std::thread::scope(|scope| {
            let handles: Vec<_> = (0..8)
                .map(|_| {
                    scope.spawn(|| {
                        barrier.wait();
                        cache
                            .get_or_load("shared", || {
                                loads.fetch_add(1, Ordering::SeqCst);
                                Ok(Map::new())
                            })
                            .unwrap()
                    })
                })
                .collect();
            let values: Vec<_> = handles
                .into_iter()
                .map(|handle| handle.join().unwrap())
                .collect();
            assert!(values.iter().all(|value| Arc::ptr_eq(value, &values[0])));
        });
        assert_eq!(loads.load(Ordering::SeqCst), 1);
    }

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
