use super::super::{database::lease_path, sqlite::FULL_CHECKS};
use super::*;

struct Fixture {
    root: PathBuf,
    path: PathBuf,
    expected: Expected,
}
impl Fixture {
    fn new(sql: &str) -> Self {
        let root = std::env::temp_dir().join(format!("prts-admission-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("data.sqlite");
        let db = rusqlite::Connection::open(&path).unwrap();
        db.execute_batch(include_str!("../../contracts/sqlite-schema-v1.sql"))
            .unwrap();
        for (key, value) in [
            ("sources_complete", "1"),
            ("derived_complete", "1"),
            ("contract", super::super::sqlite::CONTRACT),
            ("index_version", "1"),
            ("language", "zh_CN"),
            ("source_version", "fixture"),
            ("publication_revision", "1"),
            ("compiler_version", "test"),
        ] {
            db.execute("INSERT INTO meta VALUES(?1,?2)", [key, value])
                .unwrap();
        }
        db.execute_batch("PRAGMA foreign_keys=OFF").unwrap();
        db.execute_batch(sql).unwrap();
        drop(db);
        std::fs::write(lease_path(&path), "").unwrap();
        let expected = Expected {
            sha256: hash_file(&path).unwrap(),
            size: std::fs::metadata(&path).unwrap().len(),
            source_version: "fixture".into(),
            revision: 1,
            compiler_version: Some("test".into()),
        };
        Self {
            root,
            path,
            expected,
        }
    }
    fn admit(&self, mode: ValidationMode) -> Result<Arc<GameDb>, String> {
        admit(&self.path, Some(&self.expected), mode, false)
    }
    fn forget(&self) {
        validation::forget(&self.path);
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.forget();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
fn checks() -> usize {
    FULL_CHECKS.with(|n| n.get())
}

#[test]
fn historical_normal_result_does_not_satisfy_strict_admission() {
    let f = Fixture::new("");
    let before = checks();
    drop(f.admit(ValidationMode::Normal).unwrap());
    assert_eq!(checks(), before + 1);
    assert!(stamp_path(&f.path).is_file());
    f.forget();
    let normal = f.admit(ValidationMode::Normal).unwrap();
    assert_eq!(checks(), before + 1);
    let strict = f.admit(ValidationMode::Strict).unwrap();
    assert!(Arc::ptr_eq(&normal, &strict));
    assert_eq!(checks(), before + 2);
    drop(f.admit(ValidationMode::Strict).unwrap());
    assert_eq!(checks(), before + 2 + usize::from(cfg!(windows)));
}

#[test]
fn stamp_failure_is_a_cache_miss_and_never_a_redownload_requirement() {
    let f = Fixture::new("");
    drop(f.admit(ValidationMode::Normal).unwrap());
    let before = checks();
    for text in [
        "truncated",
        r#"{"validationContract":"old","sqliteVersion":0,"sha256":"wrong","size":1}"#,
    ] {
        f.forget();
        std::fs::write(stamp_path(&f.path), text).unwrap();
        drop(f.admit(ValidationMode::Normal).unwrap());
    }
    assert_eq!(checks(), before + 2);
    f.forget();
    std::fs::remove_file(stamp_path(&f.path)).unwrap();
    std::fs::create_dir(stamp_path(&f.path)).unwrap();
    drop(f.admit(ValidationMode::Normal).unwrap());
    assert!(stamp_path(&f.path).is_dir());
}

#[test]
fn sqlite_and_validation_contract_changes_invalidate_structural_history() {
    let f = Fixture::new("");
    drop(f.admit(ValidationMode::Normal).unwrap());
    for key in ["sqliteVersion", "validationContract"] {
        let mut stamp: serde_json::Value =
            serde_json::from_slice(&std::fs::read(stamp_path(&f.path)).unwrap()).unwrap();
        stamp[key] = if key == "sqliteVersion" {
            serde_json::json!(0)
        } else {
            serde_json::json!("old")
        };
        std::fs::write(stamp_path(&f.path), serde_json::to_vec(&stamp).unwrap()).unwrap();
        f.forget();
        let before = checks();
        drop(f.admit(ValidationMode::Normal).unwrap());
        assert_eq!(checks(), before + 1);
    }
}

#[test]
fn valid_history_still_requires_whole_file_digest_and_current_metadata() {
    let f = Fixture::new("");
    let db = f.admit(ValidationMode::Normal).unwrap();
    let mut wrong_size = f.expected.clone();
    wrong_size.size -= 1;
    assert!(
        admit(&f.path, Some(&wrong_size), ValidationMode::Normal, false)
            .err()
            .unwrap()
            .contains("SHA-256")
    );
    let other = Expected {
        compiler_version: Some("other".into()),
        ..Expected {
            sha256: f.expected.sha256.clone(),
            size: f.expected.size,
            source_version: "fixture".into(),
            revision: 1,
            compiler_version: None,
        }
    };
    assert!(admit(&f.path, Some(&other), ValidationMode::Normal, false)
        .err()
        .unwrap()
        .contains("metadata"));
    drop(db);
    f.forget();
    let db = rusqlite::Connection::open(&f.path).unwrap();
    db.execute(
        "UPDATE meta SET value='best' WHERE key='compiler_version'",
        [],
    )
    .unwrap();
    drop(db);
    let mut expected = f.expected.clone();
    expected.compiler_version = Some("best".into());
    assert!(
        admit(&f.path, Some(&expected), ValidationMode::Normal, false)
            .err()
            .unwrap()
            .contains("SHA-256")
    );
}

#[test]
fn new_managed_artifact_checks_foreign_keys_in_both_modes() {
    for mode in [ValidationMode::Normal, ValidationMode::Strict] {
        let f = Fixture::new("INSERT INTO sources VALUES('story','missing','not-a-blob')");
        assert!(f.admit(mode).err().unwrap().contains("missing blobs"));
        assert!(!stamp_path(&f.path).exists());
    }
}

#[test]
fn custom_read_only_sources_are_not_stamped_and_strict_checks_foreign_keys() {
    let f = Fixture::new("INSERT INTO sources VALUES('story','missing','not-a-blob')");
    let db = admit(&f.path, None, ValidationMode::Normal, false).unwrap();
    assert!(!stamp_path(&f.path).exists());
    assert!(admit(&f.path, None, ValidationMode::Strict, false)
        .err()
        .unwrap()
        .contains("missing blobs"));
    let store = super::super::ZipStore::from_database(Arc::clone(&db));
    assert!(Arc::ptr_eq(&store.database_handle().unwrap().unwrap(), &db));
}

#[test]
fn concurrent_strict_admissions_share_the_same_generation_and_full_check() {
    let f = Fixture::new("");
    let barrier = std::sync::Barrier::new(8);
    std::thread::scope(|scope| {
        let threads: Vec<_> = (0..8)
            .map(|_| {
                scope.spawn(|| {
                    barrier.wait();
                    let before = checks();
                    let db = f.admit(ValidationMode::Strict).unwrap();
                    (db, checks() - before)
                })
            })
            .collect();
        let results: Vec<_> = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect();
        for (db, _) in &results {
            assert!(Arc::ptr_eq(db, &results[0].0));
        }
        assert_eq!(
            results.iter().map(|(_, count)| count).sum::<usize>(),
            if cfg!(windows) { 8 } else { 1 }
        );
    });
}
