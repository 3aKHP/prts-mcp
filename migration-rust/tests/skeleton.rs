//! P0 skeleton test: the crate exposes the fixed identity constants that the
//! wire layer will report. Real behavior tests arrive with their phases.
#[test]
fn server_identity_matches_plan() {
    assert_eq!(prts_mcp_rust::SERVER_NAME, "PRTS_Wiki_Assistant");
    assert_eq!(prts_mcp_rust::SERVER_VERSION, "0.1.0+ts2.8.1.local");
}

/// docs/07 phase tool-count contract: the final surface is 24 real tools
/// with IMAGES_ENABLED and exactly 23 without (artwork is the only gated
/// registration — data availability never hides a tool).
#[test]
fn registry_24_with_images_23_without() {
    let tools = prts_mcp_rust::tools::registry();
    assert_eq!(tools.len(), 24, "phase contract: full surface = 24 tools");
    let names: Vec<&str> = tools.iter().map(|t| t.name).collect();
    assert_eq!(names.last().copied(), Some("operator_artwork"));
    let disabled = prts_mcp_rust::tools::registry_for(false);
    assert_eq!(
        disabled.len(),
        23,
        "IMAGES_ENABLED=false removes only artwork"
    );
    let disabled_names: Vec<&str> = disabled.iter().map(|t| t.name).collect();
    assert!(!disabled_names.contains(&"operator_artwork"));
    assert!(names.starts_with(&["search_prts", "prts_page"]));
    let names: Vec<&str> = tools.iter().map(|t| t.name).collect();
    for expected in [
        "get_operator_archives",
        "get_operator_voicelines",
        "get_operator_basic_info",
        "list_enemies",
        "get_enemy_info",
        "get_stage_enemies",
        "get_enemy_appearances",
        "list_stages",
        "get_stage_info",
        "list_items",
        "get_item_info",
        "search",
        "list_story_events",
        "list_stories",
        "get_story_summary",
        "read_story",
        "read_activity",
        "search_stories",
        "get_operator_memoirs",
        "find_character_appearances",
        "find_speakers_in",
        "search_prts",
        "prts_page",
    ] {
        assert!(names.contains(&expected), "missing {expected}");
    }
}
