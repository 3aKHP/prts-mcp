# PRTS-MCP Status

| Line | State |
| --- | --- |
| Public stable / main | 2.8.1, Python and TS; unchanged by the M1B PR. |
| This development branch | 3.0.0-dev.0, root Rust/Cargo project; M0–M3 complete; alpha.3 public on npm/GitHub/GHCR with nine actual OIDC/provenance checks; M4 not started. |
| lts/2.8 | Both 2.8 implementations preserved; release isolation at 9c84e3eeac7a5f267bc17564e0cdf115a67957cc. |
| lts/1.7 | Existing 1.7 LTS. |
| LTS EOL | Both lines: 2027-07-02. |

M1B imports the complete Rust history (source b6db34482891a83a092d81b012a942d2e00dd3bd), relocates the native project to root, removes python/ and ts/ from this tree, establishes minimum Rust CI and development verification, and prepares independent Cargo source packaging. [Import provenance and review map](docs/dev/rust-rewrite/IMPORT.md), [migration plan](docs/dev/plans/3.x-rust-migration.md).

Runtime: native Rust with vendored C regexp, no JS business/VM. 24 tools (23 with images disabled), legacy and modern MCP, Streamable HTTP and stdio, activation-aware data/image sync. Product prts-mcp defaults HTTP; explicit PRTS_TRANSPORT=stdio chooses stdio. Legacy TS command profiles remain; prts-mcp-ghcr preserves Docker default stdio.

Evidence inherited from P0–P9 proves Linux x64 glibc behavior and native performance. M1B reran native, frozen differential and lifecycle validation after import. M2A now proves native builds and detached archive execution on all five planned targets, including glibc 2.28/Windows static CRT/macOS deployment checks; exact support/evidence boundaries are in NATIVE-PLATFORMS.md. M2B proves actual npm installation and execution on those five platforms. M2C proves native x64/ARM64 Docker packaging and scoped old-volume lifecycle; publishing automation M3, real-client candidate E2E/upgrades/rollback M4, stable release/channel switch M5.

The root owns Cargo files, src/, native/, vendor/, tests/, contracts/, tools/, packaging/ and Dockerfile. Historical implementation documents live under docs/dev/rust-rewrite/; 2.x documentation is archived under docs/dev/legacy/2.x/ and remains authoritative on its own LTS branch. LICENSE and NOTICE retain code/content distinctions.

Current: M0–M3 complete. [3.0.0-alpha.3](https://github.com/3aKHP/prts-mcp/releases/tag/v3.0.0-alpha.3) from 9762db72e0ef1d5c3c9e87aa8d8d25147b166226 passed reviewed exact-source CI and formal [run 38491785379](https://github.com/3aKHP/prts-mcp/actions/runs/38491785379), all nine fresh npm OIDC/provenance checks, GitHub 44 assets, dual-native GHCR and scoped public Linux x64 installation/runtime acceptance. All existing latest/stable/LTS labels remain frozen. The partial alpha.2 publication remains immutable. [M3 acceptance](docs/dev/reports/3.0-m3-candidate-release.md), [npm distribution](docs/dev/NPM-DISTRIBUTION.md).

M3 is closed; M4 is not started and covers real-client candidate E2E, upgrades and rollback. The dedicated documentation restoration/update pass remains unstarted; both documentation and data distribution/runtime acceptance must close before stable 3.0. CLI, feature/data-domain additions, AKDP tasks and the older backlog follow 3.0. crates.io publication is a separate task after M5.
