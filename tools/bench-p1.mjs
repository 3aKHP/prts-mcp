// P1 lightweight bench: cold start to serving, first list_stages, warm queries.
// 5 independent processes per side, fixture dataset, release Rust build.
import { spawn } from "node:child_process";

const FIX = ".runtime/fixtures/minimal-gamedata-v1";

async function freePort() {
  const { createServer } = await import("node:net");
  return new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

const HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

async function post(origin, body, sid) {
  return fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { ...HEADERS, ...(sid ? { "mcp-session-id": sid } : {}) },
    body: JSON.stringify(body),
  });
}

async function measure(kind) {
  const port = await freePort();
  const t0 = performance.now();
  const cmd = kind === "ts"
    ? ["bun", [".reference/ts-v2.8.1/ts/dist/server.js"]]
    : ["./target/release/prts-mcp-rust", ["--transport", "http"]];
  const child = spawn(cmd[0], cmd[1], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, GAMEDATA_PATH: FIX, STORYJSON_PATH: `${FIX}/no.zip`, GITHUB_MIRRORS: "", IMAGES_ENABLED: "true", HOST: "127.0.0.1", PORT: String(port) },
    stdio: "ignore",
  });
  const origin = `http://127.0.0.1:${port}`;
  for (;;) {
    try { const r = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(150) }); if (r.ok) break; } catch { /* retry */ }
    if (performance.now() - t0 > 20000) throw new Error("startup timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
  const ready = performance.now() - t0;
  const initRes = await post(origin, { jsonrpc: "2.0", method: "initialize", id: 1, params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "b", version: "0" } } });
  const sid = initRes.headers.get("mcp-session-id");
  await post(origin, { jsonrpc: "2.0", method: "notifications/initialized" }, sid);
  const q0 = performance.now();
  const first = await post(origin, { jsonrpc: "2.0", method: "tools/call", id: 2, params: { name: "list_stages", arguments: {} } }, sid);
  const firstText = await first.text();
  const firstQuery = performance.now() - q0;
  const warm = [];
  for (let i = 0; i < 20; i++) {
    const t = performance.now();
    await post(origin, { jsonrpc: "2.0", method: "tools/call", id: 3, params: { name: "list_stages", arguments: {} } }, sid);
    warm.push(performance.now() - t);
  }
  warm.sort((a, b) => a - b);
  child.kill();
  await new Promise((r) => child.on("exit", r));
  return {
    ready_ms: +ready.toFixed(1),
    first_query_ms: +firstQuery.toFixed(1),
    warm_p50_ms: +warm[10].toFixed(1),
    warm_p95_ms: +warm[Math.min(19, warm.length - 1)].toFixed(1),
    ok: firstText.includes("关卡列表"),
  };
}

const out = { measured_at: new Date().toISOString(), dataset: "minimal-gamedata-v1", samples_per_side: 5 };
for (const kind of ["ts", "rust"]) {
  const runs = [];
  for (let i = 0; i < 5; i++) runs.push(await measure(kind));
  const avg = (f) => +(runs.reduce((a, r) => a + f(r), 0) / runs.length).toFixed(1);
  out[kind] = {
    cold_ready_ms: avg((r) => r.ready_ms),
    first_query_ms: avg((r) => r.first_query_ms),
    warm_p50_ms: avg((r) => r.warm_p50_ms),
    warm_p95_ms: avg((r) => r.warm_p95_ms),
    all_returned_listing: runs.every((r) => r.ok),
  };
}
console.log(JSON.stringify(out, null, 1));
