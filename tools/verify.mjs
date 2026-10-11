#!/usr/bin/env node
/**
 * Differential verification runner (P0 deliverable).
 *
 * Fixed entrypoints per docs/06-validation.md:
 *   node tools/verify.mjs --phase P0        oracle self-check (repeat + mutation)
 *   node tools/verify.mjs --phase P1..P8    TS-vs-Rust differential
 *   node tools/verify.mjs --all             offline deterministic set (highest phase)
 *   node tools/verify.mjs --live            live interop cases (separate opt-in)
 *   node tools/verify.mjs --bench           performance cases (separate opt-in)
 *   node tools/verify.mjs --update-golden   re-record goldens from the TS oracle
 *
 * The runner owns handshake, request ids, ports, timeouts, stdout/stderr
 * capture and subprocess cleanup. Raw responses and diffs are written under
 * artifacts/runs/. Exit code is non-zero when any case fails.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TS = join(ROOT, ".reference", "ts-v2.8.1", "ts");
const CASES = join(ROOT, "contracts", "cases");
const ARTIFACTS = join(ROOT, "artifacts", "runs");

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const flagValue = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const PHASE_ARG = flagValue("--phase") ?? (flag("--all") ? "ALL" : null);
const ONLY = flagValue("--only");
const RUST_BIN = flagValue("--rust-bin")
  ?? process.env.RUST_BIN
  ?? [join(ROOT, "target", "release", "prts-mcp-rust"), join(ROOT, "target", "debug", "prts-mcp-rust")].find((p) => existsSync(p))
  ?? null;

if (!PHASE_ARG && !flag("--update-golden")) {
  console.error("usage: node tools/verify.mjs --phase Pn | --all | --live | --bench | --update-golden [--only substr] [--rust-bin path]");
  process.exit(2);
}

const TS_RUNTIME = flagValue("--ts-runtime") ?? "bun";
const MANIFEST = JSON.parse(readFileSync(join(CASES, "manifest.json"), "utf-8"));
const SERVER_VERSION = JSON.parse(readFileSync(join(TS, "package.json"), "utf-8")).version;
const BUN_VERSION = execFileSync("bun", ["--version"], { encoding: "utf-8" }).trim();

// ---------------------------------------------------------------------------
// Server process management
// ---------------------------------------------------------------------------

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function datasetDir(name) {
  if (name === "empty") return join(ROOT, ".runtime", "fixtures", "empty-gamedata-v1");
  if (name === "minimal-gamedata-v1") return join(ROOT, ".runtime", "fixtures", "minimal-gamedata-v1");
  throw new Error(`unknown dataset ${name}`);
}

/** Clean-env whitelist for oracle/rust children — no inherited tokens or data roots. */
function childEnv(dataset, extra = {}) {
  const data = datasetDir(dataset);
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GAMEDATA_PATH: data,
    STORYJSON_PATH: join(data, "does-not-exist.zip"),
    GITHUB_MIRRORS: "",
    IMAGES_ENABLED: "true",
    HOST: "127.0.0.1",
    ...extra,
  };
}

