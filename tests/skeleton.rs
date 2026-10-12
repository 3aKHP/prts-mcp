//! P0 skeleton test: the crate exposes the fixed identity constants that the
//! wire layer will report. Real behavior tests arrive with their phases.
#[test]
fn server_identity_matches_plan() {
    assert_eq!(prts_mcp_rust::SERVER_NAME, "PRTS_Wiki_Assistant");
    assert_eq!(prts_mcp_rust::SERVER_VERSION, "0.1.0+ts2.8.1.local");
}

/// docs/07 phase tool-count contract: P5 ends at 23 real tools (12 GameData
/// + 9 Story + 2 Wiki); P6 adds the artwork tool (24/23 final).
#[test]
fn registry_has_23_tools_at_p5() {
    let tools = prts_mcp_rust::tools::registry();
    assert_eq!(tools.len(), 23, "phase contract: P5 = 23 tools");
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
