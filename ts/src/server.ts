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

import { randomUUID } from "node:crypto";
import express from "express";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { startAutoSync } from "./startupSync.js";
import { parseChannel, type OutputChannel } from "./output.js";
import { createMcpServer, log, SERVER_VERSION } from "./server-core.js";
import { getCacheStats } from "./cacheStats.js";
import { RuntimeMetrics } from "./metrics.js";

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

const transports = new Map<string, NodeStreamableHTTPServerTransport>();
const METRICS_ENABLED = process.env["PRTS_METRICS_ENABLED"] === "true";
const runtimeMetrics = METRICS_ENABLED ? new RuntimeMetrics() : null;

const SESSION_IDLE_TIMEOUT_MS = (() => {
  const raw = process.env["SESSION_IDLE_TIMEOUT_MS"];
  if (raw === undefined) return 24 * 60 * 60 * 1000;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return -1;
})();

interface SessionMeta {
  transport: NodeStreamableHTTPServerTransport;
  createdAt: number;
  lastActivity: number;
  closing?: boolean;
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
      m.closing = true;
      transports.delete(id);
      runtimeMetrics?.sessionEvicted();
      try {
        m.transport.close();
      } catch {
        if (m.timer) clearTimeout(m.timer);
        sessionMeta.delete(id);
        runtimeMetrics?.sessionClosed();
      }
    } else {
      scheduleSessionTimeout(id);
    }
  }, SESSION_IDLE_TIMEOUT_MS);
  meta.timer.unref();
}

app.all("/mcp", async (req, res) => {
  const requestMetrics = runtimeMetrics?.beginRequest(req.body);
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  try {
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

      const newTransport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          const now = Date.now();
          transports.set(id, newTransport);
          sessionMeta.set(id, { transport: newTransport, createdAt: now, lastActivity: now });
          runtimeMetrics?.sessionInitialized();
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
          runtimeMetrics?.sessionClosed();
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
  } finally {
    if (requestMetrics !== undefined) runtimeMetrics?.finishRequest(requestMetrics, res.statusCode);
  }
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/debug/cache", (_req, res) => {
  res.json(getCacheStats());
});

app.get("/debug/metrics", (_req, res) => {
  if (runtimeMetrics === null) {
    res.sendStatus(404);
    return;
  }
  res.json(runtimeMetrics.snapshot(
    SERVER_VERSION,
    SESSION_IDLE_TIMEOUT_MS > 0 ? SESSION_IDLE_TIMEOUT_MS : null,
    [...sessionMeta.values()]
      .filter((session) => !session.closing)
      .map(({ createdAt, lastActivity }) => ({ createdAtMs: createdAt, lastActivityMs: lastActivity })),
    getCacheStats(),
  ));
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
