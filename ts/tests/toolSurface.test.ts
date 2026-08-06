import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";

import { clearEnemyCaches } from "../src/data/enemy.ts";
import { clearItemCaches } from "../src/data/item.ts";
import { clearOperatorCaches } from "../src/data/operator.ts";
import { clearStageCaches } from "../src/data/stage.ts";
import { clearStageEnemyCaches } from "../src/data/stageEnemy.ts";
import { clearStoryCaches } from "../src/data/story.ts";
import { registerGamedataTools } from "../src/tools/gamedataTools.ts";
import { registerPrtsTools } from "../src/tools/prtsTools.ts";
import { registerStoryTools } from "../src/tools/storyTools.ts";
import { writeMinimalGamedata } from "./fixtures/operatorData.ts";

const EXPECTED_TOOLS = [
  "search_prts",
  "prts_page",
  "get_operator_archives",
  "get_operator_voicelines",
  "get_operator_basic_info",
  "list_enemies",
  "get_enemy_info",
  "get_stage_enemies",
  "get_enemy_appearances",
  "list_stages",
  "get_stage_info",
  "list_items",
  "get_item_info",
  "list_story_events",
  "list_stories",
  "get_story_summary",
  "read_story",
  "read_activity",
  "search",
  "search_stories",
  "get_operator_memoirs",
  "find_character_appearances",
  "find_speakers_in",
  // operator_artwork is conditionally registered (IMAGES_ENABLED=true); the
  // name is still part of the frozen source-level surface this test guards.
  "operator_artwork",
];

test("TypeScript MCP tool names are frozen", () => {
  // The tool registrations were split into modules under src/tools/.
  // Alpha hardening assumes tool names are registered as direct string literals.
  // Update this parser if tool registration moves to constants or helper wrappers.
  const toolsDir = join(import.meta.dirname, "..", "src", "tools");
  const toolFiles = readdirSync(toolsDir).filter((f) => f.endsWith(".ts"));
  const source = toolFiles
    .map((f) => readFileSync(join(toolsDir, f), "utf-8"))
    .join("\n");
  const toolNames = Array.from(source.matchAll(/server\.tool\(\s*"([^"]+)"/g), (match) => match[1]);

  // Compare as sets — tool registration order is not part of the frozen surface.
  assert.deepEqual(toolNames.sort(), [...EXPECTED_TOOLS].sort());
  assert.equal(toolNames.length, EXPECTED_TOOLS.length, "tool count mismatch");
});

type ToolHandler = (args: Record<string, unknown>) => unknown | Promise<unknown>;

class CapturingServer {
  tools = new Map<string, ToolHandler>();

  tool(name: string, _description: unknown, _schema: unknown, handler: ToolHandler): void {
    this.tools.set(name, handler);
  }
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data), "utf-8");
}

function writeInvariantGamedata(root: string): void {
  writeMinimalGamedata(root);
  const excel = join(root, "zh_CN", "gamedata", "excel");

  writeJson(join(excel, "enemy_handbook_table.json"), {
    enemyData: {
      enemy_1007_slime: {
        enemyId: "enemy_1007_slime",
        enemyIndex: "B1",
        name: "源石虫",
        enemyLevel: "NORMAL",
        sortId: 1,
        description: "野生的被感染生物。",
        damageType: ["PHYSIC"],
        hideInHandbook: false,
      },
    },
  });
  writeJson(join(excel, "stage_table.json"), {
    stages: {
      "main_00-01": {
        stageId: "main_00-01",
        code: "0-1",
        name: "坍塌",
        stageType: "MAIN",
        difficulty: "NORMAL",
        zoneId: "main_0",
        levelId: "Obt/Main/level_main_00-01",
        apCost: 6,
        dangerLevel: "LV.1",
        description: "三点方向出现了敌人的先锋部队。",
        stageDropInfo: { displayRewards: [{ type: "TKT_RECRUIT", id: "7001", dropType: "ONCE" }] },
        unlockCondition: [],
        bossMark: false,
      },
    },
  });
  writeJson(join(excel, "zone_table.json"), {
    zones: {
      main_0: {
        zoneID: "main_0",
        zoneNameFirst: "序章",
        zoneNameSecond: "黑暗时代·上",
      },
    },
  });
  writeJson(join(excel, "item_table.json"), {
    items: {
      "7001": {
        itemId: "7001",
        name: "招聘许可",
        description: "人事部颁发的许可书。",
        rarity: "TIER_4",
        iconId: "TKT_RECRUIT",
        sortId: 40012,
        usage: "可从公开渠道招聘一位干员。",
        obtainApproach: "采购中心、任务奖励",
        hideInItemGet: false,
        classifyType: "NORMAL",
        itemType: "TKT_RECRUIT",
        stageDropList: [],
      },
    },
  });

  const levels = join(root, "zh_CN", "gamedata", "levels");
  mkdirSync(join(levels, "enemydata"), { recursive: true });
  mkdirSync(join(levels, "obt", "main"), { recursive: true });
  writeJson(join(levels, "enemydata", "enemy_database.json"), {
    enemies: [
      {
        Key: "enemy_1007_slime",
        Value: [
          {
            level: 0,
            enemyData: {
              attributes: {
                maxHp: { m_defined: true, m_value: 550 },
                atk: { m_defined: true, m_value: 130 },
                def: { m_defined: true, m_value: 0 },
                magicResistance: { m_defined: true, m_value: 0 },
              },
            },
          },
        ],
      },
    ],
  });
  writeJson(join(levels, "obt", "main", "level_main_00-01.json"), {
    enemyDbRefs: [{ id: "enemy_1007_slime", level: 0, overwrittenData: null }],
    waves: [{ fragments: [{ actions: [{ actionType: "SPAWN", key: "enemy_1007_slime", count: 3 }] }] }],
  });
}

