/**
 * GameData tool registrations — operators, enemies, stages, items, search.
 *
 * Split from server.ts. Exports registerGamedataTools which attaches the 12
 * game-data-backed tools to a McpServer instance.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getOperatorArchives, getOperatorVoicelines, getOperatorBasicInfo } from "../data/operator.js";
import { listEnemies, getEnemyInfo, searchEnemies } from "../data/enemy.js";
import { listStages, getStageInfo, searchStages } from "../data/stage.js";
import { listItems, getItemInfo, searchItems } from "../data/item.js";
import { getStageEnemies, getEnemyAppearances, getEnemyStageInfo } from "../data/stageEnemy.js";
import { searchOperatorData } from "../data/search.js";

export function registerGamedataTools(server: McpServer): void {
  server.tool(
    "get_operator_archives",
    [
      "获取指定干员的档案资料。",
      "返回干员的客观履历、个人档案（基础档案及解锁档案）等背景故事文本。",
      "若需查询干员的职业、稀有度等数值信息，请使用 get_operator_basic_info；若需查询语音台词，请使用 get_operator_voicelines。",
    ].join(" "),
    { name: z.string().describe("干员的游戏内中文名，如「阿米娅」、「能天使」。") },
    ({ name }) => {
      const text = getOperatorArchives(name);
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
    { name: z.string().describe("干员的游戏内中文名，如「阿米娅」、「能天使」。") },
    ({ name }) => {
      const text = getOperatorVoicelines(name);
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
    { name: z.string().describe("干员的游戏内中文名，如「阿米娅」、「能天使」。") },
    ({ name }) => {
      const text = getOperatorBasicInfo(name);
      return { content: [{ type: "text", text }] };
    }
  );

  // --- Enemy tools ---

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
    [
      "获取指定敌人的详细图鉴资料。",
      "默认返回图鉴信息；若提供 stage_id，则返回该敌人在指定关卡内的等级与关卡覆盖后的战斗属性。",
    ].join(" "),
    {
      name: z.string().describe("敌人的游戏内中文名，如「源石虫」、「霜星」。"),
      stage_id: z.string().optional().describe("可选关卡 ID；设置后返回该关卡内的敌人等级/覆盖后的战斗属性。"),
    },
    ({ name, stage_id }) => ({
      content: [{ type: "text", text: stage_id ? getEnemyStageInfo(name, stage_id) : getEnemyInfo(name) }],
    })
  );

  server.tool(
    "get_stage_enemies",
    [
      "获取指定关卡实际出场的敌人列表。",
      "基于关卡 level JSON 的 SPAWN 动作统计实际出怪，并合并 enemy_database 中对应该关卡敌人等级的战斗属性。",
    ].join(" "),
    {
      stage_id: z.string().describe("关卡 ID，如 'main_00-01'（可从 list_stages 获取）。"),
    },
    ({ stage_id }) => ({ content: [{ type: "text", text: getStageEnemies(stage_id) }] })
  );

  server.tool(
    "get_enemy_appearances",
    [
      "反向查询指定敌人实际出现在哪些关卡。",
      "只统计关卡 level JSON 中 SPAWN 动作真正刷出的敌人，不把 enemyDbRefs 中未实际出场的引用计入结果。",
    ].join(" "),
    {
      name: z.string().describe("敌人的游戏内中文名或 enemyId，如「源石虫」或 enemy_1007_slime。"),
      limit: z.number().int().min(1).max(200).default(50).describe("返回数量上限，默认 50。"),
      offset: z.number().int().min(0).default(0).describe("分页偏移量，默认 0。"),
    },
    ({ name, limit, offset }) => ({
      content: [{ type: "text", text: getEnemyAppearances(name, limit, offset) }],
    })
  );

  // --- Stage tools ---

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

  // --- Item tools ---

  server.tool(
    "list_items",
    [
      "列出物品/材料列表，支持按分类过滤和分页。",
      "返回物品名称、分类、类型、稀有度、ID 和简短用途。",
      "适合查找材料、货币、凭证等 item_table 物品。",
    ].join(" "),
    {
      category: z.string().optional().describe("按物品分类过滤，如 MATERIAL（材料）、NORMAL（普通）、CONSUME（消耗品）。不填则返回全部可见物品。"),
      limit: z.number().int().min(1).max(200).default(50).describe("返回数量上限，默认 50。"),
      offset: z.number().int().min(0).default(0).describe("分页偏移量，默认 0。"),
    },
    ({ category, limit, offset }) => ({
      content: [{ type: "text", text: listItems(category ?? null, limit, offset) }],
    })
  );

  server.tool(
    "get_item_info",
    [
      "获取指定物品/材料的详细信息。",
      "返回物品的描述、用途、获取方式、掉落关卡、基建产出和商店/凭证关联等。",
    ].join(" "),
    {
      name: z.string().describe("物品中文名或 itemId，如「固源岩」、「招聘许可」或 \"30012\"。"),
    },
    ({ name }) => ({ content: [{ type: "text", text: getItemInfo(name) }] })
  );

  // --- Search tools ---

  server.tool(
    "search",
    [
      "在指定数据域中执行全文正则搜索。",
      "scope 选择搜索域：operators（干员：名称/属性/档案/语音）、enemies（敌人图鉴）、stages（关卡）、items（物品/材料）。",
      "返回带域标签的匹配结果。剧情台词搜索请用 search_stories（参数不同）。",
    ].join(" "),
    {
      scope: z.string().describe("搜索域（必填）：operators / enemies / stages / items。"),
      pattern: z.string().describe("正则表达式搜索模式，大小写不敏感。"),
      max_results: z.number().int().min(1).max(100).default(30).describe("返回结果数量上限，默认 30。"),
    },
    ({ scope, pattern, max_results }) => {
      const searchers: Record<string, (p: string, n: number) => string> = {
        operators: searchOperatorData,
        enemies: searchEnemies,
        stages: searchStages,
        items: searchItems,
      };
      const fn = searchers[scope];
      if (!fn) {
        return { content: [{ type: "text", text: `不支持的搜索域：${JSON.stringify(scope)}。可选：operators、enemies、stages、items。` }] };
      }
      return { content: [{ type: "text", text: fn(pattern, max_results) }] };
    }
  );
}
