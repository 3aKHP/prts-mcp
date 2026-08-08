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
const debugToken = requireDebugToken();
const CONCURRENT_SESSIONS = 6;
const MAX_RSS_BYTES = positiveEnv("PRTS_BENCH_MAX_RSS_BYTES", 1024 * 1024 * 1024);
const MAX_RSS_GROWTH_BYTES = positiveEnv(
  "PRTS_BENCH_MAX_RSS_GROWTH_BYTES",
  256 * 1024 * 1024,
);

function positiveEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer byte count`);
  }
  return parsed;
}

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

function requireDebugToken() {
  const token = process.env.PRTS_DEBUG_TOKEN;
  if (!token) throw new Error("PRTS_DEBUG_TOKEN is required for the isolated benchmark");
  return token;
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

async function mcpPost(body, sessionId, query = "") {
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const res = await fetch(`${origin}/mcp${query}`, { method: "POST", headers, body: JSON.stringify(body) });
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
  }, undefined, "?output_channel=both");
  if (!initialized.sessionId) throw new Error("initialize did not return Mcp-Session-Id");
  await mcpNotify({ jsonrpc: "2.0", method: "notifications/initialized" }, initialized.sessionId);
  return initialized.sessionId;
}

async function callTool(sessionId, name, args, id) {
  const { response } = await mcpPost({
    jsonrpc: "2.0",
    method: "tools/call",
    params: { name, arguments: args },
    id,
  }, sessionId);
  const result = response.result;
  if (!result || result.isError === true || !Array.isArray(result.content)) {
    throw new Error(`${name} did not return a successful tool result`);
  }
  const hasText = result.content.some((block) => (
    block && block.type === "text" && typeof block.text === "string" && block.text.length > 0
  ));
  if (!hasText) throw new Error(`${name} returned no text content`);
  return result;
}

function requireStructured(result, toolName) {
  if (!result.structuredContent || typeof result.structuredContent !== "object") {
    throw new Error(`${toolName} did not return structuredContent; initialize must use output_channel=both`);
  }
  return result.structuredContent;
}

async function discoverWorkloadTargets(sessionId) {
  const eventListing = requireStructured(
    await callTool(sessionId, "list_story_events", {}, 2),
    "list_story_events",
  );
  const events = Array.isArray(eventListing.events) ? eventListing.events : [];
  const event = events.find((candidate) => (
    candidate
    && typeof candidate.event_id === "string"
    && Number.isInteger(candidate.story_count)
    && candidate.story_count > 0
  ));
  if (!event) throw new Error("list_story_events returned no readable event");

  const storiesListing = requireStructured(
    await callTool(sessionId, "list_stories", { event_id: event.event_id }, 3),
    "list_stories",
  );
  const chapters = Array.isArray(storiesListing.chapters) ? storiesListing.chapters : [];
  const chapter = chapters.find((candidate) => candidate && typeof candidate.story_key === "string");
  if (!chapter) throw new Error(`list_stories returned no readable chapter for ${event.event_id}`);

  const artworkListing = requireStructured(
    await callTool(sessionId, "operator_artwork", { operator_name: "阿米娅", action: "list" }, 4),
    "operator_artwork list",
  );
  const artworks = Array.isArray(artworkListing.artworks) ? artworkListing.artworks : [];
  const artwork = artworks.find((candidate) => candidate && typeof candidate.artwork_id === "string");
  if (!artwork) throw new Error("operator_artwork list returned no retrievable artwork");

  return { eventId: event.event_id, storyKey: chapter.story_key, artworkId: artwork.artwork_id };
}

async function runWorkload(sessionId, idStart, targets) {
  await callTool(sessionId, "get_operator_archives", { name: "阿米娅" }, idStart);
  await callTool(sessionId, "get_operator_basic_info", { name: "阿米娅" }, idStart + 1);
  await callTool(sessionId, "search", { scope: "operators", pattern: "法术伤害", max_results: 20 }, idStart + 2);
  await callTool(sessionId, "search_stories", {
    pattern: "博士", context_lines: 1, max_results: 30,
  }, idStart + 3);
  await callTool(sessionId, "read_story", {
    story_key: targets.storyKey, include_narration: true,
  }, idStart + 4);
  await callTool(sessionId, "read_activity", {
    event_id: targets.eventId, include_narration: true, page: 1, page_size: 5,
  }, idStart + 5);
  await callTool(sessionId, "operator_artwork", {
    operator_name: "阿米娅", action: "get", artwork_id: targets.artworkId, variant: "large",
  }, idStart + 6);
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
  const res = await fetch(`${origin}/debug/metrics`, {
    headers: { Authorization: `Bearer ${debugToken}` },
  });
  const data = await readJson(res, `${label} metrics`);
  if (data.schema_version !== "prts-mcp.metrics/v1") {
    throw new Error(`${label} metrics endpoint is unavailable or has unexpected schema`);
  }
  return data;
}

const before = await snapshot("before");
const primarySession = await startSession(1);
const targets = await discoverWorkloadTargets(primarySession);
await runWorkload(primarySession, 10, targets);
const cold = await snapshot("cold");

await runWorkload(primarySession, 20, targets);
const repeated = await snapshot("repeated");
const coldMisses = cacheMisses(cold.cache);
const repeatedMisses = cacheMisses(repeated.cache);
if (repeatedMisses !== coldMisses) {
  throw new Error(`repeat workload added cache misses (${coldMisses} -> ${repeatedMisses}); rerun only after confirming no activation invalidation occurred`);
}

const concurrentSessions = await Promise.all(
  Array.from({ length: CONCURRENT_SESSIONS }, (_unused, index) => startSession(100 + index)),
);
await Promise.all(concurrentSessions.map((sessionId, index) => runWorkload(sessionId, 1_000 + index * 10, targets)));
const concurrent = await snapshot("concurrent");
const rssGrowthBytes = concurrent.process.rss_bytes - cold.process.rss_bytes;
if (concurrent.sessions.active < CONCURRENT_SESSIONS + 1) {
  throw new Error(`expected at least ${CONCURRENT_SESSIONS + 1} active sessions, got ${concurrent.sessions.active}`);
}
if (concurrent.requests.in_flight !== 0 || concurrent.tool_calls.in_flight !== 0) {
  throw new Error("workload did not quiesce before the concurrent snapshot");
}
if (concurrent.process.rss_bytes > MAX_RSS_BYTES) {
  throw new Error(`RSS exceeded budget (${concurrent.process.rss_bytes} > ${MAX_RSS_BYTES})`);
}
if (rssGrowthBytes > MAX_RSS_GROWTH_BYTES) {
  throw new Error(`concurrent workload RSS growth exceeded budget (${rssGrowthBytes} > ${MAX_RSS_GROWTH_BYTES})`);
}

console.log(JSON.stringify({
  schema_version: "prts-mcp.memory-benchmark/v1",
  target: { origin, isolated: true },
  workload: {
    concurrent_sessions: CONCURRENT_SESSIONS,
    tools: [
      "get_operator_archives", "get_operator_basic_info", "search", "search_stories",
      "read_story", "read_activity", "operator_artwork",
    ],
  },
  assertions: {
    repeated_workload_added_no_cache_misses: true,
    concurrent_sessions_remained_active: true,
    post_workload_requests_quiesced: true,
    max_rss_bytes: MAX_RSS_BYTES,
    max_rss_growth_bytes: MAX_RSS_GROWTH_BYTES,
    observed_rss_growth_bytes: rssGrowthBytes,
  },
  snapshots: {
    before: compactSnapshot(before),
    cold: compactSnapshot(cold),
    repeated: compactSnapshot(repeated),
    concurrent: compactSnapshot(concurrent),
  },
}, null, 2));