async function startHttp(kind, dataset, extraEnv = {}) {
  const port = await freePort();
  const command = kind === "ts"
    ? { cmd: TS_RUNTIME, argv: [join(TS, "dist", "server.js")] }
    : { cmd: RUST_BIN, argv: ["--transport", "http"] };
  if (!command.cmd) throw new Error("no Rust binary found; build it or pass --rust-bin");
  const child = spawn(command.cmd, command.argv, {
    env: childEnv(dataset, { PORT: String(port), ...extraEnv }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf-8");
  child.stderr.on("data", (d) => { stderr += d; });
  let stdout = "";
  child.stdout.setEncoding("utf-8");
  child.stdout.on("data", (d) => { stdout += d; });
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      const res = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(300) });
      if (res.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`${kind} server did not start. stderr: ${stderr.slice(-500)} stdout: ${stdout.slice(-200)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  return { child, origin, stderr: () => stderr, stdout: () => stdout };
}

// ---------------------------------------------------------------------------
// Wire helpers (mirror capture-wire.mjs shapes)
// ---------------------------------------------------------------------------

const LEGACY_INIT = (protocolVersion, id = 1) => ({
  jsonrpc: "2.0", method: "initialize", id,
  params: { protocolVersion, capabilities: {}, clientInfo: { name: "diff-runner", version: "1.0" } },
});
const INITIALIZED = { jsonrpc: "2.0", method: "notifications/initialized" };
const MODERN_VERSION = "2026-07-28";
const modernMessage = (method, params, id) => ({
  jsonrpc: "2.0", method, id,
  params: { ...params, _meta: {
    "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
    "io.modelcontextprotocol/clientInfo": { name: "diff-runner-modern", version: "1.0" },
    "io.modelcontextprotocol/clientCapabilities": {},
  } },
});
function modernHeaders(method, params) {
  const h = { "MCP-Protocol-Version": MODERN_VERSION, "Mcp-Method": method };
  if (method === "tools/call") h["Mcp-Name"] = String(params.name);
  return h;
}

/** Parse an HTTP response body that may be JSON or an SSE event stream. */
function parseBody(bodyText, contentType) {
  if (bodyText === "" || bodyText === undefined) return null;
  if ((contentType ?? "").includes("event-stream")) {
    const events = [];
    for (const block of bodyText.split(/\n\n+/)) {
      const data = block.split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.replace(/^data:\s?/, ""))
        .join("\n");
      if (data) {
        try { events.push(JSON.parse(data)); } catch { events.push({ unparsable: data }); }
      }
    }
    return { sse: true, events };
  }
  try { return { sse: false, body: JSON.parse(bodyText) }; } catch { return { sse: false, unparsable: bodyText }; }
}

async function httpPost(origin, path, body, headers = {}) {
  const res = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  const outHeaders = {};
  for (const name of ["content-type", "mcp-session-id"]) {
    const v = res.headers.get(name);
    if (v !== null) outHeaders[name] = v;
  }
  return { status: res.status, headers: outHeaders, body_text: text };
}

// stdio child management ------------------------------------------------------

function startStdio(kind, dataset, extraEnv = {}) {
  const command = kind === "ts"
    ? { cmd: TS_RUNTIME, argv: [join(TS, "dist", "server-stdio.js")] }
    : { cmd: RUST_BIN, argv: ["--transport", "stdio"] };
  if (!command.cmd) throw new Error("no Rust binary found");
  const child = spawn(command.cmd, command.argv, {
    env: childEnv(dataset, extraEnv), stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf-8");
  child.stderr.on("data", (d) => { stderr += d; });
  let stdoutExtra = "";
  child.stdout.setEncoding("utf-8");
  child.stdout.on("data", (d) => { stdoutExtra += d; });
  return {
    child, stderr: () => stderr,
    /** Bytes received outside the recv() framing window — stdout pollution detector. */
    stdoutPollution: () => stdoutExtra,
  };
}

function stdioSend(child, msg) { child.stdin.write(JSON.stringify(msg) + "\n"); }

function stdioRecv(child, id, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const done = (value) => {
      child.stdout.off("data", onData);
      clearTimeout(timer);
      resolve(value);
    };
    const onData = (chunk) => {
      buffer += chunk;
      for (const block of buffer.split(/\n\n+|\n/)) {
        const trimmed = block.trim();
        if (!trimmed) continue;
        let parsed;
        try { parsed = JSON.parse(trimmed); } catch { continue; }
        if (parsed.id === id) { done(parsed); return; }
      }
    };
    const timer = setTimeout(() => {
      child.stdout.off("data", onData);
      reject(new Error(`stdio recv timeout for id=${id}; buffer=${JSON.stringify(buffer.slice(0, 300))}`));
    }, timeoutMs);
    child.stdout.on("data", onData);
  });
}

// ---------------------------------------------------------------------------
// Case execution
// ---------------------------------------------------------------------------

/**
 * Execute one case against one implementation (ts|rust).
 * Returns a normalized observable: {status, content_type, session_id, body}
 * where body is the parsed JSON-RPC message for the case's request id.
 */
async function runCase(kind, c) {
  const channelEnv = c.channel && c.channel !== "content" && c.transport === "stdio"
    ? { PRTS_OUTPUT_CHANNEL: c.channel } : {};
  const dataset = c.dataset ?? "minimal-gamedata-v1";

  if (c.transport === "http") {
    const extraEnv = { ...channelEnv, ...(c.env ?? {}) };
    const server = await startHttp(kind, dataset, extraEnv);
    try {
      const query = c.transport_option === "query-channel" ? `?output_channel=${c.channel}` : "";
      const path = `/mcp${query}`;
      let headers = {};
      if (c.transport_option === "header-channel") headers = { "x-prts-output-channel": c.channel };

      if (c.era === "legacy") {
        if (c.env?.DIFF_STALE_INIT_SESSION === "1") {
          // Stale-session initialize recovery: the handshake request itself
          // carries an unknown session id the server must strip.
          const res = await httpPost(server.origin, path, c.request, {
            ...headers, "mcp-session-id": "00000000-0000-4000-8000-000000000000",
          });
          return normalizeObservable(normalizeHttp(res, c, c.request.id), c, dataset);
        }
        if (c.request.method === "initialize") {
          // The case's observable is the initialize response itself — it IS
          // the handshake; no pre-established session.
          const res = await httpPost(server.origin, path, c.request, headers);
          return normalizeObservable(normalizeHttp(res, c, c.request.id), c, dataset);
        }
        const init = await httpPost(server.origin, path, LEGACY_INIT("2025-03-26", 9001), headers);
        const sid = init.headers["mcp-session-id"];
        if (!sid) throw new Error("no session id from initialize");
        await httpPost(server.origin, path, INITIALIZED, { "mcp-session-id": sid });
        if (c.wait_ms) await new Promise((r) => setTimeout(r, c.wait_ms));
        const headers2 = { ...headers, "mcp-session-id": sid };
        if (c.env?.DIFF_FORCE_UNKNOWN_SESSION === "1") {
          // Stale-session probe: the observable is the 404 the server must
          // return for a non-initialize request carrying an unknown id.
          const res = await httpPost(server.origin, path, c.request, { "mcp-session-id": "00000000-0000-4000-8000-000000000000" });
          return normalizeObservable(normalizeHttp(res, c, c.request.id), c, dataset);
        }
        const res = await httpPost(server.origin, path, c.request, headers2);
        return normalizeObservable(normalizeHttp(res, c, c.request.id), c, dataset);
      }
      // modern
      let req = { ...c.request, params: { ...c.request.params, _meta: {
        "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
        "io.modelcontextprotocol/clientInfo": { name: "diff-runner-modern", version: "1.0" },
        "io.modelcontextprotocol/clientCapabilities": {},
      } } };
      let mHeaders = modernHeaders(c.request.method, c.request.params);
      if (c.env?.DIFF_STRIP_ENVELOPE === "1") {
        // Era-boundary probe: modern headers stay, _meta envelope is removed —
        // the request must NOT be silently downgraded to the legacy router.
        req = c.request;
      }
      const res = await httpPost(server.origin, path, req, mHeaders);
      return normalizeObservable(normalizeHttp(res, c, c.request.id), c, dataset);
    } finally {
      server.child.kill();
      await new Promise((r) => server.child.on("exit", r));
    }
  }

  // stdio
  const proc = startStdio(kind, dataset, channelEnv);
  try {
    if (c.era === "legacy" && c.request.method !== "initialize") {
      stdioSend(proc.child, LEGACY_INIT("2024-11-05", 9001));
      await stdioRecv(proc.child, 9001);
      stdioSend(proc.child, INITIALIZED);
    }
    let request = c.request;
    if (c.era === "modern" || c.request.method === "server/discover") {
      request = modernizeRequest(c.request);
    }
    stdioSend(proc.child, request);
    const response = await stdioRecv(proc.child, c.request.id);
    return normalizeObservable({
      status: 200, content_type: "stdio", session_id: null, body: response,
    }, c, dataset);
  } finally {
    proc.child.stdin.end();
    proc.child.kill();
    await new Promise((r) => proc.child.on("exit", r));
  }
}

function modernizeRequest(request) {
  return { ...request, params: { ...request.params, _meta: {
    "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
    "io.modelcontextprotocol/clientInfo": { name: "diff-runner-modern", version: "1.0" },
    "io.modelcontextprotocol/clientCapabilities": {},
  } } };
}

function normalizeHttp(res, c, wantId) {
  const parsed = parseBody(res.body_text, res.headers["content-type"]);
  let body;
  if (parsed === null) {
    body = null;
  } else if (parsed.sse) {
    body = parsed.events.find((e) => e && e.id === wantId) ?? parsed.events[0] ?? null;
  } else {
    body = parsed.body ?? parsed;
  }
  return {
    status: res.status,
    content_type: (res.headers["content-type"] ?? "").split(";")[0].trim(),
    session_id: res.headers["mcp-session-id"] ?? null,
    body,
  };
}

const D001_VERSIONS = new Set(["2.8.1", "0.1.0+ts2.8.1.local"]);

/** Apply the case's declared allow-list normalizations to an observable. */
function normalizeObservable(observed, c, dataset) {
  let body = observed.body;
  if (c.normalizations?.includes("map-sandbox-path")) {
    const root = datasetDir(dataset);
    const replaceRoot = (value) => {
      if (typeof value === "string") return value.split(root).join("<gamedata-root>");
      if (value === null || typeof value !== "object") return value;
      if (Array.isArray(value)) return value.map(replaceRoot);
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = replaceRoot(v);
      return out;
    };
    body = replaceRoot(body);
  }
  if (c.normalizations?.includes("map-version-d001")) {
    // D-001: Rust's local build identity differs from the TS release number
    // by design; serverInfo.version placeholders make both comparable.
    const replaceVersion = (value) => {
      if (typeof value === "string") return D001_VERSIONS.has(value) ? "<server-version>" : value;
      if (value === null || typeof value !== "object") return value;
      if (Array.isArray(value)) return value.map(replaceVersion);
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = replaceVersion(v);
      return out;
    };
    body = replaceVersion(body);
  }
  return { ...observed, body };
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/** Deep equality with parsed-JSON semantics: object key order ignored, 1 === 1.0. */
function deepEqual(a, b, path = "$", diffs = []) {
  if (typeof a === "number" && typeof b === "number") {
    if (Number.isNaN(a) && Number.isNaN(b)) return diffs;
    if (a === b) return diffs;
    diffs.push(`${path}: ${a} !== ${b}`);
    return diffs;
  }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    if (a !== b) diffs.push(`${path}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
    return diffs;
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    diffs.push(`${path}: array/non-array mismatch`);
    return diffs;
  }
  if (Array.isArray(a)) {
    if (a.length !== b.length) diffs.push(`${path}: length ${a.length} !== ${b.length}`);
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) deepEqual(a[i], b[i], `${path}[${i}]`, diffs);
    return diffs;
  }
  const ak = Object.keys(a), bk = Object.keys(b);
  for (const k of ak) if (!(k in b)) diffs.push(`${path}.${k}: present in TS, missing in candidate`);
  for (const k of bk) if (!(k in a)) diffs.push(`${path}.${k}: missing in TS, present in candidate`);
  for (const k of ak) if (k in b) deepEqual(a[k], b[k], `${path}.${k}`, diffs);
  return diffs;
}

