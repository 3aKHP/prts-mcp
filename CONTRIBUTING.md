# Contributing to PRTS-MCP

[简体中文](CONTRIBUTING.zh-CN.md)

Thank you for your interest in contributing to PRTS-MCP. This guide covers the root Rust project (`3.0.1-dev.0` on `develop`). Legacy Python and TypeScript maintenance takes place on the `lts/2.8` and `lts/1.7` branches.

Before getting started, please review the relevant guides (full index in [`docs/README.md`](docs/README.md)):

- [`docs/dev/ENVIRONMENT.md`](docs/dev/ENVIRONMENT.md) — local toolchain setup and platform verification commands
- [`docs/dev/STYLE.md`](docs/dev/STYLE.md) — architecture boundaries, coding conventions, and testing requirements
- [`docs/dev/DOCUMENTING.md`](docs/dev/DOCUMENTING.md) — standards for writing and updating public documentation
- [`docs/dev/LTS.md`](docs/dev/LTS.md) — maintenance scope and workflow for `lts/2.8` and `lts/1.7`
- [`SECURITY.md`](SECURITY.md#english) — private reporting flow for security vulnerabilities

## 1. Choose the Target Branch

| Type of Change | Base Branch & PR Target |
|------|---------------|
| Features, refactoring, performance improvements, non-urgent bug fixes, general documentation, chores | `develop` → `develop` |
| 2.8.x / 1.7.x compatibility, security, data-sync, or critical bug fixes (and corresponding LTS docs) | `lts/2.8` or `lts/1.7` → same LTS branch |
| Blocking hotfix for the latest public stable release | `main` → `main` (then port to `develop` / `lts/2.8` as applicable) |

Never push directly to `main`, `develop`, `lts/2.8`, or `lts/1.7`. Create a short-lived topic branch named `<type>/v<version>-<topic>` (for example, `fix/v3.0.0-sync-retry`) and open a Pull Request. Check [`STATUS.md`](STATUS.md) for current branch versions.

## 2. Develop and Verify Changes

Set up your environment following [`docs/dev/ENVIRONMENT.md`](docs/dev/ENVIRONMENT.md), run `./scripts/check-runtime.sh` to verify your toolchain, and select the appropriate verification tier from [`docs/dev/WORKFLOW.md`](docs/dev/WORKFLOW.md):

- **Documentation changes**: verify technical accuracy, runnable examples, and relative links.
- **Code changes**: run `cargo fmt --all -- --check`, `cargo clippy --locked --all-targets -- -D warnings`, `cargo test --locked`, and `./scripts/check-runtime.sh --full` for runtime- or contract-sensitive changes.
- **Behavioral parity**: Rust tool names, parameters, and output semantics align with the frozen TS/v2.8.1 baseline. Approved deviations are strictly enumerated in `contracts/baseline.json`; do not introduce new behavioral differences without discussion.
- **Dependencies and licenses**: when updating Rust dependencies, review `Cargo.toml`, `Cargo.lock`, MSRV (`rust-version`), and third-party license notices together.
- **User-visible changes**: update the owning documentation (`README.md`, `docs/user/`, `docs/admin/`) and `CHANGELOG.md` / `CHANGELOG.zh-CN.md` in the same PR.

## 3. Repository Hygiene

Root `AGENTS.md` and `CLAUDE.md` define shared collaboration workflows for AI agents in this repository. If you adapt local settings for your own machine or shell, keep those adjustments local:

- Never commit personal absolute paths, usernames, tokens, private proxy/mirror URLs, or machine-specific shell shims.
- Before committing, check `git diff HEAD -- AGENTS.md CLAUDE.md` and only stage changes to those files when intentionally updating repository-wide collaboration rules. Avoid hiding local edits with `git update-index --skip-worktree` or `--assume-unchanged`, which can silently block upstream updates.
- Keep `.env`, `.mcp.json`, `docker-compose.override.yml`, local notes under `dev/`, build artifacts, logs, and downloaded game datasets out of Git commits.

## 4. Reporting Issues

- **Bugs and feature requests**: open a public GitHub Issue. For bug reports, please include the package/version, entry point (`prts-mcp`, `prts-mcp-ts*`, or Docker), transport mode (`stdio` or Streamable HTTP), reproduction steps, expected vs. actual behavior, and sanitized `stderr` logs. For feature proposals, describe the use case and whether it requires changes to the MCP tool schemas.
- **Security vulnerabilities**: do **not** open a public issue. Follow the private reporting instructions in [`SECURITY.md`](SECURITY.md#english).
- **Automated triage**: the repository's KHPilot GitHub App may post initial AI-assisted triage comments on issues. Treat bot comments as informational pointers — final triage, prioritization, and scheduling decisions are made by human maintainers.

## 5. Pull Requests and Code Review

- Keep each PR focused on a single primary intent and use [Conventional Commits](https://www.conventionalcommits.org/) (`<type>(<scope>): <subject>`, lowercase imperative, ≤72 characters).
- Include a clear **Summary**, **Test plan** (exact commands run and any unverified areas), and **Open items** in the PR description.
- **Documentation contributions**: do not submit documentation prose drafted or substantially rewritten by GPT-family models. GPT-family models may assist with fact-checking, documentation review, and localized factual corrections that preserve the existing writing style.

### Review Process

PRs may receive feedback from human maintainers, automated bots (KHPilot), and clean-context independent reviewers arranged by the maintainer (see [`docs/dev/WORKFLOW.md`](docs/dev/WORKFLOW.md)). External contributors do not need to run any specific AI reviewer before opening a PR.

- Treat automated bot comments as findings to verify rather than automatic merge gates. To request a re-review or ask a follow-up question after pushing fixes, mention `@khpilot` (or `@khpilot[bot]`) in a PR comment.
- Address actionable findings or reply with concrete code, test, or specification evidence if you disagree.
- CI status is determined by GitHub Checks, and all merges are performed by human maintainers.
