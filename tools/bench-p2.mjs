#!/usr/bin/env node
/**
 * P2 sync peak measurement (docs/06 性能: "P2记录同步峰值"; docs/07 P2:
 * "阶段sync峰值已测，不能保持整包多份缓冲而声称完成内存优化").
 *
 * Serves the PINNED real release archives (datarev-26-10-08-…-r2, ~60 MB
 * total) from a local ghproxy-style mirror, then measures:
 *   - Rust cold sync (streaming download path) — wall time + VmHWM peak RSS
 *   - Rust no-change sync (fresh-cache skip) — wall time + VmHWM
 *   - TS cold sync via the frozen dist code under node (arrayBuffer path)
 * Determinism: direct GitHub candidates are routed through a dead proxy
 * (reqwest honors HTTPS_PROXY; the TS transport's undici branch honors the
 * lowercase https_proxy on node — Bun ignores proxy env, so the TS leg runs
 * under node, noted in the artifact).
 *
 * Usage: node tools/bench-p2.mjs [--rounds N]   (default 3, docs/06 重型同步至少3轮)
 */
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA = join(ROOT, ".runtime", "data", "datarev-26-10-08-04-51-28-56071834-r2");
const TAG = "datarev-26-10-08-04-51-28-56071834-r2";
const VID = "26-10-08-04-51-28-56071834-r2";
const ASSETS = ["zh_CN-excel.zip", "zh_CN-levels.zip", "zh_CN.zip"];
const RUST_BIN =
  process.env.RUST_BIN ??
  [join(ROOT, "target", "release", "prts-mcp-rust"), join(ROOT, "target", "debug", "prts-mcp-rust")]
    .find((p) => statSync(p, { throwIfNoType: false })?.isFile());
const ROUNDS = Number(process.argv.includes("--rounds")
  ? process.argv[process.argv.indexOf("--rounds") + 1]
  : 3);

if (!RUST_BIN) throw new Error("build the release binary first: cargo build --locked --release");
for (const asset of ASSETS) {
  if (!statSync(join(DATA, asset), { throwIfNoType: false })) {
    throw new Error(`pinned asset missing: ${join(DATA, asset)} (run tools/fetch-data.mjs)`);
  }
}

// --- local ghproxy-style mirror -------------------------------------------------

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const mirrorPort = await freePort();
const mirror = createServer((req, res) => {
  const url = req.url ?? "";
  const send = (status, type, body) => {
    res.writeHead(status, { "content-type": type, "content-length": body.length, connection: "close" });
    res.end(body);
  };
  if (url.includes("api.github.com")) {
    send("application/json".length ? 200 : 200, "application/json", JSON.stringify([{
      tag_name: TAG,
      created_at: "2026-10-08T05:00:00Z",
      assets: ASSETS.map((name) => ({
        name,
        browser_download_url: `https://github.com/3aKHP/arknights-data-pipeline/releases/download/${TAG}/${name}`,
      })),
    }]));
    return;
  }
  if (url.endsWith("manifest.json")) {
    send(200, "application/json", readFileSync(join(DATA, "manifest.json")));
    return;
  }
  for (const asset of ASSETS) {
    if (url.endsWith(asset)) {
      const bytes = readFileSync(join(DATA, asset));
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": bytes.length, connection: "close" });
      res.end(bytes);
      return;
    }
  }
  send(404, "text/plain", "missing");
});
await new Promise((resolve) => mirror.listen(mirrorPort, "127.0.0.1", resolve));

// --- measurement helpers --------------------------------------------------------

function readStatus(pid, field) {
  try {
    const text = readFileSync(`/proc/${pid}/status`, "utf-8");
    return Number(text.match(new RegExp(`^${field}:\\s+(\\d+) kB`, "m"))?.[1] ?? 0);
  } catch {
    return 0;
  }
}

