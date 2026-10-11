//! Startup option parsing (docs/04-runtime-contracts.md).
//!
//! P0 skeleton: only the module boundary exists. `RuntimeConfig` will hold the
//! once-parsed startup configuration; the dynamic data view stays in
//! `app::DataState` — the TS `config.ts ↔ activation.ts` cycle is dissolved
//! here by construction, not replicated.
