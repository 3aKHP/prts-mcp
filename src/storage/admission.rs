//! One admission boundary for sync and offline readers of immutable datasets.
use super::{
    digest::hash_file,
    sqlite::GameDb,
    validation::{self, Observation},
};
use crate::config::ValidationMode;
use serde::Serialize;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock, Weak},
};

#[path = "validation_stamp.rs"]
mod stamp;
pub(crate) use stamp::stamp_path;

/// Expected identity from a release descriptor or an activation pointer.
#[derive(Clone, Serialize)]
pub(crate) struct Expected {
    pub sha256: String,
    pub size: u64,
    pub source_version: String,
    pub revision: u64,
    pub compiler_version: Option<String>,
}

type Flights = HashMap<PathBuf, Weak<Mutex<()>>>;
static FLIGHTS: OnceLock<Mutex<Flights>> = OnceLock::new();

pub(crate) fn flight(path: &Path) -> Result<Arc<Mutex<()>>, String> {
    let mut flights = FLIGHTS
        .get_or_init(Mutex::default)
        .lock()
        .map_err(|e| e.to_string())?;
    flights.retain(|_, entry| entry.strong_count() > 0);
    if let Some(lock) = flights.get(path).and_then(Weak::upgrade) {
        return Ok(lock);
    }
    let lock = Arc::new(Mutex::new(()));
    flights.insert(path.to_owned(), Arc::downgrade(&lock));
    Ok(lock)
}

/// A historical stamp never replaces reading and checking the complete file.
pub(crate) fn admit(
    path: &Path,
    expected: Option<&Expected>,
    mode: ValidationMode,
    fresh: bool,
) -> Result<Arc<GameDb>, String> {
    let flight = flight(path)?;
    let _guard = flight.lock().map_err(|e| e.to_string())?;
    let observed = Observation::begin(path)?;
    // Authenticate managed bytes before opening them through SQLite. A live
    // process receipt already covers these exact bytes and file identity.
    let reused = if let Some(expected) = expected {
        if std::fs::metadata(path).map_err(|e| e.to_string())?.len() != expected.size {
            return Err("SQLite file size/SHA-256 mismatch".into());
        }
        let reused = !fresh
            && validation::verified_digest(path, &expected.sha256, mode == ValidationMode::Strict);
        if !reused && hash_file(path)? != expected.sha256 {
            return Err("SQLite file size/SHA-256 mismatch".into());
        }
        observed.check()?;
        reused
    } else {
        false
    };
    let db = match GameDb::cached(path)? {
        Some(db) => db,
        None => GameDb::for_verification(path)?,
    };
    if !db.derived_ready() {
        return Err("SQLite query data is incomplete".into());
    }
    let Some(expected) = expected else {
        db.check_custom(mode == ValidationMode::Strict)?;
        observed.check()?;
        GameDb::retain(&db)?;
        return Ok(db);
    };
    for (key, wanted) in [
        ("source_version", Some(expected.source_version.clone())),
        ("publication_revision", Some(expected.revision.to_string())),
        ("compiler_version", expected.compiler_version.clone()),
    ] {
        if let Some(wanted) = wanted {
            if db.metadata(key)?.as_deref() != Some(wanted.as_str()) {
                return Err(format!("SQLite metadata mismatch: {key}"));
            }
        }
    }
    let strict = mode == ValidationMode::Strict;
    if reused {
        observed.check()?;
        GameDb::retain(&db)?;
        return Ok(db);
    }
    let full = fresh || strict || !stamp::matches(path, expected);
    if full {
        db.verify_contents()?;
    }
    observed.check()?;
    if full {
        stamp::remember(path, expected);
    }
    validation::remember_proof(
        observed,
        serde_json::to_string(expected).map_err(|e| e.to_string())?,
        Some(expected.sha256.clone()),
        full,
    )?;
    GameDb::retain(&db)?;
    Ok(db)
}

#[cfg(test)]
#[path = "admission_tests.rs"]
mod tests;
