//! Bounded, process-local receipts for fully verified immutable databases.
//! An open file pins its identity; a changed path or handle invalidates proof.
use super::identity::{file_token, path_token};
use std::{
    collections::VecDeque,
    fs::File,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

const LIMIT: usize = 8;
static RECEIPTS: OnceLock<Mutex<VecDeque<Receipt>>> = OnceLock::new();

pub(crate) struct Observation {
    path: PathBuf,
    token: String,
    file: File,
}
struct Receipt {
    observed: Observation,
    descriptor: String,
}

impl Observation {
    pub(crate) fn begin(path: &Path) -> Result<Self, String> {
        let file = File::open(path).map_err(|e| e.to_string())?;
        let token = file_token(&file).ok_or("SQLite file identity is unavailable")?;
        let observed = Self {
            path: path.to_owned(),
            token,
            file,
        };
        observed.check()?;
        Ok(observed)
    }

    fn current(&self) -> bool {
        file_token(&self.file).as_ref() == Some(&self.token)
            && path_token(&self.path).as_ref() == Some(&self.token)
    }

    pub(crate) fn check(&self) -> Result<(), String> {
        self.current()
            .then_some(())
            .ok_or_else(|| "SQLite file changed during validation".into())
    }
}

pub(crate) fn contains(path: &Path, descriptor: Option<&str>) -> bool {
    // Windows last-write information may remain pending while a writer holds
    // the file open. Keep full verification until that case has its own proof.
    if cfg!(windows) {
        return false;
    }
    let mut receipts = RECEIPTS
        .get_or_init(Mutex::default)
        .lock()
        .expect("SQLite receipts lock");
    receipts.retain(|receipt| receipt.observed.current());
    receipts.iter().any(|receipt| {
        receipt.observed.path == path
            && descriptor.is_none_or(|wanted| wanted == receipt.descriptor)
    })
}

pub(crate) fn remember(observed: Observation, descriptor: String) -> Result<(), String> {
    observed.check()?;
    if cfg!(windows) {
        return Ok(());
    }
    let mut receipts = RECEIPTS
        .get_or_init(Mutex::default)
        .lock()
        .expect("SQLite receipts lock");
    receipts.retain(|receipt| receipt.observed.path != observed.path && receipt.observed.current());
    while receipts.len() >= LIMIT {
        receipts.pop_front();
    }
    receipts.push_back(Receipt {
        observed,
        descriptor,
    });
    Ok(())
}

pub(crate) fn forget(path: &Path) {
    let Some(receipts) = RECEIPTS.get() else {
        return;
    };
    receipts
        .lock()
        .expect("SQLite receipts lock")
        .retain(|receipt| receipt.observed.path != path);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proof_is_bound_to_descriptor_and_rejects_in_place_rewrite() {
        let path = std::env::temp_dir().join(format!("prts-receipt-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"old").unwrap();
        let observed = Observation::begin(&path).unwrap();
        remember(observed, "descriptor".into()).unwrap();
        assert_eq!(contains(&path, Some("descriptor")), cfg!(unix));
        assert!(!contains(&path, Some("different")));
        std::fs::write(&path, b"new").unwrap();
        assert!(!contains(&path, None));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn mutation_during_validation_cannot_be_remembered() {
        let path = std::env::temp_dir().join(format!("prts-receipt-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"old").unwrap();
        let observed = Observation::begin(&path).unwrap();
        std::fs::write(&path, b"new length").unwrap();
        assert!(remember(observed, "descriptor".into()).is_err());
        assert!(!contains(&path, None));
        std::fs::remove_file(path).unwrap();
    }
}
