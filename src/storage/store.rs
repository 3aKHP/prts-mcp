//! JSON store abstraction — port of the TS stores.ts read path.
//!
//! Three stores with the oracle's exact selection semantics: DirectoryStore
//! (filesystem), ZipStore (single zip, lazily opened), FallbackStore (primary
//! entry wins; a primary entry that exists but fails to parse is an error and
//! never silently falls back).

use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use serde_json::Value;
use zip::ZipArchive;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("Unsafe dataset path: {0}")]
    UnsafePath(String),
    #[error("Dataset file not found: {0}")]
    NotFound(String),
    #[error("Dataset zip entry not found: {0}")]
    ZipEntryNotFound(String),
    #[error("Dataset file not found in fallback chain: {0}")]
    FallbackNotFound(String),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("JSON parse failure in {path}: {message}")]
    BadJson { path: String, message: String },
}

pub trait JsonStore: Send + Sync {
    /// TS `exists()` throws on unsafe paths, so this is fallible too; callers
    /// that only feed fixed dataset paths simply unwrap-or-propagate.
    fn exists(&self, path: &str) -> Result<bool, StoreError>;
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
    fn exists(&self, path: &str) -> Result<bool, StoreError> {
        // Unsafe paths propagate (TS throws); the `?` keeps that error.
        Ok(self.resolve(path)?.is_file())
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

type ZipCache = Mutex<Option<ZipArchive<std::fs::File>>>;

pub struct ZipStore {
    zip_path: PathBuf,
    // Mirrors the TS lazy `_zip: AdmZip | null` — opened on first use and
    // dropped by close(). ZipArchive keeps a file handle, not the archive in
    // memory: entries are read from disk per request.
    cache: ZipCache,
}

impl ZipStore {
    pub fn new(zip_path: impl Into<PathBuf>) -> Self {
        Self {
            zip_path: zip_path.into(),
            cache: Mutex::new(None),
        }
    }

    pub fn zip_path(&self) -> &Path {
        &self.zip_path
    }

    fn with_archive<T>(
        &self,
        run: impl FnOnce(&mut ZipArchive<std::fs::File>) -> Result<T, StoreError>,
    ) -> Result<T, StoreError> {
        let mut guard = self.cache.lock().expect("ZipStore lock");
        if guard.is_none() {
            let file = std::fs::File::open(&self.zip_path).map_err(StoreError::Io)?;
            let archive = ZipArchive::new(file)
                .map_err(|e| StoreError::Io(std::io::Error::other(e.to_string())))?;
            *guard = Some(archive);
        }
        let archive = guard.as_mut().expect("archive just opened");
        run(archive)
    }

    /// TS `close()` drops the cached archive (resource release only).
    pub fn close(&self) {
        self.cache.lock().expect("ZipStore lock").take();
    }
}

impl JsonStore for ZipStore {
    fn exists(&self, path: &str) -> Result<bool, StoreError> {
        if !self.zip_path.is_file() {
            return Ok(false);
        }
        let inner = normalize_path(path)?;
        self.with_archive(|archive| Ok(archive.by_name(&inner).is_ok()))
    }

    fn read_json(&self, path: &str) -> Result<Value, StoreError> {
        let inner = normalize_path(path)?;
        self.with_archive(|archive| {
            let mut entry = archive
                .by_name(&inner)
                .map_err(|_| StoreError::ZipEntryNotFound(path.to_string()))?;
            let mut text = String::new();
            entry.read_to_string(&mut text).map_err(StoreError::Io)?;
            serde_json::from_str(&text).map_err(|e| StoreError::BadJson {
                path: path.to_string(),
                message: e.to_string(),
            })
        })
    }
}

pub struct FallbackStore {
    primary: Box<dyn JsonStore>,
    fallback: Box<dyn JsonStore>,
}

impl FallbackStore {
    pub fn new(primary: Box<dyn JsonStore>, fallback: Box<dyn JsonStore>) -> Self {
        Self { primary, fallback }
    }

    fn store_for(&self, path: &str) -> Result<&dyn JsonStore, StoreError> {
        if self.primary.exists(path)? {
            return Ok(self.primary.as_ref());
        }
        if self.fallback.exists(path)? {
            return Ok(self.fallback.as_ref());
        }
        Err(StoreError::FallbackNotFound(path.to_string()))
    }
}

impl JsonStore for FallbackStore {
    fn exists(&self, path: &str) -> Result<bool, StoreError> {
        Ok(self.primary.exists(path)? || self.fallback.exists(path)?)
    }

    fn read_json(&self, path: &str) -> Result<Value, StoreError> {
        // A primary entry that exists but holds bad JSON errors here — the
        // fallback is only consulted when the primary entry is absent.
        self.store_for(path)?.read_json(path)
    }
}

/// Zip builder used by tests and fixtures (mirrors AdmZip addFile/writeZip).
pub fn write_zip_entries(zip_path: &Path, entries: &[(&str, &[u8])]) -> std::io::Result<()> {
    if let Some(parent) = zip_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let file = std::fs::File::create(zip_path)?;
    let mut zip = zip::ZipWriter::new(file);
    let options: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default();
    for (name, bytes) in entries {
        zip.start_file(*name, options)?;
        std::io::Write::write_all(&mut zip, bytes)?;
    }
    zip.finish()?;
    Ok(())
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
                                                           // TS exists() also throws on unsafe paths — the error, not false.
        assert!(matches!(
            store.exists("../escape.json"),
            Err(StoreError::UnsafePath(_))
        ));
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

    fn zip_fixture(name: &str) -> (PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!("prts-zip-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let zip_path = dir.join("fixture.zip");
        write_zip_entries(
            &zip_path,
            &[(
                "zh_CN/gamedata/excel/sample.json",
                r#"{"name":"阿米娅","rarity":5}"#.as_bytes(),
            )],
        )
        .unwrap();
        (dir, zip_path)
    }

    #[test]
    fn zip_store_reads_entries_and_reports_missing() {
        let (dir, zip_path) = zip_fixture("read");
        let store = ZipStore::new(&zip_path);
        let fixture = "zh_CN/gamedata/excel/sample.json";
        assert!(store.exists(fixture).unwrap());
        let v = store.read_json(fixture).unwrap();
        assert_eq!(v["name"], "阿米娅");
        assert!(!store.exists("zh_CN/missing.json").unwrap());
        assert!(matches!(
            store.read_json("zh_CN/missing.json"),
            Err(StoreError::ZipEntryNotFound(_))
        ));
        assert!(matches!(
            store.exists("../outside.json"),
            Err(StoreError::UnsafePath(_))
        ));
        assert!(matches!(
            store.exists("/zh_CN/gamedata/excel/sample.json"),
            Err(StoreError::UnsafePath(_))
        ));
        store.close();
        // Still readable after close (re-open), matching the TS lazily reopened path.
        assert!(store.exists(fixture).unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn zip_store_missing_archive_exists_false() {
        let store = ZipStore::new("/tmp/definitely-not-here-9x.zip");
        assert!(!store.exists("a.json").unwrap());
        assert!(store.read_json("a.json").is_err());
    }

    #[test]
    fn fallback_prefers_primary_and_never_masks_bad_json() {
        let (dir, _zip) = zip_fixture("fallback");
        let primary = dir.join("primary");
        let fallback = dir.join("fallback");
        std::fs::create_dir_all(primary.join("zh_CN/gamedata/excel")).unwrap();
        std::fs::create_dir_all(fallback.join("zh_CN/gamedata/excel")).unwrap();
        let rel = "zh_CN/gamedata/excel/sample.json";
        std::fs::write(primary.join(rel), r#"{"source":"primary"}"#).unwrap();
        std::fs::write(fallback.join(rel), r#"{"source":"fallback"}"#).unwrap();
        let store = FallbackStore::new(
            Box::new(DirectoryStore::new(&primary)),
            Box::new(DirectoryStore::new(&fallback)),
        );
        assert_eq!(store.read_json(rel).unwrap()["source"], "primary");

        // Primary entry present but bad JSON → error, not silent fallback.
        std::fs::write(primary.join(rel), "{broken").unwrap();
        assert!(matches!(
            store.read_json(rel),
            Err(StoreError::BadJson { .. })
        ));

        // Primary entry removed → fallback serves it.
        std::fs::remove_file(primary.join(rel)).unwrap();
        assert_eq!(store.read_json(rel).unwrap()["source"], "fallback");

        // Missing in both → fallback-chain wording.
        assert!(matches!(
            store.read_json("zh_CN/none.json"),
            Err(StoreError::FallbackNotFound(_))
        ));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
