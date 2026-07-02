import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function tempGamedataRoot(): string {
  return mkdtempSync(join(tmpdir(), "prts-enemy-test-"));
}

async function loadEnemyModule(): Promise<typeof import("../src/data/enemy.js")> {
  return import(`../src/data/enemy.ts?cacheBust=${Date.now()}-${Math.random()}`);
}

function loadParityFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "..", "tests", "parity-fixtures", name), "utf-8"),
  );
}

function writeFixtures(root: string, levelsRoot?: string): void {
  const excel = join(root, "zh_CN", "gamedata", "excel");
  const dbRoot = levelsRoot
    ? join(levelsRoot, "zh_CN", "gamedata", "levels", "enemydata")
    : join(root, "zh_CN", "gamedata", "levels", "enemydata");
  mkdirSync(excel, { recursive: true });
  mkdirSync(dbRoot, { recursive: true });

  for (const f of [
    "character_table.json",
    "handbook_info_table.json",
    "charword_table.json",
    "story_review_table.json",
  ]) {
    writeFileSync(join(excel, f), "{}", "utf-8");
  }

  writeFileSync(
    join(excel, "enemy_handbook_table.json"),
    JSON.stringify({
      enemyData: {
        enemy_1505_frstar: {
          enemyId: "enemy_1505_frstar",
          enemyIndex: "FN",
          name: "霜星",
          enemyLevel: "BOSS",
          sortId: 100,
          description: "整合运动法术部队干部。",
          damageType: ["MAGIC"],
          hideInHandbook: false,
        },
        enemy_1004_mslime: {
          enemyId: "enemy_1004_mslime",
          enemyIndex: "B1",
          name: "源石虫",
          enemyLevel: "NORMAL",
          sortId: 1,
          description: "野生的被感染生物。",
          damageType: ["PHYSIC", "MAGIC"],
          hideInHandbook: false,
        },
        enemy_hidden: {
          enemyId: "enemy_hidden",
          name: "隐藏敌人",
          enemyLevel: "ELITE",
          sortId: 50,
          description: "应被过滤。",
          hideInHandbook: true,
        },
      },
    }),
    "utf-8",
  );

  writeFileSync(
    join(dbRoot, "enemy_database.json"),
    JSON.stringify({
      enemies: [
        {
          Key: "enemy_1505_frstar",
          Value: [
            {
              level: 0,
              enemyData: {
                attributes: {
                  maxHp: { m_defined: true, m_value: 25000 },
                  atk: { m_defined: true, m_value: 420 },
                  def: { m_defined: true, m_value: 250 },
                  magicResistance: { m_defined: true, m_value: 50.0 },
                  moveSpeed: { m_defined: true, m_value: 0.5 },
                  baseAttackTime: { m_defined: true, m_value: 3.7 },
                  stunImmune: { m_defined: true, m_value: true },
                  frozenImmune: { m_defined: true, m_value: true },
                },
                skills: [
                  {
                    prefabKey: "ArcticBlast",
                    cooldown: 8.5,
                    blackboard: [
                      { key: "duration", value: 8.0 },
                      { key: "atk_scale", value: 1.5 },
                    ],
                  },
                ],
              },
            },
          ],
        },
      ],
    }),
    "utf-8",
  );
}

test("list_enemies default filters hidden entries", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  delete process.env["STORYJSON_PATH"];
  writeFixtures(root);
  const enemy = await loadEnemyModule();
  const out = enemy.listEnemies(null, 10);
  assert.match(out, /霜星/);
  assert.match(out, /源石虫/);
  assert.doesNotMatch(out, /隐藏敌人/);
  assert.deepEqual(enemy.buildEnemiesListing(), loadParityFixture("list_enemies.json"));
});

test("list_enemies threat_level filters", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeFixtures(root);
  const enemy = await loadEnemyModule();
  const out = enemy.listEnemies("boss", 10);
  assert.match(out, /霜星/);
  assert.doesNotMatch(out, /源石虫/);
});

test("list_enemies invalid threat_level returns error", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeFixtures(root);
  const enemy = await loadEnemyModule();
  const out = enemy.listEnemies("INVALID");
  assert.match(out, /无效的 threat_level/);
});

test("list_enemies offset beyond total returns range error", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeFixtures(root);
  const enemy = await loadEnemyModule();
  const out = enemy.listEnemies(null, 50, 999);
  assert.match(out, /超出范围/);
  assert.deepEqual(enemy.buildEnemiesListing(null, 50, 999), loadParityFixture("list_enemies_offset_empty.json"));
});

