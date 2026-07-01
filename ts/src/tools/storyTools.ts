/**
 * Story tool registrations — events, chapters, dialogue, summaries, search, memoirs, characters.
 *
 * Split from server.ts. Exports registerStoryTools which attaches the 9
 * story-backed tools to a McpServer instance. Also exports the shared
 * requireStoryZip helper and line/chapter formatters.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ZipStore } from "../data/stores.js";
import { loadConfig, hasStoryData } from "../config.js";
import {
  listStoryEvents as _listStoryEvents,
  listStories as _listStories,
  readStory as _readStory,
  readActivity as _readActivity,
  searchStories as _searchStories,
  getStorySummary as _getStorySummary,
  getOperatorMemoirs as _getOperatorMemoirs,
  findCharacterAppearances as _findCharacterAppearances,
  findSpeakersIn as _findSpeakersIn,
  type StoryChapter,
  type StoryLine,
} from "../data/story.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export function requireStoryZip(): string {
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

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerStoryTools(server: McpServer): void {
  server.tool(
    "list_story_events",
    [
      "列出明日方舟剧情活动列表。",
      "返回格式：每行 `- [类型] 活动ID：名称（N 章）`，类型为 MAINLINE / ACTIVITY / MINI_ACTIVITY / NONE 之一。",
      "获取活动 ID 后可调用 list_stories 查看该活动的章节列表。",
    ].join(" "),
    { category: z.string().optional().describe("可选过滤分类。\"main\" = 主线章节，\"activities\" = 活动剧情（含联动），\"memoirs\" = 干员密录。不填则返回全部活动。") },
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
      "设 include_summaries=true 可一次性了解活动整体剧情脉络。",
    ].join(" "),
    {
      event_id: z.string().describe("活动 ID，如 \"act31side\"（可从 list_story_events 获取）。"),
      include_summaries: z.boolean().default(false).describe("是否附带梗概，默认 false。设为 true 时顶部附活动级长摘要（若有）、每章下方附一句话梗概。"),
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
        let eventSummaryText = "";
        if (include_summaries) {
          const store = new ZipStore(zipPath);
          try {
            if (store.exists("zh_CN/storyinfo.json")) {
              const raw = store.readJson<Record<string, unknown>>("zh_CN/storyinfo.json");
              for (const [k, v] of Object.entries(raw)) {
                if (v) summaries[k] = String(v);
              }
            }
            if (store.exists("zh_CN/event_summaries.json")) {
              const rawEv = store.readJson<Record<string, unknown>>("zh_CN/event_summaries.json");
              const text = rawEv[event_id];
              if (typeof text === "string") eventSummaryText = text.trim();
            }
          } catch {
            // summary indexes are optional
          } finally {
            store.close();
          }
        }

        const lines: string[] = [];
        if (eventSummaryText) {
          lines.push(eventSummaryText, "");
        }
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
    "get_story_summary",
    [
      "获取单章剧情的梗概。",
      "返回指定章节的故事摘要，优先长摘要，未就绪时回退到官方一句话梗概。",
      "整个活动的章节概览见 list_stories(include_summaries=true)。",
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
      "返回各章节台词的合并文本，格式与 read_story 一致，章节间以分隔标题区分。",
      "单次文本量可能较大，建议用 page 分批获取，返回末尾会提示是否还有后续内容。",
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

  server.tool(
    "search_stories",
    [
      "在剧情台词中执行全文正则搜索，支持角色和台词类型过滤。",
      "返回格式：以 `[stories/活动ID/章节编号 L行号]` 标注位置，命中行前缀 `>>> ` 标记，上下文行以 4 空格缩进显示。",
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

  server.tool(
    "get_operator_memoirs",
    [
      "根据干员名称查询干员密录剧情。",
      "返回干员的密录章节列表，含章节 key（story_key）和元数据。",
      "获取 story_key 后可传入 read_story 读取密录台词。",
    ].join(" "),
    {
      name: z.string().describe("干员的游戏内中文名，如「阿米娅」、「能天使」。"),
    },
    ({ name }) => {
      let zipPath: string;
      try {
        zipPath = requireStoryZip();
      } catch (e) {
        return { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }] };
      }
      try {
        const result = _getOperatorMemoirs(zipPath, name);
        const lines: string[] = [
          `# ${result.operatorName}（code: ${result.internalCode}，id: ${result.operatorId}）`,
          `共 ${result.totalChapters} 章密录\n`,
        ];
        for (const ch of result.chapters) {
          lines.push(`- ${ch.storyCode} ${ch.storyName}（key: ${ch.storyKey}）`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("未找到干员名称") || msg.includes("暂无密录数据")) {
          return { content: [{ type: "text", text: msg }] };
        }
        return { content: [{ type: "text", text: `查询干员密录失败：${msg}` }] };
      }
    }
  );

  server.tool(
    "find_character_appearances",
    [
      "查找某个角色在剧情中的出场（说话或被提及）。",
      "返回该角色作为对话发言者（speaks）或名字出现在台词/旁白文本中（mentioned）的所有章节，每章标注 speaks / mentioned / 两者皆有，适合快速定位角色的登场分布。",
      "如需精确台词，可用返回的 story_key 调用 read_story。",
    ].join(" "),
    {
      name: z.string().describe("角色名（干员中文名或「博士」）。speaks 按对话角色名精确匹配，mentioned 按名字在台词/旁白文本中的子串匹配——请使用完整名字以免误报（如「阿」会命中「阿米娅」）。"),
      scope: z.string().optional().describe("限定活动 ID，如「act31side」。不填则检索全部活动。"),
      max_events: z.number().int().min(1).max(200).default(50).describe("最多返回章节数，默认 50。"),
    },
    ({ name, scope, max_events }) => {
      let zipPath: string;
      try {
        zipPath = requireStoryZip();
      } catch (e) {
        return { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }] };
      }
      try {
        const result = _findCharacterAppearances(zipPath, name, scope, max_events);
        if (result.appearances.length === 0) {
          const scopeNote = scope ? `（限定活动：${JSON.stringify(scope)}）` : "";
          return { content: [{ type: "text", text: `未找到「${name}」的出场记录。${scopeNote}` }] };
        }
        const parts: string[] = [`# 「${result.name}」的出场（共 ${result.totalChapters} 章）`];
        for (const ap of result.appearances) {
          const tags: string[] = [];
          if (ap.speaks) tags.push("speaks");
          if (ap.mentioned) tags.push("mentioned");
          const tag = tags.join("+");
          const nameDisp = `${ap.storyCode} ${ap.storyName}`.trim();
          parts.push(`- [${tag}] ${ap.eventId} / ${nameDisp}（key: ${ap.storyKey}）`);
        }
        return { content: [{ type: "text", text: parts.join("\n") }] };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Validation errors (不能为空 / 必须) and not-found (未找到) are
        // user-facing messages returned bare; only unexpected errors get a prefix.
        const isUserFacing = msg.includes("未找到") || msg.includes("不能为空") || msg.includes("必须");
        return { content: [{ type: "text", text: isUserFacing ? msg : `查询角色出场失败：${msg}` }] };
      }
    }
  );

  server.tool(
    "find_speakers_in",
    [
      "列出某活动中的所有发言角色及其台词数。",
      "返回该活动去重后的对话发言者，按台词句数降序排列，适合了解角色戏份分布。",
      "读取某角色说的具体内容可用 search_stories(character=...) 过滤。",
    ].join(" "),
    {
      event_id: z.string().describe("活动 ID，如 \"act31side\"（可从 list_story_events 获取）。"),
    },
    ({ event_id }) => {
      let zipPath: string;
      try {
        zipPath = requireStoryZip();
      } catch (e) {
        return { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }] };
      }
      try {
        const speakers = _findSpeakersIn(zipPath, event_id);
        if (speakers.length === 0) {
          return { content: [{ type: "text", text: `活动 "${event_id}" 暂无对话发言者数据。` }] };
        }
        const parts: string[] = [`# ${event_id} 的发言角色（共 ${speakers.length} 位）`];
        for (const sp of speakers) {
          parts.push(`- ${sp.name}（${sp.lineCount} 句）`);
        }
        return { content: [{ type: "text", text: parts.join("\n") }] };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: "text", text: msg.includes("未找到") ? msg : `查询发言角色失败：${msg}` }] };
      }
    }
  );
}
