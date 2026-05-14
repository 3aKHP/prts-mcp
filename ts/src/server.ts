#!/usr/bin/env node
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { ZipStore } from "./data/stores.js";

import { loadConfig, hasStoryData } from "./config.js";
import { searchPrts, readPage } from "./api/prtsWiki.js";
import { clearOperatorCaches, getOperatorArchives, getOperatorVoicelines, getOperatorBasicInfo } from "./data/operator.js";
import { searchOperatorData } from "./data/search.js";
import { syncRelease, syncReleaseArchive } from "./data/sync.js";
import { archiveSpecForDataset, releaseSpecForDataset, GAMEDATA_EXCEL, STORY_ZH_CN } from "./data/datasets.js";
import {
  listStoryEvents as _listStoryEvents,
  listStories as _listStories,
  readStory as _readStory,
  readActivity as _readActivity,
  searchStories as _searchStories,
  getEventSummary as _getEventSummary,
  type StoryChapter,
  type StoryLine,
} from "./data/story.js";

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version?: string };
const SERVER_VERSION = packageJson.version ?? "0.0.0";

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
    version: SERVER_VERSION,
  });

  server.tool(
    "search_prts",
    [
      "搜索 PRTS 明日方舟中文维基词条。",
      "返回匹配词条的标题和简短摘要列表。这是探索维基的第一步：当需要查找不确定的专有名词、干员、关卡或世界观设定时，先用此工具搜索获取准确标题，再将标题传入 read_prts_page 获取完整内容。",
    ].join(" "),
    {
      query: z.string().describe("搜索关键词，支持中文，如「罗德岛」、「整合运动」。"),
      limit: z.number().int().min(1).max(20).default(5).describe("返回结果数量上限，默认 5，最大建议不超过 10。"),
    },
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
    [
      "读取 PRTS 维基指定词条的纯文本内容。",
      "返回该词条经过清洗的纯文本，已去除 Wikitext 模板、文件链接和 HTML 标签，内容可能较长。",
      "强烈建议先调用 search_prts 确认词条的准确标题，避免因拼写错误导致读取失败。",
    ].join(" "),
    {
      page_title: z.string().describe("词条标题，需与维基页面标题完全一致，如「阿米娅」、「整合运动」。建议通过 search_prts 获取准确标题后再传入。"),
    },
    async ({ page_title }) => {
      const text = await readPage(page_title);
      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "get_operator_archives",
    [
      "获取指定干员的档案资料。",
      "返回干员的客观履历、个人档案（基础档案及解锁档案）等背景故事文本。",
      "若需查询干员的职业、稀有度等数值信息，请使用 get_operator_basic_info；若需查询语音台词，请使用 get_operator_voicelines。",
    ].join(" "),
    { operator_name: z.string().describe("干员的游戏内中文名，如「阿米娅」、「能天使」。") },
    ({ operator_name }) => {
      const text = getOperatorArchives(operator_name);
      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "get_operator_voicelines",
    [
      "获取指定干员的所有语音台词记录。",
      "返回包含触发条件（如「交谈1」、「晋升后交谈」、「信赖提升后交谈」）及对应台词文本的完整列表。",
      "此工具仅返回语音文本；若需查询干员背景故事或客观履历，请使用 get_operator_archives。",
    ].join(" "),
    { operator_name: z.string().describe("干员的游戏内中文名，如「阿米娅」、「能天使」。") },
    ({ operator_name }) => {
      const text = getOperatorVoicelines(operator_name);
      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "get_operator_basic_info",
    [
      "获取指定干员的基本数值信息。",
      "返回干员的职业、子职业、稀有度（星级）、所属阵营、招募标签、天赋名称及描述等结构化信息。",
      "适合快速了解干员定位；若需完整背景故事请使用 get_operator_archives，若需语音台词请使用 get_operator_voicelines。",
    ].join(" "),
    { operator_name: z.string().describe("干员的游戏内中文名，如「阿米娅」、「能天使」。") },
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
      "返回格式：每行 `- [类型] 活动ID：名称（N 章）`，类型为 MAINLINE / ACTIVITY / MINI_ACTIVITY 之一。",
      "获取活动 ID 后，可调用 list_stories 查看该活动的章节列表。",
    ].join(" "),
    { category: z.string().optional().describe("可选过滤分类。\"main\" = 主线章节，\"activities\" = 活动剧情（含联动）。不填则返回全部活动。") },
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
      "列出指定活动的所有剧情章节（按官方顺序排列）。",
      "返回格式：每行 `- 章节编号 [标签] 章节名（key: story_key）`，其中 story_key 可直接传入 read_story 读取该章台词。",
      "设置 include_summaries=true 时每章下方会附带梗概。如需一次性了解活动整体剧情脉络，可使用 get_event_summary。",
    ].join(" "),
    {
      event_id: z.string().describe("活动 ID，如 \"act31side\"（可从 list_story_events 获取）。"),
      include_summaries: z.boolean().default(false).describe("是否附带每章梗概，默认 false。"),
    },
    ({ event_id, include_summaries }) => {
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

        // Load summaries if requested
        let summaries: Record<string, string> = {};
        if (include_summaries) {
          try {
            const store = new ZipStore(zipPath);
            if (store.exists("zh_CN/storyinfo.json")) {
              const raw = store.readJson<Record<string, unknown>>("zh_CN/storyinfo.json");
              for (const [k, v] of Object.entries(raw)) {
                if (v) summaries[k] = String(v);
              }
            }
          } catch {
            // storyinfo.json missing is non-fatal
          }
        }

        const lines: string[] = [];
        for (const ch of chapters) {
          const tag = ch.avgTag ? `[${ch.avgTag}] ` : "";
          lines.push(`- ${ch.storyCode} ${tag}${ch.storyName}（key: ${ch.storyKey}）`);
          if (include_summaries) {
            const summary = summaries[ch.storyKey] ?? "";
            if (summary) lines.push(`  ${summary}`);
          }
        }
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
    "get_event_summary",
    [
      "获取指定活动的章节梗概概览。",
      "返回活动的所有章节编号、标题和每章故事简介，按官方顺序排列，",
      "适合快速了解一个活动的整体剧情脉络。",
    ].join(" "),
    { event_id: z.string().describe("活动 ID，如 \"act31side\"（可从 list_story_events 获取）。") },
    ({ event_id }) => {
      let zipPath: string;
      try {
        zipPath = requireStoryZip();
      } catch (e) {
        return { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }] };
      }
      try {
        const text = _getEventSummary(zipPath, event_id);
        return { content: [{ type: "text", text }] };
      } catch (e) {
        return { content: [{ type: "text", text: `读取活动梗概失败：${e instanceof Error ? e.message : String(e)}` }] };
      }
    }
  );

  server.tool(
    "read_story",
    [
      "读取单章剧情的完整台词。",
      "返回格式：首行为【活动名】章节名，随后按顺序输出对话（`角色：台词`）、旁白（`*旁白文本*`）和选项（`【选项】文本`）。",
      "story_key 可从 list_stories 的返回结果中获取。",
    ].join(" "),
    {
      story_key: z.string().describe("章节 key，如 \"activities/act31side/level_act31side_01_beg\"（可从 list_stories 获取）。"),
      include_narration: z.boolean().default(true).describe("是否包含旁白和场景描述，默认 true。设为 false 可只保留对话台词。"),
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
      "读取整个活动的完整剧情台词（按官方章节顺序合并）。",
      "适合需要了解完整活动故事的场景。返回各章节台词的合并文本，格式与 read_story 一致，章节间以分隔标题区分。",
      "单次活动文本量可能较大，建议使用 page 参数分批获取；返回结果会提示是否还有更多页。",
    ].join(" "),
    {
      event_id: z.string().describe("活动 ID，如 \"act31side\"（可从 list_story_events 获取）。"),
      include_narration: z.boolean().default(true).describe("是否包含旁白，默认 true。"),
      page: z.number().int().min(1).optional().describe("分页页码（从 1 开始）。不填则返回全部章节。"),
      page_size: z.number().int().min(1).max(20).default(5).describe("每页章节数，默认 5。"),
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

  // -------------------------------------------------------------------------
  // Search tools
  // -------------------------------------------------------------------------

  server.tool(
    "list_search_scopes",
    "列出所有可搜索的数据域及其内容类型。返回可用搜索域的名称和简介，帮助 Agent 选择合适的搜索工具和 scope 参数。",
    {},
    () => {
      return {
        content: [
          {
            type: "text",
            text:
              "可用搜索域：\n" +
              "- operators：干员数据（名称、基本信息描述、档案文本、语音台词）\n" +
              '  使用 search_data(scope="operators") 搜索。\n' +
              "- stories：剧情台词（对话、旁白、选项），按活动/章节组织，支持按角色和台词类型过滤。\n" +
              "  使用 search_stories 搜索。",
          },
        ],
      };
    }
  );

  server.tool(
    "search_data",
    [
      "在干员数据中执行全文正则搜索。",
      "搜索范围覆盖干员名称、攻击属性描述、档案文本和语音台词。",
      "返回带领域标签的匹配结果，包含匹配字段名和完整文本。",
    ].join(" "),
    {
      pattern: z.string().describe("正则表达式搜索模式，大小写不敏感。例如「博士」、「法术伤害」。"),
      scope: z.string().default("operators").describe('搜索域，目前支持 "operators"。'),
      max_results: z.number().int().min(1).max(100).default(30).describe("最多返回条数，默认 30。"),
    },
    ({ pattern, scope, max_results }) => {
      if (scope !== "operators") {
        return { content: [{ type: "text", text: `不支持的搜索域：${JSON.stringify(scope)}。当前仅支持 scope="operators"。` }] };
      }
      const text = searchOperatorData(pattern, max_results);
      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "search_stories",
    [
      "在剧情台词中执行全文正则搜索，支持角色和台词类型过滤。",
      "返回格式：以 [stories/活动ID/章节编号 L行号] 标注位置，",
      "命中行前缀 >>> 标记，上下文行以 4 空格缩进显示。",
    ].join(" "),
    {
      pattern: z.string().describe("正则表达式搜索模式，大小写不敏感。"),
      character: z.string().optional().describe("按说话角色名过滤（仅匹配 dialog 行），如「博士」、「阿米娅」。"),
      line_type: z.string().optional().describe("台词类型过滤：dialog（对话）、narration（旁白）、choice（选项）。"),
      context_lines: z.number().int().min(0).max(5).default(1).describe("匹配行前后的上下文行数，默认 1。"),
      max_results: z.number().int().min(1).max(100).default(30).describe("最多返回条数，默认 30。"),
      event_id: z.string().optional().describe("限定活动 ID，如「act31side」。不填则搜索全部活动。"),
    },
    ({ pattern, character, line_type, context_lines, max_results, event_id }) => {
      let zipPath: string;
      try {
        zipPath = requireStoryZip();
      } catch (e) {
        return { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }] };
      }
      try {
        const text = _searchStories(
          zipPath,
          pattern,
          character,
          line_type,
          context_lines,
          max_results,
          event_id,
        );
        return { content: [{ type: "text", text }] };
      } catch (e) {
        return { content: [{ type: "text", text: `剧情搜索失败：${e instanceof Error ? e.message : String(e)}` }] };
      }
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// Startup data sync
// ---------------------------------------------------------------------------

const SYNC_RETRY_DELAYS_MS = [30_000, 120_000, 600_000] as const;

function shouldRetrySync(status: string): boolean {
  return status === "offline_fallback" || status === "no_data";
}

function scheduleSyncRetry(
  label: string,
  runSync: () => Promise<boolean>,
  attempt = 0,
): void {
  const delayMs = SYNC_RETRY_DELAYS_MS[attempt];
  if (delayMs === undefined) {
    log("WARN", `${label} sync still needs retry after ${SYNC_RETRY_DELAYS_MS.length} attempts; waiting for next process start.`);
    return;
  }

  const timer = setTimeout(() => {
    void runSync()
      .then((needsRetry) => {
        if (needsRetry) scheduleSyncRetry(label, runSync, attempt + 1);
      })
      .catch((err: unknown) => {
        log("ERROR", `${label} retry sync threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
        scheduleSyncRetry(label, runSync, attempt + 1);
      });
  }, delayMs);
  timer.unref();

  log("INFO", `${label} sync will retry in ${Math.round(delayMs / 1000)}s.`);
}

async function runStartupSync(): Promise<void> {
  const cfg = loadConfig();
  const startupTasks: Promise<void>[] = [];

  // Gamedata sync
  if (cfg.isCustomGamedata) {
    log("INFO", `GAMEDATA_PATH is custom (${cfg.gamedataPath}); auto-sync disabled.`);
  } else {
    const archiveSpec = archiveSpecForDataset(
      GAMEDATA_EXCEL,
      join(cfg.gamedataPath, "archives", "zh_CN-excel.zip"),
      cfg.gamedataPath,
    );

    const runGamedataSync = async (): Promise<boolean> => {
      const r = await syncReleaseArchive(archiveSpec);
      const sha = r.commitSha ? r.commitSha.slice(0, 8) : "unknown";
      if (r.status === "updated") {
        clearOperatorCaches();
        log("INFO", `Data updated from GitHub Release (${r.spec.repo} @ ${sha}).`);
      } else if (r.status === "up_to_date") {
        log("INFO", `Data is up to date (${r.spec.repo} @ ${sha}).`);
      } else if (r.status === "offline_fallback") {
        log("WARN", `Network unavailable; using cached data (${r.spec.repo} @ ${sha}). Error: ${r.error}`);
      } else {
        log("ERROR", `Sync failed for ${r.spec.repo} — no data. Error: ${r.error}`);
      }
      return shouldRetrySync(r.status);
    };

    startupTasks.push(
      runGamedataSync()
        .catch((err: unknown) => {
          log("ERROR", `Startup sync threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
          return true;
        })
        .then((needsRetry) => {
          if (needsRetry) scheduleSyncRetry("Gamedata", runGamedataSync);
        }),
    );
  }

  // Storyjson release sync (always attempt unless user supplied STORYJSON_PATH)
  if (!process.env["STORYJSON_PATH"]) {
    const releaseSpec = releaseSpecForDataset(STORY_ZH_CN, cfg.storyjsonZip);

    const runStorySync = async (): Promise<boolean> => {
      const r = await syncRelease(releaseSpec);
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
      return shouldRetrySync(r.status);
    };

    startupTasks.push(
      runStorySync()
        .catch((err: unknown) => {
          log("ERROR", `Storyjson sync threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
          return true;
        })
        .then((needsRetry) => {
          if (needsRetry) scheduleSyncRetry("Storyjson", runStorySync);
        }),
    );
  } else {
    log("INFO", `STORYJSON_PATH is set (${process.env["STORYJSON_PATH"]}); story auto-sync disabled.`);
  }

  await Promise.all(startupTasks);
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

app.listen(PORT, HOST, () => {
  log("INFO", `PRTS MCP Server ${SERVER_VERSION} listening on ${HOST}:${PORT} (StreamableHTTP at /mcp)`);
  void runStartupSync().catch((err: unknown) => {
    log("ERROR", `Startup sync threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
  });
});