test("list_enemies invalid limit/offset", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeFixtures(root);
  const enemy = await loadEnemyModule();
  assert.match(enemy.listEnemies(null, 0), /无效的 limit/);
  assert.match(enemy.listEnemies(null, 50, -1), /无效的 offset/);
});

test("list_enemies full=true returns all without pagination hint", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeFixtures(root);
  const enemy = await loadEnemyModule();
  const out = enemy.listEnemies(null, 50, 0, true);
  assert.match(out, /霜星/);
  assert.match(out, /源石虫/);
  assert.doesNotMatch(out, /使用 offset/);
});

test("list_enemies description newline is stripped", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  const excel = join(root, "zh_CN", "gamedata", "excel");
  mkdirSync(excel, { recursive: true });
  for (const f of [
    "character_table.json",
    "handbook_info_table.json",
    "charword_table.json",
    "story_review_table.json",
  ]) {
    writeFileSync(join(excel, f), "{}", "utf-8");
  }
  writeFileSync(
    join(excel, "enemy_handbook_table.json"),
    JSON.stringify({
      enemyData: {
        e1: {
          name: "测试",
          enemyLevel: "NORMAL",
          sortId: 1,
          enemyIndex: "T1",
          description: "第一行\n第二行",
        },
      },
    }),
    "utf-8",
  );
  const enemy = await loadEnemyModule();
  const out = enemy.listEnemies(null, 5);
  for (const line of out.split("\n")) {
    if (line.startsWith("- **测试**")) {
      assert.doesNotMatch(line, /\n/);
      break;
    }
  }
});

test("get_enemy_info merges handbook and database", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeFixtures(root);
  const enemy = await loadEnemyModule();
  const out = enemy.getEnemyInfo("霜星");
  assert.match(out, /\*\*ID\*\*：enemy_1505_frstar/);
  assert.match(out, /\*\*威胁等级\*\*：领袖/);
  assert.match(out, /\*\*最大生命\*\*：25,000/);
  assert.match(out, /\*\*攻击力\*\*：420/);
  assert.match(out, /\*\*法术抗性\*\*：50/);
  assert.match(out, /\*\*免疫\*\*：眩晕、冻结/);
  assert.match(out, /ArcticBlast/);
  assert.match(out, /duration=8/);
});

test("get_enemy_info reads database from sibling levels path", async () => {
  const root = tempGamedataRoot();
  const gamedata = join(root, "gamedata");
  const levels = join(root, "gamedata-levels");
  process.env["GAMEDATA_PATH"] = gamedata;
  writeFixtures(gamedata, levels);
  const enemy = await loadEnemyModule();
  const out = enemy.getEnemyInfo("霜星");
  assert.match(out, /\*\*最大生命\*\*：25,000/);
  assert.match(out, /\*\*免疫\*\*：眩晕、冻结/);
});

test("get_enemy_info handbook-only when no database entry", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeFixtures(root);
  const enemy = await loadEnemyModule();
  const out = enemy.getEnemyInfo("源石虫");
  assert.match(out, /源石虫/);
  assert.doesNotMatch(out, /\*\*最大生命\*\*/);
  assert.deepEqual(enemy.buildEnemyInfo("源石虫"), loadParityFixture("enemy_info.json"));
});

test("get_enemy_info uses ideographic separator for damage types", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeFixtures(root);
  const enemy = await loadEnemyModule();
  const out = enemy.getEnemyInfo("源石虫");
  assert.match(out, /\*\*伤害类型\*\*：物理、法术/);
});

test("get_enemy_info unknown name", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeFixtures(root);
  const enemy = await loadEnemyModule();
  assert.match(enemy.getEnemyInfo("不存在的敌人"), /未找到敌人/);
});

test("search_enemies matches by description", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeFixtures(root);
  const enemy = await loadEnemyModule();
  const out = enemy.searchEnemies("整合运动");
  assert.match(out, /霜星/);
});

test("search_enemies no match", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeFixtures(root);
  const enemy = await loadEnemyModule();
  const out = enemy.searchEnemies("绝对不存在的关键词");
  assert.match(out, /未找到匹配/);
});

test("search_enemies invalid regex", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeFixtures(root);
  const enemy = await loadEnemyModule();
  const out = enemy.searchEnemies("[unclosed");
  assert.match(out, /正则表达式无效/);
});

test("search_enemies filters hidden", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeFixtures(root);
  const enemy = await loadEnemyModule();
  const out = enemy.searchEnemies("隐藏");
  assert.doesNotMatch(out, /应被过滤/);
});
