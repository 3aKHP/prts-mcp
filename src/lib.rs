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
