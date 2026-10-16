# Native Platform Smoke Fixture

This directory contains minimal synthetic `GameData` and `StoryJson` files generated from the frozen TS/v2.8.1 unit-test fixtures (`tools/make-fixtures.mjs`), corresponding to `minimal-gamedata-v2` in [`contracts/data-manifest.json`](../../../contracts/data-manifest.json).

- **Purpose**: enables [`tools/native/probe.mjs`](../../../tools/native/probe.mjs) to verify standalone native binaries across all five target platforms without requiring the historical TypeScript implementation, live network downloads, or local `.runtime/` caches.
- **Integrity**: the exact committed file sizes and SHA-256 digests are sealed in [`contracts/native-smoke-manifest.json`](../../../contracts/native-smoke-manifest.json).
- **Licensing**: third-party game and wiki content notices are documented in the root [`NOTICE`](../../../NOTICE) file.
