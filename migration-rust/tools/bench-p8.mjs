#!/usr/bin/env node
/**
 * P8 unified performance comparison (docs/06 methodology): the frozen TS
 * oracle (bun dist) vs the Rust release build on IDENTICAL fixed inputs —
 * same local mirror serving the real datarev-…-r2 release, same host,
 * client-side timing, /proc memory truths (VmHWM/VmRSS).
 *
 * Stages: cold full sync (gamedata+levels+story), warm no-change cycle,
 * cold/hot story-search (shared index build), representative tool calls.
 * Full-scale images sync is measured separately (bench-p6-images.mjs).
 */
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = new URL("..", import.meta.url).pathname;
const TS = join(ROOT, ".reference/ts-v2.8.1/ts");
const RUST_BIN = join(ROOT, "target/release/prts-mcp-rust");
const DATA_RELEASE_DIR = join(ROOT, ".runtime/data");
const BENCH = join(ROOT, ".runtime/p8-bench");

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf-8", ...opts });
}

function readProc(pid, field) {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf-8");
    const m = status.match(new RegExp(`${field}:\\s+(\\d+) kB`));
    return m ? Number(m[1]) * 1024 : 0;
  } catch {
    return 0;
  }
}

function gh(tag, asset) {
  return `https://github.com/3aKHP/arknights-data-pipeline/releases/download/${tag}/${asset}`;
}

function mirrorFixture(tag) {
  const releaseDir = join(DATA_RELEASE_DIR, tag);
  const fixtureDir = join(BENCH, "mirror");
  rmSync(fixtureDir, { recursive: true, force: true });
  mkdirSync(fixtureDir, { recursive: true });
  const lines = [];
  for (const asset of ["manifest.json", "zh_CN-excel.zip", "zh_CN-levels.zip", "zh_CN.zip"]) {
    sh("cp", [join(releaseDir, asset), join(fixtureDir, asset)]);
    lines.push(`${gh(tag, asset)} ${asset}`);
  }
  writeFileSync(join(fixtureDir, "assets.txt"), lines.join("\n") + "\n");
  writeFileSync(join(fixtureDir, "releases.json"), JSON.stringify([
    { tag_name: tag, created_at: "2026-10-08T05:00:00Z",
      assets: ["manifest.json", "zh_CN-excel.zip", "zh_CN-levels.zip", "zh_CN.zip"].map((name) => ({ name, browser_download_url: gh(tag, name) })) },
  ]));
  return fixtureDir;
}

async function waitLog(stderrText, needle, limitMs) {
  const start = Date.now();
  let text = stderrText();
  while (!text.includes(needle) && Date.now() - start < limitMs) {
    await sleep(150);
    text = stderrText();
  }
  return text.includes(needle) ? Date.now() : null;
}

async function httpCall(origin, name, args, sid) {
  const t0 = performance.now();
  const res = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(sid ? { "mcp-session-id": sid } : {}),
    },
    body: JSON.stringify(sid
      ? { jsonrpc: "2.0", id: Math.floor(Math.random() * 1e6), method: "tools/call", params: { name, arguments: args } }
      : { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "bench", version: "0" } } }),
  });
  const text = await res.text();
  const ms = performance.now() - t0;
  if (!sid) {
    return { ms, sid: res.headers.get("mcp-session-id") };
  }
  const data = text.split("\n").find((l) => l.startsWith("data: "))?.slice(6);
  return { ms, text: JSON.parse(data || "{}")?.result?.content?.[0]?.text ?? "" };
}

