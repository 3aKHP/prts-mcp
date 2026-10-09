import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeMinimalGamedata } from "./fixtures/operatorData.ts";

function tempGamedataRoot(): string {
  return mkdtempSync(join(tmpdir(), "prts-operator-stats-test-"));
}

async function loadOperatorStatsModule(): Promise<typeof import("../src/data/operatorStats.js")> {
  return import(`../src/data/operatorStats.ts?cacheBust=${Date.now()}-${Math.random()}`);
}

function loadParityFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "..", "tests", "parity-fixtures", name), "utf-8"),
  );
}

test("interpolation math is hand-verified", async () => {
  const { interpolateAttributes } = await loadOperatorStatsModule();
  // Midpoint 0.5 must round AWAY from zero (JS Math.round gives 1 here, but
  // the shared formula must also hold for negatives and decimals).
  let panel = interpolateAttributes({ maxHp: 0 }, { maxHp: 1 }, 1, 0, 2);
  assert.equal(panel["maxHp"], 1);

  // Amiya E2 Lv40: 1198 + (1480-1198) * 39/79 = 1337.215... -> 1337;
  // atk 514 + 98*39/79 = 562.38 -> 562; def 110 + 11*39/79 = 115.43 -> 115.
  // Fields absent from both frames project as null.
  panel = interpolateAttributes(
    { maxHp: 1198, atk: 514, def: 110 },
    { maxHp: 1480, atk: 612, def: 121 },
    40,
    1,
    80,
  );
  assert.deepEqual(
    [panel["maxHp"], panel["atk"], panel["def"]],
    [1337, 562, 115],
  );
  assert.equal(panel["cost"], null);

  // Non-integral frames keep 2 decimals: 1.6 + 0.4*35/69 = 1.8029 -> 1.8.
  panel = interpolateAttributes({ baseAttackTime: 1.6 }, { baseAttackTime: 2.0 }, 36, 1, 70);
  assert.equal(panel["baseAttackTime"], 1.8);

  // Degenerate span (single-level frames) takes the upper frame's value.
  panel = interpolateAttributes({ maxHp: 5 }, { maxHp: 99 }, 1, 1, 1);
  assert.equal(panel["maxHp"], 99);
});

test("operator stats golden matches the shared parity fixtures", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeMinimalGamedata(root);
  const stats = await loadOperatorStatsModule();

  const overview = stats.buildOperatorStats("阿米娅");
  assert.equal(typeof overview, "object");
  assert.deepEqual(overview, loadParityFixture("operator_stats.json"));
  const markdown = stats.renderOperatorStats(overview!);
  assert.ok(markdown.startsWith("# 阿米娅 - 面板数值"));
  assert.ok(markdown.includes("## 精英2（Lv1-80）"));
  assert.ok(markdown.includes("- 生命上限：Lv1 1198 / Lv满 1480"));
  assert.ok(markdown.includes("## 满信赖加成"));
  assert.ok(markdown.includes("生命上限+200，攻击+70"));
  assert.ok(markdown.includes("## 潜能加成") && markdown.includes("- 部署费用-2"));

  const detail = stats.buildOperatorStats("阿米娅", 2, 40);
  assert.deepEqual(detail, loadParityFixture("operator_stats_level.json"));
  const detailMarkdown = stats.renderOperatorStats(detail!);
  assert.ok(detailMarkdown.includes("**精英2 Lv40**（上限 Lv80）"));
  assert.ok(detailMarkdown.includes("- 生命上限：1337"));
});

test("operator stats validates phase and level", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeMinimalGamedata(root);
  const stats = await loadOperatorStatsModule();

  assert.equal(stats.buildOperatorStats("不存在"), "未找到干员 '不存在'。请使用游戏内中文名称（如'阿米娅'）。");
  const phaseOnly = stats.buildOperatorStats("阿米娅", 2);
  assert.match(phaseOnly as string, /必须同时提供/);
  const levelOnly = stats.buildOperatorStats("阿米娅", null, 40);
  assert.match(levelOnly as string, /必须同时提供/);
  assert.equal(
    stats.buildOperatorStats("阿米娅", 3, 1),
    "phase 必须在 0..2 之间（该干员共 3 个精英阶段）。",
  );
  assert.equal(
    stats.buildOperatorStats("阿米娅", 2, 81),
    "level 必须在 1..80 之间（精英2 的等级上限为 80）。",
  );
  const e0 = stats.buildOperatorStats("阿米娅", 0, 1);
  assert.equal((e0 as { attributes: { maxHp: number } }).attributes.maxHp, 699);

  // Number.isInteger mirrors PY's isinstance(level, int): fractional
  // levels degrade at the module layer on both sides.
  const fractional = stats.buildOperatorStats("阿米娅", 2, 40.5);
  assert.match(fractional as string, /level 必须在 1\.\.80 之间/);
});

test("operator stats degrades on malformed keyframes", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeMinimalGamedata(root);
  const { readFileSync, writeFileSync, mkdirSync } = await import("node:fs");
  const excel = join(root, "zh_CN", "gamedata", "excel");
  mkdirSync(excel, { recursive: true });
  const table = JSON.parse(readFileSync(join(excel, "character_table.json"), "utf-8"));
  table.char_002_amiya.phases[2].attributesKeyFrames = [];
  writeFileSync(join(excel, "character_table.json"), JSON.stringify(table), "utf-8");
  const stats = await loadOperatorStatsModule();

  const message = stats.buildOperatorStats("阿米娅", 2, 40);
  assert.equal(message, "干员 '阿米娅' 的精英2面板关键帧缺失，数据可能损坏。");

  const overview = stats.buildOperatorStats("阿米娅");
  const emptyFrames = (overview as { phases: Array<{ keyframes: { lv1: Record<string, number | null> } }> })
    .phases[2]!.keyframes.lv1;
  // Full key set present with null values (payload parity with PY).
  assert.equal(Object.keys(emptyFrames).length, 9);
  assert.ok(Object.values(emptyFrames).every((v) => v === null));
  const markdown = stats.renderOperatorStats(overview!);
  assert.ok(markdown.includes("Lv1 None / Lv满 None"));
});
