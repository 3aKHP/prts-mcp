import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";

import { loadConfig } from "./config.js";
import { searchPrts, readPage } from "./api/prtsWiki.js";
import { getOperatorArchives, getOperatorVoicelines } from "./data/operator.js";
import { syncAll, GAMEDATA_FILES, type RepoSpec } from "./data/sync.js";

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(level: "INFO" | "WARN" | "ERROR", msg: string): void {
  const ts = new Date().toISOString();
  process.stderr.write(`${ts} ${level} prts_mcp.server: ${msg}\n`);
}

// ---------------------------------------------------------------------------
// MCP Server + tools
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Startup data sync (fire-and-forget, runs in background)
// ---------------------------------------------------------------------------

function runStartupSync(): void {
  const cfg = loadConfig();
  if (cfg.isCustomGamedata) {
    log(
      "INFO",
      `GAMEDATA_PATH is set to a custom location (${cfg.gamedataPath}); auto-sync disabled.`
    );
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

  // Intentionally not awaited — sync runs in the background while the
  // HTTP server accepts connections immediately.
  syncAll(specs).then((results) => {
    for (const r of results) {
      const sha = r.commitSha ? r.commitSha.slice(0, 8) : "unknown";
      if (r.status === "updated") {
        log("INFO", `Data updated from GitHub (${r.spec.repo} @ ${sha}).`);
      } else if (r.status === "up_to_date") {
        log("INFO", `Data is up to date (${r.spec.repo} @ ${sha}).`);
      } else if (r.status === "offline_fallback") {
        log(
          "WARN",
          `Network unavailable; using cached data (${r.spec.repo} @ ${sha}). Error: ${r.error}`
        );
      } else {
        log(
          "ERROR",
          `Sync failed for ${r.spec.repo} — no data available. Error: ${r.error}`
        );
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Express HTTP server with SSE transport
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

const transports = new Map<string, SSEServerTransport>();

app.get("/sse", async (_req, res) => {
  const transport = new SSEServerTransport("/message", res);
  transports.set(transport.sessionId, transport);
  res.on("close", () => transports.delete(transport.sessionId));
  await server.connect(transport);
});

app.post("/message", async (req, res) => {
  const sessionId = req.query["sessionId"] as string | undefined;
  const transport = sessionId ? transports.get(sessionId) : undefined;
  if (!transport) {
    res.status(400).json({ error: "Unknown or missing sessionId" });
    return;
  }
  await transport.handlePostMessage(req, res);
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const PORT = Number(process.env["PORT"] ?? 3000);

runStartupSync();

app.listen(PORT, () => {
  log("INFO", `PRTS MCP Server listening on port ${PORT}`);
});
