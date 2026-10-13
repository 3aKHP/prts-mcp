//! Local development entry: default HTTP, `--transport http|stdio`.

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let transport = args
        .iter()
        .position(|a| a == "--transport")
        .and_then(|p| args.get(p + 1))
        .map(String::as_str)
        .unwrap_or("http");
    let app = prts_mcp_rust::app::App::from_env();
    match transport {
        "stdio" => std::process::exit(app.run_stdio()),
        _ => {
            if let Err(err) = app.run_http() {
                prts_mcp_rust::log_err(&format!("HTTP server failed: {err}"));
                std::process::exit(1);
            }
        }
    }
}
