# Migration Guide: 0.x to 1.0

_Status: 1.0.0-alpha.1_

PRTS-MCP 1.0 keeps the public MCP tool surface stable while normalizing the
internal data layer.

## What Stays Compatible

- Existing MCP tool names are unchanged.
- Existing required tool parameters are unchanged.
- `GAMEDATA_PATH` still disables GameData auto-sync and points to an
  ArknightsGameData-compatible root.
- `STORYJSON_PATH` still disables story auto-sync and points to `zh_CN.zip`.
- `GITHUB_TOKEN` and `GITHUB_MIRRORS` keep the same runtime meanings.
- Docker and npm releases continue to include bundled fallback data prepared by
  CI.
- PyPI remains data-light and relies on startup auto-sync or user-provided data
  paths.

## Internal Changes

- Operator and story parsers now read through a small store abstraction.
- Directory-backed, zip-backed, and fallback stores share the same conceptual
  API across Python and TypeScript.
- Runtime sync code is being consolidated around dataset specs for:
  - `gamedata.excel`
  - `story.zh_CN`

These changes should not require client configuration changes.

## Upgrade Notes

1. Upgrade the Python package or TypeScript package as usual.
2. Keep existing `GAMEDATA_PATH`, `STORYJSON_PATH`, `GITHUB_TOKEN`, and
   `GITHUB_MIRRORS` settings if you already use them.
3. For Docker deployments, keep mounting `gamedata` and `storyjson` volumes as
   before.
4. If you publish local npm tarballs manually, prewarm `ts/data/` first or
   expect only placeholder fallback data in the tarball.

## Deferred

Story summary tools are not part of the initial 1.0 migration. They may be
considered after the reader layer is stable.

