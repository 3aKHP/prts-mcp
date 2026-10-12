# LTS Maintenance Policy

PRTS-MCP maintains two legacy lines while the product migrates to Rust: `lts/1.7` for 1.7.x and `lts/2.8` for 2.8.x. Both retain their Python and TypeScript implementations and reach end of life on **2027-07-02**. The 2.8 line does not receive a new 12-month term when Rust 3.0 is released.

| Maintenance branch | Baseline | MCP tools | EOL |
| --- | --- | --- | --- |
| `lts/1.7` | 1.7.0 | 32 | 2027-07-02 |
| `lts/2.8` | 2.8.1 (`e0ba36096cdd46640166b0a5db02902fa9a6a24c`) | 24 | 2027-07-02 |

## Scope

Allowed in either LTS line:

- Compatibility fixes for upstream data schema drift, MCP client behavior, or packaging metadata.
- Security fixes, including dependency CVEs, unsafe parsing behavior, and transport hardening.
- Data-sync fixes for GitHub Release lookup, zip validation, retry behavior, and fallback behavior.
- Critical bug fixes for incorrect results, crashes, resource leaks, or Python/TypeScript parity regressions.
- Documentation corrections for deployment, support policy, or migration notes.

Not allowed in either LTS line:

- New MCP tools.
- New required parameters.
- Default output-format changes.
- New data domains.
- Tool-surface consolidation or alias removal.
- Python/TypeScript transport role changes.

## Branches

| Branch | Purpose |
|--------|---------|
| `main` | Latest stable release line; remains 2.8.1 until the Rust 3.0 release. |
| `lts/1.7` | Long-term 1.7.x maintenance branch, created from the 1.7.0 release commit. |
| `lts/2.8` | Long-term 2.8.x maintenance branch, created from the stable 2.8.1 release commit. |
| `develop` | Development integration; root Rust layout replaces Python/TS in the subsequent source-import change. |

Do not push directly to any long-lived branch. Use PRs. Version semantics and the develop target-version rule live in [`VERSIONING.md`](VERSIONING.md); change grading and the dual-track review workflow live in [`WORKFLOW.md`](WORKFLOW.md).

## Lifecycle

The `lts/1.7` line is maintained for **12 months from the 1.7.0 baseline** (released 2026-07-02): end of life is **2027-07-02**.

The `lts/2.8` line shares that fixed EOL. Its baseline retains the source, lockfiles, fixtures, licenses, packaging scripts and workflows needed to maintain both legacy implementations. Neither line is split into another repository during migration.

