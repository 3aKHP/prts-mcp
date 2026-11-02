//! Local administration protocol, independent of MCP and installation channels.
pub mod client;
pub mod instances;
pub mod server;
#[cfg(unix)]
pub mod unix;
#[cfg(windows)]
pub mod windows;
pub mod wire;
