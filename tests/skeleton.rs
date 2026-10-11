//! P0 skeleton test: the crate exposes the fixed identity constants that the
//! wire layer will report. Real behavior tests arrive with their phases.
#[test]
fn server_identity_matches_plan() {
    assert_eq!(prts_mcp_rust::SERVER_NAME, "PRTS_Wiki_Assistant");
    assert_eq!(prts_mcp_rust::SERVER_VERSION, "0.1.0+ts2.8.1.local");
}
