/**
 * E2E test — starts the TS MCP server and exercises core tools via HTTP.
 *
 * Tests that run without network or full data:
 *   1. Server startup + health check
 *   2. MCP initialize handshake
 *   3. tools/list — all tools registered
 *   4. Session persistence across requests
 *   5. Operator tools (bundled fixture data)
 *   6. Graceful errors for unavailable data
 *
 * Network-dependent PRTS API tests are skipped when E2E_PRTS_API is unset.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      s.close(() => {
        if (addr && typeof addr === "object") resolve(addr.port);
        else reject(new Error("no port"));
      });
    });
  });
}

async function waitForHealth(origin: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(300) });
      if (res.ok) return;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("health check timeout");
}

interface McpResponse {
  status: number;
  body: Record<string, unknown>;
  sessionId: string | null;
}

async function mcpPost(
  origin: string,
  body: unknown,
  sessionId?: string,
): Promise<McpResponse> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  const res = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const sid = res.headers.get("mcp-session-id");
  const raw = await res.text();
  let data: unknown;
  const sseMatch = raw.match(/^data:\s*(\{[\s\S]*\})/m);
  if (sseMatch) {
    try { data = JSON.parse(sseMatch[1]); } catch { data = raw; }
  } else {
    try { data = JSON.parse(raw); } catch { data = raw; }
  }
  return { status: res.status, body: data as Record<string, unknown>, sessionId: sid };
}

const MODERN_VERSION = "2026-07-28";

function modernBody(method: string, params: Record<string, unknown>, id: number): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
        "io.modelcontextprotocol/clientInfo": { name: "e2e-modern", version: "1.0" },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
    id,
  };
}

async function modernPost(origin: string, method: string, params: Record<string, unknown>, id: number): Promise<McpResponse> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": MODERN_VERSION,
    "Mcp-Method": method,
  };
  if (method === "tools/call") headers["Mcp-Name"] = String(params["name"]);
  const res = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(modernBody(method, params, id)),
  });
  const raw = await res.text();
  const sseMatch = raw.match(/^data:\s*(\{[\s\S]*\})/m);
  const body = JSON.parse(sseMatch?.[1] ?? raw) as Record<string, unknown>;
  return { status: res.status, body, sessionId: res.headers.get("mcp-session-id") };
}

function toolResultText(r: McpResponse): string {
  const content = (r.body?.result as Record<string, unknown>)?.content as Array<{ text: string }> | undefined;
  return content?.[0]?.text ?? "";
}

function dataUnavailable(text: string): boolean {
  return text.includes("暂不可用") || text.includes("未就绪");
}

const tc = (name: string, args: Record<string, unknown>, id: number) => ({
  jsonrpc: "2.0" as const,
  method: "tools/call" as const,
  params: { name, arguments: args },
  id,
});

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

const GAMEDATA_PATH = join(import.meta.dirname, "..", "..", "data", "gamedata");
const RUN_PRTS_API = process.env["E2E_PRTS_API"] === "1";
const EXPECTED_VERSION = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "package.json"), "utf-8"),
).version as string;

test("E2E", async (t) => {
  // --- start server ---
  const port = await getFreePort();
  const origin = `http://127.0.0.1:${port}`;

  const dataHome = mkdtempSync(join(tmpdir(), "prts-e2e-"));
  const localAppData = join(dataHome, "LocalAppData");
  mkdirSync(localAppData, { recursive: true });

  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/server.ts"],
    {
      cwd: join(import.meta.dirname, ".."),
      env: {
        ...process.env,
        PORT: String(port),
        HOST: "127.0.0.1",
        GAMEDATA_PATH,
        XDG_DATA_HOME: dataHome,
        LOCALAPPDATA: localAppData,
        GITHUB_MIRRORS: "",
        IMAGES_ENABLED: "true",
        SESSION_IDLE_TIMEOUT_MS: "30000",
        PRTS_METRICS_ENABLED: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stderr = "";
  child.stderr!.setEncoding("utf-8");
  child.stderr!.on("data", (d: string) => { stderr += d; });

  await waitForHealth(origin, 15000);

  t.after(() => { child.kill(); });

  // --- /debug/cache ---
  await t.test("debug cache returns expected modules", async () => {
    const res = await fetch(`${origin}/debug/cache`);
    assert.equal(res.status, 200);
    const data = await res.json() as Record<string, Record<string, { loaded: boolean; count: number; hits: number; misses: number; clears: number; bytes?: number }>>;
    const expectedModules = new Set([
      "operator", "enemy", "stage", "stage_enemy", "item",
      "search", "story_search", "images", "artwork_mediawiki",
    ]);
    assert.deepEqual(new Set(Object.keys(data)), expectedModules, "module set mismatch");
    for (const [mod, caches] of Object.entries(data)) {
      for (const [cacheName, stat] of Object.entries(caches)) {
        assert.equal(typeof stat.loaded, "boolean", `${mod}.${cacheName}.loaded should be boolean`);
        assert.equal(typeof stat.count, "number", `${mod}.${cacheName}.count should be number`);
        assert.equal(typeof stat.hits, "number", `${mod}.${cacheName}.hits should be number`);
        assert.equal(typeof stat.misses, "number", `${mod}.${cacheName}.misses should be number`);
        assert.equal(typeof stat.clears, "number", `${mod}.${cacheName}.clears should be number`);
      }
    }
    // artwork_mediawiki.image_cache includes bytes
    assert.equal(typeof data["artwork_mediawiki"]!["image_cache"]!.bytes, "number");
  });

  // --- protocol handshake ---
  let sessionId: string;

  await t.test("protocol handshake", async () => {
    const init = await mcpPost(origin, {
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "e2e", version: "1.0" },
      },
      id: 1,
    });

    assert.equal(init.status, 200, `status ${init.status}`);
    assert.ok(init.sessionId, "should return Mcp-Session-Id");
    sessionId = init.sessionId!;
    const serverInfo = (init.body?.result as { serverInfo?: { version?: string } })?.serverInfo;
    assert.equal(serverInfo?.version, EXPECTED_VERSION, "serverInfo.version should match package.json");
    assert.ok(init.body?.result, "initialize should have result");
  });

  await t.test("modern discover, list, and tool calls are stateless", async () => {
    const discover = await modernPost(origin, "server/discover", {}, 100);
    assert.equal(discover.status, 200);
    assert.equal(discover.sessionId, null, "modern discover must not create a legacy session");
    assert.ok(discover.body["result"], "discover should return a modern result");

    const list = await modernPost(origin, "tools/list", {}, 101);
    assert.equal(list.status, 200);
    assert.equal(list.sessionId, null, "modern tools/list must stay stateless");
    const tools = (list.body["result"] as { tools?: Array<{ name: string }> }).tools;
    assert.equal(tools?.length, 24);

    const call = await modernPost(origin, "tools/call", {
      name: "get_operator_basic_info",
      arguments: { name: "阿米娅" },
    }, 102);
    assert.equal(call.status, 200);
    assert.equal(call.sessionId, null, "modern tools/call must not create a legacy session");
    assert.match(toolResultText(call), /阿米娅/);

    const malformed = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "MCP-Protocol-Version": MODERN_VERSION,
        "Mcp-Method": "tools/list",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", params: {}, id: 103 }),
    });
    assert.equal(malformed.status, 400, "a modern header without its envelope must not fall back to legacy");
    assert.equal(malformed.headers.get("mcp-session-id"), null);
  });

  // --- tools/list ---
  await t.test("tools/list returns all 24 tools", async () => {
    const tl = await mcpPost(
      origin,
      { jsonrpc: "2.0", method: "tools/list", id: 2 },
      sessionId,
    );

    assert.equal(tl.status, 200);
    const tools = (tl.body?.result as Record<string, unknown>)?.tools as Array<{ name: string }> | undefined;
    assert.ok(tools, "tools/list should return tools");
    assert.equal(tools!.length, 24, `got ${tools!.length} tools`);

    const expected = new Set([
      "search_prts", "prts_page",
      "get_operator_archives", "get_operator_voicelines", "get_operator_basic_info",
      "list_enemies", "get_enemy_info",
      "get_stage_enemies", "get_enemy_appearances",
      "list_stages", "get_stage_info",
      "list_items", "get_item_info",
      "list_story_events", "list_stories", "read_story", "read_activity",
      "search", "search_stories",
      "get_story_summary",
      "get_operator_memoirs",
      "find_character_appearances", "find_speakers_in",
      "operator_artwork",
    ]);
    const names = new Set(tools!.map((t) => t.name));
    for (const name of expected) {
      assert.ok(names.has(name), `missing tool: ${name}`);
    }
  });

  // --- operator tools (bundled fixture always available) ---
  await t.test("get_operator_basic_info — char_* filter (阿米娅 5★)", async () => {
    const r = await mcpPost(origin, tc("get_operator_basic_info", { name: "阿米娅" }, 3), sessionId);
    assert.equal(r.status, 200);
    const text = toolResultText(r);
    assert.ok(text.includes("5★"), `阿米娅 should be 5★: ${text.split("\n").find((l) => l.includes("稀有度"))}`);
  });

  await t.test("get_operator_basic_info — char_* filter (森蚺 6★)", async () => {
    const r = await mcpPost(origin, tc("get_operator_basic_info", { name: "森蚺" }, 4), sessionId);
    assert.equal(r.status, 200);
    const text = toolResultText(r);
    assert.ok(text.includes("6★"), `森蚺 should be 6★: ${text.split("\n").find((l) => l.includes("稀有度"))}`);
  });

  await t.test("get_operator_archives", async () => {
    const r = await mcpPost(origin, tc("get_operator_archives", { name: "阿米娅" }, 5), sessionId);
    assert.equal(r.status, 200);
    const text = toolResultText(r);
    assert.ok(text.includes("阿米娅") && text.includes("干员档案"), text.slice(0, 80));
  });

  await t.test("get_operator_voicelines", async () => {
    const r = await mcpPost(origin, tc("get_operator_voicelines", { name: "阿米娅" }, 6), sessionId);
    assert.equal(r.status, 200);
    const text = toolResultText(r);
    assert.ok(text.includes("语音记录") && text.includes("阿米娅"), text.slice(0, 80));
  });

  await t.test("search", async () => {
    const r = await mcpPost(origin, tc("search", { scope: "operators", pattern: "法术伤害", max_results: 3 }, 7), sessionId);
    assert.equal(r.status, 200);
    const text = toolResultText(r);
    assert.ok(text.includes("法术伤害"), text.slice(0, 80));
  });

  // --- graceful errors for unavailable data ---
  await t.test("list_enemies — data or graceful error", async () => {
    const r = await mcpPost(origin, tc("list_enemies", { limit: 5 }, 8), sessionId);
    assert.equal(r.status, 200);
    const text = toolResultText(r);
    assert.ok(text.includes("敌人图鉴") || dataUnavailable(text), `unexpected: ${text.slice(0, 100)}`);
  });

  await t.test("list_story_events — data or graceful error", async () => {
    const r = await mcpPost(origin, tc("list_story_events", {}, 9), sessionId);
    assert.equal(r.status, 200);
    const text = toolResultText(r);
    assert.ok(text.includes("[MAINLINE]") || text.includes("[ACTIVITY]") || dataUnavailable(text),
      `unexpected: ${text.slice(0, 100)}`);
  });

  // --- session persistence ---
  await t.test("session persists across calls", async () => {
    const r = await mcpPost(
      origin,
      { jsonrpc: "2.0", method: "tools/list", id: 10 },
      sessionId,
    );
    assert.equal(r.status, 200);
    assert.ok(r.body?.result, "reused session should work");
  });

  await t.test("debug metrics exposes aggregate runtime state only", async () => {
    const res = await fetch(`${origin}/debug/metrics`);
    assert.equal(res.status, 200);
    const data = await res.json() as Record<string, unknown>;
    assert.equal(data.schema_version, "prts-mcp.metrics/v1");
    const server = data.server as Record<string, unknown>;
    const processMetrics = data.process as Record<string, unknown>;
    const sessions = data.sessions as Record<string, unknown>;
    const requests = data.requests as Record<string, unknown>;
    const toolCalls = data.tool_calls as Record<string, unknown>;
    assert.equal(server.version, EXPECTED_VERSION);
    assert.equal(typeof processMetrics.rss_bytes, "number");
    assert.equal(sessions.idle_timeout_ms, 30000);
    assert.equal(sessions.active, 1);
    assert.ok(Number(requests.total) >= 10);
    const byName = toolCalls.by_name as Record<string, Record<string, unknown>>;
    assert.ok(Number(byName.get_operator_basic_info?.total) >= 2);
    assert.equal(typeof byName.get_operator_basic_info?.duration_ms_max, "number");
    assert.equal(JSON.stringify(data).includes(sessionId), false, "metrics must not expose session IDs");
  });

  // --- PRTS API tools (opt-in) ---
  await t.test("search_prts", { skip: !RUN_PRTS_API }, async () => {
    const r = await mcpPost(origin, tc("search_prts", { query: "阿米娅", limit: 3 }, 20), sessionId);
    assert.equal(r.status, 200);
    const text = toolResultText(r);
    assert.ok(text.includes("阿米娅") && text.includes("匹配"), text.slice(0, 80));
  });

  await t.test("prts_page sections", { skip: !RUN_PRTS_API }, async () => {
    const r = await mcpPost(origin, tc("prts_page", { page_title: "阿米娅", action: "sections" }, 21), sessionId);
    assert.equal(r.status, 200);
    const text = toolResultText(r);
    assert.ok(text.includes("[") && text.includes("] L"), text.slice(0, 80));
  });
});