async function measure(impl, mirrorUrl, vol, opts = {}) {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GITHUB_MIRRORS: mirrorUrl,
    IMAGES_ENABLED: "false",
    HOST: "127.0.0.1",
    PORT: "0",
    ...(impl === "ts" ? {} : { GAMEDATA_PATH: join(vol, "gamedata") }),
    ...(impl === "ts" ? { XDG_DATA_HOME: vol } : {}),
    ...opts.env,
  };
  const command = impl === "ts"
    ? { cmd: "bun", argv: [join(TS, "dist/server-bun.js")] }
    : { cmd: RUST_BIN, argv: ["--transport", "http"] };
  const child = spawn(command.cmd, command.argv, { env, stdio: ["ignore", "pipe", "pipe"] });
  let errText = "";
  child.stderr.on("data", (d) => (errText += d));
  const stderr = () => errText;

  const result = { impl };
  // Wait for the HTTP listener, then the FIRST completed sync cycle.
  const tSpawn = Date.now();
  const tListen = await waitLog(stderr, "listening on", 30000);
  if (!tListen) throw new Error(`${impl}: no listener log`);
  result.listen_ms = tListen - tSpawn;

  // Discover the ephemeral port from ss (PORT=0).
  await sleep(150);
  const table = sh("ss", ["-ltnpH"]);
  const line = table.split("\n").find((l) =>
    impl === "ts" ? l.includes("bun") && l.includes(`pid=${child.pid},`) : l.includes(`prts-mcp-rust`) && l.includes(`pid=${child.pid},`),
  );
  const port = line?.trim().split(/\s+/)[3]?.split(":").pop();
  if (!port) throw new Error(`${impl}: port not found`);
  const origin = `http://127.0.0.1:${port}`;

  // Memory sampler.
  let vmHwm = 0, vmRss = 0;
  const sampler = setInterval(() => {
    vmHwm = Math.max(vmHwm, readProc(child.pid, "VmHWM"));
    vmRss = Math.max(vmRss, readProc(child.pid, "VmRSS"));
  }, 150);

  if (opts.fresh) {
    const tCycle = await waitLog(stderr, "Next auto-sync check", 300000);
    if (!tCycle) throw new Error(`${impl}: sync cycle never completed`);
    result.cold_sync_ms = tCycle - tListen;
  }
  if (opts.warmCycles) {
    // With PRTS_AUTO_SYNC_INTERVAL_SECONDS=60: measure wall between two
    // consecutive cycle-end log lines minus the 60s idle.
    const times = [];
    const deadline = Date.now() + 60_000 * (opts.warmCycles + 1) + 30_000;
    while (times.length < opts.warmCycles + 1 && Date.now() < deadline) {
      await sleep(500);
      for (const m of stderr().matchAll(/(\d{4}-\d{2}-\d{2}T[\d:.]+Z) INFO prts_mcp\.server: Next auto-sync check/g)) {
        const t = Date.parse(m[1]);
        if (!times.includes(t)) times.push(t);
      }
    }
    if (times.length >= 2) {
      const gaps = [];
      for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1] - 60_000);
      result.warm_cycle_ms = gaps;
    }
  }

  // Protocol timings on the synced data.
  const init = await httpCall(origin);
  const sid = init.sid;
  const search = await httpCall(origin, "search_stories", { pattern: "阿米娅" }, sid);
  result.story_search_cold_ms = search.ms;
  result.story_search_ok = search.text.length > 0;
  let hot = [];
  for (let i = 0; i < 5; i++) {
    const r = await httpCall(origin, "search_stories", { pattern: "阿米娅" }, sid);
    hot.push(r.ms);
  }
  result.story_search_hot_ms = hot;
  result.list_stages_ms = (await httpCall(origin, "list_stages", {}, sid)).ms;
  result.search_ops_ms = (await httpCall(origin, "search", { pattern: "阿米娅", scope: "operators", limit: 3 }, sid)).ms;

  clearInterval(sampler);
  await sleep(250);
  result.vm_hwm_bytes = Math.max(vmHwm, readProc(child.pid, "VmHWM"));
  result.vm_rss_bytes = readProc(child.pid, "VmRSS") || vmRss;
  child.kill("SIGKILL");
  await new Promise((r) => child.once("exit", r));
  return result;
}

async function main() {
  const tags = readdirSync(DATA_RELEASE_DIR).filter((d) => d.startsWith("datarev-"));
  const tag = tags.sort().at(-1);
  const fixtureDir = mirrorFixture(tag);
  const mirror = spawn("node", [join(ROOT, "tools/images-mirror.mjs"), fixtureDir], {
    env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "inherit"],
  });
  const portLine = await new Promise((resolve) => {
    let buf = "";
    mirror.stdout.on("data", (d) => { buf += d; const i = buf.indexOf("\n"); if (i >= 0) resolve(buf.slice(0, i)); });
  });
  const mirrorUrl = `http://127.0.0.1:${JSON.parse(portLine).port}/`;
  console.log("mirror:", mirrorUrl);

  const out = { recorded_at: new Date().toISOString(), release: tag, methodology: "client-side timing; /proc VmHWM/VmRSS; identical mirror + host" };

  // Cold sync, both implementations, fresh volumes.
  for (const impl of ["ts", "rust"]) {
    const vol = join(BENCH, `cold-${impl}`);
    rmSync(vol, { recursive: true, force: true });
    mkdirSync(vol, { recursive: true });
    out[`cold_${impl}`] = await measure(impl, mirrorUrl, vol, { fresh: true });
    console.log(`cold ${impl}:`, JSON.stringify(out[`cold_${impl}`], null, 1));
  }

  // Warm no-change cycle (60s interval) on the synced volumes.
  for (const impl of ["ts", "rust"]) {
    const vol = join(BENCH, `cold-${impl}`);
    out[`warm_${impl}`] = await measure(impl, mirrorUrl, vol, {
      env: { PRTS_AUTO_SYNC_INTERVAL_SECONDS: "60" }, warmCycles: 1,
    });
    console.log(`warm ${impl}:`, JSON.stringify({ ...out[`warm_${impl}`], story_search_hot_ms: "…" }, null, 1));
  }

  mirror.kill();
  writeFileSync(join(ROOT, "artifacts/p8-bench.json"), JSON.stringify(out, null, 2) + "\n");
  console.log("artifacts/p8-bench.json written");
}

main().catch((err) => { console.error(err); process.exit(1); });
