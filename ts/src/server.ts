#!/usr/bin/env node
/**
 * PRTS-MCP server entry point (TypeScript).
 *
 * Creates the Express app with the StreamableHTTP transport, manages session
 * lifecycle (idle timeout, stale-session recovery), and delegates tool
 * registration to focused modules under src/tools/.
 *
 * Startup data sync lives in startupSync.ts; this file only launches it
 * as a background task before the server starts listening.
 */

import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerPrtsTools } from "./tools/prtsTools.js";
import { registerGamedataTools } from "./tools/gamedataTools.js";
import { registerStoryTools } from "./tools/storyTools.js";
import { startAutoSync } from "./startupSync.js";
import { parseChannel, type OutputChannel } from "./output.js";

// ---------------------------------------------------------------------------
// Logging + version
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version?: string };
export const SERVER_VERSION = packageJson.version ?? "0.0.0";

export function log(level: "INFO" | "WARN" | "ERROR", msg: string): void {
  const ts = new Date().toISOString();
  process.stderr.write(`${ts} ${level} prts_mcp.server: ${msg}\n`);
}

// ---------------------------------------------------------------------------
// MCP Server factory — one instance per session
// ---------------------------------------------------------------------------

export function createMcpServer(channel: OutputChannel): McpServer {
  const server = new McpServer({
    name: "PRTS_Wiki_Assistant",
    version: SERVER_VERSION,
  });

  registerPrtsTools(server, channel);
  registerGamedataTools(server, channel);
  registerStoryTools(server, channel);

  return server;
}

function firstString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const first = value.find((item) => typeof item === "string");
    return typeof first === "string" ? first : undefined;
  }
  return undefined;
}

function resolveOutputChannel(req: express.Request): OutputChannel {
  const queryValue = firstString(req.query["output_channel"]);
  const headerValue = firstString(req.headers["x-prts-output-channel"]);
  const warn = (message: string) => log("WARN", message);
  if (queryValue !== undefined) return parseChannel(queryValue, "output_channel", warn);
  if (headerValue !== undefined) return parseChannel(headerValue, "x-prts-output-channel", warn);
  return parseChannel(process.env["PRTS_OUTPUT_CHANNEL"], "PRTS_OUTPUT_CHANNEL", warn);
}

// ---------------------------------------------------------------------------
// Express + StreamableHTTP
// ---------------------------------------------------------------------------

const app = express();
// Parse JSON bodies — StreamableHTTP transport accepts req.body as parsedBody.
app.use(express.json());

const transports = new Map<string, StreamableHTTPServerTransport>();

const SESSION_IDLE_TIMEOUT_MS = (() => {
  const raw = process.env["SESSION_IDLE_TIMEOUT_MS"];
  if (raw === undefined) return 24 * 60 * 60 * 1000;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return -1;
})();

interface SessionMeta {
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
  timer?: ReturnType<typeof setTimeout>;
}

const sessionMeta = new Map<string, SessionMeta>();

function touchSession(id: string): void {
  if (SESSION_IDLE_TIMEOUT_MS <= 0) return;
  const meta = sessionMeta.get(id);
  if (!meta) return;
  meta.lastActivity = Date.now();
}

function scheduleSessionTimeout(id: string): void {
  if (SESSION_IDLE_TIMEOUT_MS <= 0) return;
  const meta = sessionMeta.get(id);
  if (!meta) return;

  if (meta.timer) clearTimeout(meta.timer);

  meta.timer = setTimeout(() => {
    const m = sessionMeta.get(id);
    if (!m) return;
    const idleMs = Date.now() - m.lastActivity;
    if (idleMs >= SESSION_IDLE_TIMEOUT_MS) {
      log("INFO", `Session ${id} idle for ${Math.round(idleMs / 1000)}s — evicting.`);
      try { m.transport.close(); } catch { /* best-effort */ }
      transports.delete(id);
      sessionMeta.delete(id);
    } else {
      scheduleSessionTimeout(id);
    }
  }, SESSION_IDLE_TIMEOUT_MS);
  meta.timer.unref();
}

app.all("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let transport = sessionId ? transports.get(sessionId) : undefined;

  if (!transport) {
    // Stale session ID: evicted by idle timeout or lost across restart.
    // Per MCP Streamable HTTP spec §3.2, unrecognized session IDs MUST
    // receive 404 regardless of request type.  We intentionally relax this
    // for initialize requests: stripping the old ID and treating it as a
    // fresh handshake gives broken/non-retrying clients (e.g. Chatbox) a
    // zero-error recovery path.  Non-init requests get the spec-mandated
    // 404 with an LLM-actionable message.
    if (sessionId) {
      const isInit =
        req.method === "POST" &&
        !Array.isArray(req.body) &&
        req.body?.method === "initialize";
      if (!isInit) {
        log("INFO", `Session ${sessionId} not found; returning 404.`);
        res.status(404).json({
          jsonrpc: "2.0",
          error: {
            code: -32002,
            message:
              "MCP session lost (server may have restarted for data sync). " +
              "Please ask the user to disconnect and reconnect the MCP server " +
              "in the client settings — typically by toggling the MCP connection " +
              "off and on, or restarting the client application.",
          },
          id: (req.body as Record<string, unknown> | undefined)?.id ?? null,
        });
        return;
      }
      delete req.headers["mcp-session-id"];
      log("INFO", `Session ${sessionId} not found; allowing re-initialization.`);
    }

    const newTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports.set(id, newTransport);
        sessionMeta.set(id, { transport: newTransport, lastActivity: Date.now() });
        scheduleSessionTimeout(id);
        log("INFO", `Session ${id} initialized.`);
      },
    });
    newTransport.onclose = () => {
      if (newTransport.sessionId) {
        const meta = sessionMeta.get(newTransport.sessionId);
        if (meta?.timer) clearTimeout(meta.timer);
        transports.delete(newTransport.sessionId);
        sessionMeta.delete(newTransport.sessionId);
        log("INFO", `Session ${newTransport.sessionId} closed.`);
      }
    };
    try {
      const channel = resolveOutputChannel(req);
      const server = createMcpServer(channel);
      await server.connect(newTransport);
    } catch (err) {
      log("ERROR", `Failed to connect MCP server to transport: ${err instanceof Error ? err.message : String(err)}`);
      res.status(500).json({ error: "Internal server error" });
      return;
    }
    transport = newTransport;
  }

  // Update idle timer on each request
  if (sessionId) {
    touchSession(sessionId);
  }

  // Pass req.body explicitly so the transport uses the already-parsed body
  // rather than attempting to re-read the consumed stream.
  await transport.handleRequest(req, res, req.body);
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const PORT = Number(process.env["PORT"] ?? 3000);
const HOST = process.env["HOST"] ?? "0.0.0.0";

app.listen(PORT, HOST, () => {
  log("INFO", `PRTS MCP Server ${SERVER_VERSION} listening on ${HOST}:${PORT} (StreamableHTTP at /mcp)`);
  startAutoSync();
});
