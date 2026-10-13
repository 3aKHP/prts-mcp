#!/usr/bin/env node
/**
 * Capture real MCP wire exchanges from the frozen TS oracle into
 * contracts/wire/. This is the authoritative wire snapshot required by P0 —
 * the Zod declaration export is NOT a wire capture.
 *
 * Every flow runs against an isolated oracle instance (clean env whitelist,
 * fixture GameData, no real data roots, no network sync) so captures never
 * pollute user data.
 *
 * Usage: node tools/capture-wire.mjs [--runtime bun|node]
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TS = join(ROOT, ".reference", "ts-v2.8.1", "ts");
const DIST = join(TS, "dist");
const FIXTURE = join(ROOT, ".runtime", "fixtures", "minimal-gamedata-v1");
const WIRE = join(ROOT, "contracts", "wire");

const RUNTIME = process.argv.includes("--runtime")
  ? process.argv[process.argv.indexOf("--runtime") + 1]
  : "bun";

const SERVER_VERSION = JSON.parse(readFileSync(join(TS, "package.json"), "utf-8")).version;
const RUNTIME_VERSION = RUNTIME === "node" ? process.version : execFileSync(RUNTIME, ["--version"], { encoding: "utf-8" }).trim();

// ---------------------------------------------------------------------------
// Oracle process management
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

/** Environment whitelist — never inherit outer tokens/paths into the oracle. */
function oracleEnv(extra = {}) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GAMEDATA_PATH: FIXTURE,
    STORYJSON_PATH: join(FIXTURE, "does-not-exist.zip"),
    GITHUB_MIRRORS: "",
    IMAGES_ENABLED: "true",
    HOST: "127.0.0.1",
    ...extra,
  };
}

