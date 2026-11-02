use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    process::Command,
};
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("prts-inspect-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        Self(root)
    }
    fn command(&self) -> Command {
        let mut c = Command::new(env!("CARGO_BIN_EXE_prtsctl"));
        c.env_clear()
            .env("HOME", &self.0)
            .env("USERPROFILE", &self.0)
            .env("APPDATA", &self.0)
            .env("XDG_CONFIG_HOME", &self.0)
            .env("XDG_DATA_HOME", self.0.join("data"));
        c
    }
    fn db(&self) -> PathBuf {
        let path = self.0.join("database/test.sqlite");
        fs::create_dir(path.parent().unwrap()).unwrap();
        let db = rusqlite::Connection::open(&path).unwrap();
        db.execute_batch(include_str!("../contracts/sqlite-schema-v1.sql"))
            .unwrap();
        for (key, value) in [
            ("sources_complete", "1"),
            ("derived_complete", "1"),
            ("contract", "prts-mcp-sqlite/v1"),
            ("index_version", "1"),
            ("language", "zh_CN"),
            ("source_version", "fixture"),
            ("publication_revision", "1"),
        ] {
            db.execute("INSERT INTO meta VALUES(?1,?2)", [key, value])
                .unwrap();
        }
        drop(db);
        path
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn snapshot(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    fn walk(root: &Path, out: &mut BTreeMap<PathBuf, Vec<u8>>) {
        for e in fs::read_dir(root).unwrap() {
            let p = e.unwrap().path();
            if p.is_dir() {
                walk(&p, out)
            } else {
                out.insert(p.clone(), fs::read(p).unwrap());
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(root, &mut out);
    out
}
fn json(output: &std::process::Output) -> serde_json::Value {
    serde_json::from_slice(&output.stdout).unwrap_or_else(|e| panic!("{e}: {output:?}"))
}
#[test]
fn missing_default_data_is_observable_without_creating_directories() {
    let f = Fixture::new();
    let before = snapshot(&f.0);
    for cmd in [["data", "status"], ["doctor", "--output=text"]] {
        let o = f.command().args(cmd).output().unwrap();
        assert!(o.status.success(), "{o:?}");
    }
    assert_eq!(snapshot(&f.0), before);
    let o = f
        .command()
        .args(["data", "verify", "-o", "json"])
        .output()
        .unwrap();
    assert_eq!(o.status.code(), Some(1));
    assert_eq!(json(&o)["ok"], false);
    assert_eq!(snapshot(&f.0), before);
}
#[test]
fn sqlite_inspection_never_writes_admission_stamps_or_sidecars() {
    let f = Fixture::new();
    let db = f.db();
    let before = snapshot(&f.0);
    for cmd in ["status", "verify"] {
        let o = f
            .command()
            .env("PRTS_DATA_DB", &db)
            .args(["data", cmd, "-o", "json"])
            .output()
            .unwrap();
        assert!(o.status.success(), "{o:?}");
        assert_eq!(json(&o)["available_backend"], "sqlite");
        assert_eq!(snapshot(&f.0), before);
    }
}
#[test]
fn managed_database_digest_and_metadata_are_checked() {
    use sha2::Digest;
    let f = Fixture::new();
    let db = f.db();
    let root = db.parent().unwrap();
    let hash = format!("{:x}", sha2::Sha256::digest(fs::read(&db).unwrap()));
    let pointer = |version: &str, digest: &str| {
        format!("prts-mcp-active/v1\ntest.sqlite\n{version}\n1\n{digest}\n")
    };
    for (version, digest, success) in [
        ("fixture", hash.clone(), true),
        ("different", hash.clone(), false),
        ("fixture", "a".repeat(64), false),
    ] {
        fs::write(root.join("active"), pointer(version, &digest)).unwrap();
        let before = snapshot(&f.0);
        let o = f
            .command()
            .env("PRTS_DATA_BACKEND", "sqlite")
            .env("PRTS_DATA_DIR", root)
            .args(["data", "verify", "-o", "json"])
            .output()
            .unwrap();
        assert_eq!(o.status.success(), success, "{o:?}");
        assert_eq!(snapshot(&f.0), before);
    }
}
#[test]
fn corrupt_pointer_and_source_mismatch_are_not_hidden() {
    let f = Fixture::new();
    let db = f.db();
    let root = db.parent().unwrap();
    fs::write(root.join("active"), "bad pointer").unwrap();
    fs::write(
        root.join(".prts-data-source.json"),
        r#"{"schemaVersion":1,"repo":"another/source"}"#,
    )
    .unwrap();
    let before = snapshot(&f.0);
    let o = f
        .command()
        .env("PRTS_DATA_DIR", root)
        .args(["doctor", "-o", "json"])
        .output()
        .unwrap();
    assert_eq!(o.status.code(), Some(1));
    assert_eq!(json(&o)["ok"], false);
    assert_eq!(snapshot(&f.0), before);
}
#[test]
fn explicit_missing_database_is_a_doctor_error() {
    let f = Fixture::new();
    let o = f
        .command()
        .env("PRTS_DATA_DB", f.0.join("missing.sqlite"))
        .args(["doctor", "-o", "json"])
        .output()
        .unwrap();
    assert_eq!(o.status.code(), Some(1));
    assert_eq!(json(&o)["ok"], false);
}

#[test]
fn json_verification_uses_complete_required_file_set() {
    let f = Fixture::new();
    let game = f.0.join("game");
    let declarations: serde_json::Value =
        serde_json::from_str(include_str!("../contracts/data-declarations.json")).unwrap();
    for dataset in declarations["datasets"].as_array().unwrap().iter().take(2) {
        for name in dataset["requiredFiles"].as_array().unwrap() {
            let path = game.join(name.as_str().unwrap());
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, "{}").unwrap();
        }
    }
    let story = f.0.join("story.zip");
    prts_mcp_rust::storage::write_zip_entries(
        &story,
        &[
            ("zh_CN/gamedata/excel/story_review_table.json", b"{}"),
            ("zh_CN/storyinfo.json", b"{}"),
        ],
    )
    .unwrap();
    let run = || {
        f.command()
            .env("GAMEDATA_PATH", &game)
            .env("STORYJSON_PATH", &story)
            .args(["data", "verify", "-o", "json"])
            .output()
            .unwrap()
    };
    let before = snapshot(&f.0);
    let o = run();
    assert!(o.status.success(), "{o:?}");
    assert_eq!(snapshot(&f.0), before);
    fs::write(
        game.join("zh_CN/gamedata/excel/skill_table.json"),
        "invalid json",
    )
    .unwrap();
    let before = snapshot(&f.0);
    let o = run();
    assert_eq!(o.status.code(), Some(1));
    assert_eq!(snapshot(&f.0), before);
}
#[test]
fn inspection_refuses_uncheckpointed_wal_without_touching_it() {
    let f = Fixture::new();
    let db = f.db();
    let mut wal = db.as_os_str().to_owned();
    wal.push("-wal");
    fs::write(PathBuf::from(wal), "uncheckpointed").unwrap();
    let before = snapshot(&f.0);
    let o = f
        .command()
        .env("PRTS_DATA_DB", db)
        .args(["data", "verify", "-o", "json"])
        .output()
        .unwrap();
    assert_eq!(o.status.code(), Some(1));
    assert_eq!(snapshot(&f.0), before);
}

#[test]
fn artwork_hash_checks_are_explicit_and_leave_files_unchanged() {
    use sha2::Digest;
    let f = Fixture::new();
    let db = f.db();
    let images = f.0.join("images");
    let generation = images.join(".releases/fixture");
    fs::create_dir_all(&generation).unwrap();
    let png = b"fixture-image";
    fs::write(generation.join("image.png"), png).unwrap();
    fs::write(
        images.join(".images_meta.json"),
        r#"{"generation_root":".releases/fixture"}"#,
    )
    .unwrap();
    let index = serde_json::json!({"schemaVersion":"akdp-images/v1","baselineVersion":"fixture","currentVersion":"fixture","artworks":{"fixture":{"kind":"base","shard":"chararts","large":{"file":"image.png","w":1,"h":1,"bytes":png.len(),"sha256":format!("{:x}",sha2::Sha256::digest(png))}}}});
    fs::write(
        generation.join("index.json"),
        serde_json::to_vec(&index).unwrap(),
    )
    .unwrap();
    let run = || {
        f.command()
            .env("PRTS_DATA_DB", &db)
            .env("PRTS_IMAGE_DIR", &images)
            .env("LOCAL_IMAGE", "true")
            .args(["data", "verify", "-o", "json"])
            .output()
            .unwrap()
    };
    let before = snapshot(&f.0);
    let out = run();
    assert!(out.status.success(), "{out:?}");
    assert_eq!(snapshot(&f.0), before);
    fs::write(generation.join("image.png"), b"damaged-image").unwrap();
    let before = snapshot(&f.0);
    let out = run();
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(snapshot(&f.0), before);
}
