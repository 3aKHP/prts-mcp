import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function loadConfigModule(): Promise<typeof import("../src/config.js")> {
  return import(`../src/config.ts?cacheBust=${Date.now()}-${Math.random()}`);
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "prts-config-test-"));
}

test("custom GAMEDATA_PATH uses embedded levels when present", async () => {
  const root = tempRoot();
  const custom = join(root, "custom");
  const enemyDb = join(custom, "zh_CN", "gamedata", "levels", "enemydata", "enemy_database.json");
  mkdirSync(join(custom, "zh_CN", "gamedata", "levels", "enemydata"), { recursive: true });
  writeFileSync(enemyDb, "{}", "utf-8");

  process.env["GAMEDATA_PATH"] = custom;
  process.env["PRTS_MCP_ROOT"] = "/app";
  try {
    const { loadConfig, hasLevelsData } = await loadConfigModule();
    const cfg = loadConfig();

    assert.equal(cfg.levelsPath, custom);
    assert.equal(cfg.effectiveLevelsPath, custom);
    assert.equal(hasLevelsData(cfg), true);
  } finally {
    delete process.env["GAMEDATA_PATH"];
    delete process.env["PRTS_MCP_ROOT"];
  }
});

test("custom GAMEDATA_PATH without embedded levels uses sibling path", async () => {
  const root = tempRoot();
  const custom = join(root, "custom");

  process.env["GAMEDATA_PATH"] = custom;
  process.env["PRTS_MCP_ROOT"] = "/app";
  try {
    const { loadConfig, hasLevelsData } = await loadConfigModule();
    const cfg = loadConfig();

    assert.equal(cfg.levelsPath, join(root, "gamedata-levels"));
    assert.equal(cfg.effectiveLevelsPath, null);
    assert.equal(hasLevelsData(cfg), false);
  } finally {
    delete process.env["GAMEDATA_PATH"];
    delete process.env["PRTS_MCP_ROOT"];
  }
});

test("effective excel path uses the activated release tree", async () => {
  const root = tempRoot();
  const custom = join(root, "gamedata");
  const activated = join(custom, ".releases", "abc123");
  const excel = join(activated, "zh_CN", "gamedata", "excel");
  mkdirSync(excel, { recursive: true });
  for (const name of [
    "character_table.json",
    "handbook_info_table.json",
    "charword_table.json",
    "story_review_table.json",
  ]) {
    writeFileSync(join(excel, name), "{}", "utf-8");
  }
  const archives = join(custom, "archives");
  mkdirSync(archives, { recursive: true });
  writeFileSync(join(archives, "extract_meta.json"), JSON.stringify({
    commit_sha: "abc123",
    data_root: ".releases/abc123",
  }), "utf-8");

  process.env["GAMEDATA_PATH"] = custom;
  try {
    const { loadConfig } = await loadConfigModule();
    const cfg = loadConfig();

    assert.equal(cfg.excelPath, join(custom, "zh_CN", "gamedata", "excel"));
    assert.equal(cfg.effectiveExcelPath, excel);
  } finally {
    delete process.env["GAMEDATA_PATH"];
  }
});
