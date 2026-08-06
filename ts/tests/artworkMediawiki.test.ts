import test from "node:test";
import assert from "node:assert/strict";

import { labelFromFilename } from "../src/data/artworkMediawiki.ts";
import { downloadImageSafe, imageMagicOk } from "../src/api/prtsWiki.ts";

const CHARINFO: Record<string, unknown> = {
  "时装1名称": "报童",
  "时装2名称": "见习联结者",
  "时装3名称": "播种者",
};

test("labelFromFilename: base / plus / building-skip / fashion / multi-form", () => {
  const cases: Record<string, string | null> = {
    "立绘_阿米娅_1.png": "精英零立绘",
    "立绘_阿米娅_1+.png": "精英零立绘（变体）",
    "立绘_阿米娅_2.png": "精英二立绘",
    "立绘_阿米娅_2b.png": null,
    "立绘_阿米娅_skin1.png": "报童",
    "立绘_阿米娅_skin2.png": "见习联结者",
    "立绘_阿米娅(近卫)_2.png": "精英二立绘（近卫）",
    "立绘_阿米娅(医疗)_skin1.png": "报童（医疗）",
    "立绘_阿米娅(近卫)_2b.png": null,
  };
  for (const [f, expected] of Object.entries(cases)) {
    assert.equal(labelFromFilename(f, CHARINFO), expected, f);
  }
});

test("labelFromFilename: fashion fallback without CharinfoV2", () => {
  assert.equal(labelFromFilename("立绘_阿米娅_skin1.png", {}), "时装 1");
  assert.equal(labelFromFilename("立绘_阿米娅_skin12.png", {}), "时装 12");
});

test("labelFromFilename: rejects non-png and malformed", () => {
  assert.equal(labelFromFilename("立绘_阿米娅_2.jpg", CHARINFO), null);
  assert.equal(labelFromFilename("立绘阿米娅", CHARINFO), null);
});

test("imageMagicOk: png/jpeg/webp signatures", () => {
  assert.equal(
    imageMagicOk(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]), "image/png"),
    true,
  );
  assert.equal(imageMagicOk(Buffer.from([0xff, 0xd8, 0xff, 0xe1]), "image/jpeg"), true);
  const webp = Buffer.alloc(12);
  webp.write("RIFF", 0);
  webp.write("WEBP", 8);
  assert.equal(imageMagicOk(webp, "image/webp"), true);
  assert.equal(imageMagicOk(Buffer.from("notanimage"), "image/png"), false);
});

test("downloadImageSafe rejects bad scheme/host before any network call", async () => {
  // http (not https) — rejected pre-stream.
  await assert.rejects(
    () => downloadImageSafe("http://media.prts.wiki/x.png"),
    /not allowed/,
  );
  // wrong host.
  await assert.rejects(
    () => downloadImageSafe("https://evil.com/x.png"),
    /not allowed/,
  );
});
