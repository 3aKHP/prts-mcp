//! Disposable, versioned structure-validation cache for managed generations.
use super::Expected;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

const CONTRACT: &str = "prts-mcp-sqlite-validation/v1";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Stamp {
    validation_contract: String,
    sqlite_version: i32,
    sha256: String,
    size: u64,
}

pub(crate) fn stamp_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(".verified.json");
    name.into()
}

pub(super) fn matches(path: &Path, expected: &Expected) -> bool {
    let read = || -> Option<Stamp> {
        let mut bytes = Vec::new();
        fs::File::open(stamp_path(path))
            .ok()?
            .take(4097)
            .read_to_end(&mut bytes)
            .ok()?;
        if bytes.len() > 4096 {
            return None;
        }
        serde_json::from_slice(&bytes).ok()
    };
    read().is_some_and(|stamp| {
        stamp.validation_contract == CONTRACT
            && stamp.sqlite_version == rusqlite::version_number()
            && stamp.sha256 == expected.sha256
            && stamp.size == expected.size
    })
}

pub(super) fn remember(path: &Path, expected: &Expected) {
    let destination = stamp_path(path);
    let temporary = path.with_file_name(format!(".verified-{}.tmp", uuid::Uuid::new_v4().simple()));
    let write = || -> Result<(), Box<dyn std::error::Error>> {
        let stamp = Stamp {
            validation_contract: CONTRACT.into(),
            sqlite_version: rusqlite::version_number(),
            sha256: expected.sha256.clone(),
            size: expected.size,
        };
        fs::write(&temporary, serde_json::to_vec(&stamp)?)?;
        fs::rename(&temporary, &destination)?;
        Ok(())
    };
    if write().is_err() {
        let _ = fs::remove_file(temporary);
    }
}
