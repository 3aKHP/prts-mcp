# Codex Instructions for PRTS-MCP

## 1. Branch Model

| Branch | Purpose |
| --- | --- |
| `main` | Latest public stable release (native Rust `3.1.2`). |
| `develop` | Active 3.x Rust integration branch (`3.1.3-dev.0`). Root Cargo project; no `python/` or `ts/` directories. |
| `lts/2.8` | Python/TypeScript 2.8.x long-term maintenance branch (EOL `2027-07-02`). |
| `lts/1.7` | Python/TypeScript 1.7.x long-term maintenance branch (EOL `2027-07-02`). |

Never push directly to any long-lived branch. Create a topic branch (`<type>/v<version>-<topic>`) from the appropriate base branch and open a Pull Request. Human maintainers perform all merges. When porting fixes from `lts/2.8` or `lts/1.7` to 3.x, reimplement them in Rust on `develop` — never merge a legacy branch into `develop`.

## 2. Startup Reads

Before making non-trivial changes, consult the authoritative guides:

- [`CLAUDE.md`](CLAUDE.md) and [`docs/dev/STYLE.md`](docs/dev/STYLE.md) — collaboration rules, module architecture, Rust conventions, and known pitfalls.
- [`docs/dev/DOCUMENTING.md`](docs/dev/DOCUMENTING.md) — required standards whenever writing, editing, or reviewing public documentation.
- [`docs/dev/WORKFLOW.md`](docs/dev/WORKFLOW.md) and [`docs/dev/VERSIONING.md`](docs/dev/VERSIONING.md) — PR grading, dual-track code review, minimum verification matrix, and SemVer compatibility promises.
- [`docs/dev/LTS.md`](docs/dev/LTS.md) — maintenance scope and release rules for `lts/2.8` and `lts/1.7`.
- [`STATUS.md`](STATUS.md) and [`ROADMAP.md`](ROADMAP.md) — current release state, 3.0 migration milestones, and post-3.0 backlog.
- [`docs/glossary.md`](docs/glossary.md) — project terminology and abbreviations (single entry point for definitions).
- [`docs/dev/adr/`](docs/dev/adr/) — architecture decision records (numbered, status-tracked) since 3.1; consult before revisiting settled decisions.

**Documentation task assignment**: GPT-family models should focus on fact-based review and small, evidence-backed corrections that preserve the existing writing style. Assign new-document drafting, substantial rewrites, large-scale translation, and prose refinement to a human maintainer or a maintainer-designated non-GPT model. This applies to both primary agents and subagents. Follow [`docs/dev/DOCUMENTING.md`](docs/dev/DOCUMENTING.md); explicit task-specific authorization takes precedence.

*(Note: Local working notes, phase plans, and historical archives live under gitignored `./dev/docs/`. Never add links to `./dev/` in tracked public documentation.)*

## 3. Runtime and Packaging

- **Native Rust Server**: The repository root is a Cargo workspace-free package (`Cargo.toml` declares MSRV `1.89`, `rust-toolchain.toml` pins `1.96.1`). Source builds require a C compiler for the statically linked QuickJS regexp engine (`vendor/quickjs-regexp/`) and OS memory diagnostics (`native/process_memory.c`). Prebuilt native archives and Docker images require no compiler or language runtime.
- **Distribution Guides**:
  - [`docs/dev/NATIVE-PLATFORMS.md`](docs/dev/NATIVE-PLATFORMS.md) — 5 native targets (`linux-x64`, `linux-arm64`, `windows-x64`, `darwin-arm64`, `darwin-x64`) and ABI baselines.
  - [`docs/dev/NPM-DISTRIBUTION.md`](docs/dev/NPM-DISTRIBUTION.md) — 9-package npm layout (`prts-mcp`, `prts-mcp-ts`, `@3akhp/prts-mcp-runtime`, `@3akhp/prts-mcp-data`, and 5 platform packages).
  - [`docs/dev/DOCKER-DISTRIBUTION.md`](docs/dev/DOCKER-DISTRIBUTION.md) — Linux `x64`/`arm64` Docker images and volume compatibility.
  - [`docs/dev/RELEASE-CANDIDATES.md`](docs/dev/RELEASE-CANDIDATES.md) and [`docs/dev/RELEASE-CD-RECOVERY.md`](docs/dev/RELEASE-CD-RECOVERY.md) — candidate aggregation, publishing, and failure recovery.
- **WSL2 Workspace**: Keep the repository checkout on the native Linux filesystem (never under `/mnt/c/`). `Node.js >= 22` and `Bun 1.3.14` are used only for development verification harnesses, packaging scripts, and the frozen TS/v2.8.1 oracle (reconstructed under gitignored `.reference/ts-v2.8.1/`).

## 4. Verification

Run `./scripts/check-runtime.sh` for a fast toolchain and metadata check. For full verification (fixture setup, `cargo fmt`, `cargo clippy`, unit/integration tests, release binary build, 384 frozen differential cases, process lifecycle, and extended regex checks), run:

```bash
./scripts/check-runtime.sh --full
```

See [`docs/dev/ENVIRONMENT.md`](docs/dev/ENVIRONMENT.md) for single-target test commands and platform-specific notes, and [`docs/dev/E2E.md`](docs/dev/E2E.md) for full real-client E2E procedures.

For quantitative code or benchmark comparisons, use [`docs/dev/COMPARATIVE-EVALUATION.md`](docs/dev/COMPARATIVE-EVALUATION.md). Select the contributor's own private environment profile and operations document; the public workflow does not assume maintainer infrastructure.

## 5. Code Review

Standard and higher-tier PRs require **dual-track review**: open the PR first to trigger KHPilot Bot Review, and run an independent clean-context, read-only review in parallel (see [`docs/dev/WORKFLOW.md`](docs/dev/WORKFLOW.md) and [`CLAUDE.md`](CLAUDE.md)).
