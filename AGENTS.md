# Codex Instructions for PRTS-MCP

This file is intentionally repo-local so a fresh Codex session starts with the known-good runtime in the current WSL2 workspace.

## Branch Model

Long-lived branches after the 1.7.0 LTS release:

| Branch | Purpose | Version suffix |
|--------|---------|---------------|
| `main` | Latest stable release. Currently `2.5.1`. | (none) |
| `lts/1.7` | 1.7.x long-term maintenance. Created from the 1.7.0 release commit. | (none) |
| `develop` | Development integration. All non-LTS changes land here. | `.dev0` (current target: `2.6.0.dev0`) |

- Feature / refactor / perf / non-urgent fix / general docs / chore -> branch from `develop`, PR to `develop`.
- 1.7.x LTS fix -> branch from `lts/1.7`, PR to `lts/1.7`, then cherry-pick or reimplement on `develop` if applicable.
- Hotfix for the latest stable line -> branch from `main`, PR to `main`, then forward-merge/cherry-pick to `develop`.
- Release -> branch from `develop` as `release/vX.Y.Z`, merge the release branch to `main` by PR, tag on `main`, then merge the same release branch back to `develop` by PR.

Never push directly to `main`, `develop`, or `lts/1.7`. Always create a feature/fix branch and open a PR. See `CLAUDE.md` and `docs/dev/LTS.md` for the detailed iteration cycles.

## Startup Reads

- Read `CLAUDE.md` and `docs/dev/STYLE.md` before non-trivial code changes.
- Read `docs/dev/LTS.md` before 1.7.x compatibility, security, or release work.
- Use `STATUS.md` for current project shape and version state.
- Use `ROADMAP.md` / `ROADMAP.zh-CN.md` when planning feature work.

## Runtime Environment

- Host: WSL2 Linux. Keep the repository on the Linux filesystem rather than under `/mnt/<drive>` for predictable permissions and filesystem performance.
- Shell: use the current POSIX shell for interactive work; repository scripts target Bash when they need Bash-specific behavior.
- Python: `uv` owns the project environment under `python/`. Bootstrap with `uv sync --directory python --locked` and run Python commands through `uv run --directory python ...`. Do not invoke `python/.venv` directly or rely on ambient `python`.
- `python/uv.lock` is committed and must stay in sync with `pyproject.toml`.
- Node.js: project requirement is Node >=22; `ts/package.json` carries the preferred Volta version. Bun >=1.3.14 is the default TS production runtime.
- In WSL use normal `npm` / `npx` commands.

## Quick Verification

Run the repo-local environment audit first when a session starts or when command behavior looks suspicious:

```bash
./scripts/check-runtime.sh
```

Run the full validation set before merging runtime-sensitive changes:

```bash
./scripts/check-runtime.sh --full
```

Equivalent manual commands:

```bash
uv run --directory python --locked python -m pytest tests -q

cd ts
npm run build
npm test
npm run typecheck
npm run smoke:bun
```
