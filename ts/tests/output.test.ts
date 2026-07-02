import test from "node:test";
import assert from "node:assert/strict";
import { parseChannel, renderResult, textResult } from "../src/output.js";

test("parseChannel accepts valid channels", () => {
  assert.equal(parseChannel(undefined), "content");
  assert.equal(parseChannel(""), "content");
  assert.equal(parseChannel("content"), "content");
  assert.equal(parseChannel(" STRUCTURED "), "structured");
  assert.equal(parseChannel("Both"), "both");
});

test("parseChannel falls back on invalid values", () => {
  const warn = console.warn;
  const messages: unknown[] = [];
  console.warn = (message?: unknown) => { messages.push(message); };
  try {
    assert.equal(parseChannel("json"), "content");
  } finally {
    console.warn = warn;
  }
  assert.equal(messages.length, 1);
});

test("renderResult emits content-only markdown by default", () => {
  const data = { total: 2, results: [{ id: "a" }] };
  assert.deepStrictEqual(renderResult(data, "# markdown", "content"), {
    content: [{ type: "text", text: "# markdown" }],
  });
});

test("renderResult emits structured summary", () => {
  const data = { total: 2, results: [{ id: "a" }] };
  assert.deepStrictEqual(renderResult(data, "# markdown", "structured"), {
    content: [{ type: "text", text: "（结构化结果共 2 条，详见 structuredContent）" }],
    structuredContent: data,
  });
});

test("renderResult supports both channels", () => {
  const data = { total: 2, results: [{ id: "a" }] };
  assert.deepStrictEqual(renderResult(data, "# markdown", "both"), {
    content: [{ type: "text", text: "# markdown" }],
    structuredContent: data,
  });
});

test("renderResult keeps null data content-only", () => {
  assert.deepStrictEqual(renderResult(null, "错误", "structured"), {
    content: [{ type: "text", text: "错误" }],
  });
});

test("textResult is always content-only", () => {
  assert.deepStrictEqual(textResult("plain"), {
    content: [{ type: "text", text: "plain" }],
  });
});