function spawnRustHttp(xdgRoot) {
  const port = 0; // unused: we never talk HTTP to the bench child
  const child = spawn(RUST_BIN, ["--transport", "http"], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      HOST: "127.0.0.1",
      PORT: "39443", // never probed; sync is the subject
      XDG_DATA_HOME: xdgRoot,
      GITHUB_MIRRORS: `http://127.0.0.1:${mirrorPort}`,
      HTTPS_PROXY: "http://127.0.0.1:9",
      https_proxy: "http://127.0.0.1:9",
      IMAGES_ENABLED: "true",
      PRTS_AUTO_SYNC_INTERVAL_SECONDS: "0",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf-8");
  child.stderr.on("data", (d) => { stderr += d; });
  return { child, stderr: () => stderr };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await sleep(150);
  }
}

function pairReady(xdgRoot) {
  try {
    const pair = JSON.parse(readFileSync(join(xdgRoot, "prts-mcp", ".gamedata_pair.json"), "utf-8"));
    const story = statSync(join(xdgRoot, "prts-mcp", "storyjson", "zh_CN.zip"));
    return pair.commit_sha === VID && story.isFile();
  } catch {
    return false;
  }
}

async function runRustCold() {
  const xdg = mkdtempSync(join(tmpdir(), "prts-bench-rust-"));
  const started = Date.now();
  const { child, stderr } = spawnRustHttp(xdg);
  try {
    await waitUntil(() => pairReady(xdg), 120_000, "rust cold sync");
    // Let the tail of the cycle (logs, lock release) settle, then sample.
    await sleep(400);
    const vmHwmKb = readStatus(child.pid, "VmHWM");
    const vmRssKb = readStatus(child.pid, "VmRSS");
    return {
      wallMs: Date.now() - started,
      vmHwmKb,
      vmRssKb,
      stderrTail: stderr().slice(-400),
    };
  } finally {
    child.kill("SIGKILL");
    await new Promise((resolve) => child.on("exit", resolve));
    rmSync(xdg, { recursive: true, force: true });
  }
}

async function runRustNoChange() {
  // Same volume as a fresh cold run: the fresh release_meta must skip the
  // network entirely — measure the no-change cycle peak and wall time.
  const cold = await runRustCold();
  const xdg = mkdtempSync(join(tmpdir(), "prts-bench-rust-nc-"));
  // Seed the volume by one cold sync first.
  const seed = spawnRustHttp(xdg);
  try {
    await waitUntil(() => pairReady(xdg), 120_000, "no-change seed");
  } finally {
    seed.child.kill("SIGKILL");
    await new Promise((resolve) => seed.child.on("exit", resolve));
  }
  const started = Date.now();
  const { child, stderr } = spawnRustHttp(xdg);
  try {
    await waitUntil(
      () => stderr().includes("Storyjson is up to date"),
      120_000,
      "rust no-change cycle",
    );
    await sleep(300);
    return {
      wallMs: Date.now() - started,
      vmHwmKb: readStatus(child.pid, "VmHWM"),
      vmRssKb: readStatus(child.pid, "VmRSS"),
      stderrTail: stderr().slice(-400),
      coldSeed: { wallMs: cold.wallMs, vmHwmKb: cold.vmHwmKb },
    };
  } finally {
    child.kill("SIGKILL");
    await new Promise((resolve) => child.on("exit", resolve));
    rmSync(xdg, { recursive: true, force: true });
  }
}

