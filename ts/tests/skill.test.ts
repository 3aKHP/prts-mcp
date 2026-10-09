import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REQUIRED_OPERATOR_FILES, writeMinimalGamedata } from "./fixtures/operatorData.ts";

function tempGamedataRoot(): string {
  return mkdtempSync(join(tmpdir(), "prts-skill-test-"));
}

async function loadSkillModule(): Promise<typeof import("../src/data/skill.js")> {
  return import(`../src/data/skill.ts?cacheBust=${Date.now()}-${Math.random()}`);
}

async function loadSearchModule(): Promise<typeof import("../src/data/search.js")> {
  return import(`../src/data/search.ts?cacheBust=${Date.now()}-${Math.random()}`);
}

function loadParityFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "..", "tests", "parity-fixtures", name), "utf-8"),
  );
}

test("placeholder formats render the closed observed set", async () => {
  const { formatPlaceholderValue } = await loadSkillModule();
  // Closed format set observed across all 1795 skill_table entries in the
  // 2.8.0 scan: "", "0", "0.0", "0%", "0.0%". Unknown formats must keep the
  // literal token (fail-open against upstream format drift).
  assert.equal(formatPlaceholderValue(10.0, ""), "10");
  assert.equal(formatPlaceholderValue(2.6, ""), "2.6");
  assert.equal(formatPlaceholderValue(0.05, "0%"), "5%");
  assert.equal(formatPlaceholderValue(1.15, "0.0%"), "115.0%");
  assert.equal(formatPlaceholderValue(0.275, "0.0%"), "27.5%");
  assert.equal(formatPlaceholderValue(6.0, "0"), "6");
  assert.equal(formatPlaceholderValue(2.25, "0.0"), "2.3");
  assert.equal(formatPlaceholderValue(1.0, "F1"), null);
  assert.equal(formatPlaceholderValue(-0.125, "0%"), "-13%"); // half away from zero
  // Zero results never render as "-0" / "-0%" (PY copysign vs JS toFixed).
  assert.equal(formatPlaceholderValue(-0.3, "0"), "0");
  assert.equal(formatPlaceholderValue(-0.001, "0%"), "0%");
});

test("description substitution matrix", async () => {
  const { renderSkillDescription } = await loadSkillModule();
  const rendered = renderSkillDescription(
    "造成<@ba.vup>{atk_scale:0%}</>伤害{times}次，类型{tag}，防御力-{-def}，移速-{-move_speed:0%}，追击{zero}次，未知{ABILITY_RANGE_FORWARD_EXTEND}",
    [
      { key: "times", value: 10.0, valueStr: null },
      { key: "atk_scale", value: 2.6, valueStr: null },
      { key: "tag", value: null, valueStr: "法术" },
      { key: "def", value: -330.0, valueStr: null },
      { key: "move_speed", value: -0.35, valueStr: null },
      { key: "zero", value: 0, valueStr: null },
    ],
  );
  assert.equal(
    rendered,
    "造成260%伤害10次，类型法术，防御力-330，移速-35%，追击0次，未知{ABILITY_RANGE_FORWARD_EXTEND}",
  );
});

