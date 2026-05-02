import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

  assert.match(operator.getOperatorArchives("阿米娅"), /阿米娅的档案文本/);
  assert.match(operator.getOperatorVoicelines("阿米娅"), /博士，今天也请多指教/);
  assert.match(operator.getOperatorBasicInfo("阿米娅"), /情绪吸收/);
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
