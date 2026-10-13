//! Product entry: HTTP by default; PRTS_TRANSPORT=stdio selects stdio.

fn main() {
    let transport = std::env::var("PRTS_TRANSPORT")
        .map(|value| value.trim().to_lowercase())
        .unwrap_or_default();
    let app = prts_mcp_rust::app::App::from_env();
    if transport == "stdio" {
        std::process::exit(app.run_stdio());
    }
    // Empty or unrecognized values keep the documented HTTP default.
    if let Err(err) = app.run_http() {
        prts_mcp_rust::log_err(&format!("HTTP server failed: {err}"));
        std::process::exit(1);
    }
}
