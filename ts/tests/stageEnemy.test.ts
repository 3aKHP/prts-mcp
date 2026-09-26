import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "prts-stage-enemy-test-"));
}

async function loadModule(): Promise<typeof import("../src/data/stageEnemy.js")> {
  return import(`../src/data/stageEnemy.ts?cacheBust=${Date.now()}-${Math.random()}`);
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data), "utf-8");
}

function writeFixture(root: string): string {
  const gamedata = join(root, "gamedata");
  const excel = join(gamedata, "zh_CN", "gamedata", "excel");
  const levels = join(root, "gamedata-levels", "zh_CN", "gamedata", "levels");
  const dbRoot = join(levels, "enemydata");
  const levelRoot = join(levels, "obt", "main");
  mkdirSync(excel, { recursive: true });
  mkdirSync(dbRoot, { recursive: true });
  mkdirSync(levelRoot, { recursive: true });

  for (const fname of [
    "character_table.json",
    "handbook_info_table.json",
    "charword_table.json",
    "story_review_table.json",
    "item_table.json",
  ]) {
    writeJson(join(excel, fname), {});
  }

  writeJson(join(excel, "stage_table.json"), {
    stages: {
      "main_00-01": {
        stageId: "main_00-01",
        code: "0-1",
        name: "坍塌",
        levelId: "Obt/Main/level_main_00-01",
      },
      empty_stage: {
        stageId: "empty_stage",
        code: "EMPTY",
        name: "空关",
        levelId: null,
      },
    },
  });
  writeJson(join(excel, "enemy_handbook_table.json"), {
    enemyData: {
      enemy_1007_slime: { enemyId: "enemy_1007_slime", name: "源石虫" },
      enemy_1002_nsabr: { enemyId: "enemy_1002_nsabr", name: "士兵" },
      enemy_unused: { enemyId: "enemy_unused", name: "未出场敌人" },
      enemy_custom: { enemyId: "enemy_custom", name: "特殊敌人" },
    },
  });
  writeJson(join(dbRoot, "enemy_database.json"), {
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
                moveSpeed: { m_defined: true, m_value: 1.0 },
                baseAttackTime: { m_defined: true, m_value: 1.7 },
              },
            },
          },
        ],
      },
      {
        Key: "enemy_1002_nsabr",
        Value: [
          {
            level: "bad",
            enemyData: {
              attributes: {
                maxHp: { m_defined: true, m_value: 1650 },
                atk: { m_defined: true, m_value: 200 },
                def: { m_defined: true, m_value: 0 },
                magicResistance: { m_defined: true, m_value: 0 },
              },
            },
          },
        ],
      },
    ],
  });
  writeJson(join(levelRoot, "level_main_00-01.json"), {
    enemyDbRefs: [
      { id: "enemy_1007_slime", level: 0, overwrittenData: null },
      {
        id: "enemy_1002_nsabr",
        level: "bad",
        overwrittenData: {
          attributes: {
            def: { m_defined: true, m_value: 30 },
            atk: { m_defined: false, m_value: 0 },
          },
        },
      },
      { id: "enemy_unused", level: 0, overwrittenData: null },
      {
        id: "enemy_custom",
        level: 0,
        overwrittenData: {
          name: { m_defined: true, m_value: "关卡特化敌人" },
          attributes: {
            maxHp: { m_defined: true, m_value: 1234 },
            atk: { m_defined: true, m_value: 321 },
            def: { m_defined: true, m_value: 45 },
            magicResistance: { m_defined: true, m_value: 10 },
          },
        },
      },
    ],
    waves: [
      {
        fragments: [
          {
            actions: [
              { actionType: "SPAWN", key: "enemy_1007_slime", count: 6 },
              { actionType: "SPAWN", key: "enemy_1002_nsabr", count: 1 },
              { actionType: "SPAWN", key: "enemy_custom", count: 1 },
            ],
          },
        ],
      },
    ],
  });
  return gamedata;
}

test("getStageEnemies uses spawn actions and overrides", async () => {
  const root = tempRoot();
  process.env["GAMEDATA_PATH"] = writeFixture(root);
  const mod = await loadModule();
  const out = mod.getStageEnemies("main_00-01");
  assert.match(out, /坍塌 0-1/);
  assert.match(out, /源石虫/);
  assert.match(out, /出场数量\*\*：6/);
  assert.match(out, /士兵/);
  assert.match(out, /出场数量\*\*：1/);
  assert.match(out, /敌人等级\*\*：0/);
  assert.match(out, /DEF 30/);
  assert.match(out, /关卡特化敌人/);
  assert.match(out, /HP 1,234/);
  assert.match(out, /ATK 321/);
  assert.doesNotMatch(out, /NaN/);
  assert.doesNotMatch(out, /未出场敌人/);
});

test("getStageEnemies reads the direct-map enemy database from current AKDP releases", async () => {
  const root = tempRoot();
  const gamedata = writeFixture(root);
  writeJson(
    join(root, "gamedata-levels", "zh_CN", "gamedata", "levels", "enemydata", "enemy_database.json"),
    {
      enemy_1007_slime: [{
        level: 0,
        enemyData: {
          attributes: {
            maxHp: { m_defined: true, m_value: 550 },
            atk: { m_defined: true, m_value: 130 },
            def: { m_defined: true, m_value: 0 },
            magicResistance: { m_defined: true, m_value: 0 },
          },
        },
      }],
    },
  );
  process.env["GAMEDATA_PATH"] = gamedata;
  const mod = await loadModule();
  const out = mod.getStageEnemies("main_00-01");
  assert.match(out, /HP 550/);
  assert.doesNotMatch(out, /无数据库记录/);
});

