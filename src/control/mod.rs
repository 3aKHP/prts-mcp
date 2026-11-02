//! Local administration protocol, independent of MCP and installation channels.
pub mod client;
pub mod instances;
pub mod server;
#[cfg(target_os = "linux")]
pub mod systemd;
pub mod template;
#[cfg(unix)]
pub mod unix;
#[cfg(windows)]
pub mod windows;
pub mod wire;
