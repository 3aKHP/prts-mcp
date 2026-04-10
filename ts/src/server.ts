#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import { loadConfig, hasStoryData } from "./config.js";
import { searchPrts, readPage } from "./api/prtsWiki.js";
import { getOperatorArchives, getOperatorVoicelines, getOperatorBasicInfo } from "./data/operator.js";
import { syncAll, syncRelease, GAMEDATA_FILES, type RepoSpec, type ReleaseSpec } from "./data/sync.js";
import {
  listStoryEvents as _listStoryEvents,
  listStories as _listStories,
  readStory as _readStory,
  readActivity as _readActivity,
  type StoryChapter,
  type StoryLine,
} from "./data/story.js";

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(level: "INFO" | "WARN" | "ERROR", msg: string): void {
  const ts = new Date().toISOString();
  process.stderr.write(`${ts} ${level} prts_mcp.server: ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Story formatting helpers
// ---------------------------------------------------------------------------

function formatLine(line: StoryLine): string {
  if (line.type === "dialog") {
    return `${line.role ?? "（旁白）"}：${line.text}`;
  } else if (line.type === "narration") {
    return `*${line.text}*`;
  } else {
    return `【选项】${line.text}`;
  }
}

function formatChapter(chapter: StoryChapter): string {
  const parts: string[] = [];
  parts.push(`【${chapter.eventName}】${chapter.storyName}`);
  if (chapter.storyInfo) parts.push(`简介：${chapter.storyInfo}\n`);
  for (const line of chapter.lines) {
    parts.push(formatLine(line));
  }
  return parts.join("\n");
}

function requireStoryZip(): string {
  const cfg = loadConfig();
  if (!hasStoryData(cfg)) {
    throw new Error(
      "剧情数据暂不可用。容器启动时的 auto-sync 可能仍在进行中，请稍后重试；" +
        "若持续出现此提示，请检查网络连接，或提供 STORYJSON_PATH 指向本地 zh_CN.zip。" +
        `（当前同步目标路径：${cfg.storyjsonZip}）`
    );
  }
  return cfg.effectiveStoryjsonZip!;
}

// ---------------------------------------------------------------------------
// MCP Server factory — one instance per session
// ---------------------------------------------------------------------------

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "PRTS_Wiki_Assistant",
    version: "0.2.0",
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

  // -------------------------------------------------------------------------
  // Story tools
  // -------------------------------------------------------------------------

  server.tool(
    "list_story_events",
    [
      "列出明日方舟剧情活动列表。",
      "category 可选过滤：\"main\"（主线）或 \"activities\"（活动 + 插曲）。",
      "不传 category 则返回全部条目。",
      "返回格式：每行 - [类型] 活动ID：名称（N 章）",
      "获取活动 ID 后，可调用 list_stories 查看该活动的章节列表。",
    ].join(" "),
    { category: z.string().optional() },
    ({ category }) => {
      let zipPath: string;
      try {
        zipPath = requireStoryZip();
      } catch (e) {
        return { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }] };
      }
      try {
        const events = _listStoryEvents(zipPath, category);
        if (events.length === 0) {
          return { content: [{ type: "text", text: "未找到匹配的活动。" }] };
        }
        const lines = events.map(
          (ev) => `- [${ev.entryType}] ${ev.eventId}：${ev.name}（${ev.storyCount} 章）`
        );
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e) {
        return { content: [{ type: "text", text: `读取剧情数据失败：${e instanceof Error ? e.message : String(e)}` }] };
      }
    }
  );

  server.tool(
    "list_stories",
    [
      "列出指定活动的所有章节，按官方顺序排列。",
      "event_id 为活动 ID（可从 list_story_events 获取，如 \"act31side\"）。",
      "返回格式：每行 - 关卡代码 [标签] 章节名（key: 章节key）",
      "获取章节 key 后，可调用 read_story 阅读具体章节内容。",
    ].join(" "),
    { event_id: z.string() },
    ({ event_id }) => {
      let zipPath: string;
      try {
        zipPath = requireStoryZip();
      } catch (e) {
        return { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }] };
      }
      try {
        const chapters = _listStories(zipPath, event_id);
        if (chapters.length === 0) {
          return { content: [{ type: "text", text: `活动 "${event_id}" 没有章节数据。` }] };
        }
        const lines = chapters.map((ch) => {
          const tag = ch.avgTag ? `[${ch.avgTag}] ` : "";
          return `- ${ch.storyCode} ${tag}${ch.storyName}（key: ${ch.storyKey}）`;
        });
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("not found")) {
          return {
            content: [
              {
                type: "text",
                text: `未找到活动："${event_id}"。请先调用 list_story_events 确认活动 ID。`,
              },
            ],
          };
        }
        return { content: [{ type: "text", text: `读取章节列表失败：${msg}` }] };
      }
    }
  );

  server.tool(
    "read_story",
    [
      "阅读指定章节的完整剧情内容。",
      "story_key 为章节 key（可从 list_stories 获取，如 \"activities/act31side/level_act31side_01_beg\"）。",
      "include_narration 控制是否包含旁白/场景描述（默认 true）。",
    ].join(" "),
    {
      story_key: z.string(),
      include_narration: z.boolean().default(true),
    },
    ({ story_key, include_narration }) => {
      let zipPath: string;
      try {
        zipPath = requireStoryZip();
      } catch (e) {
        return { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }] };
      }
      try {
        const chapter = _readStory(zipPath, story_key, include_narration);
        return { content: [{ type: "text", text: formatChapter(chapter) }] };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("not found") || msg.includes("Entry not found")) {
          return {
            content: [
              {
                type: "text",
                text: `未找到剧情："${story_key}"。请通过 list_stories 确认章节 key。`,
              },
            ],
          };
        }
        return { content: [{ type: "text", text: `读取剧情失败：${msg}` }] };
      }
    }
  );

  server.tool(
    "read_activity",
    [
      "阅读指定活动的完整剧情（按官方顺序，合并所有章节）。",
      "event_id 为活动 ID（可从 list_story_events 获取）。",
      "include_narration 控制是否包含旁白（默认 true）。",
      "page 为章节分页（从 1 开始），不传则返回全部章节。",
      "page_size 控制每页章节数（默认 5）。",
      "返回内容含 total_chapters 和 has_more，便于判断是否还有后续内容。",
    ].join(" "),
    {
      event_id: z.string(),
      include_narration: z.boolean().default(true),
      page: z.number().int().min(1).optional(),
      page_size: z.number().int().min(1).max(20).default(5),
    },
    ({ event_id, include_narration, page, page_size }) => {
      let zipPath: string;
      try {
        zipPath = requireStoryZip();
      } catch (e) {
        return { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }] };
      }
      try {
        const result = _readActivity(
          zipPath,
          event_id,
          include_narration,
          page,
          page_size
        );
        const parts: string[] = [];
        if (result.eventName) {
          parts.push(
            `# ${result.eventName}（共 ${result.totalChapters} 章${result.hasMore ? "，当前为部分内容" : ""}）`
          );
        }
        for (const chapter of result.chapters) {
          const tag = chapter.avgTag ? ` [${chapter.avgTag}]` : "";
          parts.push(`\n=== ${chapter.storyCode}${tag} ${chapter.storyName} ===`);
          if (chapter.storyInfo) parts.push(`简介：${chapter.storyInfo}`);
          for (const line of chapter.lines) {
            parts.push(formatLine(line));
          }
        }
        if (result.chapters.length === 0) {
          parts.push("该活动暂无可读取的章节数据。");
        }
        if (result.hasMore) {
          const nextPage = (page ?? 1) + 1;
          parts.push(
            `\n[还有更多章节，请调用 read_activity(event_id="${event_id}", page=${nextPage})]`
          );
        }
        return { content: [{ type: "text", text: parts.join("\n") }] };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("not found")) {
          return {
            content: [
              {
                type: "text",
                text: `未找到活动："${event_id}"。请先调用 list_story_events 确认活动 ID。`,
              },
            ],
          };
        }
        return { content: [{ type: "text", text: `读取活动剧情失败：${msg}` }] };
      }
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// Startup data sync (fire-and-forget)
// ---------------------------------------------------------------------------

