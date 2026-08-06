/**
 * Side-effect-free MCP server factory, shared by the HTTP entry (server.ts)
 * and the stdio entry (server-stdio.ts).
 *
 * This module must NOT start any listeners or perform any I/O at module load
 * time — only when createMcpServer() is called explicitly.  This guarantees
 * that importing it from server-stdio.ts does not accidentally start an HTTP
 * listener.
 */

import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "./config.js";
import { registerPrtsTools } from "./tools/prtsTools.js";
import { registerGamedataTools } from "./tools/gamedataTools.js";
import { registerStoryTools } from "./tools/storyTools.js";
import { registerArtworkTools } from "./tools/artworkTools.js";
import { type OutputChannel } from "./output.js";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version?: string };
export const SERVER_VERSION = packageJson.version ?? "0.0.0";

export function log(level: "INFO" | "WARN" | "ERROR", msg: string): void {
  const ts = new Date().toISOString();
  process.stderr.write(`${ts} ${level} prts_mcp.server: ${msg}\n`);
}

export function createMcpServer(channel: OutputChannel): McpServer {
  const server = new McpServer({
    name: "PRTS_Wiki_Assistant",
    version: SERVER_VERSION,
  });

  registerPrtsTools(server, channel);
  registerGamedataTools(server, channel);
  registerStoryTools(server, channel);

  // operator_artwork is registered only when IMAGES_ENABLED=true.
  if (loadConfig().imagesEnabled) {
    registerArtworkTools(server, channel);
  }

  return server;
}