async function startHttpServer(port, extraEnv = {}) {
  const child = spawn(RUNTIME, [join(DIST, "server.js")], {
    env: oracleEnv({ PORT: String(port), ...extraEnv }),
    stdio: ["ignore", "pipe", "pipe"],
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
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`oracle HTTP did not start. stderr: ${stderr}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  return { child, origin, stderr: () => stderr };
}

// ---------------------------------------------------------------------------
// HTTP exchange recorder
// ---------------------------------------------------------------------------

function pickHeaders(res) {
  const out = {};
  for (const name of ["content-type", "mcp-session-id", "mcp-protocol-version", "allow"]) {
    const v = res.headers.get(name);
    if (v !== null) out[name] = v;
  }
  return out;
}

async function httpExchange(origin, { method = "POST", path = "/mcp", headers = {}, body, readForMs = 0 }) {
  const finalHeaders = { ...headers };
  let bodyText;
  if (body !== undefined) {
    bodyText = typeof body === "string" ? body : JSON.stringify(body);
    finalHeaders["content-type"] ??= "application/json";
    finalHeaders["accept"] ??= "application/json, text/event-stream";
  }
  const controller = new AbortController();
  const timer = readForMs > 0 ? setTimeout(() => controller.abort(), readForMs) : null;
  let res;
  try {
    res = await fetch(`${origin}${path}`, {
      method,
      headers: finalHeaders,
      body: bodyText,
      signal: readForMs > 0 ? controller.signal : AbortSignal.timeout(15000),
    });
  } catch (err) {
    if (readForMs > 0 && err.name === "AbortError") {
      return { status: "stream-open-aborted", headers: {}, body_text: "" };
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
  let text = "";
  if (readForMs > 0) {
    // Streaming endpoint (GET SSE): read whatever arrives inside the window.
    const reader = res.body.getReader();
    const chunks = [];
    try {
      const deadline = Date.now() + readForMs;
      while (Date.now() < deadline) {
        const { value, done } = await Promise.race([
          reader.read(),
          new Promise((r) => setTimeout(() => r({ timeout: true }), Math.max(10, deadline - Date.now()))),
        ]);
        if (done || value === undefined) break;
        chunks.push(value);
      }
    } catch { /* aborted */ }
    try { controller.abort(); } catch { /* already */ }
    text = chunks.map((c) => Buffer.from(c).toString("utf-8")).join("");
  } else {
    text = await res.text();
  }
  return { status: res.status, headers: pickHeaders(res), body_text: text };
}

function request2(request) {
  return request.body !== undefined && typeof request.body !== "string"
    ? { ...request, body: request.body }
    : request;
}

function writeFlow(group, name, steps, meta = {}) {
  const dir = join(WIRE, group);
  mkdirSync(dir, { recursive: true });
  const flow = {
    capture_meta: {
      runtime: `${RUNTIME} ${RUNTIME_VERSION}`,
      server_entry: "dist/server.js",
      server_version: SERVER_VERSION,
      fixture: "minimal-gamedata-v1",
      captured_at: new Date().toISOString(),
      ...meta,
    },
    steps,
  };
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(flow, null, 2) + "\n", "utf-8");
  console.log(`captured ${group}/${name}.json (${steps.length} steps)`);
}

// ---------------------------------------------------------------------------
// JSON-RPC message builders (exact oracle test shapes)
// ---------------------------------------------------------------------------

const LEGACY_INIT = (protocolVersion, id = 1) => ({
  jsonrpc: "2.0",
  method: "initialize",
  id,
  params: {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: "wire-capture", version: "1.0" },
  },
});

const INITIALIZED = { jsonrpc: "2.0", method: "notifications/initialized" };

const CALL = (name, args, id) => ({
  jsonrpc: "2.0",
  method: "tools/call",
  id,
  params: { name, arguments: args },
});

const MODERN_VERSION = "2026-07-28";
const modernMessage = (method, params, id) => ({
  jsonrpc: "2.0",
  method,
  id,
  params: {
    ...params,
    _meta: {
      "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
      "io.modelcontextprotocol/clientInfo": { name: "wire-capture-modern", version: "1.0" },
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  },
});

function modernHeaders(method, params) {
  const headers = {
    "MCP-Protocol-Version": MODERN_VERSION,
    "Mcp-Method": method,
  };
  if (method === "tools/call") headers["Mcp-Name"] = String(params.name);
  return headers;
}

async function legacySessionHeaders(origin, protocolVersion = "2025-03-26") {
  const init = await httpExchange(origin, { body: LEGACY_INIT(protocolVersion) });
  const sessionId = init.headers["mcp-session-id"];
  if (!sessionId) throw new Error("initialize did not return a session id");
  await httpExchange(origin, { body: INITIALIZED, headers: { "mcp-session-id": sessionId } });
  return sessionId;
}

// ---------------------------------------------------------------------------
// Flow captures
// ---------------------------------------------------------------------------

async function captureHttpLegacy(origin) {
  // 1. Protocol-version negotiation matrix (each in its own session).
  const versions = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25", "2026-07-28", "1999-01-01"];
  const steps = [];
  for (const [i, v] of versions.entries()) {
    const init = await httpExchange(origin, { body: LEGACY_INIT(v, i + 1) });
    steps.push({
      label: `initialize protocolVersion=${v}`,
      request: request2({ body: LEGACY_INIT(v, i + 1) }),
      response: init,
    });
    const sid = init.headers["mcp-session-id"];
    if (sid) {
      const del = await httpExchange(origin, { method: "DELETE", headers: { "mcp-session-id": sid } });
      steps.push({ label: `DELETE session(${v})`, request: { method: "DELETE", headers: { "mcp-session-id": "«sid»" } }, response: del });
    }
  }
  writeFlow("http-legacy", "initialize-version-negotiation", steps);

  // 2. Full session lifecycle on one session.
  const init = await httpExchange(origin, { body: LEGACY_INIT("2025-03-26", 1) });
  const sid = init.headers["mcp-session-id"];
  const withSid = { "mcp-session-id": sid };
  const lifecycle = [
    { label: "initialize", request: request2({ body: LEGACY_INIT("2025-03-26", 1) }), response: init },
  ];
  const notif = await httpExchange(origin, { body: INITIALIZED, headers: withSid });
  lifecycle.push({ label: "notifications/initialized", request: request2({ body: INITIALIZED, headers: { "mcp-session-id": "«sid»" } }), response: notif });

  const list = await httpExchange(origin, { body: { jsonrpc: "2.0", method: "tools/list", id: 2 }, headers: withSid });
  lifecycle.push({ label: "tools/list", request: request2({ body: { jsonrpc: "2.0", method: "tools/list", id: 2 }, headers: { "mcp-session-id": "«sid»" } }), response: list });

  const callDefault = await httpExchange(origin, { body: CALL("list_stages", {}, 3), headers: withSid });
  lifecycle.push({ label: "tools/call list_stages default", request: request2({ body: CALL("list_stages", {}, 3), headers: { "mcp-session-id": "«sid»" } }), response: callDefault });

  const callFiltered = await httpExchange(origin, { body: CALL("list_stages", { chapter: "main_0", limit: 1 }, 4), headers: withSid });
  lifecycle.push({ label: "tools/call list_stages chapter+limit", request: request2({ body: CALL("list_stages", { chapter: "main_0", limit: 1 }, 4), headers: { "mcp-session-id": "«sid»" } }), response: callFiltered });

  const unknownMethod = await httpExchange(origin, { body: { jsonrpc: "2.0", method: "resources/list", id: 5 }, headers: withSid });
  lifecycle.push({ label: "unknown method", request: request2({ body: { jsonrpc: "2.0", method: "resources/list", id: 5 }, headers: { "mcp-session-id": "«sid»" } }), response: unknownMethod });

  const unknownTool = await httpExchange(origin, { body: CALL("no_such_tool", {}, 6), headers: withSid });
  lifecycle.push({ label: "unknown tool", request: request2({ body: CALL("no_such_tool", {}, 6), headers: { "mcp-session-id": "«sid»" } }), response: unknownTool });

  const badArgs = await httpExchange(origin, { body: CALL("list_stages", { limit: 999 }, 7), headers: withSid });
  lifecycle.push({ label: "list_stages limit out of bounds (schema reject)", request: request2({ body: CALL("list_stages", { limit: 999 }, 7), headers: { "mcp-session-id": "«sid»" } }), response: badArgs });

  const unknownSession = await httpExchange(origin, { body: { jsonrpc: "2.0", method: "tools/list", id: 8 }, headers: { "mcp-session-id": "00000000-0000-4000-8000-000000000000" } });
  lifecycle.push({ label: "unknown session 404", request: request2({ body: { jsonrpc: "2.0", method: "tools/list", id: 8 }, headers: { "mcp-session-id": "«unknown»" } }), response: unknownSession });

  // initialize with the stale id → recovery (server strips and re-initializes)
  const staleInit = await httpExchange(origin, { body: LEGACY_INIT("2025-03-26", 9), headers: { "mcp-session-id": "00000000-0000-4000-8000-000000000000" } });
  lifecycle.push({ label: "initialize with stale session id (recovery)", request: request2({ body: LEGACY_INIT("2025-03-26", 9), headers: { "mcp-session-id": "«unknown»" } }), response: staleInit });

  const del = await httpExchange(origin, { method: "DELETE", headers: withSid });
  lifecycle.push({ label: "DELETE session", request: { method: "DELETE", headers: { "mcp-session-id": "«sid»" } }, response: del });

  const afterDelete = await httpExchange(origin, { body: { jsonrpc: "2.0", method: "tools/list", id: 10 }, headers: withSid });
  lifecycle.push({ label: "tools/list after DELETE", request: request2({ body: { jsonrpc: "2.0", method: "tools/list", id: 10 }, headers: { "mcp-session-id": "«sid»" } }), response: afterDelete });

  writeFlow("http-legacy", "session-lifecycle", lifecycle, { session_id: sid });

  // 3. Transport-level edges: GET/DELETE/notifications/bad JSON/uninitialized.
  const sid2 = await legacySessionHeaders(origin);
  const edges = [];
  const getNoSession = await httpExchange(origin, { method: "GET", path: "/mcp" });
  edges.push({ label: "GET /mcp without session", request: { method: "GET", path: "/mcp" }, response: getNoSession });

  const getSse = await httpExchange(origin, { method: "GET", path: "/mcp", headers: { "mcp-session-id": sid2, accept: "text/event-stream" }, readForMs: 400 });
  edges.push({ label: "GET /mcp SSE (session, 400ms window)", request: { method: "GET", path: "/mcp", headers: { "mcp-session-id": "«sid»", accept: "text/event-stream" } }, response: getSse });

  const postNotif = await httpExchange(origin, { body: { jsonrpc: "2.0", method: "notifications/initialized" }, headers: { "mcp-session-id": sid2 } });
  edges.push({ label: "POST standalone notification", request: request2({ body: { jsonrpc: "2.0", method: "notifications/initialized" }, headers: { "mcp-session-id": "«sid»" } }), response: postNotif });

  const badJson = await httpExchange(origin, { body: "{not json", headers: { "content-type": "application/json", "mcp-session-id": sid2 } });
  edges.push({ label: "POST malformed JSON", request: { body: "{not json", headers: { "content-type": "application/json", "mcp-session-id": "«sid»" } }, response: badJson });

  const uninitialized = await httpExchange(origin, { body: { jsonrpc: "2.0", method: "tools/list", id: 1 } });
  edges.push({ label: "tools/list without initialize (no session)", request: request2({ body: { jsonrpc: "2.0", method: "tools/list", id: 1 } }), response: uninitialized });

  const deleteNoSession = await httpExchange(origin, { method: "DELETE", path: "/mcp" });
  edges.push({ label: "DELETE /mcp without session", request: { method: "DELETE", path: "/mcp" }, response: deleteNoSession });

  const health = await httpExchange(origin, { method: "GET", path: "/health" });
  edges.push({ label: "GET /health", request: { method: "GET", path: "/health" }, response: health });

  const putMcp = await httpExchange(origin, { method: "PUT", path: "/mcp", body: { jsonrpc: "2.0", method: "tools/list", id: 1 }, headers: { "mcp-session-id": sid2 } });
  edges.push({ label: "PUT /mcp", request: request2({ body: { jsonrpc: "2.0", method: "tools/list", id: 1 }, headers: { "mcp-session-id": "«sid»" } }), response: putMcp });

  writeFlow("http-legacy", "transport-edges", edges);

  // 4. Output-channel behavior (legacy: resolved at session creation).
  for (const [name, { query, header }] of Object.entries({
    "channel-query-structured": { query: "structured" },
    "channel-query-both": { query: "both" },
    "channel-query-invalid": { query: "nonsense" },
    "channel-header-structured": { header: "structured" },
  })) {
    const headers = {};
    if (header) headers["x-prts-output-channel"] = header;
    const path = query ? `/mcp?output_channel=${query}` : "/mcp";
    const initCh = await httpExchange(origin, { path, body: LEGACY_INIT("2025-03-26", 1), headers });
    const sidCh = initCh.headers["mcp-session-id"];
    const notifCh = await httpExchange(origin, { body: INITIALIZED, headers: { "mcp-session-id": sidCh } });
    const callCh = await httpExchange(origin, { path, body: CALL("list_stages", { limit: 2 }, 2), headers: { ...headers, "mcp-session-id": sidCh } });
    writeFlow("http-legacy", name, [
      { label: "initialize (channel pinned)", request: request2({ path, body: LEGACY_INIT("2025-03-26", 1), headers }), response: initCh },
      { label: "initialized", request: request2({ body: INITIALIZED, headers: { "mcp-session-id": "«sid»" } }), response: notifCh },
      { label: "tools/call list_stages", request: request2({ path, body: CALL("list_stages", { limit: 2 }, 2), headers: { ...headers, "mcp-session-id": "«sid»" } }), response: callCh },
    ]);
    await httpExchange(origin, { method: "DELETE", headers: { "mcp-session-id": sidCh } });
  }
}

async function captureHttpModern(origin) {
  const steps = [];
  const discover = await httpExchange(origin, { body: modernMessage("server/discover", {}, 100), headers: modernHeaders("server/discover", {}) });
  steps.push({ label: "server/discover", request: request2({ body: modernMessage("server/discover", {}, 100), headers: modernHeaders("server/discover", {}) }), response: discover });

  const list = await httpExchange(origin, { body: modernMessage("tools/list", {}, 101), headers: modernHeaders("tools/list", {}) });
  steps.push({ label: "tools/list", request: request2({ body: modernMessage("tools/list", {}, 101), headers: modernHeaders("tools/list", {}) }), response: list });

  const call = await httpExchange(origin, { body: modernMessage("tools/call", { name: "list_stages", arguments: {} }, 102), headers: modernHeaders("tools/call", { name: "list_stages" }) });
  steps.push({ label: "tools/call list_stages", request: request2({ body: modernMessage("tools/call", { name: "list_stages", arguments: {} }, 102), headers: modernHeaders("tools/call", { name: "list_stages" }) }), response: call });

  const unknownTool = await httpExchange(origin, { body: modernMessage("tools/call", { name: "no_such_tool", arguments: {} }, 103), headers: modernHeaders("tools/call", { name: "no_such_tool" }) });
  steps.push({ label: "unknown tool", request: request2({ body: modernMessage("tools/call", { name: "no_such_tool", arguments: {} }, 103), headers: modernHeaders("tools/call", { name: "no_such_tool" }) }), response: unknownTool });

  const initModern = await httpExchange(origin, { body: modernMessage("initialize", { protocolVersion: MODERN_VERSION, capabilities: {}, clientInfo: { name: "wire-capture-modern", version: "1.0" } }, 104), headers: modernHeaders("initialize", {}) });
  steps.push({ label: "initialize (modern envelope)", request: request2({ body: modernMessage("initialize", { protocolVersion: MODERN_VERSION, capabilities: {}, clientInfo: { name: "wire-capture-modern", version: "1.0" } }, 104), headers: modernHeaders("initialize", {}) }), response: initModern });

  writeFlow("http-modern", "modern-flow", steps);

  // Era-boundary: modern headers without envelope must NOT fall back to legacy.
  const edges = [];
  const malformed = await httpExchange(origin, {
    body: { jsonrpc: "2.0", method: "tools/list", params: {}, id: 110 },
    headers: { "MCP-Protocol-Version": MODERN_VERSION, "Mcp-Method": "tools/list" },
  });
  edges.push({ label: "modern headers without envelope (expect 400)", request: request2({ body: { jsonrpc: "2.0", method: "tools/list", params: {}, id: 110 }, headers: { "MCP-Protocol-Version": MODERN_VERSION, "Mcp-Method": "tools/list" } }), response: malformed });

  const envelopeNoHeaders = await httpExchange(origin, { body: modernMessage("tools/list", {}, 111) });
  edges.push({ label: "envelope without modern headers", request: request2({ body: modernMessage("tools/list", {}, 111) }), response: envelopeNoHeaders });

  const badEnvelopeVersion = await httpExchange(origin, {
    body: {
      jsonrpc: "2.0", method: "tools/list", id: 112,
      params: { _meta: { "io.modelcontextprotocol/protocolVersion": "1999-01-01", "io.modelcontextprotocol/clientInfo": { name: "x", version: "0" }, "io.modelcontextprotocol/clientCapabilities": {} } },
    },
    headers: { "MCP-Protocol-Version": "1999-01-01", "Mcp-Method": "tools/list" },
  });
  edges.push({ label: "envelope with unsupported version", request: request2({ body: { jsonrpc: "2.0", method: "tools/list", id: 112, params: { _meta: { "io.modelcontextprotocol/protocolVersion": "1999-01-01", "io.modelcontextprotocol/clientInfo": { name: "x", version: "0" }, "io.modelcontextprotocol/clientCapabilities": {} } } }, headers: { "MCP-Protocol-Version": "1999-01-01", "Mcp-Method": "tools/list" } }), response: badEnvelopeVersion });

  const partialMeta = await httpExchange(origin, {
    body: { jsonrpc: "2.0", method: "tools/list", id: 113, params: { _meta: { "io.modelcontextprotocol/protocolVersion": MODERN_VERSION } } },
    headers: { "MCP-Protocol-Version": MODERN_VERSION, "Mcp-Method": "tools/list" },
  });
  const partialMetaBody = {
    jsonrpc: "2.0", method: "tools/list", id: 113,
    params: { _meta: { "io.modelcontextprotocol/protocolVersion": MODERN_VERSION } },
  };
  edges.push({ label: "partial _meta (version only)", request: request2({ body: partialMetaBody, headers: { "MCP-Protocol-Version": MODERN_VERSION, "Mcp-Method": "tools/list" } }), response: partialMeta });

  writeFlow("http-modern", "era-boundary", edges);

  // Modern output channel: per-request resolution.
  for (const [name, query] of Object.entries({ "channel-query-structured": "structured", "channel-query-both": "both", "channel-query-invalid": "nonsense" })) {
    const path = `/mcp?output_channel=${query}`;
    const listCh = await httpExchange(origin, { path, body: modernMessage("tools/list", {}, 120), headers: modernHeaders("tools/list", {}) });
    const callCh = await httpExchange(origin, { path, body: modernMessage("tools/call", { name: "list_stages", arguments: { limit: 2 } }, 121), headers: modernHeaders("tools/call", { name: "list_stages" }) });
    writeFlow("http-modern", name, [
      { label: "tools/list (per-request channel)", request: request2({ path, body: modernMessage("tools/list", {}, 120), headers: modernHeaders("tools/list", {}) }), response: listCh },
      { label: "tools/call list_stages", request: request2({ path, body: modernMessage("tools/call", { name: "list_stages", arguments: { limit: 2 } }, 121), headers: modernHeaders("tools/call", { name: "list_stages" }) }), response: callCh },
    ]);
  }
}

// ---------------------------------------------------------------------------
// stdio captures
// ---------------------------------------------------------------------------

function startStdio(extraEnv = {}) {
  const child = spawn(RUNTIME, [join(DIST, "server-stdio.js")], {
    env: oracleEnv(extraEnv),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf-8");
  child.stderr.on("data", (d) => { stderr += d; });
  return { child, stderr: () => stderr };
}

function stdioSend(child, msg) {
  child.stdin.write(JSON.stringify(msg) + "\n");
}

/** Resolve the next complete JSON line from stdout. */
function stdioRecv(child, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk.toString("utf-8");
      const idx = buffer.indexOf("\n");
      if (idx >= 0) {
        const line = buffer.slice(0, idx).trim();
        child.stdout.off("data", onData);
        clearTimeout(timer);
        if (line === "") {
          // skip empty lines, keep listening
          const rest = buffer.slice(idx + 1);
          if (rest.trim() === "") { child.stdout.on("data", onData); return; }
          try { resolve(JSON.parse(rest.split("\n")[0])); } catch (e) { reject(e); }
          return;
        }
        try { resolve(JSON.parse(line)); } catch (e) { reject(new Error(`non-JSON on stdout: ${line.slice(0, 200)}`)); }
      }
    };
    const timer = setTimeout(() => {
      child.stdout.off("data", onData);
      reject(new Error(`stdio recv timeout (buffer: ${buffer.slice(0, 200)})`));
    }, timeoutMs);
    child.stdout.on("data", onData);
  });
}

async function captureStdioLegacy() {
  const { child, stderr } = startStdio();
  const steps = [];
  stdioSend(child, LEGACY_INIT("2024-11-05", 1));
  steps.push({ request: LEGACY_INIT("2024-11-05", 1), response: await stdioRecv(child) });
  stdioSend(child, INITIALIZED);
  steps.push({ request: INITIALIZED, response: { note: "notification — no response expected" } });
  const listReq = { jsonrpc: "2.0", method: "tools/list", id: 2 };
  stdioSend(child, listReq);
  steps.push({ request: listReq, response: await stdioRecv(child) });
  const callReq = CALL("list_stages", {}, 3);
  stdioSend(child, callReq);
  steps.push({ request: callReq, response: await stdioRecv(child) });
  const callFiltered = CALL("list_stages", { chapter: "main_0", type: "main" }, 4);
  stdioSend(child, callFiltered);
  steps.push({ request: callFiltered, response: await stdioRecv(child) });
  const unknownTool = CALL("no_such_tool", {}, 5);
  stdioSend(child, unknownTool);
  steps.push({ request: unknownTool, response: await stdioRecv(child) });
  const unknownMethod = { jsonrpc: "2.0", method: "resources/list", id: 6 };
  stdioSend(child, unknownMethod);
  steps.push({ request: unknownMethod, response: await stdioRecv(child) });

  child.stdin.end();
  const exitCode = await new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  writeFlow("stdio-legacy", "session-transcript", steps, { exit_code: exitCode, stderr_tail: stderr().slice(-500) });
}

async function captureStdioModern() {
  const { child, stderr } = startStdio();
  const steps = [];
  const discover = modernMessage("server/discover", {}, 10);
  stdioSend(child, discover);
  steps.push({ request: discover, response: await stdioRecv(child) });
  const list = modernMessage("tools/list", {}, 11);
  stdioSend(child, list);
  steps.push({ request: list, response: await stdioRecv(child) });
  const call = modernMessage("tools/call", { name: "list_stages", arguments: {} }, 12);
  stdioSend(child, call);
  steps.push({ request: call, response: await stdioRecv(child) });

  // Era switch on the same connection must not be allowed.
  const legacyAfterModern = LEGACY_INIT("2024-11-05", 13);
  stdioSend(child, legacyAfterModern);
  steps.push({ request: legacyAfterModern, response: await stdioRecv(child) });

  child.stdin.end();
  const exitCode = await new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  writeFlow("stdio-modern", "session-transcript", steps, { exit_code: exitCode, stderr_tail: stderr().slice(-500) });
}

async function captureStdioEraProbe() {
  // Modern-first connection where the first message is legacy initialize
  // determines legacy era; a subsequent modern envelope must be rejected.
  const { child, stderr } = startStdio();
  const steps = [];
  stdioSend(child, LEGACY_INIT("2024-11-05", 1));
  steps.push({ request: LEGACY_INIT("2024-11-05", 1), response: await stdioRecv(child) });
  stdioSend(child, INITIALIZED);
  const modernAfterLegacy = modernMessage("tools/list", {}, 2);
  stdioSend(child, modernAfterLegacy);
  steps.push({ request: modernAfterLegacy, response: await stdioRecv(child) });
  child.stdin.end();
  const exitCode = await new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  writeFlow("stdio-legacy", "modern-after-legacy", steps, { exit_code: exitCode, stderr_tail: stderr().slice(-500) });
}

// ---------------------------------------------------------------------------

const port = await freePort();
const { child, stderr } = await startHttpServer(port);
try {
  await captureHttpLegacy(`http://127.0.0.1:${port}`);
  await captureHttpModern(`http://127.0.0.1:${port}`);
} finally {
  child.kill();
  await new Promise((r) => child.on("exit", r));
}
await captureStdioLegacy();
await captureStdioModern();
await captureStdioEraProbe();
console.log("wire capture complete");
console.log(`oracle stderr tail:\n${stderr().slice(-400)}`);
