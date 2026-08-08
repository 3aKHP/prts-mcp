import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clearOperatorCaches } from "../src/data/operator.ts";
import {
  SCHEMA_VERSION,
  parseIndex,
  buildArtworkLabel,
} from "../src/data/images.ts";
import { registerArtworkTools } from "../src/tools/artworkTools.ts";

type ToolHandler = (args: Record<string, unknown>) => unknown | Promise<unknown>;

class CapturingServer {
  handler: ToolHandler | undefined;

  registerTool(_name: string, _config: unknown, handler: ToolHandler): void {
    this.handler = handler;
  }
}

function sampleIndex(): unknown {
  return {
    schemaVersion: SCHEMA_VERSION,
    baselineVersion: "b1",
    currentVersion: "c1",
    shards: { "chararts-large": "chararts-large.zip" },
    artworks: {
      "char_002_amiya#1": {
        kind: "base",
        shard: "chararts",
        large: { file: "amiya_1.large.png", w: 1024, h: 1100, bytes: 50, sha256: "h1" },
        preview: { file: "amiya_1.preview.png", w: 256, h: 275, bytes: 20, sha256: "h2" },
      },
      "char_002_amiya@winter#1": {
        kind: "skin",
        shard: "skinpack",
        large: { file: "amiya_winter.large.png", w: 1024, h: 1024, bytes: 60, sha256: "h3" },
      },
    },
  };
}

test("parseIndex accepts valid schema", () => {
  const idx = parseIndex(sampleIndex());
  assert.ok(idx !== null);
  if (idx === null) return;
  assert.equal(idx.baselineVersion, "b1");
  assert.equal(idx.currentVersion, "c1");
  assert.equal(idx.shards["chararts-large"], "chararts-large.zip");
  const entry = idx.artworks["char_002_amiya#1"];
  assert.ok(entry);
  assert.equal(entry.kind, "base");
  assert.equal(entry.shard, "chararts");
  assert.equal(entry.variants.large?.file, "amiya_1.large.png");
  assert.equal(entry.variants.original, undefined);
});

test("parseIndex rejects unknown schema", () => {
  assert.equal(parseIndex({ schemaVersion: "other" }), null);
});

test("parseIndex skips artworks without variants", () => {
  const raw = sampleIndex() as Record<string, unknown>;
  const artworks = raw["artworks"] as Record<string, unknown>;
  artworks["char_002_amiya#2"] = { kind: "base", shard: "chararts" };
  const idx = parseIndex(raw);
  assert.ok(idx !== null);
  if (idx !== null) {
    assert.equal(idx.artworks["char_002_amiya#2"], undefined);
  }
});

test("buildArtworkLabel covers base, plus, fashion and unknown shapes", () => {
  const charSkins = {
    "char_002_amiya@winter#1": { displaySkin: { skinName: "报童" } },
  };
  assert.equal(buildArtworkLabel("char_002_amiya#1", charSkins), "精英零立绘");
  assert.equal(buildArtworkLabel("char_002_amiya#1+", charSkins), "精英零立绘（变体）");
  assert.equal(buildArtworkLabel("char_002_amiya#2", charSkins), "精英二立绘");
  assert.equal(buildArtworkLabel("char_002_amiya@winter#1", charSkins), "报童");
  // Unknown fashion theme falls back to a theme-derived placeholder.
  assert.equal(buildArtworkLabel("char_002_amiya@unknown#1", charSkins), "时装（unknown）");
  // Unknown base illust number gets a tolerant label.
  assert.equal(buildArtworkLabel("char_002_amiya#5", charSkins), "立绘 5");
});

test("operator_artwork rejects cross-operator tokens before local reads or MediaWiki requests", async () => {
  const root = mkdtempSync(join(tmpdir(), "prts-artwork-owner-"));
  const excel = join(root, "gamedata", "zh_CN", "gamedata", "excel");
  const imageRoot = join(root, "images");
  const generation = join(imageRoot, ".releases", "test");
  mkdirSync(excel, { recursive: true });
  mkdirSync(generation, { recursive: true });
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
  writeFileSync(join(imageRoot, ".images_meta.json"), JSON.stringify({
    generation_root: ".releases/test",
  }), "utf-8");
  writeFileSync(join(generation, "index.json"), JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    baselineVersion: "b1",
    currentVersion: "c1",
    shards: {},
    artworks: {
      "char_263_skadi#1": {
        kind: "base",
        shard: "chararts",
        large: { file: "not-read.png", w: 1, h: 1, bytes: 1, sha256: "x" },
      },
    },
  }), "utf-8");

  const savedEnv = {
    gamedata: process.env["GAMEDATA_PATH"],
    imageDir: process.env["PRTS_IMAGE_DIR"],
    localImage: process.env["LOCAL_IMAGE"],
  };
  const originalFetch = globalThis.fetch;
  process.env["GAMEDATA_PATH"] = join(root, "gamedata");
  process.env["PRTS_IMAGE_DIR"] = imageRoot;
  process.env["LOCAL_IMAGE"] = "true";
  clearOperatorCaches();

  try {
    const server = new CapturingServer();
    registerArtworkTools(server as never);
    assert.ok(server.handler);
    const local = await server.handler({
      operator_name: "阿米娅",
      action: "get",
      artwork_id: "char_263_skadi#1",
      variant: "large",
    }) as { content: Array<{ type: string; text?: string }> };
    assert.match(local.content[0]?.text ?? "", /不属于/);
    assert.equal(local.content.some((block) => block.type === "image"), false);

    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      throw new Error("MediaWiki request must not be made");
    }) as typeof fetch;
    process.env["LOCAL_IMAGE"] = "false";
    const mediawiki = await server.handler({
      operator_name: "阿米娅",
      action: "get",
      artwork_id: "立绘_斯卡蒂_2.png",
      variant: "large",
    }) as { content: Array<{ type: string; text?: string }> };
    assert.match(mediawiki.content[0]?.text ?? "", /不属于/);
    assert.equal(mediawiki.content.some((block) => block.type === "image"), false);
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries({
      GAMEDATA_PATH: savedEnv.gamedata,
      PRTS_IMAGE_DIR: savedEnv.imageDir,
      LOCAL_IMAGE: savedEnv.localImage,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    clearOperatorCaches();
  }
});
