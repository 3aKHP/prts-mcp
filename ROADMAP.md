# PRTS-MCP Roadmap

_Last updated: 2026-05-14_

PRTS-MCP has reached its first stable release. The public tool surface and
data architecture are now under a compatibility contract.

## Current Release

- Python: `1.1.0`
- TypeScript: `1.1.0`
- The public tool surface (12 MCP tools) is frozen in the 1.x line.
  Automated CI checks enforce this.
- 1.1.0 adds 3 search tools: `list_search_scopes`, `search_data`, `search_stories`.
- A migration guide covers behavioral changes for users upgrading from 0.x.

## 1.x Patch Policy

Patch releases (1.1.1, 1.1.2, …) are limited to bug fixes and documentation
improvements within the 1.x compatibility contract.

## 1.0 Goals

1. **Version alignment**
   - Python and TypeScript share the same major and minor versions.
   - Patch versions may diverge only for implementation-specific fixes.
   - Release notes explicitly state cross-implementation compatibility.

2. **Standardized data pipeline**
   - Separate upstream source, local storage, JSON reading, and domain parsing.
   - Keep existing `GAMEDATA_PATH` and `STORYJSON_PATH` semantics compatible.
   - Hide zip-vs-directory details behind a shared reader abstraction.
   - Make new data-backed tools easier to add without new one-off sync logic.

3. **Cross-implementation behavior parity**
   - Python and TypeScript expose the same MCP tools.
   - Core outputs are covered by shared fixture/golden tests.
   - CI verifies both implementations before release.

4. **Documented compatibility boundary**
   - Docker, npm, and PyPI data-bundling behavior is explicit.
   - Migration notes cover custom data paths and startup auto-sync behavior.
   - 1.0 starts the compatibility contract for public tool parameters and
     response formats.

## 1.0 Non-Goals

- Shipping every possible Arknights data table.
- Embedding large fallback data in PyPI wheels.
- Replacing GitHub Release based sync with a different hosting model.
- Adding generated LLM summaries as a required runtime dependency.

## Release Plan

### `1.0.0-alpha.1`: Architecture Skeleton

- Status: ready for prerelease tagging from the current `main` commit.
- Introduced the dataset/reader abstraction in both implementations.
- Moved existing operator and story readers behind the new abstraction.
- Kept current user-facing behavior compatible.
- Added focused tests around directory-backed and zip-backed reads.
- Added prerelease-aware release workflows for Python and TypeScript tags.

### `1.0.0-alpha.2`: Sync and Storage Consolidation

- Status: ready for prerelease tagging from the current `main` commit.
- Added bounded retry for `offline_fallback` / `no_data` startup-sync
  results on the Python side (TypeScript already had it).
- Added post-download zip integrity validation for the storyjson Release
  asset on the TypeScript side (Python already had it).
- Normalize release metadata, cache freshness, and fallback decisions.
- Decide which datasets remain zip-backed at runtime and which are extracted.
- Verify Docker and npm bundled fallback data through CI package inspection.

### `1.0.0-beta.1`: Behavior Freeze

- Freeze the public tool list and core response formats for 1.0.
- Add migration notes from the 0.x line.
- Expand cross-implementation fixture tests.

### `1.0.0`: Stable Release

- Publish Python and TypeScript 1.0 releases together.
- Announce version alignment and compatibility rules.
- Keep later 1.0.x releases focused on bug fixes and documentation.

## 1.1.0 Added

- **Search tools** (`list_search_scopes`, `search_data`, `search_stories`):
  full-text regex search across operator data and story dialogue, with filtering
  by speaker, line type, and configurable context lines.

## Optional Future Feature Track

The most likely next feature candidate is a story-summary tool, but it should
only be implemented from existing structured story data.

Possible shape:

- `get_story_summary(story_key)`: return an existing official/source-provided
  summary when available.
- Later: `get_stage_story_summary(stage_id)`, if stage-to-story mapping proves
  stable enough.

Generated summaries should remain out of scope until caching, reproducibility,
and dependency boundaries are designed.

## Detailed Plans

- [1.0 architecture plan](docs/dev/plans/1.0-architecture-plan.md)
- [1.0 development roadmap](docs/dev/plans/1.0-development-roadmap.md)
