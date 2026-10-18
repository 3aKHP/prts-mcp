//! Both backends expose the same tools and ignore the other backend's files.
#[path = "support/sqlite.rs"]
mod sqlite_fixture;

use std::{path::Path, process::Command};

use prts_mcp_rust::{
    config::RuntimeConfig,
    tools::{AppHandle, DispatchResult, OutputChannel},
};
use serde_json::{json, Value};

fn copy_tree(source: &Path, target: &Path) {
    std::fs::create_dir_all(target).unwrap();
    for entry in std::fs::read_dir(source).unwrap() {
        let entry = entry.unwrap();
        if entry.file_type().unwrap().is_dir() {
            copy_tree(&entry.path(), &target.join(entry.file_name()));
        } else {
            std::fs::copy(entry.path(), target.join(entry.file_name())).unwrap();
        }
    }
}

fn config(root: &Path, backend: &str) -> RuntimeConfig {
    RuntimeConfig::from_lookup(|key| match key {
        "PRTS_DATA_BACKEND" => Some(backend.into()),
        "GAMEDATA_PATH" => Some(root.to_string_lossy().into_owned()),
        "STORYJSON_PATH" => Some(
            root.join("storyjson/zh_CN.zip")
                .to_string_lossy()
                .into_owned(),
        ),
        _ => None,
    })
}

async fn calls(root: &Path, backend: &str) -> Vec<Value> {
    let app = AppHandle::from_config(&config(root, backend));
    let registry = prts_mcp_rust::tools::registry();
    let mut results = Vec::new();
    for (name, args) in [
        ("list_stages", json!({})),
        (
            "search",
            json!({"pattern":"阿米娅","scope":"operators","limit":2}),
        ),
        ("list_story_events", json!({})),
        (
            "search_stories",
            json!({"pattern":"阿米娅","max_results":2}),
        ),
    ] {
        let tool = registry.iter().find(|tool| tool.name == name).unwrap();
        match (tool.dispatch)(&app, &args).await {
            DispatchResult::Outcome(outcome) => results.push(outcome.render(OutputChannel::Both)),
            DispatchResult::RpcError(code, error) => panic!("{name}: {code}: {error}"),
        }
    }
    results
}

#[tokio::test]
async fn backend_outputs_match_and_unselected_files_are_not_required() {
    let root = std::env::temp_dir().join(format!("prts-dual-{}", uuid::Uuid::new_v4()));
    let fixture =
        Path::new(env!("CARGO_MANIFEST_DIR")).join(".runtime/fixtures/minimal-gamedata-v2");
    copy_tree(&fixture.join("zh_CN"), &root.join("zh_CN"));
    copy_tree(&fixture.join("storyjson"), &root.join("storyjson"));
    sqlite_fixture::compile(&root);

    let expected = calls(&root, "json").await;
    assert_eq!(expected, calls(&root, "sqlite").await);
    // Even a valid database explicitly supplied as a story archive must not
    // route JSON-mode story tools through the SQLite adapter.
    let mut explicit_story_database = config(&root, "json");
    let database_path = root.join("database/zh_CN.sqlite");
    explicit_story_database.storyjson_zip = database_path.clone();
    explicit_story_database.bundle_root = None;
    let view = AppHandle::from_config(&explicit_story_database).snapshot();
    assert!(view.database.is_none());
    assert_ne!(view.story_zip.as_ref(), Some(&database_path));
    drop(view);

    // A database renamed as the bundled story ZIP is also excluded.
    let bundled_story = root.join("bundle/storyjson/zh_CN.zip");
    std::fs::create_dir_all(bundled_story.parent().unwrap()).unwrap();
    std::fs::copy(&database_path, &bundled_story).unwrap();
    explicit_story_database.storyjson_zip = root.join("absent.zip");
    explicit_story_database.bundle_root = Some(root.join("bundle"));
    let view = AppHandle::from_config(&explicit_story_database).snapshot();
    assert!(view.database.is_none());
    assert_ne!(view.story_zip.as_ref(), Some(&bundled_story));
    drop(view);

    // SQLite must work on a fresh data view with every raw input absent.
    std::fs::rename(root.join("zh_CN"), root.join("raw-hidden")).unwrap();
    std::fs::rename(root.join("storyjson"), root.join("story-hidden")).unwrap();
    assert_eq!(expected, calls(&root, "sqlite").await);

    std::fs::rename(root.join("raw-hidden"), root.join("zh_CN")).unwrap();
    std::fs::rename(root.join("story-hidden"), root.join("storyjson")).unwrap();
    // JSON must ignore even an invalid database and pointer in its sync directory.
    std::fs::write(root.join("database/zh_CN.sqlite"), b"invalid database").unwrap();
    std::fs::write(root.join("database/active"), b"invalid pointer").unwrap();
    assert_eq!(expected, calls(&root, "json").await);
    assert!(AppHandle::from_config(&config(&root, "sqlite"))
        .snapshot()
        .database
        .is_none());
    assert!(AppHandle::from_config(&config(&root, "json"))
        .snapshot()
        .database
        .is_none());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn invalid_backend_exits_before_starting_the_protocol_or_sync() {
    for value in ["db", "SQLITE", "unknown"] {
        let output = Command::new(env!("CARGO_BIN_EXE_prts-mcp"))
            .env_clear()
            .env("PRTS_TRANSPORT", "stdio")
            .env("PRTS_DATA_BACKEND", value)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(2));
        assert!(output.stdout.is_empty());
        assert!(String::from_utf8_lossy(&output.stderr)
            .contains("PRTS_DATA_BACKEND must be json or sqlite"));
    }
}

