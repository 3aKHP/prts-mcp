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
