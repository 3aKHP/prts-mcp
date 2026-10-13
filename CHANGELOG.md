# Changelog

## [Unreleased] — 3.0.0-dev.0

- Stop tracking the outdated four-table game-data sample and its source metadata; keep existing local files ignored, exclude root data/ from Docker source contexts, and document separately validated read-only release bundles as a pre-3.0 distribution requirement. Source startup sync and historical/LTS data remain unchanged.
- Move to one native Rust implementation at repository root, retaining full Rust development history and fixed TS/v2.8.1 comparison contracts.
- Preserve Python/TS 2.8.x on lts/2.8 and 1.7.x on lts/1.7; both reach EOL on 2027-07-02.
- Default the new prts-mcp command to Streamable HTTP; PRTS_TRANSPORT=stdio selects stdio. Keep the three former TS command profiles and separate Docker default-stdio compatibility as prts-mcp-ghcr.
- Compile vendored native C regexp into the server; no JS VM or JS/TS business runtime is needed.
- Establish Linux Rust validation and standalone Cargo source packaging. Multi-platform binaries, npm entry/platform packages, published Docker and release automation follow in M2/M3; no 3.x package has been released yet.

Older Python/TS changelogs remain on their historical tags and LTS branches.