test("getStageEnemies keeps the fallback rendering for an empty legacy wrapper", async () => {
  const root = tempRoot();
  const gamedata = writeFixture(root);
  writeJson(
    join(root, "gamedata-levels", "zh_CN", "gamedata", "levels", "enemydata", "enemy_database.json"),
    { enemies: [] },
  );
  process.env["GAMEDATA_PATH"] = gamedata;
  const mod = await loadModule();
  const out = mod.getStageEnemies("main_00-01");
  // Enemies without a database entry keep the previous fallback rendering.
  assert.match(out, /源石虫/);
  assert.match(out, /无数据库记录/);
});

test("getEnemyAppearances", async () => {
  const root = tempRoot();
  process.env["GAMEDATA_PATH"] = writeFixture(root);
  const mod = await loadModule();
  const out = mod.getEnemyAppearances("源石虫");
  assert.match(out, /源石虫/);
  assert.match(out, /坍塌/);
  assert.match(out, /main_00-01/);
  assert.match(out, /6 个/);
});

test("getEnemyStageInfo", async () => {
  const root = tempRoot();
  process.env["GAMEDATA_PATH"] = writeFixture(root);
  const mod = await loadModule();
  const out = mod.getEnemyStageInfo("士兵", "main_00-01");
  assert.match(out, /士兵/);
  assert.match(out, /出场数量\*\*：1/);
  assert.match(out, /敌人等级\*\*：0/);
  assert.match(out, /关卡覆盖/);
  assert.match(out, /DEF 30/);
  assert.doesNotMatch(out, /NaN/);
});

test("empty or unknown stage", async () => {
  const root = tempRoot();
  process.env["GAMEDATA_PATH"] = writeFixture(root);
  const mod = await loadModule();
  assert.match(mod.getStageEnemies("empty_stage"), /没有 levelId/);
  assert.match(mod.getStageEnemies("missing"), /未找到关卡/);
});

test("missing levels data message", async () => {
  const root = tempRoot();
  const gamedata = join(root, "gamedata");
  const excel = join(gamedata, "zh_CN", "gamedata", "excel");
  mkdirSync(excel, { recursive: true });
  for (const fname of [
    "character_table.json",
    "handbook_info_table.json",
    "charword_table.json",
    "story_review_table.json",
  ]) {
    writeJson(join(excel, fname), {});
  }
  process.env["GAMEDATA_PATH"] = gamedata;
  const mod = await loadModule();
  assert.match(mod.getStageEnemies("main_00-01"), /关卡战斗数据暂不可用/);
});

// Upstream AKDP encodes empty arrays as {} empty-object placeholders;
// the readers must treat them as empty instead of throwing.
test("level json {} waves/enemyDbRefs placeholders behave as empty", async () => {
  const root = tempRoot();
  process.env["GAMEDATA_PATH"] = writeFixture(root);
  writeJson(
    join(root, "gamedata-levels", "zh_CN", "gamedata", "levels", "obt", "main", "level_main_00-01.json"),
    { enemyDbRefs: {}, waves: {} },
  );
  const mod = await loadModule();
  assert.match(mod.getStageEnemies("main_00-01"), /未解析到实际出怪/);
  assert.match(mod.getEnemyAppearances("源石虫"), /未找到.*实际出场关卡/);
});

test("level json {} fragments/actions placeholders behave as empty", async () => {
  const root = tempRoot();
  process.env["GAMEDATA_PATH"] = writeFixture(root);
  writeJson(
    join(root, "gamedata-levels", "zh_CN", "gamedata", "levels", "obt", "main", "level_main_00-01.json"),
    {
      enemyDbRefs: [{ id: "enemy_1007_slime", level: 0, overwrittenData: null }],
      waves: [{ fragments: {} }, { fragments: [{ actions: {} }] }],
    },
  );
  const mod = await loadModule();
  assert.match(mod.getStageEnemies("main_00-01"), /未解析到实际出怪/);
});

test("enemy database {} Value placeholder behaves as empty", async () => {
  const root = tempRoot();
  process.env["GAMEDATA_PATH"] = writeFixture(root);
  writeJson(
    join(root, "gamedata-levels", "zh_CN", "gamedata", "levels", "enemydata", "enemy_database.json"),
    {
      enemies: [
        { Key: "enemy_1007_slime", Value: {} },
        {
          Key: "enemy_1002_nsabr",
          Value: [
            { level: 0, enemyData: { attributes: { maxHp: { m_defined: true, m_value: 1650 } } } },
          ],
        },
      ],
    },
  );
  const mod = await loadModule();
  const out = mod.getStageEnemies("main_00-01");
  assert.match(out, /源石虫/);
  assert.match(out, /无数据库记录/);
  assert.match(out, /HP 1,650/);
});

test("enemy database {} enemies placeholder raises the descriptive format error", async () => {
  const root = tempRoot();
  process.env["GAMEDATA_PATH"] = writeFixture(root);
  writeJson(
    join(root, "gamedata-levels", "zh_CN", "gamedata", "levels", "enemydata", "enemy_database.json"),
    { enemies: {} },
  );
  const mod = await loadModule();
  // normalizeEnemyDatabase (backport of c834bfa) rejects the {} placeholder
  // with a descriptive error instead of a raw TypeError crash.
  assert.throws(() => mod.getStageEnemies("main_00-01"), /格式异常/);
});