#[tokio::test]
async fn incomplete_schema_is_rejected_and_previous_generation_is_selected() {
    use prts_mcp_rust::storage::{database::ActiveDatabase, sqlite::GameDb};

    let root = std::env::temp_dir().join(format!("prts-schema-{}", uuid::Uuid::new_v4()));
    let fixture =
        Path::new(env!("CARGO_MANIFEST_DIR")).join(".runtime/fixtures/minimal-gamedata-v2");
    copy_tree(&fixture.join("zh_CN"), &root.join("zh_CN"));
    copy_tree(&fixture.join("storyjson"), &root.join("storyjson"));
    sqlite_fixture::compile(&root);

    let database_dir = root.join("database");
    let healthy = database_dir.join("zh_CN.sqlite");
    let expected = calls(&root, "sqlite").await;
    let previous = ActiveDatabase {
        file_name: "zh_CN.sqlite".into(),
        source_version: "fixture".into(),
        revision: 1,
        sha256: "a".repeat(64),
    };
    std::fs::write(database_dir.join("previous"), previous.encode().unwrap()).unwrap();
    for (index, corruption) in [
        "DROP TABLE names",
        "DROP TABLE story_blocks",
        "ALTER TABLE names RENAME COLUMN name TO missing_name",
    ]
    .into_iter()
    .enumerate()
    {
        let mut active = previous.clone();
        active.file_name = format!("broken-{index}.sqlite");
        let broken = active.path(&database_dir);
        std::fs::copy(&healthy, &broken).unwrap();
        rusqlite::Connection::open(&broken)
            .unwrap()
            .execute_batch(corruption)
            .unwrap();
        assert!(GameDb::open(&broken).is_err(), "{corruption}");

        let mut explicit = config(&root, "sqlite");
        explicit.custom_database = Some(broken);
        assert!(AppHandle::from_config(&explicit)
            .snapshot()
            .database
            .is_none());

        std::fs::write(database_dir.join("active"), active.encode().unwrap()).unwrap();
        assert_eq!(
            AppHandle::from_config(&config(&root, "sqlite"))
                .snapshot()
                .database
                .as_ref()
                .unwrap()
                .path,
            healthy,
            "{corruption}"
        );
        assert_eq!(expected, calls(&root, "sqlite").await, "{corruption}");
    }
    std::fs::remove_dir_all(root).unwrap();
}
