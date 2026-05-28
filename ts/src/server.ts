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
import {
  searchPrts,
  readPage,
  listSections,
  getCategories,
  getLinks,
  getTemplateData,
} from "./api/prtsWiki.js";
import { clearOperatorCaches, getOperatorArchives, getOperatorVoicelines, getOperatorBasicInfo } from "./data/operator.js";
import { clearEnemyCaches, listEnemies, getEnemyInfo, searchEnemies } from "./data/enemy.js";
import { clearStageCaches, listStages, getStageInfo, searchStages } from "./data/stage.js";
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
  getStorySummary as _getStorySummary,
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
      "返回匹配词条的标题和简短摘要列表，含匹配总数。这是探索维基的第一步：当需要查找不确定的专有名词、干员、关卡或世界观设定时，先用此工具搜索获取准确标题，再将标题传入 read_prts_page 获取完整内容。",
    ].join(" "),
    {
      query: z.string().describe("搜索关键词，支持中文，如「罗德岛」、「整合运动」。"),
      limit: z.number().int().min(1).max(20).default(5).describe("返回结果数量上限，默认 5，最大建议不超过 10。"),
      search_mode: z.enum(["text", "title"]).default("text").describe("搜索模式：text（全文搜索，默认）或 title（仅搜索标题）。"),
      filter_technical: z.boolean().default(true).describe("是否过滤 /spine、/data 等技术页面，默认 true。"),
    },
    async ({ query, limit, search_mode, filter_technical }) => {
      const result = await searchPrts(query, limit, search_mode, filter_technical);
      if (result.results.length === 0) {
        return { content: [{ type: "text", text: `未找到与 '${query}' 相关的词条。` }] };
      }
      const header = `# 搜索 "${query}"（共 ${result.totalHits} 条匹配）\n`;
      const body = result.results
        .map((r) => `**${r.title}**\n${r.snippet}`)
        .join("\n\n---\n\n");
      return { content: [{ type: "text", text: header + body }] };
    }
  );

  server.tool(
    "read_prts_page",
    [
      "读取 PRTS 维基指定词条的纯文本内容。",
      "返回该词条经过清洗的纯文本，已去除 CSS、HTML 标签和实体，内容可能较长。",
      "强烈建议先调用 list_prts_sections 查看目录结构，再用 section_index 按需读取特定章节，避免整页内容过载。",
      "不填 section_index 时返回整页。",
    ].join(" "),
    {
      page_title: z.string().describe("词条标题，需与维基页面标题完全一致，如「阿米娅」、「整合运动」。建议通过 search_prts 获取准确标题后再传入。"),
      section_index: z.number().int().optional().describe("可选章节编号（从 list_prts_sections 获取）。不填则返回整页内容；填入编号如 1 则仅返回该节。"),
    },
    async ({ page_title, section_index }) => {
      const text = await readPage(page_title, section_index);
      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "list_prts_sections",
    [
      "列出 PRTS 维基页面的目录（章节列表）。",
      "返回章节编号、层级和标题，其中以 T- 开头的编号表示该节来自模板嵌入（如角色信息框）。",
      "获取编号后可传入 read_prts_page 的 section_index 参数按需读取特定章节，避免一次加载整页内容。",
    ].join(" "),
    { page_title: z.string().describe("词条标题，需与维基页面标题完全一致，如「阿米娅」。") },
    async ({ page_title }) => {
      try {
        const sections = await listSections(page_title);
        if (sections.length === 0) {
          return { content: [{ type: "text", text: `页面 '${page_title}' 没有章节目录。` }] };
        }
        const lines = sections.map(
          (s) => `[${s.index}] L${s.level} ${s.line}`
        );
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e) {
        return { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }] };
      }
    }
  );

  server.tool(
    "get_prts_categories",
    [
      "获取 PRTS 维基页面的分类标签。",
      "返回该页面所属的所有分类，如「干员」「术师干员」「属于罗德岛的干员」。",
      "可用于理解页面类型和所属体系，辅助导航和发现相关页面。",
    ].join(" "),
    { page_title: z.string().describe("词条标题，如「阿米娅」、「塔露拉」。") },
    async ({ page_title }) => {
      try {
        const cats = await getCategories(page_title);
        if (cats.length === 0) {
          return { content: [{ type: "text", text: `页面 '${page_title}' 没有分类标签。` }] };
        }
        return { content: [{ type: "text", text: cats.map((c) => `- ${c}`).join("\n") }] };
      } catch (e) {
        return { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }] };
      }
    }
  );

  server.tool(
    "get_prts_links",
    [
      "获取 PRTS 维基页面的相关链接。",
      "outbound 返回该页面引用的所有其他词条链接；inbound 返回所有引用了该页面的词条链接（反向链接）。",
      "可用于探索维基的知识图谱关系。",
    ].join(" "),
    {
      page_title: z.string().describe("词条标题，如「阿米娅」。"),
      direction: z.enum(["outbound", "inbound"]).default("outbound").describe("链接方向：outbound（页面引用的链接，默认）或 inbound（引用该页面的链接）。"),
      limit: z.number().int().min(1).max(100).default(30).describe("返回链接数量上限，默认 30。"),
    },
    async ({ page_title, direction, limit }) => {
      try {
        const result = await getLinks(page_title, direction, limit);
        if (result.links.length === 0) {
          const dirLabel = direction === "outbound" ? "出站" : "入站";
          return { content: [{ type: "text", text: `页面 '${page_title}' 没有${dirLabel}链接。` }] };
        }
        const suffix = result.hasMore
          ? `\n（共 ${result.total} 条，还有更多）`
          : `\n（共 ${result.total} 条）`;
        return { content: [{ type: "text", text: result.links.map((ln) => `- ${ln}`).join("\n") + suffix }] };
      } catch (e) {
        return { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }] };
      }
    }
  );

  server.tool(
    "get_prts_template",
    [
      "获取 PRTS 维基页面的结构化模板数据。",
      "提取页面中所有模板调用的键值对，返回按模板名分组的 dict。",
      "典型模板：干员页面的 CharinfoV2（干员名、稀有度、职业、所属等），",
      "敌人页面的 敌人信息/common2（名称、地位级别、描述、伤害类型等），",
      "物品页面的 道具信息（名称、用途、获得方式等）。",
    ].join(" "),
    {
      page_title: z.string().describe("词条标题，如「阿米娅」。"),
    },
    async ({ page_title }) => {
      try {
        const templates = await getTemplateData(page_title);
        if (Object.keys(templates).length === 0) {
          return { content: [{ type: "text", text: `页面 '${page_title}' 未找到可提取的模板数据。` }] };
        }
        return { content: [{ type: "text", text: JSON.stringify(templates, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }] };
      }
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
  // Enemy tools
  // -------------------------------------------------------------------------

  server.tool(
    "list_enemies",
    [
      "列出敌方图鉴，支持按威胁等级过滤和分页。",
      "默认返回前 50 条。若需翻页，增大 offset 即可。",
      "若只想看领袖/BOSS 级敌人，设置 threat_level=\"boss\"。",
      "不推荐使用 full=true，图鉴共有 1500+ 条目，密集输出极易污染上下文。",
    ].join(" "),
    {
      threat_level: z.string().optional().describe("按威胁等级过滤：boss（领袖）、elite（精英）、normal（普通）。不填则返回全部。"),
      limit: z.number().int().min(1).max(200).default(50).describe("返回数量上限，默认 50。"),
      offset: z.number().int().min(0).default(0).describe("分页偏移量，默认 0。"),
      full: z.boolean().default(false).describe("返回全部敌人（忽略 limit/offset）。不推荐常规使用。"),
    },
    ({ threat_level, limit, offset, full }) => ({
      content: [{ type: "text", text: listEnemies(threat_level ?? null, limit, offset, full) }],
    })
  );

  server.tool(
    "get_enemy_info",
    "获取指定敌人的详细图鉴资料。",
    { name: z.string().describe("敌人的游戏内中文名，如「源石虫」、「霜星」。") },
    ({ name }) => ({ content: [{ type: "text", text: getEnemyInfo(name) }] })
  );

  server.tool(
    "search_enemies",
    [
      "在敌人图鉴中进行全文正则搜索。",
      "搜索范围包含敌人名称、描述和特殊能力文本。",
      "可用于探索特定种族、阵营或关键词相关的敌人信息。",
    ].join(" "),
    {
      pattern: z.string().describe("正则表达式模式，如 '萨卡兹|骑士'。"),
      max_results: z.number().int().min(1).max(100).default(30).describe("返回结果数量上限，默认 30。"),
    },
    ({ pattern, max_results }) => ({ content: [{ type: "text", text: searchEnemies(pattern, max_results) }] })
  );

  // -------------------------------------------------------------------------
  // Stage tools
  // -------------------------------------------------------------------------

  server.tool(
    "list_stages",
    [
      "列出关卡列表，支持按章节和类型过滤。",
      "返回格式：每行 `- **关卡名** [类型] 编号 — 难度 — 区域`。",
      "获取 stage_id 后可传入 get_stage_info 查看详情。",
    ].join(" "),
    {
      chapter: z.string().optional().describe("按所属章节（zoneId）过滤，如 'main_0'。不填则返回全部。"),
      type: z.string().optional().describe("按关卡类型过滤：MAIN（主线）/ ACTIVITY（活动）/ SUB（支线）/ DAILY（每日）/ CAMPAIGN（剿灭）/ CLIMB_TOWER（爬塔）/ SPECIAL_STORY（特殊故事）/ GUIDE（教程）。"),
      limit: z.number().int().min(1).max(200).default(50).describe("返回数量上限，默认 50。"),
      offset: z.number().int().min(0).default(0).describe("分页偏移量，默认 0。"),
    },
    ({ chapter, type, limit, offset }) => ({
      content: [{ type: "text", text: listStages(chapter ?? null, type ?? null, limit, offset) }],
    })
  );

  server.tool(
    "get_stage_info",
    "获取指定关卡的详细信息。返回关卡的编号、类型、难度、所属区域、理智消耗、掉落奖励、解锁条件等。",
    { stage_id: z.string().describe("关卡 ID，如 'main_00-01'（可从 list_stages 获取）。") },
    ({ stage_id }) => ({ content: [{ type: "text", text: getStageInfo(stage_id) }] })
  );

  server.tool(
    "search_stages",
    [
      "在关卡数据库中执行全文正则搜索。",
      "搜索范围覆盖关卡名称、编号、描述。返回匹配关卡的基本信息块。",
    ].join(" "),
    {
      pattern: z.string().describe("正则表达式搜索模式，大小写不敏感。例如 'H10'、'切尔诺伯格'。"),
      max_results: z.number().int().min(1).max(100).default(30).describe("最多返回条数，默认 30。"),
    },
    ({ pattern, max_results }) => ({
      content: [{ type: "text", text: searchStages(pattern, max_results) }],
    })
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
          const store = new ZipStore(zipPath);
          try {
            if (store.exists("zh_CN/storyinfo.json")) {
              const raw = store.readJson<Record<string, unknown>>("zh_CN/storyinfo.json");
              for (const [k, v] of Object.entries(raw)) {
                if (v) summaries[k] = String(v);
              }
            }
          } catch {
            // storyinfo.json missing is non-fatal
          } finally {
            store.close();
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
    "get_story_summary",
    [
      "获取单章剧情的梗概。",
      "返回指定章节的故事摘要。优先使用 LLM 生成的长摘要，",
      "未就绪时回退到官方一句话梗概，最后回退到章节自带的 storyInfo。",
    ].join(" "),
    { story_key: z.string().describe("章节 key，如 \"activities/act31side/level_act31side_01_beg\"（可从 list_stories 获取）。") },
    ({ story_key }) => {
      let zipPath: string;
      try {
        zipPath = requireStoryZip();
      } catch (e) {
        return { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }] };
      }
      try {
        const text = _getStorySummary(zipPath, story_key);
        return { content: [{ type: "text", text }] };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("not found")) {
          return { content: [{ type: "text", text: `未找到剧情章节："${story_key}"。请通过 list_stories 确认章节 key。` }] };
        }
        return { content: [{ type: "text", text: `读取梗概失败：${msg}` }] };
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
              "  使用 search_stories 搜索。\n" +
              "- stages：关卡数据（名称、编号、描述、类型、掉落、解锁条件）。\n" +
              "  使用 list_stages / get_stage_info / search_stages 查询。\n" +
              "- enemies：敌人图鉴（名称、威胁等级、描述、属性）。\n" +
              "  使用 list_enemies / get_enemy_info / search_enemies 查询。",
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
        clearEnemyCaches();
        clearStageCaches();
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
      const server = createMcpServer();
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
  void runStartupSync().catch((err: unknown) => {
    log("ERROR", `Startup sync threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
  });
});
