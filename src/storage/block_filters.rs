//! Generation-owned, bounded hints; never cache query results or source text.
use crate::text::block_filter::BlockFilter;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
};

const LIMIT: usize = 4096; // At most 2 MiB of bitsets, plus bounded map/Arc overhead.
type Key = (i64, i64);

pub(crate) struct StoryBlock {
    pub(crate) chapter: i64,
    pub(crate) block: i64,
    pub(crate) first_line: i64,
    pub(crate) event: String,
    pub(crate) story_key: String,
    pub(crate) code: String,
}

#[derive(Default)]
pub(crate) struct BlockFilters {
    hints: Mutex<HashMap<Key, Arc<BlockFilter>>>,
    pub(crate) catalog: OnceLock<Vec<StoryBlock>>,
}

impl BlockFilters {
    pub(crate) fn get(&self, key: Key) -> Result<Option<Arc<BlockFilter>>, String> {
        Ok(self
            .hints
            .lock()
            .map_err(|e| e.to_string())?
            .get(&key)
            .cloned())
    }

    pub(crate) fn remember(&self, key: Key, payload: &[u8]) -> Result<(), String> {
        {
            let cache = self.hints.lock().map_err(|e| e.to_string())?;
            if cache.len() >= LIMIT || cache.contains_key(&key) {
                return Ok(());
            }
        }
        let filter = Arc::new(BlockFilter::new(payload)?);
        let mut cache = self.hints.lock().map_err(|e| e.to_string())?;
        if cache.len() < LIMIT {
            cache.entry(key).or_insert(filter);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hints_are_bounded_and_owned_by_the_generation() {
        let old = BlockFilters::default();
        old.remember((0, 0), b"old contents").unwrap();
        let retained = old.get((0, 0)).unwrap().unwrap();
        old.remember((0, 0), b"new contents").unwrap();
        assert!(Arc::ptr_eq(&retained, &old.get((0, 0)).unwrap().unwrap()));
        for key in 1..=LIMIT as i64 {
            old.remember((key, 0), b"text").unwrap();
        }
        assert!(old.get((LIMIT as i64, 0)).unwrap().is_none());
        let new = BlockFilters::default();
        assert!(new.get((0, 0)).unwrap().is_none());
        drop(old);
        assert!(retained.may_contain(b"old contents"));
    }
}
