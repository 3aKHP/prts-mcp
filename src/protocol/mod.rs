//! MCP protocol wiring: thin JSON-RPC adapter over HTTP sessions and stdio,
//! with the legacy/modern era rules captured in contracts/wire/.

pub mod dispatch;
pub mod http;
pub mod jsonrpc;
pub mod session;
pub mod stdio;

/// Modern protocol revision the oracle advertises (the only entry of
/// `supportedVersions` in server/discover).
pub const MODERN_PROTOCOL_VERSION: &str = "2026-07-28";

/// Legacy versions the initialize negotiation echoes back (wire capture
/// `initialize-version-negotiation`); anything else falls back to the newest.
pub const LEGACY_PROTOCOL_VERSIONS: [&str; 4] =
    ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];

/// The version legacy initialize answers with when the request asks for
/// something outside the supported set.
pub const LEGACY_FALLBACK_VERSION: &str = "2025-11-25";

pub const ENVELOPE_PROTOCOL_VERSION: &str = "io.modelcontextprotocol/protocolVersion";
pub const ENVELOPE_CLIENT_INFO: &str = "io.modelcontextprotocol/clientInfo";
pub const ENVELOPE_CLIENT_CAPABILITIES: &str = "io.modelcontextprotocol/clientCapabilities";
