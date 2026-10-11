//! GHCR compatibility profile: PRTS_TRANSPORT selects the transport — trim +
//! lowercase first; exactly `http` picks HTTP, anything else stays stdio.

fn main() {
    let requested = std::env::var("PRTS_TRANSPORT")
        .map(|v| v.trim().to_lowercase())
        .unwrap_or_default();
    let app = prts_mcp_rust::app::App::from_env();
    if requested == "http" {
        if let Err(err) = app.run_http() {
            prts_mcp_rust::log_err(&format!("HTTP server failed: {err}"));
            std::process::exit(1);
        }
    } else {
        std::process::exit(app.run_stdio());
    }
}
