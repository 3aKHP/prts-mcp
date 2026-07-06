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
| `main` | Latest stable release line. Currently 2.x. |
| `lts/1.7` | Long-term 1.7.x maintenance branch, created from the 1.7.0 release commit. |
| `develop` | Active development integration after the 1.7.0 LTS release. |

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

6. Cherry-pick or reimplement the fix on `develop` when it also applies to 2.0.

If `main` still points to the 1.7 line when the fix ships, merge `lts/1.7` back to `main` or target `main` directly according to the maintainer's release decision. After 2.0 ships, `main` follows 2.0 and `lts/1.7` remains the only 1.7 maintenance branch.

## 2.0 Boundary

2.0 work may break the 1.x compatibility contract. The 2.0 branch must provide migration notes before prerelease for:

- Final tool-surface consolidation.
- Output channel (`structuredContent`) behavior — note 2.0 keeps markdown as
  the default `content` and does **not** flip to a JSON default; the originally
  proposed per-call `output_format=markdown|json` parameter was rejected during
  design.
- Removed or hidden legacy tool aliases.

Cross-transport parity (Python gaining HTTP, TypeScript gaining stdio) was an
original 2.0 boundary goal but is **deferred beyond 2.0**; 2.0 ships with the
same transport split as 1.x (Python = stdio, TypeScript = Streamable HTTP).
See [`docs/migration-1.x-to-2.0.md`](../migration-1.x-to-2.0.md) for the
delivered 2.0 changes.
