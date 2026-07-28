import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

test("activation snapshot keeps a tool call on one generation", async () => {
  const root = tempRoot();
  const custom = join(root, "gamedata");
  const archives = join(custom, "archives");
  mkdirSync(archives, { recursive: true });
  for (const generation of ["first", "second"]) {
    const excel = join(custom, ".releases", generation, "zh_CN", "gamedata", "excel");
    mkdirSync(excel, { recursive: true });
    for (const name of [
      "character_table.json",
      "handbook_info_table.json",
      "charword_table.json",
      "story_review_table.json",
    ]) writeFileSync(join(excel, name), "{}", "utf-8");
  }
  const metadata = join(archives, "extract_meta.json");
  const activate = (generation: string): void => {
    const tmp = join(archives, `${generation}.tmp`);
    writeFileSync(tmp, JSON.stringify({
      commit_sha: generation,
      data_root: `.releases/${generation}`,
    }), "utf-8");
    renameSync(tmp, metadata);
  };
  activate("first");
  process.env["GAMEDATA_PATH"] = custom;
  try {
    const { loadConfig, withActivationSnapshot } = await loadConfigModule();
    const roots = withActivationSnapshot(() => {
      const first = loadConfig().effectiveExcelPath;
      activate("second");
      return [first, loadConfig().effectiveExcelPath];
    });

    assert.equal(roots[0], roots[1]);
    assert.equal(roots[0], join(custom, ".releases", "first", "zh_CN", "gamedata", "excel"));
    assert.equal(
      loadConfig().effectiveExcelPath,
      join(custom, ".releases", "second", "zh_CN", "gamedata", "excel"),
    );
  } finally {
    delete process.env["GAMEDATA_PATH"];
  }
});

test("activated release symlink cannot escape the configured root", async () => {
  const root = tempRoot();
  const custom = join(root, "gamedata");
  const outside = join(root, "outside");
  const excel = join(outside, "zh_CN", "gamedata", "excel");
  mkdirSync(excel, { recursive: true });
  for (const name of [
    "character_table.json",
    "handbook_info_table.json",
    "charword_table.json",
    "story_review_table.json",
  ]) writeFileSync(join(excel, name), "{}", "utf-8");
  const archives = join(custom, "archives");
  mkdirSync(join(custom, ".releases"), { recursive: true });
  mkdirSync(archives);
  symlinkSync(outside, join(custom, ".releases", "escaped"), "dir");
  writeFileSync(
    join(archives, "extract_meta.json"),
    JSON.stringify({ commit_sha: "escaped", data_root: ".releases/escaped" }),
    "utf-8",
  );
  process.env["GAMEDATA_PATH"] = custom;
  try {
    const { loadConfig } = await loadConfigModule();
    assert.notEqual(loadConfig().effectiveExcelPath, excel);
  } finally {
    delete process.env["GAMEDATA_PATH"];
  }
});
