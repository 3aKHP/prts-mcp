# LTS Maintenance Policy

PRTS-MCP 1.7.0 is the final 1.x feature release and the baseline for the `lts/1.7` maintenance line. The purpose of the LTS line is to keep existing 1.x users stable while new feature and breaking-change work moves to 2.0.

## Scope

Allowed in `1.7.x`:

- Compatibility fixes for upstream data schema drift, MCP client behavior, or packaging metadata.
- Security fixes, including dependency CVEs, unsafe parsing behavior, and transport hardening.
- Data-sync fixes for GitHub Release lookup, zip validation, retry behavior, and fallback behavior.
- Critical bug fixes for incorrect results, crashes, resource leaks, or Python/TypeScript parity regressions.
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

## Lifecycle

The `lts/1.7` line is maintained for **12 months from the 1.7.0 baseline** (released 2026-07-02): end of life is **2027-07-02**.

Until EOL, 1.7.x receives the fixes listed in [Scope](#scope). After EOL:

- No further 1.7.x releases. The `lts/1.7` branch and all `python/v1.7.*` / `ts/v1.7.*` tags remain available read-only and are not deleted.
- The AKDP projection workflows in `3aKHP/ArknightsGameData` and `3aKHP/ArknightsStoryJson` are stopped. 1.7 clients keep working with the last published data but no longer receive game-data updates.
- Users still on 1.x should follow [the 1.x → 2.0 migration guide](../migration-1.x-to-2.0.md).

**Data-source note:** 1.7 auto-sync reads the `3aKHP/ArknightsGameData` / `3aKHP/ArknightsStoryJson` forks via `/releases/latest`. These forks no longer track the original upstreams; their releases are projections of `3aKHP/arknights-data-pipeline` factory output, produced by each fork's own `sync-and-release.yml` workflow. Until EOL these forks must **not** be archived — archiving makes a repository read-only, which blocks new projection releases and would freeze 1.7 data.

## 1.7.x Fix Flow

1. Branch from `lts/1.7` with `fix/v1.7.x-<topic>` or `docs/v1.7.x-<topic>`.
2. Make the smallest compatible fix.
3. Run `./scripts/check-runtime.sh --full` for runtime-sensitive changes.
4. Open a PR to `lts/1.7`.
5. After merge, tag the LTS commit with both implementation tags:

   ```bash
   git tag python/v1.7.x
   git tag ts/v1.7.x
   git push origin python/v1.7.x ts/v1.7.x
   ```

6. Cherry-pick or reimplement the fix on `develop` when it also applies to the current development line.

`main` follows the latest stable 2.x release. Do not merge `lts/1.7` into `main`; cherry-pick or reimplement applicable fixes on `develop` instead.

## 2.0 Boundary

2.0 work may break the 1.x compatibility contract. The 2.0 branch must provide migration notes before prerelease for:

- Final tool-surface consolidation.
- Output channel (`structuredContent`) behavior — note 2.0 keeps markdown as the default `content` and does **not** flip to a JSON default; the originally proposed per-call `output_format=markdown|json` parameter was rejected during design.
- Removed or hidden legacy tool aliases.

Cross-transport parity was deferred from 2.0 and delivered in 2.3.0: Python gained Streamable HTTP and TypeScript gained stdio, while both original transport entry points remained compatible. See [`docs/migration-1.x-to-2.0.md`](../migration-1.x-to-2.0.md) for the delivered 2.0 changes.
