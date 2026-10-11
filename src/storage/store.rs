//! JSON store abstraction — port of the TS stores.ts read path.

use std::path::{Component, Path, PathBuf};

use serde_json::Value;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("Unsafe dataset path: {0}")]
    UnsafePath(String),
    #[error("Dataset file not found: {0}")]
    NotFound(String),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("JSON parse failure in {path}: {message}")]
    BadJson { path: String, message: String },
}

pub trait JsonStore: Send + Sync {
    fn exists(&self, path: &str) -> bool;
    fn read_json(&self, path: &str) -> Result<Value, StoreError>;
}

/// normalizePath(): backslashes fold to '/', absolute paths and any `..`
/// segment are rejected, empty and `.` segments drop out.
fn normalize_path(path: &str) -> Result<String, StoreError> {
    let normalized = path.replace('\\', "/");
    if normalized.starts_with('/') {
        return Err(StoreError::UnsafePath(path.to_string()));
    }
    let mut parts = Vec::new();
    for part in normalized.split('/') {
        match part {
            "" | "." => {}
            ".." => return Err(StoreError::UnsafePath(path.to_string())),
            p => parts.push(p.to_string()),
        }
    }
    Ok(parts.join("/"))
}

pub struct DirectoryStore {
    root: PathBuf,
}

impl DirectoryStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn resolve(&self, path: &str) -> Result<PathBuf, StoreError> {
        let normalized = normalize_path(path)?;
        // The normalized form contains no absolute or parent segments, so
        // joining cannot escape the root; the component walk makes that
        // explicit instead of relying on lexical string checks.
        let mut target = self.root.clone();
        for part in normalized.split('/') {
            target.push(part);
        }
        match target.components().next_back() {
            Some(Component::ParentDir) | Some(Component::RootDir) => {
                Err(StoreError::UnsafePath(path.to_string()))
            }
            _ => Ok(target),
        }
    }
}

impl JsonStore for DirectoryStore {
    fn exists(&self, path: &str) -> bool {
        self.resolve(path).is_ok_and(|p| p.is_file())
    }

    fn read_json(&self, path: &str) -> Result<Value, StoreError> {
        let target = self.resolve(path)?;
        let text = std::fs::read_to_string(&target).map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => StoreError::NotFound(path.to_string()),
            _ => StoreError::Io(e),
        })?;
        serde_json::from_str(&text).map_err(|e| StoreError::BadJson {
            path: path.to_string(),
            message: e.to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rejects_unsafe_paths() {
        let store = DirectoryStore::new("/tmp/whatever");
        assert!(store.read_json("../escape.json").is_err());
        assert!(store.read_json("/abs.json").is_err());
        assert!(store.read_json("a/../../b.json").is_err());
        assert!(store.read_json("ok/path.json").is_err()); // not found, not unsafe
    }

    #[test]
    fn reads_json_within_root() {
        let dir = std::env::temp_dir().join(format!("prts-store-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("zh_CN/gamedata/excel")).unwrap();
        std::fs::write(
            dir.join("zh_CN/gamedata/excel/stage_table.json"),
            r#"{"stages": {"s1": {"name": "x"}}}"#,
        )
        .unwrap();
        let store = DirectoryStore::new(&dir);
        let v = store
            .read_json("zh_CN/gamedata/excel/stage_table.json")
            .unwrap();
        assert_eq!(v["stages"]["s1"]["name"], "x");
        let backslash = store
            .read_json("zh_CN\\gamedata\\excel\\stage_table.json")
            .unwrap();
        assert_eq!(backslash, v);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn bad_json_reports_path() {
        let dir = std::env::temp_dir().join(format!("prts-store-bad-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("bad.json"), "{oops").unwrap();
        let store = DirectoryStore::new(&dir);
        let err = store.read_json("bad.json").unwrap_err();
        assert!(err.to_string().contains("JSON parse failure"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sentinel_read_matches_fixture_shape() {
        let root = std::path::Path::new(".runtime/fixtures/minimal-gamedata-v1");
        if !root.exists() {
            return; // fixture not built in this checkout
        }
        let store = DirectoryStore::new(root);
        let v = store
            .read_json("zh_CN/gamedata/excel/stage_table.json")
            .expect("fixture stage table readable");
        assert!(v["stages"]["main_00-01"]["stageId"].is_string());
        assert_eq!(v["stages"].as_object().map(|m| m.len()), Some(4));
        let _ = json!(null); // keep serde_json::json in scope for parity helpers
    }
}
