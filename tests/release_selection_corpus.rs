//! Shared publication-case corpus for data release selection (ported from
//! ts/tests/parity-fixtures/data-release-selection.json via
//! ts/tests/sync.test.ts "data release selector matches shared publication
//! cases"). Real historical regressions, not synthetic coverage.

use prts_mcp_rust::sync::discovery::latest_data_release;
use prts_mcp_rust::sync::types::SyncError;

fn release_entry(tag: &str, draft: Option<&str>, prerelease: Option<&str>) -> serde_json::Value {
    let mut entry = serde_json::json!({
        "tag_name": tag,
        "created_at": "2026-01-01T00:00:00Z",
        "assets": [],
    });
    if draft == Some(tag) {
        entry["draft"] = serde_json::Value::Bool(true);
    }
    if prerelease == Some(tag) {
        entry["prerelease"] = serde_json::Value::Bool(true);
    }
    entry
}

#[test]
fn data_release_selector_matches_shared_publication_cases() {
    let corpus = include_str!("../contracts/cases/data-release-selection.json");
    let cases: Vec<serde_json::Value> = serde_json::from_str(corpus).expect("corpus parses");
    assert!(
        cases.len() >= 9,
        "expected the shared corpus, got {}",
        cases.len()
    );
    for case in &cases {
        let name = case["name"].as_str().expect("case name");
        let tags: Vec<&str> = case["tags"]
            .as_array()
            .expect("tags array")
            .iter()
            .filter_map(|t| t.as_str())
            .collect();
        let draft = case["draft"].as_str();
        let prerelease = case["prerelease"].as_str();
        let releases: Vec<serde_json::Value> = tags
            .iter()
            .map(|tag| release_entry(tag, draft, prerelease))
            .collect();
        let picked = latest_data_release(&releases);
        if case.get("error").and_then(|e| e.as_bool()).unwrap_or(false) {
            assert!(
                matches!(picked, Err(SyncError::DuplicateReleaseIdentity)),
                "{name}: expected duplicate failure"
            );
            continue;
        }
        let picked = picked
            .unwrap_or_else(|e| panic!("{name}: unexpected error {e}"))
            .and_then(|r| r["tag_name"].as_str().map(str::to_string));
        let expected = case["expected"].as_str().map(str::to_string);
        assert_eq!(picked, expected, "{name}");
    }
}
