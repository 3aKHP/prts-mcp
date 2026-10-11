//! prts-mcp-rust — local Rust replication of PRTS-MCP TS v2.8.1.
//!
//! Module layout follows docs/02-architecture.md; dependency direction is
//! `app → protocol/tools/domain/wiki/sync/storage/config`, and `config` must
//! stay free of downstream imports. This crate is the single business library;
//! the thin binaries under `src/bin/` only assemble and run it.

pub mod app;
pub mod config;
pub mod contracts;
pub mod diagnostics;
pub mod domain;
pub mod protocol;
pub mod storage;
pub mod sync;
pub mod text;
pub mod tools;
pub mod wiki;

/// Crate version, also the `serverInfo.version` value the MCP handshake
/// reports. Deliberately distinct from the TS release number (D-001):
/// `0.1.0+ts2.8.1.local` states which oracle this build replicates without
/// impersonating a published 2.8.1 artifact.
pub const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Server identity reported by initialize/server-discover. Must stay identical
/// to the TS oracle (`server-core.ts`).
pub const SERVER_NAME: &str = "PRTS_Wiki_Assistant";

/// stderr logging with the oracle's line shape (`<iso> <LEVEL> prts_mcp.server: <msg>`).
pub fn log_line(level: &str, msg: &str) {
    let ts = chrono_like_now();
    eprintln!("{ts} {level} prts_mcp.server: {msg}");
}

pub fn log_info(msg: &str) {
    log_line("INFO", msg);
}

pub fn log_warn(msg: &str) {
    log_line("WARN", msg);
}

pub fn log_err(msg: &str) {
    log_line("ERROR", msg);
}

/// ISO-8601 UTC timestamp without pulling a chrono dependency.
fn chrono_like_now() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    let millis = now.subsec_millis();
    let days = secs / 86_400;
    let (year, month, day) = civil_from_days(days as i64);
    let rem = secs % 86_400;
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// Howard Hinnant's days-to-civil algorithm.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}
