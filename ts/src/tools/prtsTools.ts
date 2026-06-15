/**
 * PRTS Wiki tool registrations — search, read, sections, categories, links, template.
 *
 * Split from server.ts. Exports registerPrtsTools which attaches the 6 PRTS
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
}
