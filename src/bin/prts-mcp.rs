//! GHCR compatibility profile: PRTS_TRANSPORT selects the transport — trim +
//! lowercase first; exactly `http` picks HTTP, anything else stays stdio.

fn main() {
    let requested = std::env::var("PRTS_TRANSPORT")
        .map(|v| v.trim().to_lowercase())
        .unwrap_or_default();
    let app = prts_mcp_rust::app::App::from_env();
    if requested == "http" {
        // PORT is parsed only on the HTTP branch (python server.main());
        // a non-numeric value logs and exits 1, bind failures exit 1.
        if let Err(err) = app.run_http_profile(prts_mcp_rust::app::HttpProfile::Ghcr) {
            prts_mcp_rust::log_err(&err.to_string());
            std::process::exit(1);
        }
    } else {
        std::process::exit(app.run_stdio());
    }
}
