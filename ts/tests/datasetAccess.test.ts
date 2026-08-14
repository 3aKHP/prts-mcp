import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetActivationForTesting } from "../src/activation.js";
import {
  defineDataset,
  datasetRegistry,
  registryStats,
  excelStore,
  levelsStore,
  type DatasetSpec,
} from "../src/data/datasetAccess.ts";
import { mValue } from "../src/data/gamedataAttrs.ts";
import {
  excelMissingMessage,
  levelsMissingMessage,
  validateBounds,
  regexErrorMessage,
} from "../src/data/messages.ts";
import { writeMinimalGamedata } from "./fixtures/operatorData.ts";

function withEnv(env: Record<string, string | undefined>, run: () => void): void {
  const original = { ...process.env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    run();
  } finally {
    process.env = original;
  }
}

function makeSpec(name: string, load: () => unknown, onError?: "cacheFailure" | "null" | "empty"): DatasetSpec {
  return { name, loaders: { value: { load, ...(onError ? { onError } : {}) } } };
}

test("registry: re-registration replaces and keeps position", () => {
  const first = defineDataset(makeSpec("test_registry_domain", () => 1));
  assert.equal(datasetRegistry().get("test_registry_domain"), first);
  const names = [...datasetRegistry().keys()];
  const position = names.indexOf("test_registry_domain");
  const second = defineDataset(makeSpec("test_registry_domain", () => 2));
  assert.equal(datasetRegistry().get("test_registry_domain"), second);
  assert.equal([...datasetRegistry().keys()].indexOf("test_registry_domain"), position);
});

test("registry: registryStats reflects replacement", () => {
  defineDataset({
    name: "test_stats_domain",
    loaders: { value: { load: (): Record<string, number> => ({ a: 1, b: 2 }) } },
  });
  const access = datasetRegistry().get("test_stats_domain")!;
  access.loader("value")();
  assert.deepEqual(registryStats()["test_stats_domain"].value, {
    loaded: true, count: 2, hits: 0, misses: 1, clears: 0,
  });
});

test("onError throw retries after failure (data appears mid-process)", async () => {
  __resetActivationForTesting();
  const root = mkdtempSync(join(tmpdir(), "prts-dsaccess-throw-"));
  const file = join(root, "data.json");
  let load: () => string;
  load = () => {
    if (!existsSync(file)) throw new Error("ENOENT");
    return "hello";
  };
  const access = defineDataset(makeSpec("test_throw_domain", load));
  const cached = access.loader<string>("value");
  assert.throws(() => cached(), /ENOENT/);
  writeFileSync(file, "hello", "utf-8");
  assert.equal(cached(), "hello");
});

test("onError cacheFailure is sticky with the same exception until clear", () => {
  __resetActivationForTesting();
  let calls = 0;
  const access = defineDataset(
    makeSpec("test_sticky_domain", () => {
      calls += 1;
      throw new Error("boom");
    }, "cacheFailure"),
  );
  const cached = access.loader("value");
  assert.throws(() => cached(), /boom/);
  assert.throws(() => cached(), /boom/);
  assert.equal(calls, 1);
  access.clear();
  assert.throws(() => cached(), /boom/);
  assert.equal(calls, 2);
});

test("onError null and empty cache fallback values", () => {
  __resetActivationForTesting();
  const boom = (): never => { throw new Error("missing"); };
  const nullAccess = defineDataset(makeSpec("test_null_domain", boom, "null"));
  assert.equal(nullAccess.loader("value")(), null);
  const emptyAccess = defineDataset(makeSpec("test_empty_domain", boom, "empty"));
  assert.deepEqual(emptyAccess.loader<Record<string, never>>("value")(), {});
});

test("a loaded null snapshots as not-loaded, mirroring python cache_stat", () => {
  __resetActivationForTesting();
  // Absence expressed by load() returning null (stage zone_table pattern).
  const access = defineDataset({
    name: "test_loaded_null_domain",
    loaders: { value: { load: (): null => null } },
  });
  access.loader("value")();
  assert.deepEqual(access.stats().value.loaded, false);
  assert.deepEqual(access.stats().value.count, 0);
});

