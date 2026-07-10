import assert from "node:assert/strict";
import test from "node:test";

import { searchPrts } from "../src/api/prtsWiki.js";

function mockFetch(payloads: unknown[], requests: string[] = []): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    requests.push(String(input));
    const payload = payloads.shift();
    if (payload instanceof Error) throw payload;
    return {
      ok: true,
      status: 200,
      json: async () => payload,
    };
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test("searchPrts resolves redirect-like results", async () => {
  const requests: string[] = [];
  const restore = mockFetch([
    {
      query: {
        searchinfo: { totalhits: 1 },
        search: [{ title: "阿米亚", snippet: "# redirect [[阿米娅]]" }],
      },
    },
    { query: { redirects: [{ from: "阿米亚", to: "阿米娅" }] } },
  ], requests);
  try {
    assert.deepEqual(await searchPrts("阿米亚", 1), {
      totalHits: 1,
      results: [{ title: "阿米娅", snippet: "阿米娅" }],
    });
    assert.equal(new URL(requests[0]).searchParams.get("srprop"), "snippet|redirecttitle");
    assert.equal(new URL(requests[1]).searchParams.get("redirects"), "1");
  } finally {
    restore();
  }
});

test("searchPrts keeps results when redirect lookup fails", async () => {
  const restore = mockFetch([
    {
      query: {
        searchinfo: { totalhits: 1 },
        search: [{ title: "阿米亚", snippet: "# redirect [[阿米娅]]" }],
      },
    },
    new Error("redirect lookup failed"),
  ]);
  try {
    assert.deepEqual(await searchPrts("阿米亚", 1), {
      totalHits: 1,
      results: [{ title: "阿米亚", snippet: "阿米娅" }],
    });
  } finally {
    restore();
  }
});

test("searchPrts filters technical pages without changing totalHits", async () => {
  const restore = mockFetch([
    {
      query: {
        searchinfo: { totalhits: 2 },
        search: [
          { title: "变格凯尔希(敌人)/module", snippet: "技术数据" },
          { title: "凯尔希", snippet: "罗德岛医生。" },
        ],
      },
    },
  ]);
  try {
    assert.deepEqual(await searchPrts("凯尔希", 2), {
      totalHits: 2,
      results: [{ title: "凯尔希", snippet: "罗德岛医生。" }],
    });
  } finally {
    restore();
  }
});

test("searchPrts can keep technical pages when requested", async () => {
  const restore = mockFetch([
    {
      query: {
        searchinfo: { totalhits: 1 },
        search: [{ title: "敌人数据/module", snippet: "技术数据" }],
      },
    },
  ]);
  try {
    assert.deepEqual(await searchPrts("敌人数据", 1, "text", false), {
      totalHits: 1,
      results: [{ title: "敌人数据/module", snippet: "技术数据" }],
    });
  } finally {
    restore();
  }
});
