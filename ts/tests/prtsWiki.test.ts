import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { searchPrts } from "../src/api/prtsWiki.js";

function mockFetch(
  t: TestContext,
  payloads: unknown[],
  requests?: string[],
): void {
  const recordedRequests = requests ?? [];
  t.mock.method(globalThis, "fetch", async (input) => {
    recordedRequests.push(String(input));
    const payload = payloads.shift();
    if (payload instanceof Error) throw payload;
    return {
      ok: true,
      status: 200,
      json: async () => payload,
    };
  });
  t.mock.method(
    globalThis,
    "setTimeout",
    ((callback: () => void) => {
      callback();
      return 0;
    }) as typeof setTimeout,
  );
}

test("searchPrts resolves redirect-like results", async (t) => {
  const requests: string[] = [];
  mockFetch(t, [
    {
      query: {
        searchinfo: { totalhits: 1 },
        search: [{ title: "阿米亚", snippet: "# redirect [[阿米娅]]" }],
      },
    },
    { query: { redirects: [{ from: "阿米亚", to: "阿米娅" }] } },
  ], requests);
  assert.deepEqual(await searchPrts("阿米亚", 1), {
    totalHits: 1,
    results: [{ title: "阿米娅", snippet: "阿米娅" }],
  });
  assert.equal(new URL(requests[0]).searchParams.get("srprop"), "snippet|redirecttitle");
  assert.equal(new URL(requests[1]).searchParams.get("redirects"), "1");
  assert.equal(new URL(requests[1]).searchParams.get("titles"), "阿米亚");
});

test("searchPrts keeps results when redirect lookup fails", async (t) => {
  mockFetch(t, [
    {
      query: {
        searchinfo: { totalhits: 1 },
        search: [{ title: "阿米亚", snippet: "# redirect [[阿米娅]]" }],
      },
    },
    new Error("redirect lookup failed"),
  ]);
  assert.deepEqual(await searchPrts("阿米亚", 1), {
    totalHits: 1,
    results: [{ title: "阿米亚", snippet: "阿米娅" }],
  });
});

test("searchPrts batches redirect resolution", async (t) => {
  const requests: string[] = [];
  mockFetch(t, [
    {
      query: {
        searchinfo: { totalhits: 2 },
        search: [
          { title: "别名甲", snippet: "# redirect [[目标甲]]" },
          { title: "别名乙", snippet: "# redirect [[目标乙]]" },
        ],
      },
    },
    {
      query: {
        redirects: [
          { from: "别名甲", to: "目标甲" },
          { from: "别名乙", to: "目标乙" },
        ],
      },
    },
  ], requests);
  assert.deepEqual(await searchPrts("别名", 2), {
    totalHits: 2,
    results: [
      { title: "目标甲", snippet: "目标甲" },
      { title: "目标乙", snippet: "目标乙" },
    ],
  });
  assert.equal(requests.length, 2);
  assert.equal(new URL(requests[1]).searchParams.get("titles"), "别名甲|别名乙");
});

test("searchPrts uses native redirecttitle without another request", async (t) => {
  const requests: string[] = [];
  mockFetch(t, [
    {
      query: {
        searchinfo: { totalhits: 1 },
        search: [{
          title: "阿米娅",
          redirecttitle: "阿米亚",
          snippet: "罗德岛领袖。",
        }],
      },
    },
  ], requests);
  assert.deepEqual(await searchPrts("阿米亚", 1), {
    totalHits: 1,
    results: [{ title: "阿米娅", snippet: "罗德岛领袖。" }],
  });
  assert.equal(requests.length, 1);
});

test("searchPrts filters technical pages without changing totalHits", async (t) => {
  mockFetch(t, [
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
  assert.deepEqual(await searchPrts("凯尔希", 2), {
    totalHits: 2,
    results: [{ title: "凯尔希", snippet: "罗德岛医生。" }],
  });
});

test("searchPrts can keep technical pages when requested", async (t) => {
  mockFetch(t, [
    {
      query: {
        searchinfo: { totalhits: 1 },
        search: [{ title: "敌人数据/module", snippet: "技术数据" }],
      },
    },
  ]);
  assert.deepEqual(await searchPrts("敌人数据", 1, "text", false), {
    totalHits: 1,
    results: [{ title: "敌人数据/module", snippet: "技术数据" }],
  });
});
