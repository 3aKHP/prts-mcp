import test from "node:test";
import assert from "node:assert/strict";

import {
  SCHEMA_VERSION,
  parseIndex,
  buildArtworkLabel,
} from "../src/data/images.ts";

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
