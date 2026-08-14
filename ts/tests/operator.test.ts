import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REQUIRED_OPERATOR_FILES,
  writeMinimalGamedata,
} from "./fixtures/operatorData.ts";

function tempGamedataRoot(): string {
  return mkdtempSync(join(tmpdir(), "prts-operator-test-"));
}

async function loadOperatorModule(): Promise<typeof import("../src/data/operator.js")> {
  return import(`../src/data/operator.ts?cacheBust=${Date.now()}-${Math.random()}`);
}

function loadParityFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "..", "tests", "parity-fixtures", name), "utf-8"),
  );
}

test("same process sees data written after initial miss", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  delete process.env["STORYJSON_PATH"];
  const operator = await loadOperatorModule();

  assert.match(operator.getOperatorBasicInfo("阿米娅"), /干员数据暂不可用/);

  writeMinimalGamedata(root);

  const basic = operator.getOperatorBasicInfo("阿米娅");
  assert.match(basic, /# 阿米娅 - 干员基本信息/);
  assert.match(basic, /Amiya/);
  assert.match(basic, /术师/);
});

test("core operator tools read the shared minimal fixture", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeMinimalGamedata(root);
  const operator = await loadOperatorModule();

  assert.equal(
    operator.getOperatorArchives("阿米娅"),
    [
      "# 阿米娅 - 干员档案",
      "",
      "### 档案资料一",
      "阿米娅的档案文本。",
    ].join("\n"),
  );
  assert.equal(
    operator.getOperatorVoicelines("阿米娅"),
    [
      "# 阿米娅 - 语音记录",
      "",
      "**任命助理**: 博士，今天也请多指教。",
    ].join("\n"),
  );
  assert.equal(
    operator.getOperatorBasicInfo("阿米娅"),
    [
      "# 阿米娅 - 干员基本信息",
      "",
      "- **编号**：R001",
      "- **英文名**：Amiya",
      "- **稀有度**：5★",
      "- **职业**：术师（corecaster）",
      "- **站位**：远程",
      "- **所属**：rhodes",
      "- **招募标签**：输出、支援",
      "- **攻击属性**：法术伤害",
      "",
      "**图鉴**：罗德岛的公开领袖。",
      "",
      "> 阿米娅的信物。",
      "",
      "**获取方式**：主线获得",
      "",
      "## 天赋",
      "- **情绪吸收**：攻击回复技力",
      "",
      "## 基建技能",
      "- **合作协议**（控制中枢，精英0解锁）：进驻控制中枢时，所有贸易站订单效率+7%（同种效果取最高）",
      "- **热情**（宿舍，精英2解锁）：进驻宿舍时，恢复+0.25",
    ].join("\n"),
  );
  assert.deepStrictEqual(
    operator.buildOperatorBasicInfo("阿米娅"),
    loadParityFixture("operator_basic_info.json"),
  );
});

test("table caches can be cleared explicitly", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeMinimalGamedata(root);
  const operator = await loadOperatorModule();

  assert.match(operator.getOperatorBasicInfo("阿米娅"), /Amiya/);

  operator.clearOperatorCaches();

  assert.match(operator.getOperatorBasicInfo("阿米娅"), /Amiya/);
});

test("table caches switch when the activated generation changes", async () => {
  const root = tempGamedataRoot();
  const first = join(root, ".releases", "first");
  const second = join(root, ".releases", "second");
  writeMinimalGamedata(first);
  writeMinimalGamedata(second);
  const secondTable = join(second, "zh_CN", "gamedata", "excel", "character_table.json");
  const value = JSON.parse(readFileSync(secondTable, "utf-8")) as {
    char_002_amiya: { appellation: string };
  };
  value.char_002_amiya.appellation = "Amiya v2";
  writeFileSync(secondTable, JSON.stringify(value), "utf-8");
  const archives = join(root, "archives");
  mkdirSync(archives, { recursive: true });
  const metadata = join(archives, "extract_meta.json");
  writeFileSync(metadata, JSON.stringify({
    commit_sha: "first",
    data_root: ".releases/first",
  }), "utf-8");
  process.env["GAMEDATA_PATH"] = root;
  const operator = await loadOperatorModule();

  assert.doesNotMatch(operator.getOperatorBasicInfo("阿米娅"), /Amiya v2/);
  writeFileSync(metadata, JSON.stringify({
    commit_sha: "second",
    data_root: ".releases/second",
  }), "utf-8");
  assert.match(operator.getOperatorBasicInfo("阿米娅"), /Amiya v2/);
});

test("operator data is incomplete when a required file is not a file", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  const excel = join(root, "zh_CN", "gamedata", "excel");
  mkdirSync(excel, { recursive: true });
  for (const file of REQUIRED_OPERATOR_FILES) {
    if (file === "story_review_table.json") mkdirSync(join(excel, file));
    else writeFileSync(join(excel, file), "{}", "utf-8");
  }
  const operator = await loadOperatorModule();

  assert.match(operator.getOperatorBasicInfo("阿米娅"), /干员数据暂不可用/);
});

test("trap entry with same name does not override operator", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  delete process.env["STORYJSON_PATH"];

  const excel = join(root, "zh_CN", "gamedata", "excel");
  mkdirSync(excel, { recursive: true });
  writeFileSync(
    join(excel, "character_table.json"),
    JSON.stringify({
      char_002_amiya: { name: "阿米娅", rarity: "TIER_5", profession: "CASTER" },
      trap_999_amiya_fake: { name: "阿米娅", rarity: "TIER_1", profession: "TRAP" },
    }),
    "utf-8",
  );
  writeFileSync(
    join(excel, "handbook_info_table.json"),
    JSON.stringify({ handbookDict: { char_002_amiya: { storyTextAudio: [] } } }),
    "utf-8",
  );
  writeFileSync(
    join(excel, "charword_table.json"),
    JSON.stringify({ charWords: {} }),
    "utf-8",
  );
  writeFileSync(join(excel, "story_review_table.json"), "{}", "utf-8");

  const operator = await loadOperatorModule();
  const info = operator.getOperatorBasicInfo("阿米娅");
  assert.match(info, /5★/);
  assert.doesNotMatch(info, /TRAP/);
});
