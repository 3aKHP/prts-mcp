/**
 * E2E test — starts the TS MCP stdio server and exercises core tools via
 * stdin/stdout JSON-RPC. Mirrors the Python test_e2e.py pattern.
 *
 * Tests that run without network or full data:
 *   1. MCP initialize handshake
 *   2. tools/list — all tools registered
 *   3. Graceful errors for unavailable data
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, ChildProcess } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const GAMEDATA_PATH = join(REPO_ROOT, "data", "gamedata");
const EXPECTED_VERSION = JSON.parse(
  readFileSync(join(REPO_ROOT, "ts", "package.json"), "utf-8"),
).version as string;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ServerHandle {
  child: ChildProcess;
}

function startServer(): ServerHandle {
  const distServer = join(REPO_ROOT, "ts", "dist", "server-stdio.js");
  const env: Record<string, string> = {
    ...process.env,
    GAMEDATA_PATH: GAMEDATA_PATH,
    GITHUB_MIRRORS: "",
    STORYJSON_PATH: join(GAMEDATA_PATH, "does-not-exist.zip"),
  } as Record<string, string>;

  const child = spawn(process.execPath, [distServer], {
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });
  return { child };
}

async function send(child: ChildProcess, msg: unknown): Promise<void> {
  const stdin = child.stdin;
  if (!stdin) throw new Error("no stdin");
  stdin.write(JSON.stringify(msg) + "\n");
}

async function recv(child: ChildProcess, timeoutMs = 10000): Promise<Record<string, unknown>> {
  const stdout = child.stdout;
  if (!stdout) throw new Error("no stdout");
  const deadline = Date.now() + timeoutMs;
  const chunks: Buffer[] = [];
  return new Promise((resolveFn, reject) => {
    const timer = setTimeout(() => {
      stdout.off("data", onData);
      reject(new Error("recv timeout"));
    }, deadline - Date.now());

    function onData(data: Buffer) {
      chunks.push(data);
      const text = Buffer.concat(chunks).toString("utf-8");
      const lines = text.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          clearTimeout(timer);
          stdout.off("data", onData);
          resolveFn(parsed);
          return;
        } catch {
          // not a complete JSON line yet
        }
      }
    }
    stdout.on("data", onData);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("stdio: initialize handshake + tools/list", async () => {
  const { child } = startServer();
  try {
    await send(child, {
      jsonrpc: "2.0",
      method: "initialize",
      id: 1,
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      },
    });
    const initResp = await recv(child);
    assert.equal(initResp["id"], 1);
    const result = initResp["result"] as Record<string, unknown>;
    const serverInfo = result["serverInfo"] as Record<string, string>;
    assert.equal(serverInfo["name"], "PRTS_Wiki_Assistant");
    assert.equal(serverInfo["version"], EXPECTED_VERSION, "serverInfo.version should match package.json");

    // notifications/initialized
    await send(child, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });

    // tools/list
    await send(child, {
      jsonrpc: "2.0",
      method: "tools/list",
      id: 2,
      params: {},
    });
    const listResp = await recv(child);
    assert.equal(listResp["id"], 2);
    const tools = (listResp["result"] as { tools: Array<{ name: string }> }).tools;
    const names = new Set(tools.map((t) => t.name));
    for (const required of [
      "search_prts",
      "get_operator_archives",
      "list_story_events",
      "read_story",
      "list_enemies",
    ]) {
      assert.ok(names.has(required), `missing tool ${required}`);
    }
  } finally {
    child.kill();
  }
});

test("stdio: graceful error for unavailable data", async () => {
  const { child } = startServer();
  try {
    await send(child, {
      jsonrpc: "2.0",
      method: "initialize",
      id: 1,
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      },
    });
    await recv(child);

    await send(child, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });

    // list_story_events should gracefully report story data unavailable,
    // not crash the server.
    await send(child, {
      jsonrpc: "2.0",
      method: "tools/call",
      id: 2,
      params: { name: "list_story_events", arguments: {} },
    });
    const resp = await recv(child);
    assert.equal(resp["id"], 2);
    const result = resp["result"] as { content: Array<{ text: string }>; isError?: boolean };
    assert.ok(!result.isError, "expected graceful text, not isError");
    assert.ok(result.content.length > 0);
    const text = result.content[0].text;
    // Should mention unavailability, not crash.
    assert.ok(
      text.includes("暂不可用") || text.includes("未就绪") || text.includes("仍在进行中"),
      `unexpected response: ${text.slice(0, 100)}`,
    );
  } finally {
    child.kill();
  }
});

test("stdio: does not start an HTTP listener", async () => {
  // The stdio entry must not import server.ts (which binds a TCP port at
  // module load).  We set PORT to a unique high number, spawn the stdio
  // server, then probe whether that port is bound.
  const probePort = 39999;
  const distServer = join(REPO_ROOT, "ts", "dist", "server-stdio.js");
  const child = spawn(process.execPath, [distServer], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      GAMEDATA_PATH: GAMEDATA_PATH,
      GITHUB_MIRRORS: "",
      STORYJSON_PATH: join(GAMEDATA_PATH, "does-not-exist.zip"),
      PORT: String(probePort),
    } as Record<string, string>,
  });

  let stderrText = "";
  child.stderr?.on("data", (d: Buffer) => { stderrText += d.toString(); });

  try {
    // Give the process time to start (and bind, if buggy).
    await new Promise((r) => setTimeout(r, 1500));

    const net = await import("node:net");
    const probe = net.createServer();
    const portIsFree = await new Promise<boolean>((resolve) => {
      probe.once("error", () => resolve(false));
      probe.once("listening", () => { probe.close(); resolve(true); });
      probe.listen(probePort, "127.0.0.1");
    });

    assert.ok(
      portIsFree,
      `stdio server must not bind TCP port ${probePort}. stderr: ${stderrText}`,
    );
  } finally {
    child.kill();
    await new Promise<void>((r) => child.on("exit", () => r()));
  }
});
