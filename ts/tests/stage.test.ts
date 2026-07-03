import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function tempGamedataRoot(): string {
  return mkdtempSync(join(tmpdir(), "prts-stage-test-"));
}

async function loadStageModule(): Promise<typeof import("../src/data/stage.js")> {
  return import(`../src/data/stage.ts?cacheBust=${Date.now()}-${Math.random()}`);
}

const SENTINEL_FILES = [
  "character_table.json",
  "handbook_info_table.json",
  "charword_table.json",
  "story_review_table.json",
];

function writeFixtures(root: string): void {
  const excel = join(root, "zh_CN", "gamedata", "excel");
  mkdirSync(excel, { recursive: true });

  for (const f of SENTINEL_FILES) {
    writeFileSync(join(excel, f), "{}", "utf-8");
  }

  const stages = {
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
        stageDropInfo: {
          displayRewards: [{ type: "TKT_RECRUIT", id: "7001", dropType: "ONCE" }],
        },
        unlockCondition: [],
        hardStagedId: "main_00-01#f#",
        bossMark: false,
      },
      "main_00-01#f#": {
        stageId: "main_00-01#f#",
        code: "TR-1",
        name: "坍塌·突袭",
        stageType: "MAIN",
        difficulty: "FOUR_STAR",
        zoneId: "main_0",
        levelId: "Obt/Main/level_main_00-01",
        apCost: 9,
        dangerLevel: "LV.2",
        description: "<@lv.fs>突袭条件</>：敌方生命值提升。",
        stageDropInfo: null,
        unlockCondition: [{ stageId: "main_00-01", completeState: "STAR_3" }],
        hardStagedId: null,
        bossMark: true,
      },
      "act31side_01": {
        stageId: "act31side_01",
        code: "AS-1",
        name: "测试活动关",
        stageType: "ACTIVITY",
        difficulty: "NORMAL",
        zoneId: "act31side_zone1",
        levelId: null,
        apCost: 12,
        dangerLevel: "NORMAL",
        description: "",
        unlockCondition: [{ stageId: "act31side_02", completeState: "PASS" }],
        hardStagedId: null,
        bossMark: false,
      },
      "daily_01": {
        stageId: "daily_01",
        code: "CE-5",
        name: "货物运送",
        stageType: "DAILY",
        difficulty: "NORMAL",
        zoneId: "daily_zone1",
        levelId: "Activities/Daily/level_daily_01",
        apCost: 30,
        dangerLevel: "ELITE",
        description: "高资源产出的每日关卡。",
        stageDropInfo: {
          displayRewards: [
            { type: "GOLD", dropType: "ONCE" },
            { type: "CARD_EXP", dropType: "ONCE" },
          ],
        },
        unlockCondition: [],
        hardStagedId: null,
        bossMark: false,
      },
    },
  };

  const zones = {
    zones: {
      main_0: {
        zoneID: "main_0",
        zoneNameFirst: "序章",
        zoneNameSecond: "黑暗时代·上",
      },
      act31side_zone1: {
        zoneID: "act31side_zone1",
        zoneNameFirst: "火山旅梦",
        zoneNameSecond: null,
      },
      daily_zone1: {
        zoneID: "daily_zone1",
        zoneNameFirst: null,
        zoneNameSecond: null,
      },
    },
  };

  writeFileSync(join(excel, "stage_table.json"), JSON.stringify(stages), "utf-8");
  writeFileSync(join(excel, "zone_table.json"), JSON.stringify(zones), "utf-8");
  writeFileSync(
    join(excel, "item_table.json"),
    JSON.stringify({
      items: {
        "7001": {
          itemId: "7001",
          name: "招聘许可",
          hideInItemGet: false,
          classifyType: "NORMAL",
          itemType: "TKT_RECRUIT",
        },
      },
    }),
    "utf-8",
  );
}

function loadParityFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "..", "tests", "parity-fixtures", name), "utf-8"),
  );
}

// ---------------------------------------------------------------------------
// listStages
// ---------------------------------------------------------------------------

test("listStages default returns all", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeFixtures(root);
  const stage = await loadStageModule();
  const out = stage.listStages();
  assert.match(out, /关卡列表/);
  assert.match(out, /坍塌/);
  assert.match(out, /测试活动关/);
  assert.match(out, /货物运送/);
  assert.match(out, /共 4 个/);
});

test("listStages chapter filter", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeFixtures(root);
  const stage = await loadStageModule();
  const out = stage.listStages("main_0", null, 50, 0);
  assert.match(out, /坍塌/);
  assert.match(out, /坍塌·突袭/);
  assert.doesNotMatch(out, /测试活动关/);
  assert.match(out, /共 2 个/);
});

