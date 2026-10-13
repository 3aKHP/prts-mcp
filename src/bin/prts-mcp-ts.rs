//! `prts-mcp-ts` compatibility entry: HTTP, no transport env switching.

fn main() {
    let app = prts_mcp_rust::app::App::from_env();
    if let Err(err) = app.run_http() {
        prts_mcp_rust::log_err(&format!("HTTP server failed: {err}"));
        std::process::exit(1);
    }
}
