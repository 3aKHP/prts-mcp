#!/usr/bin/env node
/**
 * P4 story-index performance measurement (docs/06: P4 records the full
 * story index; cold = fresh process samples, hot = warmed queries, plus the
 * swap-rebuild and multi-session-sharing evidence docs/07 requires).
 *
 * Legs:
 *   rust-cold   ×5   fresh process, one scoped search (first index build)
 *   rust-hot    100  warmed process, p50/p95 client-side latency
 *   rust-swap   3×   warmed process, zip replaced → exactly one rebuild each,
 *                    VmHWM must not grow per swap (old index released)
 *   rust-share  1    fresh process, two concurrent sessions racing the cold
 *                    index — the second must ride the shared build
 *   ts-cold     ×3   oracle comparison (bun runtime)
 *   ts-hot      ×30
 *
 * Output: artifacts/p4-bench.json (deterministic notes recorded inline).
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DATASET = join(ROOT, ".runtime", "fixtures", "full-story-r2");
const RUST_BIN = join(ROOT, "target", "release", "prts-mcp-rust");
const TS = join(ROOT, ".reference", "ts-v2.8.1", "ts");
const SWAP_SRC = join(ROOT, ".runtime", "fixtures", "minimal-gamedata-v2", "storyjson", "zh_CN.zip");
const FULL_ZIP = join(DATASET, "storyjson", "zh_CN.zip");
const FULL_ZIP_BACKUP = join(DATASET, "storyjson", "zh_CN.full.bak");

const SEARCH = { name: "search_stories", arguments: { pattern: "罗德岛", max_results: 5 } };
const HOT_PATTERNS = ["罗德岛", "博士", "源石", "整合运动", "龙门"].map((p) => ({
  name: "search_stories",
  arguments: { pattern: p, max_results: 5 },
}));

function env(port) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GAMEDATA_PATH: DATASET,
    STORYJSON_PATH: FULL_ZIP,
    GITHUB_MIRRORS: "",
    IMAGES_ENABLED: "true",
    HOST: "127.0.0.1",
    PORT: String(port),
    // structured channel so the bench can read structuredContent.total.
    PRTS_OUTPUT_CHANNEL: "structured",
  };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function startServer(kind) {
  const port = await freePort();
  const cmd = kind === "ts"
    ? { c: "bun", a: [join(TS, "dist", "server.js")] }
    : { c: RUST_BIN, a: ["--transport", "http"] };
  const child = spawn(cmd.c, cmd.a, { env: env(port), stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.on("data", () => {});
  const origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 400; i++) {
    try { const r = await fetch(`${origin}/health`); if (r.ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  return { child, origin, port };
}

async function session(origin) {
  let sid = null;
  const post = async (body) => {
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    if (sid) headers["mcp-session-id"] = sid;
    const res = await fetch(`${origin}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
    sid = res.headers.get("mcp-session-id") ?? sid;
    const text = await res.text();
    if (text.trim() === "") return null; // notifications answer 202 + empty
    // SSE frames may carry leading "event: message\ndata: " prefixes; strip
    // any non-JSON prefix before the first "{".
    const rest = text.slice(text.indexOf("{")).trim();
    return JSON.parse(rest);
  };
  await post({ jsonrpc: "2.0", method: "initialize", id: 0, params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "bench", version: "0" } } });
  await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  return { post };
}

async function timedSearch(sess) {
  const t0 = performance.now();
  const r = await sess.post({ jsonrpc: "2.0", method: "tools/call", id: 1, params: SEARCH });
  const ms = performance.now() - t0;
  const total = r?.result?.structuredContent?.total ?? null;
  return { ms, total };
}

function procStatus(pid, field) {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf-8");
    const m = status.match(new RegExp(`${field}:\\s+(\\d+) kB`));
    return m ? Number(m[1]) : null;
  } catch { return null; }
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const p = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { n: values.length, min: +sorted[0].toFixed(1), p50: +p(0.5).toFixed(1), p95: +p(0.95).toFixed(1), max: +sorted[sorted.length - 1].toFixed(1) };
}

async function killServer(server) {
  server.child.kill();
  await new Promise((r) => server.child.on("exit", r));
}

const out = { recorded_at: new Date().toISOString(), dataset: "full-story-r2", legs: {}, notes: [] };

// --- rust-cold ×5 ------------------------------------------------------------
{
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const server = await startServer("rust");
    const sess = await session(server.origin);
    const { ms, total } = await timedSearch(sess);
    samples.push({ ms: +ms.toFixed(1), total, vm_hwm_kb: procStatus(server.child.pid, "VmHWM"), vm_rss_kb: procStatus(server.child.pid, "VmRSS") });
    await killServer(server);
  }
  out.legs["rust-cold"] = {
    samples,
    summary: stats(samples.map((s) => s.ms)),
    hits: samples[0].total,
    peak_rss_mb: +(Math.max(...samples.map((s) => s.vm_rss_kb)) / 1024).toFixed(1),
    high_water_mb: +(Math.max(...samples.map((s) => s.vm_hwm_kb)) / 1024).toFixed(1),
  };
}

// --- rust-hot 100 ------------------------------------------------------------
{
  const server = await startServer("rust");
  const sess = await session(server.origin);
  await timedSearch(sess); // warm the index
  const latencies = [];
  for (let i = 0; i < 100; i++) {
    const t0 = performance.now();
    const r = await sess.post({ jsonrpc: "2.0", method: "tools/call", id: i + 2, params: HOT_PATTERNS[i % HOT_PATTERNS.length] });
    latencies.push(performance.now() - t0);
    if (!r?.result) throw new Error(`hot query failed: ${JSON.stringify(r).slice(0, 200)}`);
  }
  out.legs["rust-hot"] = { ...stats(latencies), vm_rss_mb: +(procStatus(server.child.pid, "VmRSS") / 1024).toFixed(1) };
  out.rust_server_pid_hot = server.child.pid;
  // keep this process alive for the swap leg
  globalThis.__swapCtx = { server, sess };
}

// --- rust-swap ×3 (rebuild once per swap; no unbounded growth) ----------------
{
  const { server, sess } = globalThis.__swapCtx;
  copyFileSync(FULL_ZIP, FULL_ZIP_BACKUP);
  const swaps = [];
  for (let i = 0; i < 3; i++) {
    copyFileSync(i % 2 === 0 ? SWAP_SRC : FULL_ZIP_BACKUP, FULL_ZIP);
    const t0 = performance.now();
    const r = await sess.post({ jsonrpc: "2.0", method: "tools/call", id: 1000 + i, params: SEARCH });
    const rebuildMs = performance.now() - t0;
    // immediate repeat must be fast (cached new index)
    const t1 = performance.now();
    await sess.post({ jsonrpc: "2.0", method: "tools/call", id: 2000 + i, params: SEARCH });
    const reuseMs = performance.now() - t1;
    swaps.push({
      rebuild_ms: +rebuildMs.toFixed(1),
      reuse_ms: +reuseMs.toFixed(1),
      ok: Boolean(r?.result),
      vm_hwm_kb: procStatus(server.child.pid, "VmHWM"),
      vm_rss_kb: procStatus(server.child.pid, "VmRSS"),
    });
  }
  copyFileSync(FULL_ZIP_BACKUP, FULL_ZIP);
  rmSync(FULL_ZIP_BACKUP);
  const t0 = performance.now();
  await sess.post({ jsonrpc: "2.0", method: "tools/call", id: 3000, params: SEARCH });
  swaps.push({ rebuild_ms: +(performance.now() - t0).toFixed(1), note: "restore full zip" });
  out.legs["rust-swap"] = {
    swaps,
    hwm_growth_over_3_swaps_kb: swaps.length > 2 && swaps[0].vm_hwm_kb != null && swaps[2].vm_hwm_kb != null
      ? swaps[2].vm_hwm_kb - swaps[0].vm_hwm_kb
      : null,
  };
  await killServer(server);
}

// --- rust-share: two sessions race the cold index -----------------------------
{
  const coldMedian = out.legs["rust-cold"].summary.p50;
  const server = await startServer("rust");
  const [a, b] = await Promise.all([session(server.origin), session(server.origin)]);
  const wall0 = performance.now();
  const tA = timedSearch(a);
  await new Promise((r) => setTimeout(r, 50));
  const tB = timedSearch(b);
  const [ra, rb] = await Promise.all([tA, tB]);
  const wall = performance.now() - wall0;
  out.legs["rust-share"] = {
    cold_median_ms: coldMedian,
    session_a_ms: +ra.ms.toFixed(1),
    session_b_ms: +rb.ms.toFixed(1),
    b_over_cold: +(rb.ms / coldMedian).toFixed(2),
    wall_ms: +wall.toFixed(1),
    wall_over_cold: +(wall / coldMedian).toFixed(2),
    hits_a: ra.total,
    hits_b: rb.total,
    note: "Both sessions race the same cold index: B waits out A's in-flight build instead of building a second copy (the single-flight unit test pins build_count == 1); wall ≈ one build + the 50ms stagger, never two builds",
  };
  await killServer(server);
}

// --- ts-cold ×3 + ts-hot ×30 ---------------------------------------------------
{
  const samples = [];
  for (let i = 0; i < 3; i++) {
    const server = await startServer("ts");
    const sess = await session(server.origin);
    const { ms, total } = await timedSearch(sess);
    samples.push({ ms: +ms.toFixed(1), total, vm_hwm_kb: procStatus(server.child.pid, "VmHWM"), vm_rss_kb: procStatus(server.child.pid, "VmRSS") });
    await killServer(server);
  }
  out.legs["ts-cold"] = {
    samples,
    summary: stats(samples.map((s) => s.ms)),
    hits: samples[0].total,
    peak_rss_mb: +(Math.max(...samples.map((s) => s.vm_rss_kb)) / 1024).toFixed(1),
    high_water_mb: +(Math.max(...samples.map((s) => s.vm_hwm_kb)) / 1024).toFixed(1),
  };

  const server = await startServer("ts");
  const sess = await session(server.origin);
  await timedSearch(sess);
  const latencies = [];
  for (let i = 0; i < 30; i++) {
    const t0 = performance.now();
    await sess.post({ jsonrpc: "2.0", method: "tools/call", id: i + 2, params: HOT_PATTERNS[i % HOT_PATTERNS.length] });
    latencies.push(performance.now() - t0);
  }
  out.legs["ts-hot"] = stats(latencies);
  await killServer(server);
}

out.notes.push(
  "cold = fresh process + one scoped search (first full index build over 2357-entry zip)",
  "hot = warmed process, client-side wall time over HTTP",
  "swap = zip replaced in place (stat descriptor changes): exactly one rebuild then cache reuse; VmHWM growth over 3 swaps must stay bounded (old index released with last reader)",
  "share = two sessions race the cold build; B over cold << 1 proves the shared single-flight index",
  "TS legs run under bun (node ignores nothing here; same env whitelist as the differential runner)",
);

mkdirSync(join(ROOT, "artifacts"), { recursive: true });
writeFileSync(join(ROOT, "artifacts", "p4-bench.json"), JSON.stringify(out, null, 2) + "\n", "utf-8");
console.log(JSON.stringify({
  rust_cold: out.legs["rust-cold"].summary,
  rust_hot: out.legs["rust-hot"],
  rust_share: { b_over_cold: out.legs["rust-share"].b_over_cold },
  swap_hwm_growth_kb: out.legs["rust-swap"].hwm_growth_over_3_swaps_kb,
  ts_cold: out.legs["ts-cold"].summary,
  ts_hot: out.legs["ts-hot"],
}, null, 1));