function compareObservables(expected, actual, c) {
  const diffs = [];
  if (expected.status !== actual.status) diffs.push(`status: ${expected.status} !== ${actual.status}`);
  if (expected.content_type !== actual.content_type) diffs.push(`content_type: ${expected.content_type} !== ${actual.content_type}`);
  const sidNormalizations = c.normalizations?.includes("bind-session-id");
  if (!sidNormalizations && expected.session_id !== actual.session_id) {
    diffs.push(`session_id presence: ${expected.session_id ? "present" : "absent"} !== ${actual.session_id ? "present" : "absent"}`);
  } else if (expected.session_id === null !== (actual.session_id === null)) {
    diffs.push(`session_id presence mismatch: ${expected.session_id} vs ${actual.session_id}`);
  }
  if (c.compare === "exact-status-only") {
    return diffs;
  }
  deepEqual(expected.body, actual.body, "$.body", diffs);
  return diffs;
}

// ---------------------------------------------------------------------------
// Golden management
// ---------------------------------------------------------------------------

function goldenPath(c) { return join(CASES, "golden", `${c.id}.json`); }

async function updateGolden() {
  const cases = selectableCases("P8", { golden: false });
  mkdirSync(join(CASES, "golden"), { recursive: true });
  let n = 0;
  for (const c of cases) {
    const observed = await runCase("ts", c);
    const golden = {
      case: c.id,
      source: "ts-oracle",
      recorded_with: { runtime: `bun ${BUN_VERSION}`, server_version: SERVER_VERSION },
      dataset: c.dataset ?? "minimal-gamedata-v1",
      expected: observed,
    };
    writeFileSync(goldenPath(c), JSON.stringify(golden, null, 2) + "\n", "utf-8");
    n++;
    console.log(`golden ${c.id}`);
  }
  console.log(`${n} goldens written`);
}

