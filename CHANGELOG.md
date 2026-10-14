# Changelog

## [Unreleased] — 3.0.0-dev.0

- Wait for npm's asynchronous validation to make an accepted candidate upload publicly readable before advancing dependencies. Preserve and verify all existing labels, including npm-required bootstrap latest aliases; candidate releases advance next only and verify independent tag writes with temporary labels that are removed. Existing prts-mcp-ts stable/LTS channels remain unchanged.
- Add verified-snapshot publishing for Rust candidates on GitHub/GHCR and independently enabled npm OIDC. Prereleases use next and leave stable latest unchanged; npm account setup remains required.

- Prepare full native release candidates with validated read-only fallback data on all five platforms, verify archive installation without developer tools, and collect one exact-version snapshot for npm, native and Docker channels. Public publishing and stable latest are not enabled by this preparation.

- Prepare native Linux x64/ARM64 Docker packaging with validated fallback data, original dependency notices and preserved default stdio/explicit HTTP, root permissions and legacy writable volumes; add tini to forward container stop signals. Both native architectures pass scoped development image verification; GHCR publication remains a later stage.

- Prepare native-backed prts-mcp and prts-mcp-ts npm entries, shared exact-version platform/runtime packages and validated read-only game-data fallback, with real installation verification on native CI. These development tarballs are not published npm releases.
- Keep native npm stdio/HTTP profiles, standard streams and exit behavior; diagnose missing optional platform packages or version mismatches. Windows npm launches monitor parent-process exit so force-closing the Node bridge stops the native server.
- Stop tracking the outdated four-table game-data sample and its source metadata; keep existing local files ignored, exclude root data/ from Docker source contexts, and document separately validated read-only release bundles as a pre-3.0 distribution requirement. Source startup sync and historical/LTS data remain unchanged.
- Move to one native Rust implementation at repository root, retaining full Rust development history and fixed TS/v2.8.1 comparison contracts.
- Preserve Python/TS 2.8.x on lts/2.8 and 1.7.x on lts/1.7; both reach EOL on 2027-07-02.
- Default the new prts-mcp command to Streamable HTTP; PRTS_TRANSPORT=stdio selects stdio. Keep the three former TS command profiles and separate Docker default-stdio compatibility as prts-mcp-ghcr.
- Compile vendored native C regexp into the server; no JS VM or JS/TS business runtime is needed.
- Prepare five native platform archives with static regexp, bundled dependency notices, ABI audits and detached runtime checks; Rust source builds require 1.89 or newer. 3.x development artifacts are not public releases.
- Use the Windows LOCALAPPDATA user-data location during actual startup, matching the frozen TS default path contract; preserve Windows file identity and drive prefixes for activation/extraction, movable relative generation pointers on desktop platforms, and actual Windows/macOS memory diagnostics.
- Establish full Linux Rust validation, standalone Cargo source packaging and five native archive build/runtime checks. npm entry/platform installation, published Docker and release automation follow in M2B/C and M3; no 3.x package has been released yet.

Older Python/TS changelogs remain on their historical tags and LTS branches.
