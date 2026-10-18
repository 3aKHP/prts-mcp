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
