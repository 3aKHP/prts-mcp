# Changelog

## [Unreleased] — 3.0.0-dev.0

- Move to one native Rust implementation at repository root, retaining full Rust development history and fixed TS/v2.8.1 comparison contracts.
- Preserve Python/TS 2.8.x on lts/2.8 and 1.7.x on lts/1.7; both reach EOL on 2027-07-02.
- Default the new prts-mcp command to Streamable HTTP; PRTS_TRANSPORT=stdio selects stdio. Keep the three former TS command profiles and separate Docker default-stdio compatibility as prts-mcp-ghcr.
- Compile vendored native C regexp into the server; no JS VM or JS/TS business runtime is needed.
- Prepare five native platform archives with static regexp, bundled dependency notices, ABI audits and detached runtime checks; Rust source builds require 1.89 or newer. 3.x development artifacts are not public releases.
- Use the Windows LOCALAPPDATA user-data location during actual startup, matching the frozen TS default path contract; preserve Windows file identity and drive prefixes for activation/extraction, movable relative generation pointers on desktop platforms, and actual Windows/macOS memory diagnostics.
- Establish Linux Rust validation and standalone Cargo source packaging. Multi-platform binaries, npm entry/platform packages, published Docker and release automation follow in M2/M3; no 3.x package has been released yet.

Older Python/TS changelogs remain on their historical tags and LTS branches.
