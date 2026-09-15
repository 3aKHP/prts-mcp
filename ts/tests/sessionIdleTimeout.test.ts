import test from "node:test";
import assert from "node:assert/strict";
import { spawn, ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      server.close(() => {
        if (addr && typeof addr === "object") resolve(addr.port);
        else reject(new Error("Failed to allocate test port"));
      });
    });
  });
}

async function waitForHealth(origin: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(origin + "/health", { signal: AbortSignal.timeout(300) });
      if (res.ok) return;
      lastErr = new Error("HTTP " + res.status);
    } catch (err) { lastErr = err; }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function collectStderr(child: ChildProcess): string[] {
  const lines: string[] = [];
  child.stderr!.setEncoding("utf-8");
  child.stderr!.on("data", (chunk: string) => { lines.push(chunk); });
  return lines;
}

test("idle sessions are evicted after timeout", async () => {
  const debugToken = "session-idle-debug-token";
  const debugHeaders = { Authorization: `Bearer ${debugToken}` };
  const port = await getFreePort();
  const dataHome = mkdtempSync(join(tmpdir(), "prts-session-idle-"));
  const localAppData = join(dataHome, "LocalAppData");
  mkdirSync(localAppData, { recursive: true });

  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--import", "./tests/fixtures/hangingFetch.ts", "src/server.ts"],
    {
      cwd: join(import.meta.dirname, ".."),
      env: {
        ...process.env,
        PORT: String(port),
        HOST: "127.0.0.1",
        XDG_DATA_HOME: dataHome,
        LOCALAPPDATA: localAppData,
        GITHUB_MIRRORS: "",
        STORYJSON_PATH: join(dataHome, "storyjson", "missing.zip"),
        SESSION_IDLE_TIMEOUT_MS: "3000",
        PRTS_METRICS_ENABLED: "true",
        PRTS_DEBUG_TOKEN: debugToken,
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );

  const stderrLines = collectStderr(child);

  try {
    const origin = "http://127.0.0.1:" + port;
    await waitForHealth(origin, 5000);
    const metricsEnabled = await fetch(origin + "/debug/metrics", { headers: debugHeaders });
    assert.equal(metricsEnabled.status, 200, "metrics should be available when explicitly enabled");

    const initRes = await fetch(origin + "/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0", method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
        id: 1,
      }),
    });

    const sessionId = initRes.headers.get("mcp-session-id");
    assert.ok(sessionId, "should return Mcp-Session-Id");
    assert.ok(initRes.ok, "initialize should succeed");

    // Any post-initialize request bumps lastActivity past the moment the idle
    // timer was armed (#193). With a 3s timeout and a request 1s in, eviction
    // is due at ~4s after initialize: at 3.5s the session must still be alive
    // (it would already be gone at 3.0s if activity did not extend the
    // deadline) …
    await new Promise((r) => setTimeout(r, 1000));
    const notifyRes = await fetch(origin + "/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "mcp-session-id": sessionId,
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    assert.ok(notifyRes.ok, "post-initialize request on the session should succeed");

    await new Promise((r) => setTimeout(r, 2500));
    const earlyRes = await fetch(origin + "/debug/metrics", { headers: debugHeaders });
    assert.equal(earlyRes.status, 200);
    const earlyMetrics = JSON.parse(await earlyRes.text()) as { sessions: Record<string, unknown> };
    assert.equal(earlyMetrics.sessions.active, 1, "session must not be evicted before the idle deadline");
    assert.equal(earlyMetrics.sessions.evicted_total, 0);

    // … and eviction must land at ~4s (one timeout after the last request),
    // not ~6s (full-period reschedule, the #193 bug). Poll the metrics side
    // channel — requests to /mcp would themselves count as activity and push
    // the deadline — with a 5.2s hard deadline that keeps the 2× bug red
    // while absorbing event-loop stalls.
    let metrics: { sessions: Record<string, unknown> } | undefined;
    let metricsText = "";
    const evictDeadline = Date.now() + 1700;
    while (Date.now() < evictDeadline) {
      const pollRes = await fetch(origin + "/debug/metrics", { headers: debugHeaders });
      metricsText = await pollRes.text();
      metrics = JSON.parse(metricsText) as { sessions: Record<string, unknown> };
      if (metrics.sessions.active === 0) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(metrics, "metrics should be available");
    assert.equal(metrics.sessions.active, 0, "an evicted session must not stay active in metrics");
    assert.equal(metrics.sessions.initialized_total, 1);
    assert.equal(metrics.sessions.evicted_total, 1);
    assert.equal(metrics.sessions.closed_total, 1, "idle eviction closes the session");
    assert.equal(metricsText.includes(sessionId), false, "metrics must not expose session IDs");

    // --- non-init request with stale session → 404 JSON-RPC error ---
    const reuseRes = await fetch(origin + "/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", "mcp-session-id": sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 2 }),
    });

    assert.equal(reuseRes.status, 404, "non-init stale session should return 404");
    assert.equal(
      reuseRes.headers.get("content-type")?.split(";")[0],
      "application/json",
    );
    const reuseBody = await reuseRes.json() as Record<string, unknown>;
    assert.equal(reuseBody.jsonrpc, "2.0", "should be valid JSON-RPC");
    assert.equal(reuseBody.id, 2, "should preserve request id");
    assert.ok(reuseBody.error, "should include error object");
    const err = reuseBody.error as Record<string, unknown>;
    assert.equal(err.code, -32002, "error code should be -32002");
    assert.ok(
      typeof err.message === "string" && err.message.includes("MCP session lost"),
      "error message should mention session loss",
    );

    // --- initialize request with stale session → auto-recovery ---
    const reinitRes = await fetch(origin + "/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "mcp-session-id": sessionId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test-reinit", version: "1.0" },
        },
        id: 3,
      }),
    });

    assert.equal(reinitRes.status, 200, "init with stale session should auto-recover");
    assert.ok(reinitRes.ok, "initialize should succeed");
    const newSessionId = reinitRes.headers.get("mcp-session-id");
    assert.ok(newSessionId, "should return a new session ID");
    assert.notEqual(newSessionId, sessionId, "new session ID should differ from old one");

    // Check eviction log
    const allStderr = stderrLines.join("");
    assert.match(allStderr, /idle for \d+s.*evicting/i, "should log idle eviction");
  } finally {
    child.kill();
    await new Promise((r) => child.once("exit", r));
  }
});