test("listStages type filter", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeFixtures(root);
  const stage = await loadStageModule();
  const out = stage.listStages(null, "DAILY", 50, 0);
  assert.match(out, /货物运送/);
  assert.doesNotMatch(out, /坍塌/);
  assert.match(out, /共 1 个/);
});

test("listStages combined filter", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeFixtures(root);
  const stage = await loadStageModule();
  const out = stage.listStages("main_0", "MAIN", 50, 0);
  assert.match(out, /坍塌/);
  assert.match(out, /坍塌·突袭/);
  assert.doesNotMatch(out, /测试活动关/);
  assert.match(out, /共 2 个/);
});

test("listStages no match", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeFixtures(root);
  const stage = await loadStageModule();
  const out = stage.listStages("nonexistent", null, 50, 0);
  assert.match(out, /没有匹配的关卡/);
});

test("listStages invalid offset", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeFixtures(root);
  const stage = await loadStageModule();
  const out = stage.listStages(null, null, 50, -1);
  assert.match(out, /offset 必须 >= 0/);
});

test("listStages pagination hint", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeFixtures(root);
  const stage = await loadStageModule();
  const out = stage.listStages(null, null, 2, 0);
  assert.match(out, /显示第 1–2 条/);
  assert.match(out, /offset=2/);
});

test("listStages offset beyond range", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeFixtures(root);
  const stage = await loadStageModule();
  const out = stage.listStages(null, null, 50, 100);
  assert.match(out, /超出范围/);
});

test("listStages invalid type", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeFixtures(root);
  const stage = await loadStageModule();
  const out = stage.listStages(null, "INVALID");
  assert.match(out, /无效的 type/);
});

test("listStages invalid limit", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeFixtures(root);
  const stage = await loadStageModule();
  const out = stage.listStages(null, null, 0);
  assert.match(out, /limit 必须 >= 1/);
});

test("listStages max limit", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeFixtures(root);
  const stage = await loadStageModule();
  const out = stage.listStages(null, null, 201);
  assert.match(out, /limit 必须 <= 200/);
});

test("buildStagesListing matches shared parity fixture", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeFixtures(root);
  const stage = await loadStageModule();
  const data = stage.buildStagesListing();
  assert.deepStrictEqual(data, loadParityFixture("list_stages.json"));
});

test("buildStagesListing filtered payload matches shared parity fixture", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeFixtures(root);
  const stage = await loadStageModule();
  const data = stage.buildStagesListing(null, "daily");
  assert.deepStrictEqual(data, loadParityFixture("list_stages_daily.json"));
});

test("buildStagesListing page payload matches shared parity fixture", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeFixtures(root);
  const stage = await loadStageModule();
  const data = stage.buildStagesListing(null, null, 2);
  assert.deepStrictEqual(data, loadParityFixture("list_stages_page.json"));
});

test("buildStagesListing empty payload matches shared parity fixture", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeFixtures(root);
  const stage = await loadStageModule();
  const data = stage.buildStagesListing("nonexistent");
  assert.deepStrictEqual(data, loadParityFixture("list_stages_empty.json"));
  if (typeof data === "string") assert.fail(`unexpected error: ${data}`);
  const expected = "没有匹配的关卡（filter: zoneId=nonexistent）。";
  assert.equal(stage.renderStagesListing(data), expected);
  assert.equal(stage.listStages("nonexistent"), expected);
});

test("buildStagesListing offset empty payload matches shared parity fixture", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeFixtures(root);
  const stage = await loadStageModule();
  const data = stage.buildStagesListing(null, null, 50, 100);
  assert.deepStrictEqual(data, loadParityFixture("list_stages_offset_empty.json"));
  if (typeof data === "string") assert.fail(`unexpected error: ${data}`);
  const expected = "offset 100 超出范围（共 4 条）。";
  assert.equal(stage.renderStagesListing(data), expected);
  assert.equal(stage.listStages(null, null, 50, 100), expected);
});

test("listStages preserves default markdown golden", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeFixtures(root);
  const stage = await loadStageModule();
  assert.equal(
    stage.listStages(),
    [
      "# 关卡列表（共 4 个）",
      "- **测试活动关** [活动] AS-1 — 普通 — 火山旅梦（id: act31side_01）",
      "- **货物运送** [每日] CE-5 — 普通 — daily_zone1（id: daily_01）",
      "- **坍塌** [主线] 0-1 — 普通 — 序章-黑暗时代·上（id: main_00-01）",
      "- **坍塌·突袭** [主线] TR-1 — 突袭 — 序章-黑暗时代·上（id: main_00-01#f#）",
      "",
      "（显示第 1–4 条，共 4 条。使用 offset=50 查看下一页）",
    ].join("\n"),
  );
});

// ---------------------------------------------------------------------------
// getStageInfo
// ---------------------------------------------------------------------------

