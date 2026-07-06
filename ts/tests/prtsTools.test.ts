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

function mockFetch(payload: unknown | unknown[], requests?: string[]): () => void {
  const original = globalThis.fetch;
  const queue = Array.isArray(payload) ? [...payload] : [payload];
  globalThis.fetch = (async (input) => {
    requests?.push(String(input));
    return {
      ok: true,
      status: 200,
      json: async () => {
        if (queue.length === 0) throw new Error("unexpected fetch call");
        return queue.shift();
      },
    };
  }) as typeof fetch;
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

test("buildPrtsSearch resolves redirect-like search results", async () => {
  const requests: string[] = [];
  const restore = mockFetch([
    {
      query: {
        searchinfo: { totalhits: 1 },
        search: [{ title: "阿米亚", snippet: "# redirect [[阿米娅]]" }],
      },
    },
    {
      query: {
        redirects: [{ from: "阿米亚", to: "阿米娅" }],
        pages: { "1": { title: "阿米娅" } },
      },
    },
  ], requests);
  try {
    const data = await buildPrtsSearch("阿米亚", 1);
    if (typeof data === "string") assert.fail(`unexpected error: ${data}`);
    assert.equal(data.total, 1);
    assert.deepStrictEqual(data.results, [{ title: "阿米娅", snippet: "阿米娅" }]);
    assert.equal(
      new URL(requests[0]).searchParams.get("srprop"),
      "snippet|redirecttitle|redirectsnippet",
    );
  } finally {
    restore();
  }
});

test("buildPrtsSearch filters technical pages but keeps totalhits", async () => {
  const restore = mockFetch({
    query: {
      searchinfo: { totalhits: 2 },
      search: [
        { title: "变格凯尔希(敌人)/module", snippet: "技术数据" },
        { title: "凯尔希", snippet: "罗德岛医生。" },
      ],
    },
  });
  try {
    const data = await buildPrtsSearch("凯尔希", 2);
    if (typeof data === "string") assert.fail(`unexpected error: ${data}`);
    assert.equal(data.total, 2);
    assert.deepStrictEqual(data.results, [{ title: "凯尔希", snippet: "罗德岛医生。" }]);
  } finally {
    restore();
  }
});

test("buildPrtsSearch filter_technical=false keeps technical pages", async () => {
  const restore = mockFetch({
    query: {
      searchinfo: { totalhits: 1 },
      search: [{ title: "变格凯尔希(敌人)/module", snippet: "技术数据" }],
    },
  });
  try {
    const data = await buildPrtsSearch("凯尔希", 1, "text", false);
    if (typeof data === "string") assert.fail(`unexpected error: ${data}`);
    assert.equal(data.total, 1);
    assert.deepStrictEqual(data.results, [{ title: "变格凯尔希(敌人)/module", snippet: "技术数据" }]);
  } finally {
    restore();
  }
});

test("buildPrtsSearch returns structured empty after filtering all technical hits", async () => {
  const restore = mockFetch({
    query: {
      searchinfo: { totalhits: 1 },
      search: [{ title: "敌人数据/module", snippet: "技术数据" }],
    },
  });
  try {
    const data = await buildPrtsSearch("敌人数据", 1);
    assert.deepStrictEqual(data, {
      query: "敌人数据",
      search_mode: "text",
      filters: {
        limit: 1,
        filter_technical: true,
      },
      total: 1,
      results: [],
    });
  } finally {
    restore();
  }
});