async function runTsCold() {
  const xdg = mkdtempSync(join(tmpdir(), "prts-bench-ts-"));
  const started = Date.now();
  const child = spawn(process.execPath, [
    join(ROOT, "tools", "ts-interop-peer.mjs"),
    "sync-bench",
    xdg,
    String(mirrorPort),
  ], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      HTTPS_PROXY: "http://127.0.0.1:9",
      https_proxy: "http://127.0.0.1:9",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf-8");
  child.stderr.setEncoding("utf-8");
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  const code = await new Promise((resolve) => child.on("exit", resolve));
  const resultLine = stdout.split("\n").filter((l) => l.startsWith("{")).pop();
  const parsed = JSON.parse(resultLine ?? "{}");
  rmSync(xdg, { recursive: true, force: true });
  if (code !== 0) throw new Error(`ts bench leg failed: ${stderr.slice(-500)}`);
  return {
    wallMs: Date.now() - started,
    vmHwmKb: parsed.vmHwmKb,
    vmRssKb: parsed.vmRssKb,
  };
}

// --- run ------------------------------------------------------------------------

const assetSizes = Object.fromEntries(
  ASSETS.map((name) => [name, statSync(join(DATA, name)).size]),
);
const manifest = JSON.parse(readFileSync(join(DATA, "manifest.json"), "utf-8"));

const rustCold = [];
const rustNoChange = [];
const tsCold = [];
for (let round = 1; round <= ROUNDS; round++) {
  rustCold.push(await runRustCold());
  console.log(`round ${round}/${ROUNDS}: rust cold ${rustCold.at(-1).wallMs}ms peak ${rustCold.at(-1).vmHwmKb}kB`);
  tsCold.push(await runTsCold());
  console.log(`round ${round}/${ROUNDS}: ts cold   ${tsCold.at(-1).wallMs}ms peak ${tsCold.at(-1).vmHwmKb}kB`);
}
// One no-change sample set (seeded cold + fresh process).
for (let round = 1; round <= ROUNDS; round++) {
  rustNoChange.push(await runRustNoChange());
  console.log(`round ${round}/${ROUNDS}: rust no-change ${rustNoChange.at(-1).wallMs}ms peak ${rustNoChange.at(-1).vmHwmKb}kB`);
}

const summary = (samples, key) => {
  const values = samples.map((s) => s[key]).sort((a, b) => a - b);
  return { min: values[0], median: values[Math.floor(values.length / 2)], max: values.at(-1) };
};

const report = {
  schema: "prts-rust-plan/p2-bench/v1",
  recorded_at: new Date().toISOString(),
  subject: "sync peak measurement — cold sync + no-change cycle of the pinned real release",
  release: {
    tag: TAG,
    manifest_contract_version: manifest.contractVersion,
    manifest_publication_revision: manifest.publicationRevision,
    asset_bytes: assetSizes,
    total_bytes: Object.values(assetSizes).reduce((a, b) => a + b, 0),
  },
  determinism: {
    mirror: `http://127.0.0.1:${mirrorPort} (ghproxy-style, local loopback)`,
    direct_github: "routed through a dead proxy (127.0.0.1:9) so candidates cascade to the mirror",
    ts_leg_runtime: `node ${process.version} (the TS transport's undici proxy branch; Bun ignores proxy env vars, noted honestly)`,
    rust_bin: RUST_BIN,
    rounds: ROUNDS,
  },
  rust_cold_sync: {
    samples: rustCold,
    wall_ms: summary(rustCold, "wallMs"),
    vm_hwm_kb: summary(rustCold, "vmHwmKb"),
    vm_rss_kb: summary(rustCold, "vmRssKb"),
  },
  rust_no_change_sync: {
    samples: rustNoChange,
    wall_ms: summary(rustNoChange, "wallMs"),
    vm_hwm_kb: summary(rustNoChange, "vmHwmKb"),
    vm_rss_kb: summary(rustNoChange, "vmRssKb"),
  },
  ts_cold_sync: {
    samples: tsCold,
    wall_ms: summary(tsCold, "wallMs"),
    vm_hwm_kb: summary(tsCold, "vmHwmKb"),
    vm_rss_kb: summary(tsCold, "vmRssKb"),
  },
  notes: [
    "Rust downloads stream to temp files with incremental sha256 (docs/02 deviation); TS buffers each arrayBuffer before writing.",
    "TS-leg baseline includes the node runtime (~tens of MB); compare the DELTA against the ~60 MB package set, not absolute equality.",
    "VmHWM is the kernel high-water mark of RSS for the whole process lifetime.",
  ],
};

mkdirSync(join(ROOT, "artifacts"), { recursive: true });
const out = join(ROOT, "artifacts", "p2-bench.json");
writeFileSync(out, JSON.stringify(report, null, 2) + "\n", "utf-8");
console.log(`\nbench: ${ROUNDS} rounds each; artifact: ${out}`);
mirror.close();
