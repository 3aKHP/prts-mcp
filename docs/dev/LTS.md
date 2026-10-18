# LTS Maintenance Policy

PRTS-MCP maintains two legacy long-term support (LTS) lines alongside the 3.x Rust product line: `lts/1.7` for 1.7.x and `lts/2.8` for 2.8.x. Both branches retain their dual Python and TypeScript implementations and reach end of life (EOL) on **2027-07-02**.

| Maintenance Branch | Baseline Release | MCP Tools | End of Life (EOL) |
| --- | --- | --- | --- |
| `lts/1.7` | `1.7.0` | 32 | 2027-07-02 |
| `lts/2.8` | `2.8.1` (`e0ba36096cdd46640166b0a5db02902fa9a6a24c`) | 24 | 2027-07-02 |

---

## 1. Maintenance Scope

**Allowed in `lts/1.7` and `lts/2.8`:**

- Compatibility fixes for upstream data schema changes, MCP client behavior, or package metadata.
- Security fixes, including dependency CVEs, archive/input validation, and transport hardening.
- Data-sync fixes for GitHub Release discovery, ZIP verification, retry logic, and mirror fallback.
- Critical bug fixes for incorrect query outputs, crashes, resource leaks, or Python/TypeScript parity regressions.
- Documentation updates covering deployment, support policy, or migration instructions.

**Out of scope for LTS branches:**

- New MCP tools or new data domains.
- New required tool parameters or changes to default output formats.
- Tool-surface consolidation or removal of legacy aliases.
- Architectural rewrites or transport role changes.

---

## 2. Long-Lived Branches

| Branch | Purpose |
|--------|---------|
| `main` | Latest public stable release line (native Rust `3.1.0`). |
| `develop` | Active 3.x Rust integration branch (`3.1.1-dev.0`). Does not contain `python/` or `ts/` directories. |
| `lts/2.8` | Long-term 2.8.x Python/TypeScript maintenance branch, forked from the `2.8.1` release commit. |
| `lts/1.7` | Long-term 1.7.x Python/TypeScript maintenance branch, forked from the `1.7.0` release commit. |

Never push directly to any long-lived branch; all changes must go through Pull Requests. For version semantics and compatibility rules, see [`VERSIONING.md`](VERSIONING.md); for PR grading and review requirements, see [`WORKFLOW.md`](WORKFLOW.md).

---

## 3. Support Lifecycle and Data Sources

Both `lts/1.7` and `lts/2.8` are supported through **2027-07-02** (the 12-month support window established when `1.7.0` shipped on `2026-07-02`). Release workflow guards on `lts/2.8` enforce this cutoff and reject publications after `2027-07-02` UTC.

After EOL:

- No further `1.7.x` or `2.8.x` maintenance releases will be published.
- The `lts/1.7` and `lts/2.8` branches, Git tags (`python/v*`, `ts/v*`), and published registry packages/images remain available read-only for reproducible installs and rollback.
- Users still on `1.7.x` or `2.8.x` should upgrade following [`docs/migration-1.x-to-2.0.md`](../migration-1.x-to-2.0.md) and [`docs/migration-2.x-to-3.0.md`](../migration-2.x-to-3.0.md).

### Data Pipeline Compatibility Notes

- **`lts/2.8` data sync**: consumes `3aKHP/arknights-data-pipeline` (AKDP) directly, including `datarev-<versionId>-r<N>` repair revisions introduced in 2.7.3. Since 3.x also consumes AKDP, `2.8.x` deployments continue to receive normal data updates throughout and after the 3.0 transition.
- **`lts/1.7` projection forks**: 1.7 auto-sync reads `/releases/latest` from the `3aKHP/ArknightsGameData` and `3aKHP/ArknightsStoryJson` forks, which are populated by projection workflows from AKDP.
  - **Do not archive** those two fork repositories before `2027-07-02` — archiving a GitHub repository makes it read-only and would halt automated projection releases for 1.7 users.
  - After `2027-07-02`, the projection workflows in both forks will be disabled; existing 1.7 instances will continue running with the final projected dataset.
  - Note that `datarev-` repair releases are not marked `latest` and are not projected to the 1.7 forks; repair content reaches 1.7 on the next standard `data-` release.

---

## 4. Maintenance Workflows

### 1.7.x Fix and Release Flow

1. Create a topic branch from `lts/1.7` named `fix/v1.7.x-<topic>` or `docs/v1.7.x-<topic>`.
2. Implement the minimal compatible fix in both `python/` and `ts/` (keeping behavior and versions in lockstep).
3. Run the 1.7 test suites (and `./scripts/check-runtime.sh --full` on that branch for runtime-sensitive changes).
4. Open a PR targeting `lts/1.7` and complete the review required by [`WORKFLOW.md`](WORKFLOW.md).
5. When publishing a 1.7.x maintenance release, tag the merged release commit on `lts/1.7` with both implementation tags:
   ```bash
   git tag python/v1.7.x
   git tag ts/v1.7.x
   git push origin python/v1.7.x ts/v1.7.x
   ```
6. If the bug also affects 2.8.x or 3.x Rust, port the fix to `lts/2.8` and/or reimplement it in Rust on `develop` via separate PRs. Never merge `lts/1.7` into `main` or `develop`.

### 2.8.x Fix and Release Flow

1. Create a topic branch from `lts/2.8` named `fix/v2.8.x-<topic>` or `docs/v2.8.x-<topic>`, keeping Python and TypeScript behavior and lockfiles aligned.
2. Run the 2.8 verification suite (`./scripts/check-runtime.sh --full` on the `lts/2.8` checkout for runtime or workflow changes).
3. Open a PR targeting `lts/2.8` and complete review per [`WORKFLOW.md`](WORKFLOW.md).
4. For a `2.8.x` maintenance release, open a release PR to `lts/2.8` bumping `python/pyproject.toml`, `ts/package.json`, and both changelogs. Once merged, tag the commit with `python/v2.8.x` and `ts/v2.8.x` (prerelease `-alpha`/`-beta`/`-rc` tags are rejected on `lts/2.8`).
5. The `lts/2.8` CD workflow verifies that the tag commit is an ancestor of `origin/lts/2.8`, that tag and package versions match, and that the current UTC date is on or before `2027-07-02`.
6. If a fix also applies to 3.x, reimplement and verify it in Rust on `develop` in a separate PR. **Never merge `lts/2.8` into `develop`**, as doing so would reintroduce the removed `python/` and `ts/` source trees.

### 2.8.x Publishing Channels

To prevent 2.8 maintenance releases from overwriting 3.x stable tags after cutover, `lts/2.8` publishes under dedicated maintenance channels:

| Channel | `lts/2.8` Publication Behavior |
| --- | --- |
| **npm (`prts-mcp-ts`)** | Publishes with `--tag lts-2.8`; never updates `latest` or `lts-1.7`. |
| **GHCR (`ghcr.io/3akhp/prts-mcp`)** | Publishes `:2.8.x` and `:2`; never updates `:latest` or `:3`. |
| **GitHub Releases** | Publishes `python/v2.8.x` and `ts/v2.8.x` releases with `make_latest: false`. |
| **PyPI (`prts-mcp`)** | Publishes `2.8.x` Python packages (3.x does not publish to PyPI; users can pin `'prts-mcp>=2.8,<2.9'`). |

Downstream users who wish to stay on the 2.8 maintenance line can pin:

```bash
npm install -g prts-mcp-ts@lts-2.8
docker pull ghcr.io/3akhp/prts-mcp:2
pip install 'prts-mcp>=2.8,<2.9'
```
