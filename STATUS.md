# PRTS-MCP Status

| Line | State |
| --- | --- |
| Public stable / main | 2.8.1, Python and TS; unchanged by the M1B PR. |
| This development branch | 3.0.0-dev.0, root Rust/Cargo project; M1B merged as 67722ce, M2A in progress. |
| lts/2.8 | Both 2.8 implementations preserved; release isolation at 9c84e3eeac7a5f267bc17564e0cdf115a67957cc. |
| lts/1.7 | Existing 1.7 LTS. |
| LTS EOL | Both lines: 2027-07-02. |

M1B imports the complete Rust history (source b6db34482891a83a092d81b012a942d2e00dd3bd), relocates the native project to root, removes python/ and ts/ from this tree, establishes minimum Rust CI and development verification, and prepares independent Cargo source packaging. [Import provenance and review map](docs/dev/rust-rewrite/IMPORT.md), [migration plan](docs/dev/plans/3.x-rust-migration.md).

Runtime: native Rust with vendored C regexp, no JS business/VM. 24 tools (23 with images disabled), legacy and modern MCP, Streamable HTTP and stdio, activation-aware data/image sync. Product prts-mcp defaults HTTP; explicit PRTS_TRANSPORT=stdio chooses stdio. Legacy TS command profiles remain; prts-mcp-ghcr preserves Docker default stdio.

Evidence inherited from P0–P9 proves Linux x64 glibc behavior and native performance. M1B reruns relevant native, frozen differential and lifecycle validation after import. Five-platform binaries/npm installation and Docker distribution are M2, publishing automation M3, real-client candidate E2E/upgrades/rollback M4, stable release/channel switch M5. No unverified platform is claimed supported here; see the PR for exact validation results.

The root owns Cargo files, src/, native/, vendor/, tests/, contracts/, tools/, packaging/ and Dockerfile. Historical implementation documents live under docs/dev/rust-rewrite/; 2.x documentation is archived under docs/dev/legacy/2.x/ and remains authoritative on its own LTS branch. LICENSE and NOTICE retain code/content distinctions.

Current: M2A platform builds and detached native archive runtime evidence; see [platform baselines and evidence](docs/dev/NATIVE-PLATFORMS.md). Next: M2B npm entry/platform packages, then M2C Docker. CLI, feature/data-domain additions, AKDP tasks and the older backlog follow 3.0. crates.io publication is a separate task after M5.