// ---------------------------------------------------------------------------
// Case selection
// ---------------------------------------------------------------------------

const PHASE_ORDER = ["P0", "P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8"];
function phaseRank(p) { return PHASE_ORDER.indexOf(p); }

function selectableCases(phase, { live = false, deferSurface = true }) {
  return MANIFEST.cases.filter((c) => {
    if (ONLY && !c.id.includes(ONLY)) return false;
    if (!!c.live !== live) return false;
    // diff_phase defers full-surface cases (e.g. 24-tool tools/list) until
    // the registry catches up; oracle self-checks always use `phase`.
    const cp = deferSurface ? (c.diff_phase ?? c.phase ?? "P0") : (c.phase ?? "P0");
    if (phase === "ALL" || phaseRank(phase) >= phaseRank(cp)) return true;
    return false;
  });
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

function artifactDir() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dir = join(ARTIFACTS, stamp);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf-8");
}

/** P0 oracle self-check: same TS twice → equal; mutated capture → comparator fires. */
async function selfCheckP0() {
  const cases = selectableCases("P0", { live: false, deferSurface: false });
  if (cases.length === 0) throw new Error("no P0 cases selected");
  const dir = artifactDir();
  const startedAt = Date.now();
  const results = [];

  const runAll = async (tag) => {
    const out = new Map();
    for (const c of cases) {
      const observed = await runCase("ts", c);
      writeJson(join(dir, `${c.id}.${tag}.raw.json`), observed);
      out.set(c.id, observed);
    }
    return out;
  };

  const run1 = await runAll("run1");
  const run2 = await runAll("run2");

  let repeatFailures = 0;
  for (const c of cases) {
    const diffs = compareObservables(run1.get(c.id), run2.get(c.id), c);
    if (diffs.length > 0) {
      repeatFailures++;
      writeJson(join(dir, `${c.id}.repeat-diff.json`), diffs);
      results.push({ id: c.id, status: "fail", reason: "repeat run diverged", diffs });
      console.log(`FAIL ${c.id}: repeat divergence (${diffs.length} diffs)`);
    }
  }

  // Mutation check: tamper with one captured result; the comparator must fire.
  const target = cases.find((c) => c.id === "stage.list.default") ?? cases[0];
  const mutated = structuredClone(run2.get(target.id));
  const mutatedNote = mutateObservables(mutated);
  const mutationDiffs = compareObservables(run2.get(target.id), mutated, target);
  const mutationCaught = mutationDiffs.length > 0;
  if (!mutationCaught) {
    results.push({ id: target.id, status: "fail", reason: "mutation was NOT detected" });
    console.log(`FAIL mutation-check: tampering (${mutatedNote}) produced no diff — comparator is blind`);
  } else {
    console.log(`ok   mutation-check: tampering (${mutatedNote}) detected with ${mutationDiffs.length} diffs`);
  }

  // Golden freshness: every selected case must have a golden on disk.
  let goldenMissing = 0;
  for (const c of cases) {
    if (!existsSync(goldenPath(c))) {
      goldenMissing++;
      results.push({ id: c.id, status: "blocked", reason: "golden missing (run --update-golden)" });
      console.log(`BLOCKED ${c.id}: golden missing`);
    }
  }

  const passed = cases.length - repeatFailures - goldenMissing;
  const report = {
    mode: "P0-oracle-selfcheck",
    command: `node tools/verify.mjs ${args.join(" ")}`,
    started_at: new Date(startedAt).toISOString(),
    duration_ms: Date.now() - startedAt,
    ts: { runtime: `${TS_RUNTIME} ${TS_RUNTIME === "bun" ? BUN_VERSION : process.version}`, server_version: SERVER_VERSION },
    dataset: "minimal-gamedata-v1 (+empty)",
    counts: { total: cases.length, pass: passed, fail: repeatFailures, blocked: goldenMissing, not_run: 0 },
    mutation_check: { target: target.id, mutation: mutatedNote, detected: mutationCaught },
    artifacts_dir: dir,
    failures: results,
  };
  writeJson(join(dir, "P0-selfcheck.json"), report);
  console.log(`\nP0 self-check: ${passed}/${cases.length} pass, ${repeatFailures} fail, ${goldenMissing} blocked; mutation detected=${mutationCaught}`);
  console.log(`artifacts: ${dir}`);
  return repeatFailures === 0 && mutationCaught && goldenMissing === 0 ? 0 : 1;
}

