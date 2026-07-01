# Codex Instructions for PRTS-MCP

This file is intentionally repo-local so a fresh Codex session starts with the known-good runtime on this Windows workstation.

## Branch Model

Long-lived branches after the 1.7.0 LTS release:

| Branch | Purpose | Version suffix |
|--------|---------|---------------|
| `main` | Latest stable release. `1.7.0` until 2.0 ships. | (none) |
| `lts/1.7` | 1.7.x long-term maintenance. Created from the 1.7.0 release commit. | (none) |
| `dev` | Development integration for 2.0. All non-LTS changes land here. | `.dev0` (next target, e.g. `2.0.0.dev0`) |

- Feature / refactor / perf / non-urgent fix / docs / chore → branch from `dev`, PR to `dev`.
- 1.7.x LTS fix → branch from `lts/1.7`, PR to `lts/1.7`, then cherry-pick or reimplement on `dev` if applicable.
- Hotfix for the latest stable line → branch from `main`, PR to `main`, then forward-merge/cherry-pick to `dev`.
- Release → merge the release branch to `main`, tag on `main`, then merge or cherry-pick back to `dev`.

Never push directly to `main`, `dev`, or `lts/1.7`. Always create a feature/fix branch and open a PR. See `CLAUDE.md` and `docs/dev/LTS.md` for the detailed iteration cycles.

## Startup Reads

- Read `CLAUDE.md` and `docs/dev/STYLE.md` before non-trivial code changes.
- Read `docs/dev/LTS.md` before 1.7.x compatibility, security, or release work.
- Use `STATUS.md` for current project shape and version state.
- Use `ROADMAP.md` / `ROADMAP.zh-CN.md` when planning feature work.

## Runtime Environment

- Shell: prefer `C:\Program Files\PowerShell\7\pwsh.exe` with UTF-8 output.
- Python: use `E:\Anaconda3\envs\python311\python.exe` for this repo.
- Do not use ambient `python` from PATH for validation. On this machine it
  resolves to MSYS/WindowsApps before the intended conda environment.
- Do not use `python\.venv` for Python MCP tests. It was created from MSYS
  Python 3.12 and currently lacks the real `mcp` runtime dependency.
- For local-source Python imports, set `PYTHONPATH` to
  `F:\2026-Spring\PRTS-MCP\python\src`.
- Node: use the Volta Node image already selected by `ts/package.json`
  (`node` currently resolves to Node 24.14.0; project requires Node >=22).
- In PowerShell, use `npm.cmd` / `npx.cmd` instead of bare `npm` / `npx`.
  Bare commands resolve to Volta-generated `.ps1` shims first on this host, and
  those shims can fail while the `.cmd` shims work.

## Quick Verification

Run the repo-local environment audit first when a session starts or when command behavior looks suspicious:

```powershell
.\scripts\check-runtime.ps1
```

Run the full validation set before merging runtime-sensitive changes:

```powershell
.\scripts\check-runtime.ps1 -Full
```

Equivalent manual commands:

```powershell
Push-Location python
& 'E:\Anaconda3\envs\python311\python.exe' -m pytest tests -q
Pop-Location

Push-Location ts
npm.cmd test
npm.cmd run typecheck
Pop-Location
```
