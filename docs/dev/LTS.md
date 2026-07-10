# LTS Maintenance Policy

PRTS-MCP 1.7.0 is the final 1.x feature release and the baseline for the `lts/1.7` maintenance line. The purpose of the LTS line is to keep existing 1.x users stable while new feature and breaking-change work moves to 2.0.

## Scope

Allowed in `1.7.x`:

- Compatibility fixes for upstream data schema drift, MCP client behavior, or
  packaging metadata.
- Security fixes, including dependency CVEs, unsafe parsing behavior, and
  transport hardening.
- Data-sync fixes for GitHub Release lookup, zip validation, retry behavior,
  and fallback behavior.
- Critical bug fixes for incorrect results, crashes, resource leaks, or
  Python/TypeScript parity regressions.
- Documentation corrections for deployment, support policy, or migration notes.

Not allowed in `1.7.x`:

- New MCP tools.
- New required parameters.
- Default output-format changes.
- New data domains.
- Tool-surface consolidation or alias removal.
- Python/TypeScript transport role changes.

## Branches

| Branch | Purpose |
|--------|---------|
| `main` | Latest stable release line. It is `1.7.0` until 2.0 ships. |
| `lts/1.7` | Long-term 1.7.x maintenance branch, created from the 1.7.0 release commit. |
| `dev` | Active 2.0 development after the 1.7.0 LTS release. |

Do not push directly to any long-lived branch. Use PRs.

## 1.7.x Fix Flow

1. Branch from `lts/1.7` with `fix/v1.7.x-<topic>` or `docs/v1.7.x-<topic>`.
2. Make the smallest compatible fix.
3. Run `.\scripts\check-runtime.ps1 -Full` for runtime-sensitive changes.
4. Open a PR to `lts/1.7`.
5. After merge, tag the LTS commit with both implementation tags:

   ```powershell
   git tag python/v1.7.x
   git tag ts/v1.7.x
   git push origin python/v1.7.x ts/v1.7.x
   ```

   The TypeScript CD workflow on `lts/1.7` publishes stable npm releases under
   the `lts-1.7` dist-tag. `latest` belongs exclusively to the current stable
   release line on `main`; never move it as part of an LTS release. LTS
   consumers should install `prts-mcp-ts@lts-1.7` (or a fully pinned version).
   Before the next LTS release, seed the channel once with the current release:

   ```bash
   npm dist-tag add prts-mcp-ts@1.7.1 lts-1.7
   ```

6. Cherry-pick or reimplement the fix on `dev` when it also applies to 2.0.

If `main` still points to the 1.7 line when the fix ships, merge `lts/1.7` back to `main` or target `main` directly according to the maintainer's release decision. After 2.0 ships, `main` follows 2.0 and `lts/1.7` remains the only 1.7 maintenance branch.

## 2.0 Boundary

2.0 work may break the 1.x compatibility contract. The 2.0 branch must provide migration notes before prerelease for:

- Final tool-surface consolidation.
- Markdown/JSON output-format behavior.
- Python and TypeScript transport parity.
- Removed or hidden legacy tool aliases.
