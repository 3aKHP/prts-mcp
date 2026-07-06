#!/usr/bin/env node
/**
 * Black-box Streamable HTTP smoke test for the TypeScript MCP server.
 *
 * Usage:
 *   node scripts/smoke-http.mjs -- node dist/server.js
 *   node scripts/smoke-http.mjs --origin http://127.0.0.1:3000
 */

import { spawn } from "node:child_process";
import { createServer } from "node:net";
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
  const sseMatch = raw.match(/^data:\s*(\{[\s\S]*\})/m);
  const body = sseMatch?.[1] ?? raw;
  try {
    return JSON.parse(body);
  } catch {
    return raw;
  }
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
  if (!text.includes("阿米娅") || hasDataUnavailable(text)) {
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
  const eventsPayload = structuredContent(eventsResponse);
  if (!eventsPayload || !Array.isArray(eventsPayload.events)) {
    throw new SmokeFailure(
      "tools/call list_story_events",
      "missing structuredContent.events; run smoke with output_channel=both",
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
  const storiesPayload = structuredContent(storiesResponse);
  if (!storiesPayload || !Array.isArray(storiesPayload.chapters)) {
    throw new SmokeFailure(
      "tools/call list_stories",
      "missing structuredContent.chapters",
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
  const payload = structuredContent(response);
  if (!payload || typeof payload !== "object") {
    throw new SmokeFailure(
      "output_channel structuredContent",
      "structural tool did not return structuredContent",
      JSON.stringify(response.body.result, null, 2),
    );
  }
}

async function runSmoke(origin, options) {
  await waitForHealth(origin, options.timeoutMs);
  const sessionId = await initializeSession(origin, options.timeoutMs, options.outputChannel);
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

  try {
    if (!origin) {
      const port = options.port ?? await getFreePort(options.host);
      origin = `http://${options.host}:${port}`;
      const [command, ...args] = options.command;
      child = spawn(command, args, {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOST: options.host,
          PORT: String(port),
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
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`HTTP MCP smoke failed: ${message}`);
  process.exit(1);
});
