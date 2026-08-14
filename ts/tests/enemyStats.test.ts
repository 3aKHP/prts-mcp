import test from "node:test";
import assert from "node:assert/strict";
import {
  extractEnemyStats,
  formatNumber,
  formatStats,
  mergeDefined,
  overwrittenEnemyName,
  pythonFloatString,
  stageSpecificEnemyData,
  type EnemyDbEntry,
} from "../src/data/enemyStats.ts";
import { renderHandbookCard, renderStatsBlock } from "../src/data/enemyRender.ts";
import {
  enemyRefs,
  levelPath,
  parseLevel,
  spawnCounts,
} from "../src/data/levelParser.ts";

const DB_ENTRY: EnemyDbEntry = {
  attributes: {
    maxHp: { m_defined: true, m_value: 1200 },
    atk: { m_defined: true, m_value: 250 },
    def: { m_defined: true, m_value: 80 },
    magicResistance: { m_defined: true, m_value: 10.0 },
    moveSpeed: { m_defined: true, m_value: 0.8 },
    baseAttackTime: { m_defined: true, m_value: 2.4 },
    attackSpeed: { m_defined: true, m_value: 100.0 },
    stunImmune: { m_defined: true, m_value: true },
    silenceImmune: { m_defined: true, m_value: false },
  },
  skills: [{
    prefabKey: "sk1",
    cooldown: 8,
    initCooldown: 4,
    spData: { spCost: { m_defined: true, m_value: 20 } },
    blackboard: [{ key: "atk", value: 30 }],
  }],
};

test("extractEnemyStats: exact structured dict", () => {
  assert.deepEqual(extractEnemyStats(DB_ENTRY), {
    max_hp: "1,200",
    atk: "250",
    def: "80",
    resistance: "10.0",
    move_speed: "0.8",
    attack_interval: "2.4s",
    attack_speed: null,
    mass_level: null,
    hp_recovery_per_sec: null,
    immunities: ["眩晕"],
    life_point_reduce: null,
    skills: [{
      prefab: "sk1",
      timing: "冷却 8s，初始 4s，SP 20",
      // Pre-existing PY/TS divergence: TS routes numeric blackboard values
      // through pythonFloatString (int → "30.0"); PY's f-string keeps "30".
      blackboard: "atk=30.0",
    }],
  });
});

test("extractEnemyStats: empty entry yields all-null scalars", () => {
  const stats = extractEnemyStats({});
  assert.equal(stats.max_hp, null);
  assert.deepEqual(stats.immunities, []);
  assert.deepEqual(stats.skills, []);
});

test("formatting shims (TS-only, python-parity)", () => {
  assert.equal(pythonFloatString(2), "2.0");
  assert.equal(pythonFloatString(1234.5), "1234.5");
  assert.equal(formatNumber(1234567), "1,234,567");
  assert.equal(formatNumber(999), "999");
});

test("mergeDefined: override pair applies only when defined", () => {
  assert.equal(mergeDefined(1, { m_defined: true, m_value: 2 }), 2);
  assert.equal(mergeDefined(1, { m_defined: false, m_value: 2 }), 1);
});

test("mergeDefined: nested merge skips undefined children", () => {
  const base = { atk: 5, hp: 100 };
  const override = { atk: { m_defined: false, m_value: 9 }, hp: { m_defined: true, m_value: 200 } };
  assert.deepEqual(mergeDefined(base, override), { atk: 5, hp: 200 });
});

test("stageSpecificEnemyData: exact level → level0 → overwritten fallback", () => {
  const levels: Record<string, Record<number, unknown>> = {
    e1: { 0: { attributes: { atk: 1 } }, 2: { attributes: { atk: 3 } } },
    e2: { 5: { attributes: { atk: 7 } } },
  };
  assert.deepEqual(stageSpecificEnemyData(levels, "e1", 2), { attributes: { atk: 3 } });
  assert.deepEqual(stageSpecificEnemyData(levels, "e1", 1), { attributes: { atk: 1 } });
  const ov = { attributes: { atk: 9 } };
  assert.deepEqual(stageSpecificEnemyData(levels, "missing", 0, ov), ov);
  assert.equal(stageSpecificEnemyData(levels, "missing", 0), null);
  assert.equal(stageSpecificEnemyData(null, "e1", 0), null);
});

test("overwrittenEnemyName: name → prefab → none", () => {
  assert.equal(overwrittenEnemyName({ name: "X" }), "X");
  assert.equal(overwrittenEnemyName({ prefabKey: "Y" }), "Y");
  assert.equal(overwrittenEnemyName({ name: { m_defined: true, m_value: "Z" } }), "Z");
  assert.equal(overwrittenEnemyName(null), null);
});

test("formatStats: compact summary", () => {
  const data = { attributes: {
    maxHp: { m_defined: true, m_value: 1200 },
    atk: { m_defined: true, m_value: 250 },
    def: { m_defined: true, m_value: 80 },
    magicResistance: { m_defined: true, m_value: 10.0 },
    moveSpeed: { m_defined: true, m_value: 0.8 },
    baseAttackTime: { m_defined: true, m_value: 2.4 },
  } };
  assert.equal(
    formatStats(data as { attributes?: Record<string, unknown> }),
    // Pre-existing PY/TS divergence: TS prints RES raw ("10"); PY str(10.0) → "10.0".
    "HP 1,200；ATK 250；DEF 80；RES 10；移速 0.8；攻击间隔 2.4s",
  );
  assert.equal(formatStats(null), "无数据库记录");
});

test("renderHandbookCard: includeEnemyId flag", () => {
  const entry = {
    name: "Test", enemy_id: "e1", enemy_index: "D1", level_label: "精英",
    description: "d", attack_type: "近战", ability: "a",
    damage_types_label: "物理", enemy_tags: ["t1", "t2"],
  };
  const withId = renderHandbookCard(entry, true);
  const withoutId = renderHandbookCard(entry);
  assert.ok(withId.includes("- **ID**：e1"));
  assert.ok(!withoutId.join("\n").includes("- **ID**："));
  assert.deepEqual(withId.slice(2), withoutId.slice(1));
});

test("renderStatsBlock: renders fields and skills", () => {
  const lines = renderStatsBlock(extractEnemyStats(DB_ENTRY));
  assert.equal(lines[0], "## 战斗属性");
  assert.ok(lines.some((line) => line.startsWith("- **最大生命**：")));
});

test("levelParser: levelPath / parseLevel", () => {
  assert.equal(levelPath("Level_ABC\\X"), "level_abc/x.json");
  assert.equal(parseLevel("3"), 3);
  assert.equal(parseLevel(2.7), 2);
  assert.equal(parseLevel(null), 0);
  assert.equal(parseLevel("abc"), 0);
});

test("levelParser: spawnCounts", () => {
  const level = { waves: [{ fragments: [{ actions: [
    { actionType: "SPAWN", key: "a", count: 2 },
    { actionType: 0, key: "a" },
    { actionType: "SPAWN", key: "b", count: Number("bad") },
    { actionType: "OTHER", key: "c", count: 9 },
    { actionType: "SPAWN", count: 5 },
  ] } ] } ] };
  const counts = spawnCounts(level);
  assert.equal(counts.get("a"), 3);
  assert.equal(counts.get("b"), 1);
  assert.equal(counts.has("c"), false);
});

test("levelParser: enemyRefs", () => {
  const refs = enemyRefs({ enemyDbRefs: [{ id: "e1", level: 2 }, { level: 3 }] });
  assert.deepEqual([...refs.keys()], ["e1"]);
  assert.equal(refs.get("e1")?.level, 2);
});