Until EOL, both lines receive only the fixes listed in [Scope](#scope). After EOL, their branches, tags and published artifacts remain available for reproducible installs and rollback; no further LTS versions are released. The 2.8 CD guard permits releases through the end of 2027-07-02 UTC and rejects later runs.

Until EOL, 1.7.x receives the fixes listed in [Scope](#scope). After EOL:

- No further 1.7.x releases. The `lts/1.7` branch and all `python/v1.7.*` / `ts/v1.7.*` tags remain available read-only and are not deleted.
- The AKDP projection workflows in `3aKHP/ArknightsGameData` and `3aKHP/ArknightsStoryJson` are stopped. 1.7 clients keep working with the last published data but no longer receive game-data updates.
- Users still on 1.x should follow [the 1.x → 2.0 migration guide](../migration-1.x-to-2.0.md).

**Data-source note:** 1.7 auto-sync reads the `3aKHP/ArknightsGameData` / `3aKHP/ArknightsStoryJson` forks via `/releases/latest`. These forks no longer track the original upstreams; their releases are projections of `3aKHP/arknights-data-pipeline` factory output, produced by each fork's own `sync-and-release.yml` workflow. Until EOL these forks must **not** be archived — archiving makes a repository read-only, which blocks new projection releases and would freeze 1.7 data.

**Revision-release note:** from 2.7.3 the modern implementations additionally discover `datarev-<versionId>-r<N>` repair revisions directly from `3aKHP/arknights-data-pipeline` (ordered by `(versionId, publicationRevision)`). 1.7 never sees them: it follows `/releases/latest` on the projection forks, and `datarev-` releases are neither marked latest nor projected. Repair content reaches 1.7 only through the next normal `data-` release's projection.

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

## 2.8.x Fix Flow

1. Branch from `lts/2.8` as `fix/v2.8.x-<topic>` or `docs/v2.8.x-<topic>` and keep Python/TS behavior and versions aligned.
2. Run the relevant checks and `./scripts/check-runtime.sh --full` for runtime-sensitive or release-workflow changes.
3. Open a PR to `lts/2.8`, complete the review required by WORKFLOW, and have the maintainer merge it.
4. For a maintenance release, update both versions and CHANGELOGs through a release PR to `lts/2.8`; tag its merged commit with `python/v2.8.x` and `ts/v2.8.x`. Alpha/beta/RC tags are rejected on this line.
5. CD verifies that the actual tag resolves to the requested commit and that this commit is an ancestor of `origin/lts/2.8`; ancestry on `main` or `develop` alone is insufficient. Tag and package versions must still match. Every remote publication rechecks the scope and current UTC date, so an earlier successful verification cannot authorize a publication resumed after EOL.
6. If a fix also applies to Rust, implement and review it separately on `develop`. Never merge the whole maintenance branch into a Rust branch, which would restore `python/` and `ts/`.

During the transition, a blocking regression in the still-stable 2.x `main` follows the existing hotfix flow, then is ported to `lts/2.8` and to Rust where applicable. Once `develop` has the Rust layout, use a Rust implementation of the fix instead of a whole-branch forward merge. This maintenance setup does not itself publish a new version or bump the 2.8.1 baseline.

## 2.8 Release Channels

| Channel | LTS behavior |
| --- | --- |
| npm `prts-mcp-ts` | Publish new maintenance versions with `--tag lts-2.8`; never update `latest` or the 1.7 tag. |
| GHCR `ghcr.io/3akhp/prts-mcp` | Publish the exact version and `:2`; never update `:latest` or `:3`. This remains the Python image. |
| GitHub Release | Keep both implementation-prefixed releases; set `make_latest: false`. |
| PyPI `prts-mcp` | Continue publishing exact 2.8.x Python versions. PyPI has no npm-style maintenance dist-tag; pin a version or use `<3` to remain on 2.x. |

Examples after the first maintenance release establishes the channel aliases:

```bash
npm install -g prts-mcp-ts@lts-2.8
docker pull ghcr.io/3akhp/prts-mcp:2
pip install 'prts-mcp>=2.8,<2.9'
```

Exact 2.8.1 artifacts remain usable before those aliases exist. Setting an alias on an already published version is a registry operation separate from source preparation. Retrying an already published npm version verifies its immutable bytes and does not republish it.

The npm/PyPI workflows retain their existing Trusted Publishing identities and `npm`/`pypi` environments. Before the first remote run, check that environment tag rules allow the new maintenance tags. CI includes `lts/2.8` and executes the release-guard tests; modifying either guard or workflow triggers CI. Existing 1.7 workflows are unchanged.

2.8 data synchronization continues to consume AKDP directly. Its retirement does not stop the AKDP factory used by Rust. The 1.7 projection lifecycle above remains separate.

## 2.0 Boundary

2.0 work may break the 1.x compatibility contract. The 2.0 branch must provide migration notes before prerelease for:

- Final tool-surface consolidation.
- Output channel (`structuredContent`) behavior — note 2.0 keeps markdown as the default `content` and does **not** flip to a JSON default; the originally proposed per-call `output_format=markdown|json` parameter was rejected during design.
- Removed or hidden legacy tool aliases.

Cross-transport parity was deferred from 2.0 and delivered in 2.3.0: Python gained Streamable HTTP and TypeScript gained stdio, while both original transport entry points remained compatible. See [`docs/migration-1.x-to-2.0.md`](../migration-1.x-to-2.0.md) for the delivered 2.0 changes.