function writeInvariantStoryZip(zipPath: string): void {
  const zip = new AdmZip();
  const firstStoryKey = "activities/act_test/level_act_test_01_beg";
  const memoirStoryKey = "memory/amiya/level_amiya_01";
  const files: Record<string, unknown> = {
    "zh_CN/gamedata/excel/story_review_table.json": {
      act_test: {
        name: "测试活动",
        entryType: "ACTIVITY",
        infoUnlockDatas: [
          { storyTxt: firstStoryKey, storyCode: "TEST-1", storyName: "开端", avgTag: "BEG", storySort: 1 },
        ],
      },
      story_amiya_set_1: {
        name: "阿米娅密录",
        entryType: "NONE",
        infoUnlockDatas: [
          { storyTxt: memoirStoryKey, storyCode: "AM-1", storyName: "出发", avgTag: null, storySort: 1 },
        ],
      },
    },
    "zh_CN/chardict.json": {
      amiya: { name: "阿米娅", id: "char_002_amiya" },
    },
    "zh_CN/storyinfo.json": {
      [firstStoryKey]: "第一章梗概",
      [memoirStoryKey]: "密录梗概",
    },
    [`zh_CN/gamedata/story/${firstStoryKey}.json`]: {
      storyCode: "TEST-1",
      storyName: "开端",
      avgTag: "BEG",
      eventName: "测试活动",
      storyInfo: "第一章梗概",
      storyList: [
        { prop: "name", attributes: { name: "阿米娅", content: "你好，博士。" } },
        { prop: "name", attributes: { name: "博士", content: "我们出发吧。" } },
      ],
    },
    [`zh_CN/gamedata/story/${memoirStoryKey}.json`]: {
      storyCode: "AM-1",
      storyName: "出发",
      avgTag: null,
      eventName: "阿米娅密录",
      storyInfo: "密录梗概",
      storyList: [
        { prop: "name", attributes: { name: "阿米娅", content: "继续前进。" } },
      ],
    },
  };
  for (const [innerPath, data] of Object.entries(files)) {
    zip.addFile(innerPath, Buffer.from(JSON.stringify(data), "utf-8"));
  }
  mkdirSync(join(zipPath, ".."), { recursive: true });
  zip.writeZip(zipPath);
}

function resetCaches(): void {
  clearOperatorCaches();
  clearEnemyCaches();
  clearStageCaches();
  clearItemCaches();
  clearStageEnemyCaches();
  clearStoryCaches();
}

function mockPrtsFetch(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const list = url.searchParams.get("list");
    const prop = url.searchParams.get("prop");
    if (list === "search") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          query: {
            searchinfo: { totalhits: 1 },
            search: [{ title: "阿米娅", snippet: "罗德岛公开领袖。" }],
          },
        }),
      } as Response;
    }
    if (prop === "text") {
      return {
        ok: true,
        status: 200,
        json: async () => ({ parse: { text: { "*": "<p>阿米娅页面正文。</p>" } } }),
      } as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ parse: { sections: [{ index: "1", level: "2", line: "档案", fromtitle: "阿米娅" }] } }),
    } as Response;
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

