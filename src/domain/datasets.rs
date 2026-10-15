//! Per-generation parsed-dataset cache — the Rust shape of TS
//! `data/datasetAccess.ts`.
//!
//! TS caches each parsed table in a module-level slot and clears all of them
//! when the activation signature changes. Rust attaches the cache to the
//! `DataView` snapshot instead: one generation → one `Arc<DataView>` → one
//! cache map, so a pointer swap rebuilds naturally and the previous
//! generation's parsed tables are released once in-flight calls finish
//! (nothing survives the last `Arc` reference). Failed loads are not cached
//! — the next call retries, exactly like the TS loader contract.

use std::any::Any;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Default)]
pub struct Datasets {
    slots: Mutex<HashMap<String, Arc<Slot>>>,
}

type Slot = Mutex<Option<Arc<dyn Any + Send + Sync>>>;

impl Datasets {
    pub fn new() -> Self {
        Self::default()
    }

    /// `get_or_load`: return the cached parse, or run `load` once and cache
    /// it. A load returning `Err` leaves the slot empty so later calls retry.
    pub fn get_or_load<T: Send + Sync + 'static>(
        &self,
        name: &str,
        load: impl FnOnce() -> Result<T, String>,
    ) -> Result<Arc<T>, String> {
        self.get_or_load_counted(name, load, |_| 0)
    }

    /// `get_or_load` with a `count_of` hook feeding the /debug/cache
    /// projection (entry count of the cached value, TS `count` semantics).
    /// Hit/miss/load-failure accounting is identical for both entry points.
    pub fn get_or_load_counted<T: Send + Sync + 'static>(
        &self,
        name: &str,
        load: impl FnOnce() -> Result<T, String>,
        count_of: impl FnOnce(&T) -> u64,
    ) -> Result<Arc<T>, String> {
        // Serialize a cold load per slot, not per dataset collection: derived
        // loaders may acquire other slots in this same generation.
        let slot = {
            let mut slots = self.slots.lock().expect("datasets lock");
            Arc::clone(slots.entry(name.to_string()).or_default())
        };
        let mut cached = slot.lock().expect("dataset slot lock");
        if let Some(hit) = cached.as_ref() {
            if let Ok(typed) = Arc::clone(hit).downcast::<T>() {
                crate::diagnostics::record_hit(name);
                return Ok(typed);
            }
        }
        crate::diagnostics::record_miss(name);
        let value = match load() {
            Ok(value) => value,
            Err(err) => {
                crate::diagnostics::record_load_failed(name);
                return Err(err);
            }
        };
        let count = count_of(&value);
        let value = Arc::new(value);
        crate::diagnostics::record_loaded(name, count);
        *cached = Some(Arc::clone(&value) as Arc<dyn Any + Send + Sync>);
        Ok(value)
    }

    /// Slot count (diagnostics / tests).
    pub fn len(&self) -> usize {
        let slots: Vec<_> = self
            .slots
            .lock()
            .expect("datasets lock")
            .values()
            .cloned()
            .collect();
        slots
            .iter()
            .filter(|slot| slot.lock().expect("dataset slot lock").is_some())
            .count()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caches_success_and_retries_failure() {
        let ds = Datasets::new();
        let mut loads = 0;
        let v = ds
            .get_or_load("x", || {
                loads += 1;
                Ok(vec![1i64])
            })
            .unwrap();
        assert_eq!(*v, vec![1]);
        ds.get_or_load("x", || {
            loads += 1;
            Ok(vec![2i64])
        })
        .unwrap();
        assert_eq!(loads, 1); // cached
        assert_eq!(ds.len(), 1);

        let mut fails = 0;
        let err: Result<Arc<String>, _> = ds.get_or_load("bad", || {
            fails += 1;
            Err("nope".to_string())
        });
        assert!(err.is_err());
        let err: Result<Arc<String>, _> = ds.get_or_load("bad", || {
            fails += 1;
            Err("nope".to_string())
        });
        assert!(err.is_err());
        assert_eq!(fails, 2); // failures are not cached
        assert_eq!(ds.len(), 1); // failed slots do not count as loaded
    }

    #[test]
    fn concurrent_cold_load_shares_one_value_and_allows_dependencies() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Barrier;
        let ds = Arc::new(Datasets::new());
        let loads = Arc::new(AtomicUsize::new(0));
        let barrier = Arc::new(Barrier::new(8));
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let (ds, loads, barrier) =
                    (Arc::clone(&ds), Arc::clone(&loads), Arc::clone(&barrier));
                std::thread::spawn(move || {
                    barrier.wait();
                    ds.get_or_load("derived", || {
                        loads.fetch_add(1, Ordering::SeqCst);
                        let source = ds.get_or_load("source", || Ok(vec![1, 2, 3]))?;
                        std::thread::sleep(std::time::Duration::from_millis(20));
                        Ok(source)
                    })
                    .unwrap()
                })
            })
            .collect();
        let values: Vec<_> = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect();
        assert_eq!(loads.load(Ordering::SeqCst), 1);
        assert!(values.iter().all(|value| Arc::ptr_eq(value, &values[0])));
        assert_eq!(ds.len(), 2);
    }
}
