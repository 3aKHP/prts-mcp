//! Public search results stay complete when block hints and catalogs are reused.
use super::{config, copy_tree, sqlite_fixture};
use prts_mcp_rust::tools::{AppHandle, DispatchResult, OutputChannel};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

fn fixture() -> PathBuf {
    let root = std::env::temp_dir().join(format!("prts-story-filters-{}", uuid::Uuid::new_v4()));
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/native-smoke");
    copy_tree(&source.join("zh_CN"), &root.join("zh_CN"));
    copy_tree(&source.join("storyjson"), &root.join("storyjson"));
    sqlite_fixture::compile(&root);
    root
}

fn fresh_sqlite_app(root: &Path, name: &str) -> AppHandle {
    // Distinct files prevent the process-wide GameDb registry from turning a
    // supposedly cold application into another reader of an already warm DB.
    let path = root.join("database").join(format!("{name}.sqlite"));
    std::fs::copy(root.join("database/zh_CN.sqlite"), &path).unwrap();
    let mut runtime = config(root, "sqlite");
    runtime.custom_database = Some(path.clone());
    let app = AppHandle::from_config(&runtime);
    assert_eq!(app.snapshot().database.as_ref().unwrap().path, path);
    app
}

async fn search(app: &AppHandle, args: &Value) -> Value {
    let registry = prts_mcp_rust::tools::registry();
    let tool = registry
        .iter()
        .find(|tool| tool.name == "search_stories")
        .unwrap();
    match (tool.dispatch)(app, args).await {
        DispatchResult::Outcome(outcome) => {
            let result = outcome.render(OutputChannel::Both);
            assert_ne!(result["isError"], json!(true), "{result}");
            assert!(
                result["structuredContent"]["results"].is_array(),
                "{result}"
            );
            result
        }
        DispatchResult::RpcError(code, error) => panic!("search_stories: {code}: {error}"),
    }
}

fn all_args() -> Value {
    // This Han literal has a usable multibyte prefix under the native /iu
    // engine, and matches both act_test choices and act_big dialogue.
    json!({"pattern":"一", "context_lines":0, "max_results":100})
}

fn assert_complete_fixture_results(result: &Value) {
    let matches = result["structuredContent"]["results"].as_array().unwrap();
    assert!(matches.len() > 1 && matches.len() < 100);
    assert!(matches.iter().any(|row| row["event_id"] == "act_test"));
    assert!(matches.iter().any(|row| row["event_id"] == "act_big"));
}

#[tokio::test]
async fn repeated_search_matches_json_before_and_after_catalog_warming() {
    let root = fixture();
    let json_app = AppHandle::from_config(&config(&root, "json"));
    let expected = search(&json_app, &all_args()).await;
    assert_complete_fixture_results(&expected);
    let sqlite = fresh_sqlite_app(&root, "repeated");
    assert_eq!(search(&sqlite, &all_args()).await, expected);
    assert_eq!(search(&sqlite, &all_args()).await, expected);
    drop((sqlite, json_app));
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn event_search_matches_cold_database_before_and_after_unscoped_search() {
    let root = fixture();
    let json_app = AppHandle::from_config(&config(&root, "json"));
    let expected_all = search(&json_app, &all_args()).await;
    assert_complete_fixture_results(&expected_all);
    let mut event_args = all_args();
    event_args["event_id"] = json!("act_test");
    let expected_event = search(&json_app, &event_args).await;
    let matches = expected_event["structuredContent"]["results"]
        .as_array()
        .unwrap();
    assert!(!matches.is_empty());
    assert!(matches.iter().all(|row| row["event_id"] == "act_test"));

    let cold = fresh_sqlite_app(&root, "cold-event");
    assert_eq!(search(&cold, &event_args).await, expected_event);
    let warm = fresh_sqlite_app(&root, "warm-event");
    assert_eq!(search(&warm, &event_args).await, expected_event);
    // A scoped first search must not publish a partial whole-database catalog.
    assert_eq!(search(&warm, &all_args()).await, expected_all);
    assert_eq!(search(&warm, &event_args).await, expected_event);
    drop((cold, warm, json_app));
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn early_result_limit_does_not_truncate_subsequent_searches() {
    let root = fixture();
    let json_app = AppHandle::from_config(&config(&root, "json"));
    let expected = search(&json_app, &all_args()).await;
    assert_complete_fixture_results(&expected);
    let sqlite = fresh_sqlite_app(&root, "early-limit");
    let mut limited_args = all_args();
    limited_args["max_results"] = json!(1);
    let limited = search(&sqlite, &limited_args).await;
    let matches = limited["structuredContent"]["results"].as_array().unwrap();
    assert_eq!(matches.len(), 1);
    assert_eq!(matches[0], expected["structuredContent"]["results"][0]);
    assert_eq!(search(&sqlite, &all_args()).await, expected);
    assert_eq!(search(&sqlite, &all_args()).await, expected);
    drop((sqlite, json_app));
    std::fs::remove_dir_all(root).unwrap();
}
