#!/usr/bin/env bun
/**
 * Bun package entry point.
 *
 * The actual server stays in server.ts so Node and Bun share the same
 * Express/MCP implementation. This wrapper only verifies the runtime selected
 * by the public bin before loading the server.
 */

if (!("Bun" in globalThis)) {
  process.stderr.write("prts-mcp-ts-bun must be run with Bun.\n");
  process.exit(1);
}

await import("./server.js");
