#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import { loadConfig } from "./config.js";
import { searchPrts, readPage } from "./api/prtsWiki.js";
import { getOperatorArchives, getOperatorVoicelines, getOperatorBasicInfo } from "./data/operator.js";
import { syncAll, GAMEDATA_FILES, type RepoSpec } from "./data/sync.js";

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(level: "INFO" | "WARN" | "ERROR", msg: string): void {
  const ts = new Date().toISOString();
  process.stderr.write(`${ts} ${level} prts_mcp.server: ${msg}\n`);
}

// ---------------------------------------------------------------------------
// MCP Server factory — one instance per session
// ---------------------------------------------------------------------------

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "PRTS_Wiki_Assistant",
    version: "0.1.0",
  });

  server.tool(
    "search_prts",
    "搜索 PRTS 明日方舟中文维基词条。返回匹配的词条标题和摘要。",
    { query: z.string(), limit: z.number().int().min(1).max(20).default(5) },
    async ({ query, limit }) => {
      const results = await searchPrts(query, limit);
      if (results.length === 0) {
        return { content: [{ type: "text", text: `未找到与 '${query}' 相关的词条。` }] };
      }
      const text = results
        .map((r) => `**${r.title}**\n${r.snippet}`)
        .join("\n\n---\n\n");
      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "read_prts_page",
    "读取 PRTS 维基指定词条的纯文本内容。",
    { page_title: z.string() },
    async ({ page_title }) => {
      const text = await readPage(page_title);
      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "get_operator_archives",
    '获取指定干员的档案资料（使用游戏内中文名，如"阿米娅"）。',
    { operator_name: z.string() },
    ({ operator_name }) => {
      const text = getOperatorArchives(operator_name);
      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "get_operator_voicelines",
    '获取指定干员的语音记录（使用游戏内中文名，如"阿米娅"）。',
    { operator_name: z.string() },
    ({ operator_name }) => {
      const text = getOperatorVoicelines(operator_name);
      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "get_operator_basic_info",
    '获取指定干员的基本信息：职业、稀有度、所属、招募标签、天赋等（使用游戏内中文名，如"阿米娅"）。',
    { operator_name: z.string() },
    ({ operator_name }) => {
      const text = getOperatorBasicInfo(operator_name);
      return { content: [{ type: "text", text }] };
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// Startup data sync (fire-and-forget)
// ---------------------------------------------------------------------------

function runStartupSync(): void {
  const cfg = loadConfig();
  if (cfg.isCustomGamedata) {
    log("INFO", `GAMEDATA_PATH is custom (${cfg.gamedataPath}); auto-sync disabled.`);
    return;
  }

  const specs: RepoSpec[] = [
    {
      owner: "Kengxxiao",
      repo: "ArknightsGameData",
      branch: "master",
      files: GAMEDATA_FILES,
      localRoot: cfg.gamedataPath,
    },
  ];

  syncAll(specs)
    .then((results) => {
      for (const r of results) {
        const sha = r.commitSha ? r.commitSha.slice(0, 8) : "unknown";
        if (r.status === "updated") {
          log("INFO", `Data updated from GitHub (${r.spec.repo} @ ${sha}).`);
        } else if (r.status === "up_to_date") {
          log("INFO", `Data is up to date (${r.spec.repo} @ ${sha}).`);
        } else if (r.status === "offline_fallback") {
          log("WARN", `Network unavailable; using cached data (${r.spec.repo} @ ${sha}). Error: ${r.error}`);
        } else {
          log("ERROR", `Sync failed for ${r.spec.repo} — no data. Error: ${r.error}`);
        }
      }
    })
    .catch((err: unknown) => {
      log("ERROR", `Startup sync threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
    });
}

// ---------------------------------------------------------------------------
// Express + StreamableHTTP
// ---------------------------------------------------------------------------

const app = express();
// Parse JSON bodies — StreamableHTTP transport accepts req.body as parsedBody.
app.use(express.json());

const transports = new Map<string, StreamableHTTPServerTransport>();

app.all("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let transport = sessionId ? transports.get(sessionId) : undefined;

  if (!transport) {
    const newTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports.set(id, newTransport);
        log("INFO", `Session ${id} initialized.`);
      },
    });
    newTransport.onclose = () => {
      if (newTransport.sessionId) {
        transports.delete(newTransport.sessionId);
        log("INFO", `Session ${newTransport.sessionId} closed.`);
      }
    };
    try {
      const server = createMcpServer();
      await server.connect(newTransport);
    } catch (err) {
      log("ERROR", `Failed to connect MCP server to transport: ${err instanceof Error ? err.message : String(err)}`);
      res.status(500).json({ error: "Internal server error" });
      return;
    }
    transport = newTransport;
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

runStartupSync();

app.listen(PORT, HOST, () => {
  log("INFO", `PRTS MCP Server listening on ${HOST}:${PORT} (StreamableHTTP at /mcp)`);
});
