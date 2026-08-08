import test from "node:test";
import assert from "node:assert/strict";

import {
  artworkBelongsToOperator,
  labelFromFilename,
  operatorFromFilename,
} from "../src/data/artworkMediawiki.ts";
import { downloadImageSafe, imageMagicOk, listAllimages } from "../src/api/prtsWiki.ts";

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

test("artwork ownership requires exact form match", () => {
  assert.equal(operatorFromFilename("立绘_阿米娅(近卫)_2.png"), "阿米娅(近卫)");
  assert.equal(artworkBelongsToOperator("立绘_阿米娅(近卫)_2.png", "阿米娅(近卫)"), true);
  assert.equal(artworkBelongsToOperator("立绘_阿米娅（近卫）_2.png", "阿米娅(近卫)"), true);
  assert.equal(artworkBelongsToOperator("立绘_阿米娅(近卫)_2.png", "阿米娅"), false);
  assert.equal(artworkBelongsToOperator("立绘_阿米娅(近卫)_2.png", "阿米娅(医疗)"), false);
  assert.equal(artworkBelongsToOperator("立绘_阿米娅(近卫)_2.png", "阿米"), false);
  assert.equal(artworkBelongsToOperator("立绘_斯卡蒂_2.png", "阿米娅"), false);
  assert.equal(artworkBelongsToOperator("立绘_阿米娅_2b.png", "阿米娅"), false);
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

// ---------------------------------------------------------------------------
// downloadImageSafe: in-stream rejection paths (fetch mock + Date.now override
// to neutralise rate-limit delay)
// ---------------------------------------------------------------------------

// Module-level mock clock — persists across tests so nextAllowedTime (module
// state in prtsWiki) never outruns the mock Date.now.
let _mockClock = 0;

function withMockFetch<T>(mockRes: Response, fn: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  const realDateNow = Date.now;
  if (_mockClock === 0) _mockClock = realDateNow() + 100_000;
  Date.now = () => (_mockClock += 2000); // always ahead of nextAllowedTime → 0 wait
  globalThis.fetch = (async () => mockRes) as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = realFetch;
    Date.now = realDateNow;
  });
}

function mockImageRes(body: BodyInit, opts: { url: string; contentType: string; status?: number }): Response {
  const res = new Response(body, {
    status: opts.status ?? 200,
    headers: { "content-type": opts.contentType },
  });
  Object.defineProperty(res, "url", { value: opts.url });
  return res;
}

test("downloadImageSafe rejects post-redirect scheme downgrade", async () => {
  const res = mockImageRes(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
    url: "http://evil.com/img.png",
    contentType: "image/png",
  });
  await withMockFetch(res, async () => {
    await assert.rejects(
      () => downloadImageSafe("https://media.prts.wiki/img.png"),
      /disallowed/,
    );
  });
});

test("downloadImageSafe rejects bad Content-Type", async () => {
  const res = mockImageRes(new Uint8Array([0x89, 0x50]), {
    url: "https://media.prts.wiki/img.png",
    contentType: "text/html",
  });
  await withMockFetch(res, async () => {
    await assert.rejects(
      () => downloadImageSafe("https://media.prts.wiki/img.png"),
      /content-type/,
    );
  });
});

test("downloadImageSafe rejects magic-byte mismatch", async () => {
  const res = mockImageRes(Buffer.from("notanimage"), {
    url: "https://media.prts.wiki/img.png",
    contentType: "image/png",
  });
  await withMockFetch(res, async () => {
    await assert.rejects(
      () => downloadImageSafe("https://media.prts.wiki/img.png"),
      /magic/,
    );
  });
});

test("downloadImageSafe rejects body exceeding 1 MiB cap", async () => {
  const oversized = Buffer.alloc(1024 * 1024 + 10, 0);
  Buffer.from("\x89PNG\r\n\x1a\n").copy(oversized);
  const res = mockImageRes(oversized, {
    url: "https://media.prts.wiki/img.png",
    contentType: "image/png",
  });
  await withMockFetch(res, async () => {
    await assert.rejects(
      () => downloadImageSafe("https://media.prts.wiki/img.png"),
      /exceeds/,
    );
  });
});

// ---------------------------------------------------------------------------
// listAllimages pagination
// ---------------------------------------------------------------------------

test("listAllimages paginates via continue token", async () => {
  const realFetch = globalThis.fetch;
  const realDateNow = Date.now;
  if (_mockClock === 0) _mockClock = realDateNow() + 100_000;
  Date.now = () => (_mockClock += 2000);

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const body = input.toString().includes("aicontinue")
      ? { query: { allimages: [{ name: "立绘_阿米娅_2.png", size: 200, mime: "image/png" }] } }
      : {
          query: { allimages: [{ name: "立绘_阿米娅_1.png", size: 100, mime: "image/png" }] },
          continue: { aicontinue: "立绘_阿米娅_2.png", continue: "-||" },
        };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const result = await listAllimages("立绘_阿米娅_");
    assert.equal(result.length, 2);
    assert.equal(result[0].name, "立绘_阿米娅_1.png");
    assert.equal(result[1].name, "立绘_阿米娅_2.png");
  } finally {
    globalThis.fetch = realFetch;
    Date.now = realDateNow;
  }
});