function mutateObservables(observed) {
  const body = observed?.body;
  if (body?.result?.structuredContent && "total" in body.result.structuredContent) {
    body.result.structuredContent.total += 1;
    return "structuredContent.total += 1";
  }
  if (body?.result?.content?.[0]?.text) {
    body.result.content[0].text += " tampered";
    return "content[0].text += ' tampered'";
  }
  if (body?.result?.protocolVersion) {
    body.result.protocolVersion = "1999-01-01";
    return "protocolVersion overwritten";
  }
  if (body?.error?.message) {
    body.error.message += " tampered";
    return "error.message += ' tampered'";
  }
  observed.status = (observed.status ?? 200) + 1;
  return "status += 1";
}

/** Differential mode: golden (TS) vs implementation under test. */
async function differential(phase) {
  const useRust = phase !== "P0";
  if (useRust && !RUST_BIN) {
    console.error("no Rust binary found; build with cargo build --locked --release or pass --rust-bin");
    return 2;
  }
  const cases = selectableCases(phase, { live: false });
  if (cases.length === 0) { console.log(`no cases selectable for ${phase}`); return 0; }
  const dir = artifactDir();
  const startedAt = Date.now();
  const results = [];
  let pass = 0, fail = 0, blocked = 0;

  for (const c of cases) {
    const gp = goldenPath(c);
    if (!existsSync(gp)) {
      blocked++;
      results.push({ id: c.id, status: "blocked", reason: "golden missing" });
      console.log(`BLOCKED ${c.id}: golden missing`);
      continue;
    }
    const golden = JSON.parse(readFileSync(gp, "utf-8"));
    try {
      const actual = useRust ? await runCase("rust", c) : golden.expected;
      writeJson(join(dir, `${c.id}.actual.json`), actual);
      const diffs = compareObservables(golden.expected, actual, c);
      if (diffs.length === 0) {
        pass++;
        results.push({ id: c.id, status: "pass" });
        console.log(`ok   ${c.id}`);
      } else {
        fail++;
        writeJson(join(dir, `${c.id}.diff.json`), diffs);
        results.push({ id: c.id, status: "fail", diffs });
        console.log(`FAIL ${c.id}: ${diffs.length} diffs → ${join(dir, `${c.id}.diff.json`)}`);
      }
    } catch (err) {
      fail++;
      results.push({ id: c.id, status: "fail", reason: String(err?.message ?? err).slice(0, 400) });
      console.log(`FAIL ${c.id}: ${String(err?.message ?? err).slice(0, 200)}`);
    }
  }

  const report = {
    mode: `differential-${phase}`,
    command: `node tools/verify.mjs ${args.join(" ")}`,
    started_at: new Date(startedAt).toISOString(),
    duration_ms: Date.now() - startedAt,
    ts: { runtime: `${TS_RUNTIME} ${TS_RUNTIME === "bun" ? BUN_VERSION : process.version}`, server_version: SERVER_VERSION },
    rust: useRust ? RUST_BIN : null,
    dataset: "minimal-gamedata-v1 (+empty)",
    counts: { total: cases.length, pass, fail, blocked, not_run: 0 },
    artifacts_dir: dir,
    results,
  };
  writeJson(join(dir, `${phase}-differential.json`), report);
  console.log(`\n${phase}: ${pass}/${cases.length} pass, ${fail} fail, ${blocked} blocked`);
  console.log(`artifacts: ${dir}`);
  return fail === 0 && blocked === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------

let exitCode;
if (flag("--update-golden")) {
  await updateGolden();
  exitCode = 0;
} else if (PHASE_ARG === "--live" || flag("--live")) {
  console.log("live: no live cases defined in this phase — not-run (nothing claimed)");
  exitCode = 0;
} else if (flag("--bench")) {
  console.log("bench: no bench cases defined in this phase — not-run (nothing claimed)");
  exitCode = 0;
} else if (PHASE_ARG === "P0") {
  exitCode = await selfCheckP0();
} else {
  exitCode = await differential(PHASE_ARG);
}
process.exit(exitCode);
