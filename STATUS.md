# PRTS-MCP Status

| Line | State |
| --- | --- |
| Public stable / main | 2.8.1, Python and TS; unchanged by the M1B PR. |
| This development branch | 3.0.0-dev.0, root Rust/Cargo project; M2A/B/C merged; native, npm and Docker packaging verified; M3A candidate engineering complete, M3B publishing automation in validation. |
| lts/2.8 | Both 2.8 implementations preserved; release isolation at 9c84e3eeac7a5f267bc17564e0cdf115a67957cc. |
| lts/1.7 | Existing 1.7 LTS. |
| LTS EOL | Both lines: 2027-07-02. |

M1B imports the complete Rust history (source b6db34482891a83a092d81b012a942d2e00dd3bd), relocates the native project to root, removes python/ and ts/ from this tree, establishes minimum Rust CI and development verification, and prepares independent Cargo source packaging. [Import provenance and review map](docs/dev/rust-rewrite/IMPORT.md), [migration plan](docs/dev/plans/3.x-rust-migration.md).

Runtime: native Rust with vendored C regexp, no JS business/VM. 24 tools (23 with images disabled), legacy and modern MCP, Streamable HTTP and stdio, activation-aware data/image sync. Product prts-mcp defaults HTTP; explicit PRTS_TRANSPORT=stdio chooses stdio. Legacy TS command profiles remain; prts-mcp-ghcr preserves Docker default stdio.

Evidence inherited from P0–P9 proves Linux x64 glibc behavior and native performance. M1B reran native, frozen differential and lifecycle validation after import. M2A now proves native builds and detached archive execution on all five planned targets, including glibc 2.28/Windows static CRT/macOS deployment checks; exact support/evidence boundaries are in NATIVE-PLATFORMS.md. M2B proves actual npm installation and execution on those five platforms. M2C proves native x64/ARM64 Docker packaging and scoped old-volume lifecycle; publishing automation M3, real-client candidate E2E/upgrades/rollback M4, stable release/channel switch M5.

The root owns Cargo files, src/, native/, vendor/, tests/, contracts/, tools/, packaging/ and Dockerfile. Historical implementation documents live under docs/dev/rust-rewrite/; 2.x documentation is archived under docs/dev/legacy/2.x/ and remains authoritative on its own LTS branch. LICENSE and NOTICE retain code/content distinctions.

Current: M2B two npm entries, shared native platform/runtime packages and pinned read-only fallback data pass five-platform installation and runtime verification; see [npm distribution](docs/dev/NPM-DISTRIBUTION.md) and [acceptance evidence](docs/dev/reports/3.0-m2b-npm-distribution.md). M2A PR #229 and data-source Quick PR #230 are merged and their short branches cleaned. npm packages are development CI tarballs, not public releases. M2C Docker/old-volume packaging passes native x64/ARM64 scoped acceptance ([distribution contract](docs/dev/DOCKER-DISTRIBUTION.md), [evidence](docs/dev/reports/3.0-m2c-docker-distribution.md)); PR #232 merged as e58e646. M3A PR #233 supplies complete native candidates and version/artifact aggregation ([plan](docs/dev/plans/3.0-m3-release.md), [candidate contract](docs/dev/RELEASE-CANDIDATES.md)); all five native runners, shared npm bytes and source-bound complete snapshot are required before merge. M3B adds isolated GitHub/GHCR and npm publishing jobs; maintainer AFK authorization allows non-npm candidate work, while npm account setup and actual OIDC publication remain pending. Implementation does not claim a public candidate until external assets/manifests are verified. M4 remains later candidate/runtime acceptance. The dedicated documentation restoration/update pass remains unstarted; both documentation and data distribution/runtime acceptance must close before stable 3.0. CLI, feature/data-domain additions, AKDP tasks and the older backlog follow 3.0. crates.io publication is a separate task after M5.
