//! Local development entry: default HTTP, `--transport http|stdio`.
//! P0 skeleton — prints identity to stderr and exits; no listener, no tools.
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let transport = if args.iter().any(|a| a == "--transport") {
        args.iter()
            .position(|a| a == "--transport")
            .and_then(|p| args.get(p + 1))
            .map(String::as_str)
            .unwrap_or("http")
    } else {
        "http"
    };
    eprintln!(
        "prts-mcp-rust {} skeleton (transport={}): P0骨架尚无业务实现",
        prts_mcp_rust::SERVER_VERSION,
        transport
    );
}