test("getStageInfo full info", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeFixtures(root);
  const stage = await loadStageModule();
  const out = stage.getStageInfo("main_00-01");
  assert.match(out, /坍塌/);
  assert.match(out, /0-1/);
  assert.match(out, /主线/);
  assert.match(out, /普通/);
  assert.match(out, /序章-黑暗时代·上/);
  assert.match(out, /6/);
  assert.match(out, /三点方向/);
  assert.match(out, /招聘许可（7001）/);
  assert.match(out, /无条件/);
  assert.match(out, /main_00-01#f#/);
  const data = stage.buildStageInfo("main_00-01");
  assert.deepStrictEqual(data, loadParityFixture("stage_info.json"));
  if (typeof data === "string") assert.fail(`unexpected error: ${data}`);
  assert.equal(stage.renderStageInfo(data), out);
});

test("getStageInfo four star variant strips markup", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeFixtures(root);
  const stage = await loadStageModule();
  const out = stage.getStageInfo("main_00-01#f#");
  assert.match(out, /突袭/);
  assert.match(out, /三星通关 main_00-01/);
  assert.match(out, /BOSS标记/);
  assert.doesNotMatch(out, /<@lv\.fs>/);
  assert.match(out, /突袭条件/);
});

test("getStageInfo null levelId", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeFixtures(root);
  const stage = await loadStageModule();
  const out = stage.getStageInfo("act31side_01");
  assert.match(out, /测试活动关/);
  assert.match(out, /AS-1/);
  assert.doesNotMatch(out, /关卡数据/);
});

test("getStageInfo empty description", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeFixtures(root);
  const stage = await loadStageModule();
  const out = stage.getStageInfo("act31side_01");
  assert.match(out, /无描述/);
});

test("getStageInfo empty drops", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeFixtures(root);
  const stage = await loadStageModule();
  const out = stage.getStageInfo("act31side_01");
  assert.match(out, /（无）/);
  const data = stage.buildStageInfo("act31side_01");
  if (typeof data === "string") assert.fail(`unexpected error: ${data}`);
  assert.equal(data.drop_info, null);
});

test("getStageInfo multi drops", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeFixtures(root);
  const stage = await loadStageModule();
  const out = stage.getStageInfo("daily_01");
  assert.match(out, /GOLD/);
  assert.match(out, /CARD_EXP/);
});

test("getStageInfo unknown stage", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeFixtures(root);
  const stage = await loadStageModule();
  const out = stage.getStageInfo("nonexistent");
  assert.match(out, /未找到关卡/);
});

// ---------------------------------------------------------------------------
// searchStages
// ---------------------------------------------------------------------------

test("searchStages by name", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeFixtures(root);
  const stage = await loadStageModule();
  const out = stage.searchStages("坍塌");
  assert.match(out, /坍塌/);
  assert.match(out, /坍塌·突袭/);
  assert.match(out, /搜索结果/);
});

test("searchStages by code", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeFixtures(root);
  const stage = await loadStageModule();
  const out = stage.searchStages("AS-1");
  assert.match(out, /测试活动关/);
});

test("searchStages by description", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeFixtures(root);
  const stage = await loadStageModule();
  const out = stage.searchStages("先锋");
  const data = stage.buildStageSearch("先锋");
  assert.deepStrictEqual(data, loadParityFixture("search_stages.json"));
  if (typeof data === "string") assert.fail(`unexpected error: ${data}`);
  const expected = [
    "# 搜索结果：先锋（共 1 个）",
    "",
    "## 坍塌 [主线] 0-1（id: main_00-01）",
    "- **区域**：序章-黑暗时代·上",
    "- **难度**：普通",
    "- **理智**：6",
    "- **描述**：三点方向出现了敌人的先锋部队。",
  ].join("\n");
  assert.equal(stage.renderStageSearch(data), expected);
  assert.equal(out, expected);
});

test("searchStages multiple matches", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeFixtures(root);
  const stage = await loadStageModule();
  const out = stage.searchStages(".");
  assert.match(out, /共 4 个/);
});

test("searchStages no match", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeFixtures(root);
  const stage = await loadStageModule();
  const out = stage.searchStages("ZZZZNOMATCH");
  const data = stage.buildStageSearch("ZZZZNOMATCH");
  assert.deepStrictEqual(data, loadParityFixture("search_stages_empty.json"));
  if (typeof data === "string") assert.fail(`unexpected error: ${data}`);
  const expected = "未找到匹配 'ZZZZNOMATCH' 的关卡。";
  assert.equal(stage.renderStageSearch(data), expected);
  assert.equal(out, expected);
});

test("searchStages invalid regex", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeFixtures(root);
  const stage = await loadStageModule();
  const out = stage.searchStages("[invalid");
  assert.match(out, /正则表达式无效/);
});

test("searchStages max_results cap", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeFixtures(root);
  const stage = await loadStageModule();
  const out = stage.searchStages(".", 1);
  assert.match(out, /共 1 个/);
});
