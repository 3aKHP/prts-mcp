/**
 * GameData tool registrations — operators, enemies, stages, items, search.
 *
 * Split from server.ts. Exports registerGamedataTools which attaches the 12
 * game-data-backed tools to a McpServer instance.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { withActivationSnapshot } from "../activation.js";
import {
  buildOperatorBasicInfo,
  getOperatorArchives,
  getOperatorVoicelines,
  renderOperatorBasicInfo,
} from "../data/operator.js";
import {
  buildEnemiesListing,
  buildEnemyInfo,
  renderEnemiesListing,
  renderEnemyInfo,
} from "../data/enemy.js";
import {
  buildStageInfo,
  buildStagesListing,
  renderStageInfo,
  renderStagesListing,
} from "../data/stage.js";
import {
  buildItemInfo,
  buildItemsListing,
  renderItemInfo,
  renderItemsListing,
} from "../data/item.js";
import {
  buildEnemyAppearances,
  buildStageEnemies,
  getEnemyStageInfo,
  renderEnemyAppearances,
  renderStageEnemies,
} from "../data/stageEnemy.js";
import { buildSearch, renderSearch } from "../data/search.js";
import { renderResult, textResult, type OutputChannel } from "../output.js";
import { registerTool } from "./registerTool.js";

export function registerGamedataTools(server: McpServer, channel: OutputChannel = "content"): void {
  registerTool(server,
    "get_operator_archives",
    [
      "获取指定干员的档案资料。",
      "返回干员的客观履历、个人档案（基础档案及解锁档案）等背景故事文本。",
      "数值信息见 get_operator_basic_info，语音台词见 get_operator_voicelines。",
    ].join(" "),
    { name: z.string().describe("干员的游戏内中文名，如「阿米娅」、「能天使」。") },
    ({ name }) => withActivationSnapshot(() => {
      const text = getOperatorArchives(name);
      return textResult(text);
    })
  );

  registerTool(server,
    "get_operator_voicelines",
    [
      "获取指定干员的所有语音台词记录。",
      "返回触发条件（如「交谈1」、「晋升后交谈」、「信赖提升后交谈」）及对应台词文本的完整列表。",
      "背景故事与客观履历见 get_operator_archives。",
    ].join(" "),
    { name: z.string().describe("干员的游戏内中文名，如「阿米娅」、「能天使」。") },
    ({ name }) => withActivationSnapshot(() => {
      const text = getOperatorVoicelines(name);
      return textResult(text);
    })
  );

  registerTool(server,
    "get_operator_basic_info",
    [
      "获取指定干员的基本数值信息。",
      "返回干员的职业、子职业、稀有度（星级）、所属阵营、招募标签、天赋名称及描述、基建技能（设施/精英阶段解锁/效果）等结构化信息，适合快速了解干员定位。",
      "完整背景故事见 get_operator_archives。",
    ].join(" "),
    { name: z.string().describe("干员的游戏内中文名，如「阿米娅」、「能天使」。") },
    ({ name }) => withActivationSnapshot(() => {
      const data = buildOperatorBasicInfo(name);
      if (typeof data === "string") return textResult(data);
      return renderResult(
        data,
        renderOperatorBasicInfo(data),
        channel,
        `干员『${data.name}』的基本信息`,
      );
    })
  );

  // --- Enemy tools ---

  registerTool(server,
    "list_enemies",
    [
      "列出敌方图鉴，支持按威胁等级过滤和分页。",
      "默认返回前 50 条；翻页增大 offset，只看领袖/BOSS 设 threat_level=\"boss\"。",
      "图鉴共 1500+ 条目，不推荐 full=true。",
    ].join(" "),
    {
      threat_level: z.string().optional().describe("按威胁等级过滤：boss（领袖）、elite（精英）、normal（普通）。不填则返回全部。"),
      limit: z.number().int().min(1).max(200).default(50).describe("返回数量上限，默认 50。"),
      offset: z.number().int().min(0).default(0).describe("分页偏移量，默认 0。"),
      full: z.boolean().default(false).describe("返回全部敌人（忽略 limit/offset）。不推荐常规使用。"),
    },
    ({ threat_level, limit, offset, full }) => withActivationSnapshot(() => {
      const data = buildEnemiesListing(threat_level ?? null, limit, offset, full);
      if (typeof data === "string") return textResult(data);
      return renderResult(data, renderEnemiesListing(data), channel);
    })
  );

  registerTool(server,
    "get_enemy_info",
    [
      "获取指定敌人的详细图鉴资料。",
      "默认返回威胁等级、描述、攻击方式、伤害类型和特殊能力等图鉴信息。",
      "提供 stage_id 时改为返回该敌人在指定关卡内的等级与关卡覆盖后的战斗属性。",
    ].join(" "),
    {
      name: z.string().describe("敌人的游戏内中文名，如「源石虫」、「霜星」。"),
      stage_id: z.string().optional().describe("可选关卡 ID；设置后返回该关卡内的敌人等级/覆盖后的战斗属性。"),
    },
    ({ name, stage_id }) => withActivationSnapshot(() => {
      if (stage_id) return textResult(getEnemyStageInfo(name, stage_id));
      const data = buildEnemyInfo(name);
      if (typeof data === "string") return textResult(data);
      return renderResult(
        data,
        renderEnemyInfo(data),
        channel,
        `敌人『${data.name}』的图鉴`,
      );
    })
  );

  registerTool(server,
    "get_stage_enemies",
    [
      "获取指定关卡实际出场的敌人列表。",
      "只统计关卡内真正刷出的敌人，并附上其在该关卡等级下的战斗属性。",
      "反向查询某敌人出现在哪些关卡见 get_enemy_appearances。",
    ].join(" "),
    {
      stage_id: z.string().describe("关卡 ID，如 'main_00-01'（可从 list_stages 获取）。"),
    },
    ({ stage_id }) => withActivationSnapshot(() => {
      const data = buildStageEnemies(stage_id);
      if (typeof data === "string") return textResult(data);
      return renderResult(
        data,
        renderStageEnemies(data),
        channel,
        `${data.stage_label} 的敌人列表（共 ${data.total} 种）`,
      );
    })
  );

  registerTool(server,
    "get_enemy_appearances",
    [
      "反向查询指定敌人实际出现在哪些关卡。",
      "只统计该敌人真正刷出的关卡，不计入引用但未实际出场的关卡。",
    ].join(" "),
    {
      name: z.string().describe("敌人的游戏内中文名或 enemyId，如「源石虫」或 enemy_1007_slime。"),
      limit: z.number().int().min(1).max(200).default(50).describe("返回数量上限，默认 50。"),
      offset: z.number().int().min(0).default(0).describe("分页偏移量，默认 0。"),
    },
    ({ name, limit, offset }) => withActivationSnapshot(() => {
      const data = buildEnemyAppearances(name, limit, offset);
      if (typeof data === "string") return textResult(data);
      return renderResult(data, renderEnemyAppearances(data), channel);
    })
  );

  // --- Stage tools ---

  registerTool(server,
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
    ({ chapter, type, limit, offset }) => withActivationSnapshot(() => {
      const data = buildStagesListing(chapter ?? null, type ?? null, limit, offset);
      if (typeof data === "string") return textResult(data);
      const markdown = renderStagesListing(data);
      return renderResult(data, markdown, channel);
    })
  );

  registerTool(server,
    "get_stage_info",
    "获取指定关卡的详细信息。返回关卡的编号、类型、难度、所属区域、理智消耗、掉落奖励、解锁条件等。关卡实际出场的敌人见 get_stage_enemies。",
    { stage_id: z.string().describe("关卡 ID，如 'main_00-01'（可从 list_stages 获取）。") },
    ({ stage_id }) => withActivationSnapshot(() => {
      const data = buildStageInfo(stage_id);
      if (typeof data === "string") return textResult(data);
      return renderResult(
        data,
        renderStageInfo(data),
        channel,
        `关卡『${data.name}』的详情`,
      );
    })
  );

  // --- Item tools ---

  registerTool(server,
    "list_items",
    [
      "列出物品/材料列表，支持按分类过滤和分页。",
      "返回每个物品的名称、分类、类型、稀有度、ID 和简短用途，适合查找材料、货币、凭证等。",
    ].join(" "),
    {
      category: z.string().optional().describe("按物品分类过滤，如 MATERIAL（材料）、NORMAL（普通）、CONSUME（消耗品）。不填则返回全部可见物品。"),
      limit: z.number().int().min(1).max(200).default(50).describe("返回数量上限，默认 50。"),
      offset: z.number().int().min(0).default(0).describe("分页偏移量，默认 0。"),
    },
    ({ category, limit, offset }) => withActivationSnapshot(() => {
      const data = buildItemsListing(category ?? null, limit, offset);
      if (typeof data === "string") return textResult(data);
      return renderResult(data, renderItemsListing(data), channel);
    })
  );

  registerTool(server,
    "get_item_info",
    [
      "获取指定物品/材料的详细信息。",
      "返回物品的描述、用途、获取方式、掉落关卡、基建产出和商店/凭证关联等。",
    ].join(" "),
    {
      name: z.string().describe("物品中文名或 itemId，如「固源岩」、「招聘许可」或 \"30012\"。"),
    },
    ({ name }) => withActivationSnapshot(() => {
      const data = buildItemInfo(name);
      if (typeof data === "string") return textResult(data);
      return renderResult(
        data,
        renderItemInfo(data),
        channel,
        `物品『${data.name}』的详情`,
      );
    })
  );

  // --- Search tools ---

  registerTool(server,
    "search",
    [
      "在指定数据域中执行全文正则搜索。",
      "scope 选择搜索域：operators（名称/属性/档案/语音）、enemies（图鉴）、stages（关卡）、items（物品/材料）、building_skills（干员基建技能，可按设施/效果/技能名跨干员反查）。",
      "返回带域标签的匹配结果。剧情台词搜索见 search_stories。",
    ].join(" "),
    {
      scope: z.enum(["operators", "enemies", "stages", "items", "building_skills"]).describe("搜索域（必填）：operators / enemies / stages / items / building_skills。"),
      pattern: z.string().describe("正则表达式搜索模式，大小写不敏感。"),
      max_results: z.number().int().min(1).max(100).default(30).describe("返回结果数量上限，默认 30。"),
    },
    ({ scope, pattern, max_results }) => withActivationSnapshot(() => {
      const data = buildSearch(scope, pattern, max_results);
      if (typeof data === "string") return textResult(data);
      return renderResult(data, renderSearch(data), channel);
    })
  );
}
