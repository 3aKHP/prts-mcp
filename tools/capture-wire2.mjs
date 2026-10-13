#!/usr/bin/env node
/**
 * Supplemental P1 wire probes: Zod error text shapes, Accept negotiation,
 * batch/notification edges, stdio framing edges. Stored under
 * contracts/wire/supplemental/. Same isolated-oracle rules as capture-wire.mjs.
 *
 * Usage: node tools/capture-wire2.mjs
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TS = join(ROOT, ".reference", "ts-v2.8.1", "ts");
const FIXTURE = join(ROOT, ".runtime", "fixtures", "minimal-gamedata-v1");
const OUT = join(ROOT, "contracts", "wire", "supplemental");

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

function oracleEnv(extra = {}) {
  return {
    PATH: process.env.PATH, HOME: process.env.HOME,
    GAMEDATA_PATH: FIXTURE,
    STORYJSON_PATH: join(FIXTURE, "does-not-exist.zip"),
    GITHUB_MIRRORS: "", IMAGES_ENABLED: "true", HOST: "127.0.0.1",
    ...extra,
  };
}

async function startHttp(port) {
  const child = spawn("bun", [join(TS, "dist", "server.js")], {
    env: oracleEnv({ PORT: String(port) }), stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf-8");
  child.stderr.on("data", (d) => { stderr += d; });
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      const res = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(300) });
      if (res.ok) break;
    } catch { /* retry */ }
    if (Date.now() > deadline) throw new Error(`oracle did not start: ${stderr.slice(-300)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  return { child, origin };
}

async function ex(origin, { method = "POST", headers = {}, body, path = "/mcp" }) {
  let bodyText;
  if (body !== undefined) {
    bodyText = typeof body === "string" ? body : JSON.stringify(body);
    headers = { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers };
  }
  const res = await fetch(`${origin}${path}`, { method, headers, body: bodyText, signal: AbortSignal.timeout(15000) });
  const text = await res.text();
  const outHeaders = {};
  for (const name of ["content-type", "mcp-session-id", "allow"]) {
    const v = res.headers.get(name);
    if (v !== null) outHeaders[name] = v;
  }
  return { status: res.status, headers: outHeaders, body_text: text };
}

const INIT = (id = 1) => ({
  jsonrpc: "2.0", method: "initialize", id,
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "probe2", version: "1.0" } },
});
const INITIALIZED = { jsonrpc: "2.0", method: "notifications/initialized" };
const CALL = (args, id) => ({ jsonrpc: "2.0", method: "tools/call", id, params: { name: "list_stages", arguments: args } });

function write(name, steps) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify({
    capture_meta: { runtime: "bun 1.3.14", server_version: "2.8.1", fixture: "minimal-gamedata-v1", captured_at: new Date().toISOString() },
    steps,
  }, null, 2) + "\n", "utf-8");
  console.log(`captured supplemental/${name}.json`);
}

const port = await freePort();
const { child, origin } = await startHttp(port);
try {
  // 1. Zod validation error shapes on list_stages (schema-first rejection).
  const init = await ex(origin, { body: INIT(1) });
  const sid = init.headers["mcp-session-id"];
  const H = { "mcp-session-id": sid };
  await ex(origin, { body: INITIALIZED, headers: H });
  const zodSteps = [{ label: "initialize", request: { body: INIT(1) }, response: init }];
  const probes = [
    ["limit wrong type (string)", { limit: "5" }],
    ["limit non-integer (1.5)", { limit: 1.5 }],
    ["limit 1.0 float-integral", { limit: 1.0 }],
    ["limit below min (0)", { limit: 0 }],
    ["offset negative", { offset: -1 }],
    ["offset float", { offset: 1.5 }],
    ["chapter null", { chapter: null }],
    ["type null", { type: null }],
    ["unknown extra argument", { chapter: "main_0", nonsense: true }],
    ["arguments key missing", undefined],
    ["arguments null", null],
    ["chapter wrong type (number)", { chapter: 5 }],
  ];
  for (const [i, [label, args]] of probes.entries()) {
    const body = args === undefined
      ? { jsonrpc: "2.0", method: "tools/call", id: 100 + i, params: { name: "list_stages" } }
      : args === null
        ? { jsonrpc: "2.0", method: "tools/call", id: 100 + i, params: { name: "list_stages", arguments: null } }
        : CALL(args, 100 + i);
    const res = await ex(origin, { body, headers: H });
    zodSteps.push({ label, request: { body }, response: res });
  }
  // double initialize on an established session
  const dbl = await ex(origin, { body: INIT(2), headers: H });
  zodSteps.push({ label: "second initialize on live session", request: { body: INIT(2) }, response: dbl });
  write("zod-and-double-init", zodSteps);

  // 2. Accept negotiation + method edges.
  const edgeSteps = [];
  const jsonOnly = await ex(origin, { body: { jsonrpc: "2.0", method: "tools/list", id: 3 }, headers: { ...H, accept: "application/json" } });
  edgeSteps.push({ label: "legacy POST Accept: application/json only", request: { headers: { accept: "application/json" } }, response: jsonOnly });

  const noContentType = await ex(origin, { body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 4 }), headers: { ...H, "content-type": "", accept: "application/json, text/event-stream" } });
  edgeSteps.push({ label: "POST without content-type", request: { headers: { "content-type": "" } }, response: noContentType });

  const getSseNoSession = await ex(origin, { method: "GET", headers: { accept: "text/event-stream" } });
  edgeSteps.push({ label: "GET /mcp accept=event-stream, no session", request: { method: "GET", headers: { accept: "text/event-stream" } }, response: getSseNoSession });

  const batch = await ex(origin, { body: [{ jsonrpc: "2.0", method: "tools/list", id: 5 }, { jsonrpc: "2.0", method: "tools/list", id: 6 }], headers: H });
  edgeSteps.push({ label: "JSON-RPC batch array (legacy session)", request: { body: "(array)" }, response: batch });

  const unknownNotif = await ex(origin, { body: { jsonrpc: "2.0", method: "notifications/cancelled", params: {} }, headers: H });
  edgeSteps.push({ label: "unknown notification on session", request: { body: "(notification)" }, response: unknownNotif });

  const notInitializedNotif = await ex(origin, { body: INITIALIZED });
  edgeSteps.push({ label: "notifications/initialized without session", request: { body: "(notification)" }, response: notInitializedNotif });
  write("http-edges2", edgeSteps);

  // 3. Idle eviction (short timeout on a dedicated server).
  const port2 = await freePort();
  const { child: child2, origin: origin2 } = await startHttpEnv(port2, { SESSION_IDLE_TIMEOUT_MS: "1200" });
  try {
    const idleSteps = [];
    const init2 = await ex(origin2, { body: INIT(1) });
    const sid2 = init2.headers["mcp-session-id"];
    idleSteps.push({ label: "initialize (idle timeout 1200ms)", request: { body: INIT(1) }, response: init2 });
    await ex(origin2, { body: INITIALIZED, headers: { "mcp-session-id": sid2 } });
    const before = await ex(origin2, { body: { jsonrpc: "2.0", method: "tools/list", id: 2 }, headers: { "mcp-session-id": sid2 } });
    idleSteps.push({ label: "tools/list before idle (touch resets budget)", request: { body: "(tools/list)" }, response: before });
    await new Promise((r) => setTimeout(r, 2500));
    const after = await ex(origin2, { body: { jsonrpc: "2.0", method: "tools/list", id: 3 }, headers: { "mcp-session-id": sid2 } });
    idleSteps.push({ label: "tools/list after idle expiry (expect 404 -32002)", request: { body: "(tools/list)" }, response: after });
    write("session-idle-eviction", idleSteps);
  } finally {
    child2.kill();
    await new Promise((r) => child2.on("exit", r));
  }
} finally {
  child.kill();
  await new Promise((r) => child.on("exit", r));
}

// stdio framing edges ---------------------------------------------------------

function startStdio(extraEnv = {}) {
  const child = spawn("bun", [join(TS, "dist", "server-stdio.js")], {
    env: oracleEnv(extraEnv), stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf-8");
  child.stderr.on("data", (d) => { stderr += d; });
  return { child, stderr: () => stderr };
}
function send(child, msg) { child.stdin.write(typeof msg === "string" ? msg : JSON.stringify(msg) + "\n"); }
function recv(child, id, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk.toString("utf-8");
      for (const line of buffer.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          const parsed = JSON.parse(t);
          if (parsed.id === id) {
            child.stdout.off("data", onData); clearTimeout(timer); resolve(parsed); return;
          }
        } catch { continue; }
      }
    };
    const timer = setTimeout(() => { child.stdout.off("data", onData); reject(new Error(`timeout id=${id} buf=${buffer.slice(0, 200)}`)); }, timeoutMs);
    child.stdout.on("data", onData);
  });
}

{
  const { child, stderr } = startStdio();
  const steps = [];
  const bad = recvAny(child, 4000);
  send(child, "{this is not json\n");
  let badResult;
  try { badResult = await bad; } catch (e) { badResult = { timeout: String(e).slice(0, 120) }; }
  steps.push({ label: "invalid JSON line", request: "{this is not json", response: badResult });

  send(child, "");
  send(child, "\n");
  steps.push({ label: "blank lines", request: "(blank)", response: { note: "no output expected" } });

  send(child, { jsonrpc: "2.0", method: "notifications/initialized" });
  steps.push({ label: "notification (no id)", request: "(notification)", response: { note: "no output expected" } });

  send(child, INIT(10));
  steps.push({ label: "initialize", request: INIT(10), response: await recv(child, 10) });
  send(child, INITIALIZED);
  send(child, { jsonrpc: "2.0", method: "no/such/method", id: 11 });
  steps.push({ label: "unknown method", request: "(unknown method)", response: await recv(child, 11) });
  send(child, CALL({ limit: "5" }, 12));
  steps.push({ label: "zod error via stdio", request: "(call limit=5 string)", response: await recv(child, 12) });
  child.stdin.end();
  const code = await new Promise((r) => child.on("exit", (c) => r(c)));
  writeTo(join(ROOT, "contracts", "wire", "stdio-legacy", "framing-edges.json"), [...steps.map((s) => ({ ...s, request: typeof s.request === "string" ? s.request : "(json)" })), { label: "exit", request: "EOF", response: { code, stderr_tail: stderr().slice(-300) } }]);
}

function writeTo(path, steps) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({
    capture_meta: { runtime: "bun 1.3.14", server_version: "2.8.1", fixture: "minimal-gamedata-v1", captured_at: new Date().toISOString() },
    steps,
  }, null, 2) + "\n", "utf-8");
  console.log(`captured ${path.split("contracts/wire/")[1]}`);
}

function recvAny(child, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.stdout.off("data", onData); reject(new Error("timeout")); }, timeoutMs);
    const onData = (chunk) => {
      const t = chunk.toString("utf-8").trim();
      if (t) { clearTimeout(timer); child.stdout.off("data", onData); try { resolve(JSON.parse(t.split("\n")[0])); } catch { resolve({ raw: t.slice(0, 200) }); } }
    };
    child.stdout.on("data", onData);
  });
}

async function startHttpEnv(port, extraEnv) {
  const child = spawn("bun", [join(TS, "dist", "server.js")], {
    env: oracleEnv({ PORT: String(port), ...extraEnv }), stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf-8");
  child.stderr.on("data", (d) => { stderr += d; });
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      const res = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(300) });
      if (res.ok) break;
    } catch { /* retry */ }
    if (Date.now() > deadline) throw new Error(`oracle did not start: ${stderr.slice(-300)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  return { child, origin };
}
console.log("supplemental capture complete");
