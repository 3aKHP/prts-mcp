//! `prts-mcp-ts-stdio` compatibility entry: stdio only, never binds a port.

fn main() {
    prts_mcp_rust::cli::legacy::dispatch("prts-mcp-ts-stdio");
    let app = prts_mcp_rust::app::App::from_env();
    std::process::exit(app.run_stdio());
}
