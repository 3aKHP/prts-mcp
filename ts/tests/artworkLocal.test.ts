import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SCHEMA_VERSION } from "../src/data/images.ts";
import { clearOperatorCaches } from "../src/data/operator.ts";
import {
  charIdOf,
  getArtworkLocal,
  listArtworksLocal,
  resolveArtworkCharId,
} from "../src/data/artworkLocal.ts";
import { normalizedArtworkFormName } from "../src/data/artworkFormat.ts";

interface Fixture {
  root: string;
  gen: string;
}

function buildFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "prts-artwork-local-"));
  const excel = join(root, "gamedata", "zh_CN", "gamedata", "excel");
  const gen = join(root, "gen");
  mkdirSync(excel, { recursive: true });
  mkdirSync(gen, { recursive: true });
  for (const file of [
    "handbook_info_table.json",
    "charword_table.json",
    "story_review_table.json",
  ]) {
    writeFileSync(join(excel, file), "{}", "utf-8");
  }
  writeFileSync(join(excel, "character_table.json"), JSON.stringify({
    char_002_amiya: { name: "阿米娅" },
  }), "utf-8");
  writeFileSync(join(gen, "index.json"), JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    baselineVersion: "b1",
    currentVersion: "c1",
    shards: {},
    artworks: {
      "char_002_amiya#1": {
        kind: "base",
        shard: "chararts",
        large: { file: "amiya_1.large.png", w: 1024, h: 1100, bytes: 50, sha256: "h1" },
        preview: { file: "escape.png", w: 256, h: 275, bytes: 20, sha256: "h2" },
      },
    },
  }), "utf-8");
  writeFileSync(join(gen, "amiya_1.large.png"), "png-bytes", "utf-8");
  // Lexically contained but realpath-escaped via a symlink pointing outside.
  const secret = join(root, "secret.png");
  writeFileSync(secret, "host-secret", "utf-8");
  symlinkSync(secret, join(gen, "escape.png"));
  return { root, gen };
}

async function withGamedata<T>(fx: Fixture, fn: () => Promise<T> | T): Promise<T> {
  const saved = process.env["GAMEDATA_PATH"];
  process.env["GAMEDATA_PATH"] = join(fx.root, "gamedata");
  clearOperatorCaches();
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env["GAMEDATA_PATH"];
    else process.env["GAMEDATA_PATH"] = saved;
    clearOperatorCaches();
  }
}

test("charIdOf strips skin and variant suffixes", () => {
  assert.equal(charIdOf("char_002_amiya#1+"), "char_002_amiya");
  assert.equal(charIdOf("char_002_amiya@epoque#4"), "char_002_amiya");
});

test("form aliases resolve before the operator table", async () => {
  const fx = buildFixture();
  await withGamedata(fx, () => {
    assert.equal(normalizedArtworkFormName("阿米娅（近卫）"), "阿米娅(近卫)");
    assert.equal(resolveArtworkCharId("阿米娅(近卫)"), "char_1001_amiya2");
    assert.equal(resolveArtworkCharId("阿米娅（医疗）"), "char_1037_amiya3");
    assert.equal(resolveArtworkCharId("阿米娅"), "char_002_amiya");
    assert.equal(resolveArtworkCharId("不存在"), null);
  });
});

test("list filters by char id and renders markdown", async () => {
  const fx = buildFixture();
  await withGamedata(fx, () => {
    const outcome = listArtworksLocal("阿米娅", fx.gen);
    assert.ok(typeof outcome !== "string");
    if (typeof outcome === "string") return;
    assert.equal(outcome.data["char_id"], "char_002_amiya");
    assert.equal(outcome.data["total"], 1);
    assert.match(outcome.markdown, /char_002_amiya#1/);
  });
});

test("list returns messages for unknown operator and missing generation", async () => {
  const fx = buildFixture();
  await withGamedata(fx, () => {
    assert.match(listArtworksLocal("不存在", fx.gen), /找不到干员/);
    assert.match(listArtworksLocal("阿米娅", null), /立绘数据未就绪/);
  });
});

test("get serves contained files and rejects symlink escapes", async () => {
  const fx = buildFixture();
  await withGamedata(fx, () => {
    const served = getArtworkLocal("阿米娅", "char_002_amiya#1", "large", fx.gen);
    assert.ok(typeof served !== "string");
    if (typeof served !== "string") {
      assert.equal(served.imageB64, Buffer.from("png-bytes").toString("base64"));
      assert.equal(served.mime, "image/png");
      assert.equal(served.data["variant"], "large");
    }

    const escaped = getArtworkLocal("阿米娅", "char_002_amiya#1", "preview", fx.gen);
    assert.ok(typeof escaped === "string");
    if (typeof escaped === "string") assert.match(escaped, /图片文件缺失/);
  });
});