test("operator skills golden matches the shared parity fixture", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeMinimalGamedata(root);
  const skill = await loadSkillModule();

  const data = skill.buildOperatorSkills("阿米娅");
  assert.equal(typeof data, "object");
  assert.notEqual(data, null);
  assert.deepEqual(data, loadParityFixture("operator_skills.json"));

  // Mastery labeling, SP suffix, ammo/charge rendering, passive omission.
  const markdown = skill.renderOperatorSkills(data!);
  assert.ok(markdown.startsWith("# 阿米娅 - 战斗技能"));
  assert.ok(markdown.includes("## 战术咏唱（手动，自动回复）"));
  assert.ok(markdown.includes("- **Lv1**：攻击速度+30，持续30秒（SP 40，持续 30 秒）"));
  assert.ok(markdown.includes("- **Lv2**：攻击速度+35，持续30秒（SP 40，持续 30 秒）"));
  assert.ok(markdown.includes("- **Lv4**：攻击速度+45，持续30秒（SP 35，初始 5，持续 30 秒）"));
  assert.ok(markdown.includes("- **Lv7**：攻击速度+60，持续30秒（SP 32，初始 10，持续 30 秒）"));
  assert.ok(markdown.includes("- **专一**：攻击速度+70，持续30秒（SP 32，初始 10，持续 30 秒）"));
  assert.ok(markdown.includes("- **专二**：攻击速度+80，持续30秒（SP 32，初始 10，持续 30 秒）"));
  assert.ok(markdown.includes("- **专三**：攻击速度+90，持续30秒（SP 30，初始 15，持续 30 秒）"));
  assert.ok(markdown.includes("移动速度-35%"));
  assert.ok(markdown.includes("弹药 6 发") && markdown.includes("可充能 3 次"));
  assert.ok(markdown.includes("另有0次追击")); // falsy-but-numeric zero renders
  assert.ok(markdown.includes("## 奇美拉（被动）"));
  assert.ok(!markdown.includes("（被动，8）")); // integer spType sentinel never leaks
  assert.ok(markdown.includes("防御力-330")); // minus-key placeholder resolves
  assert.ok(!markdown.includes("持续 -1 秒")); // -1 is the no-duration sentinel
  const passiveSection = markdown.split("## 奇美拉")[1]!.split("##")[0];
  assert.ok(!passiveSection.includes("SP"));

  const missing = skill.buildOperatorSkills("不存在");
  assert.equal(missing, "未找到干员 '不存在'。请使用游戏内中文名称（如'阿米娅'）。");
});

test("skills search golden, empty, and dispatch", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeMinimalGamedata(root);
  const skill = await loadSkillModule();
  const search = await loadSearchModule();

  const routed = search.buildSearch("skills", "晕眩");
  assert.deepEqual(routed, loadParityFixture("search_skills.json"));
  assert.equal(
    skill.renderSkillSearch(routed as { scope: "skills"; pattern: string; total: number; results: unknown[] }),
    '# 搜索 "晕眩" 的结果（共 2 条）\n' +
      "- **阿米娅**｜精神爆发：伤害类型变为法术，连击6次，倍率115.0%，另有0次追击\n" +
      "- **阿米娅**｜奇美拉：被动效果：每击使敌人防御力-330，并使其晕眩2秒",
  );

  const empty = skill.buildSkillSearch("不存在");
  assert.deepEqual(empty, loadParityFixture("search_skills_empty.json"));
  assert.equal(
    skill.renderSkillSearch(empty as { scope: "skills"; pattern: string; total: number; results: unknown[] }),
    "未找到匹配 '不存在' 的干员战斗技能。",
  );

  const unsupported = search.buildSearch("no_such_scope", "x");
  assert.equal(
    unsupported,
    "不支持的搜索域：'no_such_scope'。可选：operators、enemies、stages、items、building_skills、skills。",
  );
});

test("missing skill_table degrades on both surfaces", async () => {
  // Operator data resolvable but no skill_table.json (older user-supplied
  // data root) — the dedicated tool explains the gap, the search scope
  // reports no matches instead of a data error (building_data precedent).
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  const excel = join(root, "zh_CN", "gamedata", "excel");
  mkdirSync(excel, { recursive: true });
  writeFileSync(join(excel, "character_table.json"), JSON.stringify({
    char_002_amiya: { name: "阿米娅", skills: [{ skillId: "skchr_amiya_1" }] },
  }), "utf-8");
  for (const sentinel of REQUIRED_OPERATOR_FILES.slice(1)) {
    writeFileSync(join(excel, sentinel), "{}", "utf-8");
  }
  const skill = await loadSkillModule();

  const message = skill.buildOperatorSkills("阿米娅");
  assert.equal(typeof message, "string");
  assert.ok(message.includes("战斗技能数据文件不存在"));

  const empty = skill.buildSkillSearch("晕眩");
  assert.deepEqual(empty, { scope: "skills", pattern: "晕眩", total: 0, results: [] });
});

test("wrong-shape skill_table degrades to a message", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeMinimalGamedata(root);
  const excel = join(root, "zh_CN", "gamedata", "excel");
  // Valid JSON, wrong shape: must degrade to a message, not crash.
  writeFileSync(join(excel, "skill_table.json"), "[]", "utf-8");
  const skill = await loadSkillModule();

  const message = skill.buildOperatorSkills("阿米娅");
  assert.equal(message, "skill_table.json 顶层不是 JSON 对象。");

  const search = skill.buildSkillSearch("晕眩");
  assert.equal(typeof search, "string");
  assert.ok(search.includes("skill_table.json 顶层不是 JSON 对象"));
});
