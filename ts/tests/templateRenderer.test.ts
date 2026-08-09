import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getTemplateData } from "../src/api/prtsWiki.ts";
import { TemplateRenderError, renderTemplateData } from "../src/api/templateRenderer.ts";

interface Fixture {
  title: string;
  parsetree: string;
  rendered_values: string[];
  expected: Record<string, Record<string, unknown>>;
}

function fixture(): Fixture {
  return JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "..", "tests", "parity-fixtures", "template_nested_rendering.json"), "utf-8"),
  ) as Fixture;
}

test("getTemplateData renders nested fields in one POST", async () => {
  const data = fixture();
  const originalFetch = globalThis.fetch;
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input, init) => {
    calls.push({ input: String(input), init });
    if (init?.method !== "POST") {
      return new Response(JSON.stringify({ parse: { parsetree: { "*": data.parsetree } } }));
    }

    const form = new URLSearchParams(String(init.body));
    const text = form.get("text") ?? "";
    const markers = [...text.matchAll(/(PRTSMCP_[0-9a-f]{32}_BEGIN_(\d+)_)/g)];
    assert.equal(markers.length, data.rendered_values.length);
    const html = markers.map((marker, index) => {
      const begin = marker[1]!;
      const end = begin.replace("_BEGIN_", "_END_");
      return `<p>${begin}\n${data.rendered_values[index]}\n${end}</p>`;
    }).join("\n");
    return new Response(JSON.stringify({ parse: { text: { "*": html } } }));
  }) as typeof fetch;

  try {
    assert.deepEqual(await getTemplateData(data.title), data.expected);
    assert.equal(calls.length, 2);
    assert.equal(new URL(calls[0]!.input).searchParams.get("prop"), "parsetree");
    const form = new URLSearchParams(String(calls[1]!.init?.body));
    assert.equal(calls[1]!.init?.method, "POST");
    assert.equal(form.get("action"), "parse");
    assert.equal(form.get("title"), data.title);
    assert.equal(form.get("prop"), "text");
    assert.match(form.get("text") ?? "", /攻击造成\{\{color\|#00B0FF\|法术伤害\}\}。/);
    assert.match(form.get("text") ?? "", /攻击力\{\{\*\|100%\}\}/);
    assert.match(form.get("text") ?? "", /查看\[\[阿米娅\|阿米娅\]\]/);
    assert.doesNotMatch(form.get("text") ?? "", /数值/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("renderTemplateData rejects unsupported nested nodes", async () => {
  const xml = "<root><template><title>Test</title><part><name>字段</name><value><h>标题</h></value></part></template></root>";

  await assert.rejects(
    renderTemplateData("测试", xml, async () => {
      throw new Error("renderer should not be called");
    }),
    TemplateRenderError,
  );
});

test("renderTemplateData skips batch rendering for plain values", async () => {
  const xml = "<root><template><title>Test</title><part><name>数值</name><value>12</value></part></template></root>";

  const result = await renderTemplateData("测试", xml, async () => {
    throw new Error("plain values must not reach the renderer");
  });

  assert.deepEqual(result, { Test: { 数值: "12" } });
});

test("renderTemplateData trims parsetree whitespace for plain values", async () => {
  const xml = "<root><template><title>Test</title><part><name>字段</name><value>\n  阿米娅  \n</value></part></template></root>";

  const result = await renderTemplateData("测试", xml, async () => {
    throw new Error("plain values must not reach the renderer");
  });

  assert.deepEqual(result, { Test: { 字段: "阿米娅" } });
});

test("getTemplateData keeps other fields when one nested value renders empty", async () => {
  const originalFetch = globalThis.fetch;
  const parsetree = [
    "<root><template><title>Test</title>",
    "<part><name>空字段</name><value><template><title>Empty</title></template></value></part>",
    "<part><name>保留字段</name><value><template><title>Kept</title></template></value></part>",
    "</template></root>",
  ].join("");
  let requestCount = 0;
  globalThis.fetch = (async (_input, init) => {
    requestCount += 1;
    if (init?.method !== "POST") {
      return new Response(JSON.stringify({ parse: { parsetree: { "*": parsetree } } }));
    }

    const form = new URLSearchParams(String(init.body));
    const markers = [...(form.get("text") ?? "").matchAll(/(PRTSMCP_[0-9a-f]{32}_BEGIN_(\d+)_)/g)];
    const values = ["", "保留值"];
    const html = markers.map((marker, index) => {
      const begin = marker[1]!;
      const end = begin.replace("_BEGIN_", "_END_");
      return `<p>${begin}\n${values[index]}\n${end}</p>`;
    }).join("\n");
    return new Response(JSON.stringify({ parse: { text: { "*": html } } }));
  }) as typeof fetch;

  try {
    assert.deepEqual(await getTemplateData("测试"), { Test: { 保留字段: "保留值" } });
    assert.equal(requestCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getTemplateData normalizes invalid render response shapes", async () => {
  const originalFetch = globalThis.fetch;
  const parsetree = "<root><template><title>Test</title><part><name>字段</name><value><template><title>Nested</title></template></value></part></template></root>";
  globalThis.fetch = (async (_input, init) => {
    if (init?.method !== "POST") {
      return new Response(JSON.stringify({ parse: { parsetree: { "*": parsetree } } }));
    }
    return new Response(JSON.stringify({ parse: { text: { "*": null } } }));
  }) as typeof fetch;

  try {
    await assert.rejects(getTemplateData("测试"), TemplateRenderError);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getTemplateData rejects reversed render markers", async () => {
  const originalFetch = globalThis.fetch;
  const parsetree = "<root><template><title>Test</title><part><name>字段</name><value><template><title>Nested</title></template></value></part></template></root>";
  globalThis.fetch = (async (_input, init) => {
    if (init?.method !== "POST") {
      return new Response(JSON.stringify({ parse: { parsetree: { "*": parsetree } } }));
    }
    const form = new URLSearchParams(String(init.body));
    const match = (form.get("text") ?? "").match(/(PRTSMCP_[0-9a-f]{32}_BEGIN_0_)/);
    assert.ok(match);
    const begin = match[1]!;
    const end = begin.replace("_BEGIN_", "_END_");
    return new Response(JSON.stringify({ parse: { text: { "*": `${end}\n${begin}\n错误` } } }));
  }) as typeof fetch;

  try {
    await assert.rejects(getTemplateData("测试"), TemplateRenderError);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getTemplateData rejects interleaved render markers", async () => {
  const originalFetch = globalThis.fetch;
  const parsetree = [
    "<root><template><title>Test</title>",
    "<part><name>A</name><value><template><title>A</title></template></value></part>",
    "<part><name>B</name><value><template><title>B</title></template></value></part>",
    "</template></root>",
  ].join("");
  globalThis.fetch = (async (_input, init) => {
    if (init?.method !== "POST") {
      return new Response(JSON.stringify({ parse: { parsetree: { "*": parsetree } } }));
    }
    const form = new URLSearchParams(String(init.body));
    const markers = [...(form.get("text") ?? "").matchAll(/(PRTSMCP_[0-9a-f]{32}_BEGIN_(\d+)_)/g)];
    assert.equal(markers.length, 2);
    const begin0 = markers[0]![1]!;
    const end0 = begin0.replace("_BEGIN_", "_END_");
    const begin1 = markers[1]![1]!;
    const end1 = begin1.replace("_BEGIN_", "_END_");
    return new Response(JSON.stringify({ parse: { text: { "*": `${begin0}\n${begin1}\n值0\n${end0}\n值1\n${end1}` } } }));
  }) as typeof fetch;

  try {
    await assert.rejects(getTemplateData("测试"), TemplateRenderError);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getTemplateData rejects non-string MediaWiki error info", async () => {
  const originalFetch = globalThis.fetch;
  const parsetree = "<root><template><title>Test</title><part><name>字段</name><value><template><title>Nested</title></template></value></part></template></root>";
  globalThis.fetch = (async (_input, init) => {
    if (init?.method !== "POST") {
      return new Response(JSON.stringify({ parse: { parsetree: { "*": parsetree } } }));
    }
    return new Response(JSON.stringify({ error: { info: 1 } }));
  }) as typeof fetch;

  try {
    await assert.rejects(getTemplateData("测试"), TemplateRenderError);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
