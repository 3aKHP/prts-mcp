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

try {
  await import("./server.js");
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`prts-mcp-ts-bun failed to load server: ${message}\n`);
  process.exit(1);
}