test("spec hooks: available / missingMessage / onClear", () => {
  __resetActivationForTesting();
  let cleared = 0;
  const access = defineDataset({
    name: "test_hook_domain",
    loaders: { value: { load: () => 1 } },
    available: () => false,
    missingMessage: () => "缺数据",
    onClear: () => { cleared += 1; },
  });
  assert.equal(access.available(), false);
  assert.equal(access.missingMessage(), "缺数据");
  access.clear();
  assert.equal(cleared, 1);
});

test("cacheBust re-import: fresh module registry is isolated", async () => {
  defineDataset(makeSpec("test_bust_before_domain", () => 1));
  const fresh = await import(
    `../src/data/datasetAccess.ts?cacheBust=${Date.now()}-${Math.random()}`
  ) as typeof import("../src/data/datasetAccess.ts");
  assert.equal(fresh.datasetRegistry().has("test_bust_before_domain"), false);
  const access = fresh.defineDataset(makeSpec("test_bust_fresh_domain", () => 2));
  access.loader("value")();
  assert.deepEqual(fresh.registryStats()["test_bust_fresh_domain"].value.count, 1);
});

test("excelStore roots at effective excel path", () => {
  const root = mkdtempSync(join(tmpdir(), "prts-dsaccess-excel-"));
  writeMinimalGamedata(root);
  withEnv({ GAMEDATA_PATH: root, STORYJSON_PATH: undefined, PRTS_MCP_ROOT: undefined }, () => {
    const store = excelStore();
    assert.equal(store.root, join(root, "zh_CN", "gamedata", "excel"));
  });
});

test("levelsStore roots at <levels>/zh_CN/gamedata/levels", () => {
  const root = mkdtempSync(join(tmpdir(), "prts-dsaccess-levels-"));
  const enemydata = join(root, "zh_CN", "gamedata", "levels", "enemydata");
  mkdirSync(enemydata, { recursive: true });
  writeFileSync(join(enemydata, "enemy_database.json"), "{}", "utf-8");
  withEnv({ GAMEDATA_PATH: root, STORYJSON_PATH: undefined, PRTS_MCP_ROOT: undefined }, () => {
    const store = levelsStore();
    assert.equal(store.root, join(root, "zh_CN", "gamedata", "levels"));
  });
});

test("mValue unwraps and falls back (parity with python)", () => {
  assert.equal(mValue({ m_defined: true, m_value: 42 }), 42);
  assert.equal(mValue({ m_defined: false, m_value: 42 }), 42);
  assert.equal(mValue(7), 7);
  assert.equal(mValue(null, "d"), "d");
});

test("messages: canonical families and bounds strings", () => {
  const root = mkdtempSync(join(tmpdir(), "prts-dsaccess-msg-"));
  writeMinimalGamedata(root);
  withEnv({ GAMEDATA_PATH: root, STORYJSON_PATH: undefined, PRTS_MCP_ROOT: undefined }, () => {
    const message = excelMissingMessage("物品")();
    assert.ok(message.startsWith("物品数据暂不可用。"));
    assert.ok(message.includes("GITHUB_TOKEN"));
    assert.ok(message.includes(join(root, "zh_CN", "gamedata", "excel")));
  });
  const levelsRoot = mkdtempSync(join(tmpdir(), "prts-dsaccess-lmsg-"));
  const enemydata = join(levelsRoot, "zh_CN", "gamedata", "levels", "enemydata");
  mkdirSync(enemydata, { recursive: true });
  writeFileSync(join(enemydata, "enemy_database.json"), "{}", "utf-8");
  withEnv({ GAMEDATA_PATH: levelsRoot, STORYJSON_PATH: undefined, PRTS_MCP_ROOT: undefined }, () => {
    const message = levelsMissingMessage("关卡战斗")();
    assert.ok(message.startsWith("关卡战斗数据暂不可用。"));
    assert.ok(message.includes("zh_CN-levels.zip"));
    assert.ok(message.includes(levelsRoot));
  });

  assert.equal(validateBounds("limit", 0, { minimum: 1 }), "limit 必须 >= 1。");
  assert.equal(validateBounds("limit", 201, { maximum: 200 }), "limit 必须 <= 200。");
  assert.equal(validateBounds("offset", -1, { minimum: 0 }), "offset 必须 >= 0。");
  assert.equal(validateBounds("limit", 50, { minimum: 1, maximum: 200 }), null);
  assert.equal(regexErrorMessage(new Error("bad")), "正则表达式无效：bad");
});
