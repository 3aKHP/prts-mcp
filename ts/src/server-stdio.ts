#!/usr/bin/env node
/**
 * PRTS-MCP stdio entry point (TypeScript).
 *
 * The default HTTP server lives in server.ts; this file provides the stdio
 * transport so the TypeScript implementation can be used from local MCP
 * clients (Claude Desktop, Claude Code, Cursor, etc.) without running an
 * HTTP listener. It reuses the same McpServer factory, tool registration,
 * and startup sync as the HTTP path — only the transport differs.
 *
 * Output channel is resolved purely from the PRTS_OUTPUT_CHANNEL env var
 * (stdio has no query string / headers); the default is "content".
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer, log, SERVER_VERSION } from "./server.js";
import { startAutoSync } from "./startupSync.js";
import { parseChannel } from "./output.js";

async function main(): Promise<void> {
  const warn = (message: string) => log("WARN", message);
  const channel = parseChannel(
    process.env["PRTS_OUTPUT_CHANNEL"],
    "PRTS_OUTPUT_CHANNEL",
    warn,
  );

  const server = createMcpServer(channel);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  log("INFO", `PRTS-MCP stdio server ${SERVER_VERSION} connected (channel=${channel})`);

  // Background data sync — same as the HTTP path. On stdio the process is
  // typically short-lived (client spawns per use), so retry timers use
  // unref and incomplete sync is acceptable (resumes next launch).
  startAutoSync();
}

main().catch((err) => {
  log("ERROR", `stdio server failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
