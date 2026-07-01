/**
 * PRTS Wiki tool registrations — search, read, sections, categories, links, template.
 *
 * Split from server.ts. Exports registerPrtsTools which attaches the 2 PRTS
 * Wiki tools to a McpServer instance.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  searchPrts,
  readPage,
  listSections,
  getCategories,
  getLinks,
  getTemplateData,
} from "../api/prtsWiki.js";

export function registerPrtsTools(server: McpServer): void {
  server.tool(
    "search_prts",
    [
      "搜索 PRTS 明日方舟中文维基词条。",
      "返回匹配词条的标题、简短摘要列表及匹配总数。查询专有名词、干员、关卡或世界观设定时先用此工具拿到准确标题，再传入 prts_page 获取完整内容。",
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
    "prts_page",
    [
      "读取 PRTS 维基页面的正文或元数据，按 action 分派。",
      "推荐流程：先用 action=\"sections\" 看目录（每行 `[编号] L层级 标题`，T- 前缀表示模板嵌入的节），再用 action=\"read\" + section_index 读特定章节，避免整页过载。",
      "其余 action：categories 返回分类标签；links 返回相关链接（outbound 出链 / inbound 反向链接）；template 返回结构化模板数据（如干员 CharinfoV2、敌人 敌人信息/common2、物品 道具信息）。",
    ].join(" "),
    {
      page_title: z.string().describe("词条标题，需与维基页面标题完全一致，如「阿米娅」。建议先用 search_prts 获取准确标题。"),
      action: z.enum(["read", "sections", "categories", "links", "template"]).describe("操作（必填）：read=读取正文 / sections=章节目录 / categories=分类标签 / links=相关链接 / template=结构化模板数据。"),
      section_index: z.number().int().optional().describe("仅 action=read 生效：章节编号（从 action=sections 获取）。不填返回整页。"),
      direction: z.enum(["outbound", "inbound"]).default("outbound").describe("仅 action=links 生效：outbound（出链，默认）或 inbound（入链）。"),
      limit: z.number().int().min(1).max(100).default(30).describe("仅 action=links 生效：返回链接数量上限，默认 30。"),
    },
    async ({ page_title, action, section_index, direction, limit }) => {
      try {
        if (action === "read") {
          const text = await readPage(page_title, section_index);
          return { content: [{ type: "text", text }] };
        }
        if (action === "sections") {
          const sections = await listSections(page_title);
          if (sections.length === 0) {
            return { content: [{ type: "text", text: `页面 '${page_title}' 没有章节目录。` }] };
          }
          return { content: [{ type: "text", text: sections.map((s) => `[${s.index}] L${s.level} ${s.line}`).join("\n") }] };
        }
        if (action === "categories") {
          const cats = await getCategories(page_title);
          if (cats.length === 0) {
            return { content: [{ type: "text", text: `页面 '${page_title}' 没有分类标签。` }] };
          }
          return { content: [{ type: "text", text: cats.map((c) => `- ${c}`).join("\n") }] };
        }
        if (action === "links") {
          const result = await getLinks(page_title, direction, limit);
          if (result.links.length === 0) {
            const dirLabel = direction === "outbound" ? "出站" : "入站";
            return { content: [{ type: "text", text: `页面 '${page_title}' 没有${dirLabel}链接。` }] };
          }
          const suffix = result.hasMore
            ? `\n（共 ${result.total} 条，还有更多）`
            : `\n（共 ${result.total} 条）`;
          return { content: [{ type: "text", text: result.links.map((ln) => `- ${ln}`).join("\n") + suffix }] };
        }
        // action === "template"
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
}
