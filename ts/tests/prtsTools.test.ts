import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { buildPrtsSearch, renderPrtsSearch } from "../src/tools/prtsTools.ts";

function loadParityFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "..", "tests", "parity-fixtures", name), "utf-8"),
  );
}

function mockFetch(payload: unknown): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => payload,
  })) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test("buildPrtsSearch payload matches shared parity fixture", async () => {
  const restore = mockFetch({
    query: {
      searchinfo: { totalhits: 9 },
      search: [{ title: "阿米娅", snippet: "罗德岛公开领袖。" }],
    },
  });
  try {
    const data = await buildPrtsSearch("阿米娅", 1);
    assert.deepStrictEqual(data, loadParityFixture("search_prts.json"));
    if (typeof data === "string") assert.fail(`unexpected error: ${data}`);
    assert.equal(
      renderPrtsSearch(data),
      "# 搜索 \"阿米娅\"（共 9 条匹配）\n**阿米娅**\n罗德岛公开领袖。",
    );
  } finally {
    restore();
  }
});

test("buildPrtsSearch empty payload matches shared parity fixture", async () => {
  const restore = mockFetch({
    query: {
      searchinfo: { totalhits: 0 },
      search: [],
    },
  });
  try {
    const data = await buildPrtsSearch("不存在");
    assert.deepStrictEqual(data, loadParityFixture("search_prts_empty.json"));
    if (typeof data === "string") assert.fail(`unexpected error: ${data}`);
    assert.equal(renderPrtsSearch(data), "未找到与 '不存在' 相关的词条。");
  } finally {
    restore();
  }
});

test("buildPrtsSearch rejects invalid mode before network", async () => {
  assert.equal(
    await buildPrtsSearch("阿米娅", 5, "bad"),
    "无效的 search_mode 参数，可选值：text、title。",
  );
});
