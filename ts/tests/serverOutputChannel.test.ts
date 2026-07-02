import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      server.close(() => {
        if (addr && typeof addr === "object") resolve(addr.port);
        else reject(new Error("no port"));
      });
    });
  });
}

async function waitForHealth(origin: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(300) });
      if (res.ok) return;
    } catch {
      // Retry until the child has finished booting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
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
  query = "",
  extraHeaders: Record<string, string> = {},
): Promise<McpResponse> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...extraHeaders,
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  const res = await fetch(`${origin}/mcp${query}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const raw = await res.text();
  const sseMatch = raw.match(/^data:\s*(\{[\s\S]*\})/m);
  const parsed = JSON.parse(sseMatch ? sseMatch[1] : raw) as Record<string, unknown>;
  return {
    status: res.status,
    body: parsed,
    sessionId: res.headers.get("mcp-session-id"),
  };
}

function writeGamedata(root: string): void {
  const excel = join(root, "zh_CN", "gamedata", "excel");
  mkdirSync(excel, { recursive: true });

  for (const file of [
    "character_table.json",
    "handbook_info_table.json",
    "charword_table.json",
    "story_review_table.json",
  ]) {
    writeFileSync(join(excel, file), "{}", "utf-8");
  }

  writeFileSync(
    join(excel, "stage_table.json"),
    JSON.stringify({
      stages: {
        "main_00-01": {
          stageId: "main_00-01",
          code: "0-1",
          name: "坍塌",
          stageType: "MAIN",
          difficulty: "NORMAL",
          zoneId: "main_0",
        },
      },
    }),
    "utf-8",
  );
  writeFileSync(
    join(excel, "zone_table.json"),
    JSON.stringify({
      zones: {
        main_0: {
          zoneID: "main_0",
          zoneNameFirst: "序章",
          zoneNameSecond: "黑暗时代·上",
        },
      },
    }),
    "utf-8",
  );
}

test("output_channel is resolved once per session by query/header/env priority", async (t) => {
  const port = await getFreePort();
  const origin = `http://127.0.0.1:${port}`;
  const gamedata = mkdtempSync(join(tmpdir(), "prts-output-channel-"));
  const dataHome = mkdtempSync(join(tmpdir(), "prts-output-home-"));
  const localAppData = join(dataHome, "LocalAppData");
  mkdirSync(localAppData, { recursive: true });
  writeGamedata(gamedata);

  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: join(import.meta.dirname, ".."),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      GAMEDATA_PATH: gamedata,
      XDG_DATA_HOME: dataHome,
      LOCALAPPDATA: localAppData,
      GITHUB_MIRRORS: "",
      PRTS_OUTPUT_CHANNEL: "both",
      SESSION_IDLE_TIMEOUT_MS: "30000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { child.kill(); });

  await waitForHealth(origin);

  let id = 1;
  const initialize = (query = "", headers: Record<string, string> = {}) =>
    mcpPost(
      origin,
      {
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "output-channel-test", version: "1.0" },
        },
        id: id++,
      },
      undefined,
      query,
      headers,
    );

  const callListStages = (sessionId: string, query = "", headers: Record<string, string> = {}) =>
    mcpPost(
      origin,
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "list_stages", arguments: {} },
        id: id++,
      },
      sessionId,
      query,
      headers,
    );

  const envInit = await initialize();
  assert.equal(envInit.status, 200);
  assert.ok(envInit.sessionId);
  const envResult = await callListStages(envInit.sessionId);
  const envToolResult = envResult.body.result as Record<string, unknown>;
  assert.ok(envToolResult.structuredContent);
  assert.match(((envToolResult.content as Array<{ text: string }>)[0]).text, /^# 关卡列表/);

  const headerInit = await initialize("", { "x-prts-output-channel": "structured" });
  assert.equal(headerInit.status, 200);
  assert.ok(headerInit.sessionId);
  const headerResult = await callListStages(headerInit.sessionId);
  const headerToolResult = headerResult.body.result as Record<string, unknown>;
  assert.ok(headerToolResult.structuredContent);
  assert.equal(
    ((headerToolResult.content as Array<{ text: string }>)[0]).text,
    "（结构化结果共 1 条，详见 structuredContent）",
  );

  const queryInit = await initialize("?output_channel=structured", {
    "x-prts-output-channel": "both",
  });
  assert.equal(queryInit.status, 200);
  assert.ok(queryInit.sessionId);

  const queryResult = await callListStages(queryInit.sessionId);
  assert.equal(queryResult.status, 200);
  const toolResult = queryResult.body.result as Record<string, unknown>;
  assert.deepStrictEqual(toolResult.structuredContent, {
    total: 1,
    offset: 0,
    limit: 50,
    filters: { chapter: null, type: null },
    stages: [
      {
        stage_id: "main_00-01",
        name: "坍塌",
        code: "0-1",
        type: "MAIN",
        type_label: "主线",
        difficulty_label: "普通",
        zone_id: "main_0",
        zone_display: "序章-黑暗时代·上",
      },
    ],
  });

  const content = toolResult.content as Array<{ text: string }>;
  assert.equal(content[0].text, "（结构化结果共 1 条，详见 structuredContent）");

  const fixedResult = await callListStages(
    queryInit.sessionId,
    "?output_channel=content",
    { "x-prts-output-channel": "content" },
  );
  const fixedToolResult = fixedResult.body.result as Record<string, unknown>;
  assert.ok(fixedToolResult.structuredContent, "existing session should keep structured channel");
  assert.equal(
    ((fixedToolResult.content as Array<{ text: string }>)[0]).text,
    "（结构化结果共 1 条，详见 structuredContent）",
  );

  const invalidInit = await initialize("?output_channel=nope");
  assert.equal(invalidInit.status, 200);
  assert.ok(invalidInit.sessionId);
  const invalidResult = await callListStages(invalidInit.sessionId);
  const invalidToolResult = invalidResult.body.result as Record<string, unknown>;
  assert.equal(invalidToolResult.structuredContent, undefined);
  assert.match(((invalidToolResult.content as Array<{ text: string }>)[0]).text, /^# 关卡列表/);
});
