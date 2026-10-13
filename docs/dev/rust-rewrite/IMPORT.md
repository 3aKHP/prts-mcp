# M1B import provenance and snapshot review map

Review the **pushed branch HEAD snapshot** for this PR. Do not read the full repository diff: most lines are imported, previously validated Rust or removed legacy implementation. This is the maintainer's explicit review instruction. Check the selected paths below and use small, purpose-specific comparisons only where they resolve a concrete claim.

## Identity and retention

| Source | Commit |
| --- | --- |
| Frozen TS/Python 2.8.1 oracle | e0ba36096cdd46640166b0a5db02902fa9a6a24c |
| develop base | fbfb69573e5bc03fed8d31a0e7ae6039a414af9f |
| Imported Rust source (P0–P9) | b6db34482891a83a092d81b012a942d2e00dd3bd |
| Non-squash subtree import commit | aee9952 (full identity is available in Git history) |
| Preserved lts/2.8 maintenance snapshot | 9c84e3eeac7a5f267bc17564e0cdf115a67957cc |

The subtree import retains Rust ancestry without squashing, then relocates the temporary migration-rust prefix to the root. No nested .git is copied. The original Rust checkout and source bundles remain outside this tracked tree as independent backups. Main and both LTS branches are unchanged by this feature branch; main stays 2.8.1 until M5.

[import-manifest.json](import-manifest.json) maps all 618 tracked source files to destination paths and records original Git blobs and SHA-256, import SHA-256 and unchanged flags. The invalid Windows/Cargo filename found at M0 is excluded from the final tree; its original history remains intact. Source .gitignore rules are merged into the root file. No complete downloaded dataset, image volume, node_modules, target cache, secrets or local reports are imported.

Root Cargo/src/native/vendor/contracts/tests/tools/packaging/docker/examples are the current project. Historical Rust README, PROGRESS, phase docs, reports and research remain under this directory with original text; references in those documents describe the original sandbox layout, not current installation commands. AGENTS.original.md is historical evidence, not an active agent instruction file. Prior 2.x documents and ops examples are explicitly historical under ../legacy/2.x/; use the LTS branch for maintained legacy instructions.

## Purposeful review paths

| Lens | Snapshot entrypoints and questions |
| --- | --- |
| Structure, version and history | Cargo.toml, Cargo.lock, rust-toolchain.toml, src/lib.rs, import-manifest.json. Is version 3.0.0-dev.0 consistent? Is b6db an ancestor? Are root python/, ts/ and migration-rust absent? |
| Entrypoints and transport | src/bin/prts-mcp.rs, prts-mcp-ghcr.rs, the three TS aliases; tests/process_stdio.rs and process_p7.rs. New product defaults HTTP, explicit stdio; GHCR defaults stdio, only http switches; legacy aliases ignore PRTS_TRANSPORT. Invalid product transport retains HTTP. No protocol rewrite. |
| Protocol/tool parity | src/protocol/, src/tools/, src/tools/schemas/, contracts/baseline.json and frozen cases/goldens. Approved D-001–D-007 remain bounded; version substitutions and fixture-root portability do not rewrite goldens. |
| Data sync/cache/artwork | src/sync/, src/storage/, src/domain/, tests/interop_ts.rs and images_sync.rs. Existing implementations are retained unchanged; locks, hashes, generations, offline recovery and both image paths remain covered. |
| Native component and source package | build.rs, native/regexp.c, vendor/quickjs-regexp/, Cargo include list, LICENSE/NOTICE. Native files are byte-identical to the source commit. The package must include embedded contracts/data-declarations.json and build independently, with no JS VM. |
| CI, fixtures and deployment | .github/workflows/ci.yml, scripts/check-runtime.*, tools/prepare-validation.mjs, prepare-ts-images-volume.mjs, verify.mjs, package-native.mjs, Dockerfile. Old publishers removed only from this tree; oracle rebuilt from fixed history in .reference; assets hash-pinned; no public publisher until M3. |
| Claims and phase boundaries | STATUS, README, ROADMAP bilingual, migration plan, ENVIRONMENT/VERSIONING/WORKFLOW/LTS. Public stable stays 2.8.1; only Linux x64 evidence in M1B, five-platform distribution M2, public automation M3, full actual-client E2E M4, release M5. CLI follows 3.0; crates.io post-M5. |

A bounded production comparison against the imported source commit is sufficient to verify unchanged algorithms: inspect only src/, native/ and vendor/ paths; expected production edits are the new/renamed entrypoint and library identity comments, not indexing/regex/sync algorithms. The source manifest lists the handful of necessary tooling/version/test changes separately.

## Validation scope and portability

./scripts/check-runtime.sh --full runs native tests, fmt/clippy, a release build, all 384 frozen MCP cases, scoped lifecycle and 3,276 native regex ASan/UBSan cases. Lifecycle uses the fixed real GameData/StoryJson release for update/offline recovery and volumes actually written by frozen TS for pair/image read-back. Its CI image volume is a small synthetic baseline/delta fixture written by real TS syncImages, not the archived 2,802-artwork full-size P6 volume. Full-size prior evidence remains in P8/P9 reports; M4 will validate actual candidate artifacts with a real client.

Frozen error goldens contained their original absolute workspace roots. Only explicit map-sandbox-path cases normalize known current/recorded fixture roots on both comparison sides; two story missing-data cases receive that declaration. Relative suffixes, error text and all other fields remain checked, and raw goldens stay unchanged. One pre-existing process test now waits for complete pair/story publication before asserting volume state, instead of treating the first readable excel result as completion; no production sync code changed. D-001 maps the exact current Cargo version alongside the frozen historical versions.

Cargo packaging is local validation only (publish=false), including all embedded runtime declarations, native source and notices. The private one-platform npm harness remains a local test package; it is not the planned public two-entry/platform-package distribution. Dockerfile is a development source-build image; minimum systems/ABI, MSRV, macOS/Windows/ARM64, npm platform installation and published multi-architecture images are not claimed at M1B.

2.x fix intake: the frozen stable commit and develop base have no differences in ts/src or python/src. M1A changed maintenance rules/publishers only; no unported runtime fix was found at this checkpoint. Recheck again before RC.

Local results: [M1B validation report](../reports/3.0-m1b-root-import.md). The 124-file Cargo package uses root-anchored include patterns and actual list checks, preventing nested oracle/cache README/LICENSE overmatches.