const STRUCTURED_TOOL_ARGS: Record<string, Record<string, unknown>> = {
  get_operator_basic_info: { name: "阿米娅" },
  list_enemies: { limit: 1, offset: 0, full: false },
  get_enemy_info: { name: "源石虫" },
  get_stage_enemies: { stage_id: "main_00-01" },
  get_enemy_appearances: { name: "源石虫", limit: 10, offset: 0 },
  list_stages: { limit: 1, offset: 0 },
  get_stage_info: { stage_id: "main_00-01" },
  list_items: { limit: 1, offset: 0 },
  get_item_info: { name: "7001" },
  list_story_events: { category: "activities" },
  list_stories: { event_id: "act_test", include_summaries: true },
  search: { scope: "operators", pattern: "阿米娅", max_results: 1 },
  search_stories: { pattern: "你好" },
  search_prts: { query: "阿米娅", limit: 1, search_mode: "text", filter_technical: true },
  get_operator_memoirs: { name: "阿米娅" },
  find_character_appearances: { name: "博士", max_events: 10 },
  find_speakers_in: { event_id: "act_test" },
};

const NARRATIVE_TOOL_ARGS: Record<string, Record<string, unknown>> = {
  get_operator_archives: { name: "阿米娅" },
  get_operator_voicelines: { name: "阿米娅" },
  read_story: { story_key: "activities/act_test/level_act_test_01_beg", include_narration: true },
  read_activity: { event_id: "act_test", include_narration: true },
  get_story_summary: { story_key: "activities/act_test/level_act_test_01_beg" },
  prts_page: { page_title: "阿米娅", action: "read" },
};

async function callTool(
  server: CapturingServer,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const handler = server.tools.get(name);
  assert.ok(handler, `missing tool handler for ${name}`);
  return await handler(args) as Record<string, unknown>;
}

test("output-channel semantic invariant for structured and narrative tools", async () => {
  const invariantTools = [
    ...Object.keys(STRUCTURED_TOOL_ARGS),
    ...Object.keys(NARRATIVE_TOOL_ARGS),
  ];
  // operator_artwork is conditionally registered (IMAGES_ENABLED). Its
  // output-channel behavior is covered by python/tests/test_images.py (list/get
  // with structured/both channels), not the TS invariant suite; exclude it here.
  const invariantExpected = EXPECTED_TOOLS.filter((t) => t !== "operator_artwork");
  assert.deepEqual([...new Set(invariantTools)].sort(), [...invariantExpected].sort());
  assert.equal(new Set(invariantTools).size, invariantTools.length, "tool invariant args contain duplicates");

  const root = mkdtempSync(join(tmpdir(), "prts-tool-invariant-"));
  const storyZip = join(mkdtempSync(join(tmpdir(), "prts-tool-story-")), "zh_CN.zip");
  const oldGamedata = process.env["GAMEDATA_PATH"];
  const oldStory = process.env["STORYJSON_PATH"];
  const restoreFetch = mockPrtsFetch();
  process.env["GAMEDATA_PATH"] = root;
  process.env["STORYJSON_PATH"] = storyZip;
  writeInvariantGamedata(root);
  writeInvariantStoryZip(storyZip);
  resetCaches();

  try {
    for (const channel of ["structured", "both"] as const) {
      const server = new CapturingServer();
      registerPrtsTools(server as never, channel);
      registerGamedataTools(server as never, channel);
      registerStoryTools(server as never, channel);

      for (const [name, args] of Object.entries(STRUCTURED_TOOL_ARGS)) {
        const result = await callTool(server, name, args);
        assert.ok(result["structuredContent"], `${name} should emit structuredContent in ${channel}`);
      }

      for (const [name, args] of Object.entries(NARRATIVE_TOOL_ARGS)) {
        const result = await callTool(server, name, args);
        assert.equal(result["structuredContent"], undefined, `${name} should remain content-only in ${channel}`);
      }
    }
  } finally {
    if (oldGamedata === undefined) delete process.env["GAMEDATA_PATH"];
    else process.env["GAMEDATA_PATH"] = oldGamedata;
    if (oldStory === undefined) delete process.env["STORYJSON_PATH"];
    else process.env["STORYJSON_PATH"] = oldStory;
    restoreFetch();
    resetCaches();
  }
});
