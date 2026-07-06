#!/usr/bin/env node
/**
 * Black-box Streamable HTTP smoke test for the TypeScript MCP server.
 *
 * Usage:
 *   node scripts/smoke-http.mjs -- node dist/server.js
 *   node scripts/smoke-http.mjs --origin http://127.0.0.1:3000
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const EXPECTED_TOOLS = [
  "search_prts",
  "prts_page",
  "get_operator_archives",
  "get_operator_voicelines",
  "get_operator_basic_info",
  "list_enemies",
  "get_enemy_info",
  "get_stage_enemies",
  "get_enemy_appearances",
  "list_stages",
  "get_stage_info",
  "list_items",
  "get_item_info",
  "list_story_events",
  "list_stories",
  "read_story",
  "read_activity",
  "search",
  "search_stories",
  "get_story_summary",
  "get_operator_memoirs",
  "find_character_appearances",
  "find_speakers_in",
];

const DEFAULT_TIMEOUT_MS = 30_000;

class SmokeFailure extends Error {
  constructor(step, message, detail) {
    super(`${step}: ${message}${detail ? `\n${detail}` : ""}`);
    this.name = "SmokeFailure";
    this.step = step;
  }
}

function parseArgs(argv) {
  const options = {
    host: "127.0.0.1",
    port: undefined,
    origin: undefined,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    outputChannel: "both",
    storyEventId: undefined,
    storyKey: undefined,
    fixtureData: false,
    command: [],
  };

  const sep = argv.indexOf("--");
  const optArgs = sep === -1 ? argv : argv.slice(0, sep);
  options.command = sep === -1 ? [] : argv.slice(sep + 1);

  for (let i = 0; i < optArgs.length; i += 1) {
    const arg = optArgs[i];
    const next = () => {
      i += 1;
      if (i >= optArgs.length) throw new Error(`Missing value for ${arg}`);
      return optArgs[i];
    };
    if (arg === "--origin") options.origin = stripTrailingSlash(next());
    else if (arg === "--host") options.host = next();
    else if (arg === "--port") options.port = Number(next());
    else if (arg === "--timeout-ms") options.timeoutMs = Number(next());
    else if (arg === "--output-channel") options.outputChannel = next();
    else if (arg === "--story-event-id") options.storyEventId = next();
    else if (arg === "--story-key") options.storyKey = next();
    else if (arg === "--fixture-data") options.fixtureData = true;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive number");
  }
  if (options.port !== undefined && (!Number.isInteger(options.port) || options.port <= 0)) {
    throw new Error("--port must be a positive integer");
  }
  if (options.origin && options.command.length > 0) {
    throw new Error("Use either --origin or a server command after --, not both");
  }
  if (options.origin && options.fixtureData) {
    throw new Error("--fixture-data can only be used with a spawned server command");
  }
  if (!options.origin && options.command.length === 0) {
    throw new Error("Provide --origin URL or a server command after --");
  }
  return options;
}

function printHelp() {
  console.log(`Usage:
  node scripts/smoke-http.mjs -- node dist/server.js
  node scripts/smoke-http.mjs --origin http://127.0.0.1:3000

Options:
  --origin URL               Use an already-running server, such as Docker.
  --host HOST                Host for a spawned server. Default: 127.0.0.1.
  --port PORT                Port for a spawned server. Default: free port.
  --timeout-ms MS            Startup/request timeout. Default: ${DEFAULT_TIMEOUT_MS}.
  --output-channel CHANNEL   Session output_channel query value. Default: both.
  --story-event-id ID        Known event id for list_stories.
  --story-key KEY            Known story key for read_story.
  --fixture-data             Generate temporary minimal GameData and StoryJson fixtures.
`);
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function getFreePort(host) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, host, () => {
      const addr = server.address();
      server.close(() => {
        if (addr && typeof addr === "object") resolve(addr.port);
        else reject(new Error("no free port"));
      });
    });
  });
}

async function waitForHealth(origin, timeoutMs) {
  console.log(`Checking /health at ${origin} ...`);
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${origin}/health`, {
        signal: AbortSignal.timeout(Math.min(1_000, timeoutMs)),
      });
      if (res.ok) {
        const body = await readJsonOrText(res);
        if (body && typeof body === "object" && body.status === "ok") return;
        throw new Error(`unexpected /health body: ${JSON.stringify(body)}`);
      }
      lastError = `HTTP ${res.status}: ${await res.text()}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await delay(250);
  }
  throw new SmokeFailure("health", "server did not become healthy", lastError);
}

async function readJsonOrText(res) {
  const raw = await res.text();
  if (!raw) return null;
  const body = parseSseData(raw) ?? raw;
  try {
    return JSON.parse(body);
  } catch {
    return raw;
  }
}

function parseSseData(raw) {
  for (const event of raw.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n");
    if (data) return data;
  }
  return null;
}

async function mcpPost(origin, body, sessionId, timeoutMs, outputChannel) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  const url = new URL(`${origin}/mcp`);
  if (!sessionId && outputChannel) {
    url.searchParams.set("output_channel", outputChannel);
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return {
    status: res.status,
    sessionId: res.headers.get("mcp-session-id"),
    body: await readJsonOrText(res),
  };
}

function assertMcpOk(step, response) {
  if (response.status !== 200) {
    throw new SmokeFailure(step, `expected HTTP 200, got ${response.status}`, JSON.stringify(response.body));
  }
  if (!response.body || typeof response.body !== "object") {
    throw new SmokeFailure(step, "expected JSON-RPC response object", String(response.body));
  }
  if (response.body.error) {
    throw new SmokeFailure(step, "JSON-RPC returned error", JSON.stringify(response.body.error));
  }
  if (!response.body.result) {
    throw new SmokeFailure(step, "missing result", JSON.stringify(response.body));
  }
}

function resultText(response) {
  const content = response.body?.result?.content;
  if (!Array.isArray(content)) return "";
  return content.map((item) => item?.text ?? "").join("\n");
}

function structuredContent(response) {
  return response.body?.result?.structuredContent;
}

function requireStructuredObject(step, response) {
  const payload = structuredContent(response);
  if (!payload || typeof payload !== "object") {
    throw new SmokeFailure(
      step,
      "missing structuredContent object",
      JSON.stringify(response.body?.result ?? response.body, null, 2),
    );
  }
  return payload;
}

function hasDataUnavailable(text) {
  return text.includes("暂不可用") || text.includes("未就绪") || text.includes("请稍后重试");
}

function toolCall(name, args, id) {
  return {
    jsonrpc: "2.0",
    method: "tools/call",
    params: { name, arguments: args },
    id,
  };
}

function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data), "utf-8");
}

async function createFixtureData() {
  const { default: AdmZip } = await import("adm-zip");
  const root = mkdtempSync(join(tmpdir(), "prts-http-smoke-"));
  try {
    const gamedata = join(root, "gamedata");
    const excel = join(gamedata, "zh_CN", "gamedata", "excel");
    const storyZip = join(root, "storyjson", "zh_CN.zip");

    writeJson(join(excel, "character_table.json"), {
      char_002_amiya: {
        name: "阿米娅",
        appellation: "Amiya",
        displayNumber: "R001",
        description: "<@ba.kw>法术伤害</>",
        rarity: "TIER_5",
        profession: "CASTER",
        subProfessionId: "corecaster",
        position: "RANGED",
        nationId: "rhodes",
        groupId: "",
        teamId: "",
        tagList: ["输出", "支援"],
        itemUsage: "罗德岛的公开领袖。",
        itemDesc: "阿米娅的信物。",
        itemObtainApproach: "主线获得",
        talents: [
          {
            candidates: [
              { name: "？？？", description: "" },
              { name: "情绪吸收", description: "攻击回复技力" },
            ],
          },
        ],
      },
    });
    writeJson(join(excel, "handbook_info_table.json"), {
      handbookDict: {
        char_002_amiya: {
          storyTextAudio: [
            {
              storyTitle: "档案资料一",
              stories: [{ storyText: "阿米娅的档案文本。" }],
            },
          ],
        },
      },
    });
    writeJson(join(excel, "charword_table.json"), {
      charWords: {
        amiya_001: {
          charId: "char_002_amiya",
          voiceTitle: "任命助理",
          voiceText: "博士，今天也请多指教。",
        },
      },
    });
    writeJson(join(excel, "story_review_table.json"), {});
    writeJson(join(excel, "item_table.json"), { items: {} });

    mkdirSync(dirname(storyZip), { recursive: true });
    const zip = new AdmZip();
    const firstStoryKey = "activities/act_test/level_act_test_01_beg";
    const secondStoryKey = "activities/act_test/level_act_test_02_end";
    const storyFiles = {
      "zh_CN/gamedata/excel/story_review_table.json": {
        act_test: {
          name: "测试活动",
          entryType: "ACTIVITY",
          infoUnlockDatas: [
            {
              storyTxt: firstStoryKey,
              storyCode: "TEST-1",
              storyName: "开端",
              avgTag: "BEG",
              storySort: 1,
            },
            {
              storyTxt: secondStoryKey,
              storyCode: "TEST-2",
              storyName: "终章",
              avgTag: "END",
              storySort: 2,
            },
          ],
        },
      },
      [`zh_CN/gamedata/story/${firstStoryKey}.json`]: {
        storyCode: "TEST-1",
        storyName: "开端",
        avgTag: "BEG",
        eventName: "测试活动",
        storyInfo: "测试简介",
        storyList: [
          { prop: "name", attributes: { name: "阿米娅", content: "你好，{@nickname}。" } },
          { prop: "sticker", attributes: { content: "<b>场景描述</b>" } },
        ],
      },
      [`zh_CN/gamedata/story/${secondStoryKey}.json`]: {
        storyCode: "TEST-2",
        storyName: "终章",
        avgTag: "END",
        eventName: "测试活动",
        storyInfo: "",
        storyList: [
          { prop: "name", attributes: { name: "博士", content: "结束。" } },
        ],
      },
    };
    for (const [path, data] of Object.entries(storyFiles)) {
      zip.addFile(path, Buffer.from(JSON.stringify(data), "utf-8"));
    }
    zip.writeZip(storyZip);

    return { root, gamedata, storyZip };
  } catch (err) {
    rmSync(root, { recursive: true, force: true });
    throw err;
  }
}

async function initializeSession(origin, timeoutMs, outputChannel) {
  console.log("Initializing MCP session ...");
  const init = await mcpPost(
    origin,
    {
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "prts-http-smoke", version: "1.0.0" },
      },
      id: 1,
    },
    undefined,
    timeoutMs,
    outputChannel,
  );
  assertMcpOk("initialize", init);
  if (!init.sessionId) {
    throw new SmokeFailure("initialize", "missing Mcp-Session-Id response header", JSON.stringify(init.body));
  }
  return init.sessionId;
}

async function sendInitialized(origin, sessionId, timeoutMs, outputChannel) {
  console.log("Sending initialized notification ...");
  const response = await mcpPost(
    origin,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    sessionId,
    timeoutMs,
    outputChannel,
  );
  if (![200, 202].includes(response.status)) {
    throw new SmokeFailure(
      "notifications/initialized",
      `expected HTTP 200 or 202, got ${response.status}`,
      JSON.stringify(response.body),
    );
  }
  if (response.body && typeof response.body === "object" && response.body.error) {
    throw new SmokeFailure(
      "notifications/initialized",
      "JSON-RPC returned error",
      JSON.stringify(response.body.error),
    );
  }
}

async function checkToolsList(origin, sessionId, timeoutMs, outputChannel) {
  console.log("Checking tools/list surface ...");
  const response = await mcpPost(
    origin,
    { jsonrpc: "2.0", method: "tools/list", id: 2 },
    sessionId,
    timeoutMs,
    outputChannel,
  );
  assertMcpOk("tools/list", response);
  const tools = response.body.result.tools;
  if (!Array.isArray(tools)) {
    throw new SmokeFailure("tools/list", "result.tools is not an array", JSON.stringify(response.body.result));
  }
  const names = tools.map((tool) => tool.name).sort();
  const expected = [...EXPECTED_TOOLS].sort();
  const missing = expected.filter((name) => !names.includes(name));
  const extra = names.filter((name) => !expected.includes(name));
  if (names.length !== expected.length || missing.length > 0 || extra.length > 0) {
    throw new SmokeFailure(
      "tools/list",
      `expected exact ${expected.length}-tool surface`,
      JSON.stringify({ missing, extra, got: names }, null, 2),
    );
  }
}

async function callTool(origin, sessionId, timeoutMs, outputChannel, name, args, id) {
  const response = await mcpPost(
    origin,
    toolCall(name, args, id),
    sessionId,
    timeoutMs,
    outputChannel,
  );
  assertMcpOk(`tools/call ${name}`, response);
  return response;
}

async function checkOperator(origin, sessionId, timeoutMs, outputChannel) {
  console.log("Checking get_operator_basic_info ...");
  const response = await callTool(
    origin,
    sessionId,
    timeoutMs,
    outputChannel,
    "get_operator_basic_info",
    { name: "阿米娅" },
    3,
  );
  const text = resultText(response);
  const payload = requireStructuredObject("tools/call get_operator_basic_info", response);
  if (payload.name !== "阿米娅" || !payload.rarity) {
    throw new SmokeFailure(
      "tools/call get_operator_basic_info",
      "expected structured operator payload for 阿米娅",
      JSON.stringify(payload, null, 2),
    );
  }
  if (!text.includes("阿米娅")) {
    throw new SmokeFailure(
      "tools/call get_operator_basic_info",
      "expected usable bundled GameData result for 阿米娅",
      text.slice(0, 500),
    );
  }
}

async function discoverStoryTarget(origin, sessionId, timeoutMs, outputChannel, storyEventId, storyKey) {
  console.log("Checking list_story_events ...");
  const eventsResponse = await callTool(
    origin,
    sessionId,
    timeoutMs,
    outputChannel,
    "list_story_events",
    { category: "activities" },
    4,
  );
  const eventsText = resultText(eventsResponse);
  if (hasDataUnavailable(eventsText)) {
    throw new SmokeFailure("tools/call list_story_events", "story data is unavailable", eventsText.slice(0, 500));
  }
  const eventsPayload = requireStructuredObject("tools/call list_story_events", eventsResponse);
  if (!Array.isArray(eventsPayload.events)) {
    throw new SmokeFailure(
      "tools/call list_story_events",
      "missing structuredContent.events array",
      JSON.stringify(eventsResponse.body.result, null, 2),
    );
  }
  if (eventsPayload.events.length === 0) {
    throw new SmokeFailure("tools/call list_story_events", "no activity events returned", JSON.stringify(eventsPayload));
  }
  const eventId = storyEventId ?? eventsPayload.events.find((event) => event.story_count > 0)?.event_id;
  if (!eventId) {
    throw new SmokeFailure("story target discovery", "could not find an activity event with chapters", JSON.stringify(eventsPayload));
  }

  if (storyKey) return { eventId, storyKey };

  console.log(`Checking list_stories for ${eventId} ...`);
  const storiesResponse = await callTool(
    origin,
    sessionId,
    timeoutMs,
    outputChannel,
    "list_stories",
    { event_id: eventId, include_summaries: false },
    5,
  );
  const storiesText = resultText(storiesResponse);
  if (hasDataUnavailable(storiesText) || storiesText.includes("未找到活动")) {
    throw new SmokeFailure("tools/call list_stories", `event ${eventId} did not return stories`, storiesText.slice(0, 500));
  }
  const storiesPayload = requireStructuredObject("tools/call list_stories", storiesResponse);
  if (!Array.isArray(storiesPayload.chapters)) {
    throw new SmokeFailure(
      "tools/call list_stories",
      "missing structuredContent.chapters array",
      JSON.stringify(storiesResponse.body.result, null, 2),
    );
  }
  const chapter = storiesPayload.chapters.find((item) => typeof item.story_key === "string" && item.story_key.length > 0);
  if (!chapter) {
    throw new SmokeFailure("tools/call list_stories", `event ${eventId} has no readable story_key`, JSON.stringify(storiesPayload));
  }
  return { eventId, storyKey: chapter.story_key };
}

async function checkStoryRead(origin, sessionId, timeoutMs, outputChannel, target) {
  console.log(`Checking read_story for ${target.storyKey} ...`);
  const response = await callTool(
    origin,
    sessionId,
    timeoutMs,
    outputChannel,
    "read_story",
    { story_key: target.storyKey, include_narration: true },
    6,
  );
  const text = resultText(response);
  if (hasDataUnavailable(text) || text.includes("未找到剧情") || text.length < 20) {
    throw new SmokeFailure(
      "tools/call read_story",
      `expected readable story text for ${target.storyKey}`,
      text.slice(0, 500),
    );
  }
}

async function checkStructuredOutput(origin, sessionId, timeoutMs, outputChannel) {
  if (outputChannel !== "both" && outputChannel !== "structured") return;
  console.log("Checking structuredContent output ...");
  const response = await callTool(
    origin,
    sessionId,
    timeoutMs,
    outputChannel,
    "search",
    { scope: "operators", pattern: "阿米娅", max_results: 1 },
    7,
  );
  const payload = requireStructuredObject("output_channel structuredContent", response);
  if (!Array.isArray(payload.results)) {
    throw new SmokeFailure(
      "output_channel structuredContent",
      "structural search tool did not return a results array",
      JSON.stringify(payload, null, 2),
    );
  }
}

async function runSmoke(origin, options) {
  await waitForHealth(origin, options.timeoutMs);
  const sessionId = await initializeSession(origin, options.timeoutMs, options.outputChannel);
  await sendInitialized(origin, sessionId, options.timeoutMs, options.outputChannel);
  await checkToolsList(origin, sessionId, options.timeoutMs, options.outputChannel);
  await checkOperator(origin, sessionId, options.timeoutMs, options.outputChannel);
  const target = await discoverStoryTarget(
    origin,
    sessionId,
    options.timeoutMs,
    options.outputChannel,
    options.storyEventId,
    options.storyKey,
  );
  await checkStoryRead(origin, sessionId, options.timeoutMs, options.outputChannel, target);
  await checkStructuredOutput(origin, sessionId, options.timeoutMs, options.outputChannel);
  console.log(`HTTP MCP smoke passed at ${origin} (story: ${target.eventId} / ${target.storyKey})`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let child;
  let origin = options.origin;
  let stoppingChild = false;
  let fixture;

  try {
    if (!origin) {
      fixture = options.fixtureData ? await createFixtureData() : undefined;
      const port = options.port ?? await getFreePort(options.host);
      origin = `http://${options.host}:${port}`;
      const [command, ...args] = options.command;
      child = spawn(command, args, {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOST: options.host,
          PORT: String(port),
          ...(fixture
            ? {
                GAMEDATA_PATH: fixture.gamedata,
                STORYJSON_PATH: fixture.storyZip,
                GITHUB_MIRRORS: "",
              }
            : {}),
        },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
        if (stderr.length > 8_000) stderr = stderr.slice(-8_000);
      });
      child.on("exit", (code, signal) => {
        if (stoppingChild) return;
        if (code !== null && code !== 0) {
          console.error(`Server command exited with code ${code}.`);
        } else if (signal) {
          console.error(`Server command exited with signal ${signal}.`);
        }
      });
      try {
        await runSmoke(origin, options);
      } catch (err) {
        if (stderr) console.error(`\n--- server stderr ---\n${stderr}`);
        throw err;
      }
    } else {
      await runSmoke(origin, options);
    }
  } finally {
    if (child && !child.killed) {
      stoppingChild = true;
      child.kill();
    }
    if (fixture) {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`HTTP MCP smoke failed: ${message}`);
  process.exit(1);
});
