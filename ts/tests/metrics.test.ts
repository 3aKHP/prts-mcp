import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeMetrics } from "../src/metrics.js";
import { CacheMetrics } from "../src/data/cacheMetrics.js";

test("RuntimeMetrics records aggregate tool calls without retaining payloads", () => {
  const metrics = new RuntimeMetrics();
  const token = metrics.beginRequest({
    jsonrpc: "2.0",
    method: "tools/call",
    params: { name: "get_operator_basic_info", arguments: { name: "阿米娅", secret: "must-not-leak" } },
  });
  metrics.finishRequest(token, 200);

  const snapshot = metrics.snapshot("2.6.0-test", 86_400_000, [], {});
  const text = JSON.stringify(snapshot);
  const toolCalls = snapshot["tool_calls"] as Record<string, unknown>;
  const byName = toolCalls["by_name"] as Record<string, Record<string, unknown>>;

  assert.equal(toolCalls["total"], 1);
  assert.equal(byName["get_operator_basic_info"]?.["total"], 1);
  assert.equal(typeof byName["get_operator_basic_info"]?.["duration_ms_max"], "number");
  assert.equal(text.includes("must-not-leak"), false);
  assert.equal(text.includes("阿米娅"), false);
  assert.equal(text.includes("arguments"), false);
});

test("RuntimeMetrics leaves batch requests out of ambiguous tool attribution", () => {
  const metrics = new RuntimeMetrics();
  const token = metrics.beginRequest([
    { method: "tools/call", params: { name: "search", arguments: { pattern: "test" } } },
  ]);
  metrics.finishRequest(token, 404);

  const snapshot = metrics.snapshot("2.6.0-test", null, [], {});
  const requests = snapshot["requests"] as Record<string, unknown>;
  const toolCalls = snapshot["tool_calls"] as Record<string, unknown>;

  assert.equal(requests["total"], 1);
  assert.equal(requests["http_errors_total"], 1);
  assert.equal(toolCalls["total"], 0);
});

test("RuntimeMetrics does not retain an unrecognized caller-supplied tool name", () => {
  const metrics = new RuntimeMetrics();
  const toolName = "private-tool-name-must-not-be-retained";
  const token = metrics.beginRequest({
    jsonrpc: "2.0",
    method: "tools/call",
    params: { name: toolName, arguments: { secret: "must-not-leak" } },
  });
  metrics.finishRequest(token, 404);

  const snapshot = metrics.snapshot("2.6.0-test", null, [], {});
  const toolCalls = snapshot["tool_calls"] as Record<string, unknown>;
  assert.equal(toolCalls["total"], 0);
  assert.equal(JSON.stringify(snapshot).includes(toolName), false);
});

test("CacheMetrics reports cache-gate hits, misses, and invalidation attempts", () => {
  const metrics = new CacheMetrics();
  metrics.access(false);
  metrics.access(true);
  metrics.clear();

  assert.deepEqual(metrics.snapshot(true, 3), {
    loaded: true,
    count: 3,
    hits: 1,
    misses: 1,
    clears: 1,
  });
});
