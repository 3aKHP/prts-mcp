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

test("SESSION_IDLE_TIMEOUT_MS parsing is strict-decimal", async () => {
  const cases: Array<[string | undefined, number]> = [
    [undefined, 86_400_000], // unset → 24h default
    ["2000", 2000],
    [" 2000 ", 2000],
    ["1e3", 1000],
    ["250.5", 250.5],
    // Invalid or <= 0 disables, including spellings that Number() would
    // otherwise accept (hex/binary/octal literals, numeric separators).
    ["0", -1],
    ["-5", -1],
    ["abc", -1],
    ["", -1],
    ["Infinity", -1],
    ["1e400", -1],
    ["nan", -1],
    ["0x10", -1],
    ["0b101", -1],
    ["0o17", -1],
    ["1_000", -1],
    // Unicode digits must be rejected too, not passed through to Number().
    ["２０００", -1],
    ["٢٠٠٠", -1],
  ];
  try {
    for (const [raw, expected] of cases) {
      if (raw === undefined) delete process.env["SESSION_IDLE_TIMEOUT_MS"];
      else process.env["SESSION_IDLE_TIMEOUT_MS"] = raw;
      const mod = await loadConfigModule();
      assert.equal(mod.SESSION_IDLE_TIMEOUT_MS, expected, `input ${JSON.stringify(raw)}`);
    }
  } finally {
    delete process.env["SESSION_IDLE_TIMEOUT_MS"];
  }
});
