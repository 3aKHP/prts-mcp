# Codex Instructions for PRTS-MCP

## Branch model

| Branch | Purpose |
| --- | --- |
| main | Latest stable release, currently 2.8.1; changes to Rust at M5. |
| develop | Rust integration, target 3.0.0-dev.0. No python/ or ts/ source directories. |
| lts/2.8 | Python/TS 2.8.x maintenance, EOL 2027-07-02. |
| lts/1.7 | Python/TS 1.7.x maintenance, EOL 2027-07-02. |

Never push directly to a long-lived branch. Branch from the appropriate line and open a PR. Human maintainers merge. During the 2.x main / Rust develop transition, port applicable fixes individually; never merge the entire legacy tree into Rust. User instructions can authorize session-specific workflow exceptions.

## Startup reads

Read CLAUDE.md and docs/dev/STYLE.md before non-trivial changes. Read docs/dev/VERSIONING.md and docs/dev/WORKFLOW.md before release/review work; docs/dev/LTS.md for either LTS line. STATUS.md records release state; ROADMAP.md / ROADMAP.zh-CN.md and docs/dev/plans/3.x-rust-migration.md own migration scope.

## Runtime

The root is a native Cargo project. rust-toolchain.toml pins the development compiler; Cargo.lock pins dependencies; Cargo.toml declares Rust 1.89 minimum. Source builds require a C compiler for native regexp and OS diagnostics. Prebuilt binaries carry those components, so users need no compiler. M2A validates five native archive targets; docs/dev/NATIVE-PLATFORMS.md owns exact ABI/runtime evidence. npm/Docker installation, public publishing and candidate E2E remain later migration stages.

In WSL keep the checkout on the Linux filesystem. Development oracle/packaging tools use Node >=22 and Bun 1.3.14; they are not the production business runtime. Historical TS/Python comparison sources are reconstructed from the fixed 2.8.1 commit under ignored .reference/, never restored to root python/ or ts/.

## Verification

Run ./scripts/check-runtime.sh first. Full scoped validation is ./scripts/check-runtime.sh --full (fixture preparation, fmt, clippy, native tests, release build, frozen differential suite, lifecycle and native regex checks). It may download pinned validation assets; it never rewrites committed contracts. See docs/dev/ENVIRONMENT.md.

High-risk changes strongly recommend real-machine E2E, never a general hard gate; maintainers choose the scope under docs/dev/WORKFLOW.md. The migration's complete candidate-release E2E is scheduled for M4.

## Review

Standard and larger changes require independent clean-context, read-only subagent review plus KHPilot Bot Review after opening the PR. For the large M1B import, review the pushed branch snapshot purposefully using docs/dev/rust-rewrite/IMPORT.md; do not attempt to read the full repository diff.
