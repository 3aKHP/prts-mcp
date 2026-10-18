use super::*;
use rusqlite::params;

fn temp() -> PathBuf {
    let path = std::env::temp_dir().join(format!("prts-data-compiler-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(path.join("input/zh_CN/gamedata/excel")).unwrap();
    path
}

#[test]
fn archives_unknown_fields_and_empty_containers_without_pruning() -> Result<()> {
    let root = temp();
    let raw=br#"{"char_2":{"name":"same","future":{"array":[],"object":{},"null":null,"u64":18446744073709551615}},"char_1":{"name":"same"},"char_3":{"name":""}}"#;
    fs::write(
        root.join("input/zh_CN/gamedata/excel/character_table.json"),
        raw,
    )?;
    fs::write(root.join("input/zh_CN/unknown.dat"), b"\0future input\xff")?;
    let options = Options {
        input: Some(root.join("input")),
        version: "fixture".into(),
        output: root.join("data.sqlite"),
        revision: 1,
        allow_incomplete: true,
        ..Options::default()
    };
    let mut db = Connection::open(root.join("capture.sqlite"))?;
    db.execute_batch(include_str!("../../contracts/sqlite-schema-v1.sql"))?;
    sources::capture(&mut db, &options)?;
    let (count, _) = sources::verify_sources(&db)?;
    assert_eq!(
        count, 2,
        "aliases deduplicate physical blobs without removing logical paths"
    );
    let payload: String = db.query_row(
        "SELECT payload FROM entities WHERE dataset='character_table' AND key='char_2'",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&payload)?["future"]["u64"],
        u64::MAX
    );
    let name: String = db.query_row(
        "SELECT key FROM names WHERE dataset=? AND name='same'",
        ["character_table"],
        |r| r.get(0),
    )?;
    assert_eq!(name, "char_1");
    let ordinal: i64 = db.query_row(
        "SELECT ordinal FROM names WHERE dataset=? AND name='same'",
        ["character_table"],
        |r| r.get(0),
    )?;
    assert_eq!(ordinal, 0);
    assert_eq!(
        db.query_row(
            "SELECT key FROM names WHERE dataset=? AND name=''",
            ["character_table"],
            |r| r.get::<_, String>(0)
        )?,
        "char_3"
    );
    let unknown: i64 = db.query_row(
        "SELECT count(*) FROM sources WHERE path=?",
        ["zh_CN/unknown.dat"],
        |r| r.get(0),
    )?;
    assert_eq!(unknown, 2, "original and story namespaces remain available");
    drop(db);
    {
        let reader = prts_mcp_rust::storage::sqlite::GameDb::open(&root.join("capture.sqlite"))?;
        assert_eq!(reader.raw("excel", "character_table.json")?, raw);
    }
    fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn rejects_incomplete_production_input_and_does_not_publish_outputs() -> Result<()> {
    let root = temp();
    fs::write(
        root.join("input/zh_CN/gamedata/excel/character_table.json"),
        b"{}",
    )?;
    let options = Options {
        input: Some(root.join("input")),
        version: "fixture".into(),
        output: root.join("data.sqlite"),
        revision: 1,
        ..Options::default()
    };
    assert!(compile(&options).is_err());
    assert!(!options.output.exists());
    assert!(!suffix(&options.output, ".gz").exists());
    fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn rejects_invalid_core_json_before_sources_are_marked_complete() -> Result<()> {
    let root = temp();
    fs::write(
        root.join("input/zh_CN/gamedata/excel/character_table.json"),
        b"[]",
    )?;
    let options = Options {
        input: Some(root.join("input")),
        version: "fixture".into(),
        output: root.join("data.sqlite"),
        revision: 1,
        allow_incomplete: true,
        ..Options::default()
    };
    let mut db = Connection::open_in_memory()?;
    db.execute_batch(include_str!("../../contracts/sqlite-schema-v1.sql"))?;
    assert!(sources::capture(&mut db, &options).is_err());
    let count: i64 = db.query_row(
        "SELECT count(*) FROM meta WHERE key=?",
        params!["sources_complete"],
        |r| r.get(0),
    )?;
    assert_eq!(count, 0);
    fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn production_derivation_failure_does_not_publish_an_artifact() -> Result<()> {
    let root = temp();
    let excel = root.join("input/zh_CN/gamedata/excel");
    for file in [
        "character_table",
        "handbook_info_table",
        "charword_table",
        "story_review_table",
        "enemy_handbook_table",
        "stage_table",
        "zone_table",
        "item_table",
        "building_data",
        "skin_table",
        "skill_table",
    ] {
        fs::write(excel.join(format!("{file}.json")), b"{}")?;
    }
    fs::create_dir_all(root.join("input/zh_CN/gamedata/levels/enemydata"))?;
    fs::write(
        root.join("input/zh_CN/gamedata/levels/enemydata/enemy_database.json"),
        b"{\"enemies\":[]}",
    )?;
    fs::write(root.join("input/zh_CN/storyinfo.json"), b"{}")?;
    let options = Options {
        input: Some(root.join("input")),
        output: root.join("data.sqlite"),
        version: "fixture".into(),
        revision: 1,
        ..Default::default()
    };
    let error = compile(&options).unwrap_err().to_string();
    assert!(error.contains("Cannot derive"), "{error}");
    for suffix_text in ["", ".gz", ".meta.json"] {
        assert!(!suffix(&options.output, suffix_text).exists());
    }
    fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn explicit_story_archive_preserves_its_excel_copy_without_overwriting_main_excel() -> Result<()> {
    let root = temp();
    let current = br#"{"char_1":{"name":"new"}}"#;
    let archived = br#"{"char_1":{"name":"old"}}"#;
    fs::write(
        root.join("input/zh_CN/gamedata/excel/character_table.json"),
        current,
    )?;
    let story = root.join("story.zip");
    let mut zip = zip::ZipWriter::new(fs::File::create(&story)?);
    zip.start_file(
        "zh_CN/gamedata/excel/character_table.json",
        zip::write::SimpleFileOptions::default(),
    )?;
    zip.write_all(archived)?;
    zip.finish()?;
    let options = Options {
        input: Some(root.join("input")),
        story_zip: Some(story),
        output: root.join("data.sqlite"),
        version: "fixture".into(),
        revision: 1,
        allow_incomplete: true,
        ..Default::default()
    };
    let mut writer = Connection::open(&options.output)?;
    writer.execute_batch(include_str!("../../contracts/sqlite-schema-v1.sql"))?;
    sources::capture(&mut writer, &options)?;
    drop(writer);
    {
        let db = prts_mcp_rust::storage::sqlite::GameDb::open(&options.output)?;
        assert_eq!(db.raw("excel", "character_table.json")?, current);
        assert_eq!(
            db.raw("story", "zh_CN/gamedata/excel/character_table.json")?,
            archived
        );
        assert_eq!(
            db.entity("character_table", "", "char_1")?.unwrap()["name"],
            "new"
        );
    }
    fs::remove_dir_all(root)?;
    Ok(())
}
