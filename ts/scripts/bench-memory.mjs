#!/usr/bin/env node
/**
 * Run the repeat/concurrency memory probe against an explicitly isolated MCP
 * instance. It never starts a server and refuses a non-loopback origin.
 *
 * Usage:
 *   PRTS_BENCH_ISOLATED=true PRTS_BENCH_ORIGIN=http://127.0.0.1:3000 \
 *     node scripts/bench-memory.mjs
 */

const origin = requireIsolatedOrigin();

function requireIsolatedOrigin() {
  if (process.env.PRTS_BENCH_ISOLATED !== "true") {
    throw new Error("Set PRTS_BENCH_ISOLATED=true after confirming the target is an isolated instance");
  }
  const raw = process.env.PRTS_BENCH_ORIGIN;
  if (!raw) throw new Error("Set PRTS_BENCH_ORIGIN to the isolated server origin");
  const parsed = new URL(raw);
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname)) {
    throw new Error("PRTS_BENCH_ORIGIN must use a loopback host; do not run this benchmark against production");
  }
  return parsed.origin;
}

async function readJson(res, label) {
  const text = await res.text();
  if (!res.ok) throw new Error(`${label} returned HTTP ${res.status}: ${text.slice(0, 500)}`);
  const sseMatch = text.match(/^data:\s*(\{[\s\S]*\})/m);
  try {
    return JSON.parse(sseMatch ? sseMatch[1] : text);
  } catch {
    throw new Error(`${label} returned invalid JSON: ${text.slice(0, 500)}`);
  }
}

async function mcpPost(body, sessionId) {
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const res = await fetch(`${origin}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
  const response = await readJson(res, "MCP request");
  if (response.error) throw new Error(`MCP protocol error: ${JSON.stringify(response.error)}`);
  if (!response.result) throw new Error("MCP response has no result");
  return { response, sessionId: res.headers.get("mcp-session-id") };
}

async function mcpNotify(body, sessionId) {
  const res = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Mcp-Session-Id": sessionId,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`MCP notification returned HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
}

async function startSession(id) {
  const initialized = await mcpPost({
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "prts-memory-benchmark", version: "1" },
    },
    id,
  });
  if (!initialized.sessionId) throw new Error("initialize did not return Mcp-Session-Id");
  await mcpNotify({ jsonrpc: "2.0", method: "notifications/initialized" }, initialized.sessionId);
  return initialized.sessionId;
}

async function callTool(sessionId, name, args, id) {
  await mcpPost({
    jsonrpc: "2.0",
    method: "tools/call",
    params: { name, arguments: args },
    id,
  }, sessionId);
}

async function runWorkload(sessionId, idStart) {
  await callTool(sessionId, "get_operator_archives", { name: "阿米娅" }, idStart);
  await callTool(sessionId, "get_operator_basic_info", { name: "阿米娅" }, idStart + 1);
  await callTool(sessionId, "search", { scope: "operators", pattern: "法术伤害", max_results: 20 }, idStart + 2);
}

function cacheMisses(cache) {
  return Object.values(cache).reduce((total, domain) => total + Object.values(domain)
    .reduce((domainTotal, stat) => domainTotal + Number(stat.misses ?? 0), 0), 0);
}

function compactSnapshot(snapshot) {
  return {
    server: snapshot.server,
    process: snapshot.process,
    requests: snapshot.requests,
    tool_calls: snapshot.tool_calls,
    sessions: snapshot.sessions,
    cache_misses_total: cacheMisses(snapshot.cache),
    cache: snapshot.cache,
  };
}

async function snapshot(label) {
  const res = await fetch(`${origin}/debug/metrics`);
  const data = await readJson(res, `${label} metrics`);
  if (data.schema_version !== "prts-mcp.metrics/v1") {
    throw new Error(`${label} metrics endpoint is unavailable or has unexpected schema`);
  }
  return data;
}

const before = await snapshot("before");
const primarySession = await startSession(1);
await runWorkload(primarySession, 10);
const cold = await snapshot("cold");

await runWorkload(primarySession, 20);
const repeated = await snapshot("repeated");
const coldMisses = cacheMisses(cold.cache);
const repeatedMisses = cacheMisses(repeated.cache);
if (repeatedMisses !== coldMisses) {
  throw new Error(`repeat workload added cache misses (${coldMisses} -> ${repeatedMisses}); rerun only after confirming no activation invalidation occurred`);
}

const concurrentSessions = await Promise.all([startSession(100), startSession(200), startSession(300)]);
await Promise.all(concurrentSessions.map((sessionId, index) => runWorkload(sessionId, 1_000 + index * 10)));
const concurrent = await snapshot("concurrent");

console.log(JSON.stringify({
  schema_version: "prts-mcp.memory-benchmark/v1",
  target: { origin, isolated: true },
  assertions: { repeated_workload_added_no_cache_misses: true },
  snapshots: {
    before: compactSnapshot(before),
    cold: compactSnapshot(cold),
    repeated: compactSnapshot(repeated),
    concurrent: compactSnapshot(concurrent),
  },
}, null, 2));
