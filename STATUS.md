# PRTS-MCP Status

[简体中文](STATUS.zh-CN.md)

## Branch and Release Lines

| Line / Branch | Current State |
| --- | --- |
| Public stable (`main`) | `2.8.1` (Python and TypeScript); `latest` stable channels remain on `2.8.1` until 3.0.0 stable (M5). |
| Active development (`develop`) | `3.0.0-dev.0` (native Rust Cargo project at the repository root). Public candidate [`3.0.0-rc.1`](https://github.com/3aKHP/prts-mcp/releases/tag/v3.0.0-rc.1) is published on npm (`@next`), GitHub Releases, and GHCR. |
| `lts/2.8` | Python and TypeScript 2.8.x maintenance branch (`2.8.1` baseline, 24 tools). |
| `lts/1.7` | Python and TypeScript 1.7.x maintenance branch (latest patch `1.7.2`, `1.7.0` feature baseline, 32 tools). |
| LTS End of Life | Both `lts/2.8` and `lts/1.7` are supported through **2027-07-02**. |

## 3.x Architecture and Repository Layout

- **Runtime**: Native Rust server at the repository root with a statically linked C regular-expression engine (`vendor/quickjs-regexp/`), requiring no JavaScript or Python business runtime.
- **Capabilities**: 24 MCP tools (`23` when `IMAGES_ENABLED=false`), supporting both legacy session-based and modern stateless (`2026-07-28`) MCP protocol eras over Streamable HTTP and stdio, with generation-aware background sync for game tables, levels, stories, and artwork.
- **Entry Point Defaults**:
  - `prts-mcp` (native binary and npm main package) defaults to Streamable HTTP (`:3000/mcp`); set `PRTS_TRANSPORT=stdio` for stdio mode.
  - `prts-mcp-ts`, `prts-mcp-ts-bun` (HTTP), and `prts-mcp-ts-stdio` (stdio) preserve fixed 2.x transport modes on top of the Rust binary.
  - `prts-mcp-ghcr` (Docker image entrypoint) preserves default `stdio`; set `PRTS_TRANSPORT=http` for HTTP mode.
- **Repository Structure**: The root directory holds `Cargo.toml`, `src/`, `native/`, `vendor/`, `tests/`, `contracts/`, `tools/`, `packaging/`, and `Dockerfile`. Legacy Python and TypeScript implementations are maintained on `lts/2.8` and `lts/1.7` (see [LTS Policy](docs/dev/LTS.md)). Code and third-party content licensing are documented in [LICENSE](LICENSE) and [NOTICE](NOTICE).

## 3.0 Migration Progress

- **M0–M1 (Scope & Root Import — Complete)**: Froze the TS/v2.8.1 behavioral baseline (`contracts/`), isolated `lts/2.8` maintenance publishing, imported the Rust implementation to the repository root, and established Rust CI and source-package verification.
- **M2 (Multi-Platform Native, npm & Docker Packaging — Complete)**:
  - **M2A**: Verified native builds, ABI baselines, and standalone archive execution across all 5 target platforms (`linux-x64`, `linux-arm64`, `windows-x64`, `darwin-arm64`, `darwin-x64`; see [NATIVE-PLATFORMS.md](docs/dev/NATIVE-PLATFORMS.md)).
  - **M2B**: Verified the 9-package npm layout (`prts-mcp`, `prts-mcp-ts`, `@3akhp/prts-mcp-runtime`, `@3akhp/prts-mcp-data`, and 5 platform packages) with bundled read-only fallback data across all 5 platforms (see [NPM-DISTRIBUTION.md](docs/dev/NPM-DISTRIBUTION.md)).
  - **M2C**: Verified Linux `x64`/`arm64` Docker images and backward-compatible volume layouts (see [DOCKER-DISTRIBUTION.md](docs/dev/DOCKER-DISTRIBUTION.md)).
- **M3 (Candidate Release Automation — Complete)**: Published [`3.0.0-alpha.3`](https://github.com/3aKHP/prts-mcp/releases/tag/v3.0.0-alpha.3) via `.github/workflows/release-rust.yml` with npm OIDC provenance across all 9 packages, 44 GitHub Release assets, and dual-architecture GHCR manifests, while keeping `latest` and LTS channels untouched (see [RELEASE-CANDIDATES.md](docs/dev/RELEASE-CANDIDATES.md)).
- **M4 (Candidate E2E, Upgrade & Rollback — Complete within Accepted Scope)**: Verified `3.0.0-alpha.3` on WSL across the full 24-tool harness, real MCP client operator/artwork workflows, game-data and artwork baseline/delta sync, and live upgrade/rollback against npm `2.8.1` user volumes (see [E2E.md](docs/dev/E2E.md)).
- **M5 (Stable 3.0.0 Release — In Progress)**: Documentation work is complete; the RC is `3.0.0-rc.1`. Stable release follows RC lifecycle observation and targeted stress testing on the production server, with real-client usability testing if needed. Then promote `latest` tags on npm/GHCR/GitHub Releases and back-merge to `develop`. Standalone `crates.io` publication, management CLI, and new feature work are scheduled after 3.0.0.

## Release History (Python / TypeScript)

The table below summarizes all published 1.x and 2.x releases (including 1.7 LTS maintenance patches). For complete release notes and per-version change lists, see [CHANGELOG.md](CHANGELOG.md).

| Version | Date | Highlights |
|------|------|------|
| 2.8.1 | 2026-10-11 | Supplementary roguelike story catalog: discovery, reading, search, and character tracking for six events; backward compatibility with older data packs |
| 2.8.0 | 2026-10-10 | Detailed operator stats: interpolated attributes, per-level skill effects, per-tier talent effects, and the `skills` search scope; sync compatibility with hyphenated `versionId` values |
| 2.7.4 | 2026-09-15 | Consistent idle HTTP session eviction across both implementations: Python support for `SESSION_IDLE_TIMEOUT_MS`; TS rescheduling based on remaining timeout and strict decimal parsing |
| 2.7.3 | 2026-09-05 | Data revision discovery (`datarev-`) and validation; downgrade prevention during cache recovery; consistent chapter summaries |
| 2.7.2 | 2026-08-22 | Consistent quoting of echoed IDs in both implementations; code-point ordering for artwork and item lists |
| 2.7.1 | 2026-08-18 | Image sync applies the complete AKDP delta chain (#179); consistent fallback for malformed `building_data` across both implementations (#178) |
| 2.7.0 | 2026-08-15 | Operator base skills (`basic_info` section and `building_skills` search scope); skin metadata for local artwork; completion of the 2.7 module refactoring |
| 2.6.2 | 2026-08-12 | GameData pair idempotency fix: unchanged sync cycles no longer replace activation metadata or clear caches (#152) |
| 2.6.1 | 2026-08-10 | Safe rendering of nested template fields and malformed-response handling; event-story page validation and out-of-range messages |
| 2.6.0 | 2026-08-09 | MCP SDK v2 support for both protocol eras; artwork support for Amiya forms; aggregate metrics, six-session memory benchmark, and canary comparison |
| 2.5.2 | 2026-08-09 | Security updates to npm production dependencies; direct AKDP enemy database support; scalar story `Decision` values; artwork token ownership validation |
| 2.5.1 | 2026-08-07 | GameData pair retry fix; fail-open behavior for manifest 404 responses; image SHA-256 validation; Node 24 in CI |
| 2.5.0 | 2026-08-07 | Operator artwork tool `operator_artwork`; data source switched to `arknights-data-pipeline`; TS stdio HTTP leak fix |
| 2.4.0 | 2026-07-29 | Auto-sync for long-running services; atomic paired publication of GameData excel/levels; cross-process coordination and lock renewal on shared volumes |
| 2.3.1 | 2026-07-10 | Security updates to TypeScript production dependencies; synchronized npm lockfile bin metadata for `prts-mcp-ts-stdio` |
| 2.3.0 | 2026-07-08 | Transport parity: Streamable HTTP added to Python and stdio to TypeScript; both implementations support both transports |
| 2.2.0 | 2026-07-08 | Bun becomes the default TypeScript production runtime in Dockerfile/CI/scripts; Node retained as an optional path |
| 2.1.0 | 2026-07-07 | Bun officially supported as an optional TypeScript runtime; new `prts-mcp-ts-bun` command and Bun Dockerfile |
| 2.0.2 | 2026-07-07 | TS HTTP MCP smoke harness; candidate Bun runtime path; fixes to `search_prts` redirect resolution and technical-page filtering |
| 2.0.1 | 2026-07-03 | Fixed output-channel wrapping in `list_story_events` when story data is missing; unified TS text-result helper; additional MCP example configuration |
| 2.0.0 | 2026-07-03 | Tool consolidation from 32 to 23 tools and connection-level output channel (`structuredContent`) |
| 1.7.2 | 2026-09-26 | LTS: shared sync metadata compatibility and atomic writes; mirror normalization; fixes to pagination, Unicode ordering/regex, story decisions, and enemy databases; dependency security updates |
| 1.7.1 | 2026-07-10 | LTS: PRTS search redirects and technical-page filtering; Docker offline fallback data; security updates to TS production dependencies |
| 1.7.0 | 2026-07-02 | 1.7 LTS baseline: story character tracking and module separation (32 tools) |
| 1.6.1 | 2026-06-03 | Operator Record discovery and search-cache improvements (30 tools) |
| 1.6.0 | 2026-05-28 | Integrated stage enemy data and item/material data (29 tools) |
| 1.5.0 | 2026-05-25 | Stage data domain: `list_stages`, `get_stage_info`, and `search_stages` (24 tools) |
| 1.4.2 | 2026-05-25 | Fixed Streamable HTTP session-pool 400 errors |
| 1.4.1 | 2026-05-19 | Production fixes: ZipStore caching, session leaks, `httpx` reuse, and cross-implementation parity fixes |
| 1.4.0 | 2026-05-19 | Template extraction tool and enemy catalog with combat attributes |
| 1.3.1 | 2026-05-19 | Fixed operator ID collisions with same-name trap/token entities |
| 1.3.0 | 2026-05-18 | Deeper PRTS integration: chapter lists, category tags, and link traversal |
| 1.2.0 | 2026-05-14 | Story summary tool and LLM pipeline |
| 1.1.1 | 2026-05-14 | PRTS API fix: `action=parse` replaces `prop=extracts` |
| 1.1.0 | 2026-05-14 | Full-text search tool |
| 1.0.0 | 2026-05-13 | Initial stable release with frozen 1.x tool interface |