function runStartupSync(): void {
  const cfg = loadConfig();

  // Gamedata sync
  if (cfg.isCustomGamedata) {
    log("INFO", `GAMEDATA_PATH is custom (${cfg.gamedataPath}); auto-sync disabled.`);
  } else {
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

  // Storyjson release sync (always attempt unless user supplied STORYJSON_PATH)
  if (!process.env["STORYJSON_PATH"]) {
    const releaseSpec: ReleaseSpec = {
      owner: "3aKHP",
      repo: "ArknightsStoryJson",
      assetName: "zh_CN.zip",
      localZip: cfg.storyjsonZip,
    };

    syncRelease(releaseSpec)
      .then((r) => {
        const sha = r.commitSha ? r.commitSha.slice(0, 8) : "unknown";
        if (r.status === "updated") {
          log("INFO", `Storyjson updated from GitHub Release (${r.spec.repo} @ ${sha}).`);
        } else if (r.status === "up_to_date") {
          log("INFO", `Storyjson is up to date (${r.spec.repo} @ ${sha}).`);
        } else if (r.status === "offline_fallback") {
          log("WARN", `Network unavailable; using cached storyjson (${r.spec.repo} @ ${sha}). Error: ${r.error}`);
        } else {
          log("ERROR", `Storyjson sync failed for ${r.spec.repo} — no zip. Error: ${r.error}`);
        }
      })
      .catch((err: unknown) => {
        log("ERROR", `Storyjson sync threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
      });
  } else {
    log("INFO", `STORYJSON_PATH is set (${process.env["STORYJSON_PATH"]}); story auto-sync disabled.`);
  }
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
