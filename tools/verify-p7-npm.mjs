#!/usr/bin/env node
// P7 npm-package verification: 3 entry semantics, stdio passthrough,
// bundled-data fallback via the launcher's --bundle-root, signals, exits.
import { spawn } from "node:child_process";
import { readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = new URL("..", import.meta.url).pathname;
const PROJ = join(ROOT, ".runtime/npm-install/proj");
const BIN = (name) => `${PROJ}/node_modules/.bin/${name}`;
const EMPTY = join(ROOT, ".runtime/fixtures/empty-gamedata-v1");
const baseEnv = (extra = {}) => ({
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  GAMEDATA_PATH: EMPTY, // custom-but-empty → bundle fallback must engage
  STORYJSON_PATH: `${EMPTY}/nope.zip`,
  GITHUB_MIRRORS: "",
  IMAGES_ENABLED: "true",
  HOST: "127.0.0.1",
  ...extra,
});

// Fresh install project dir.
rmSync(PROJ, { recursive: true, force: true });
mkdirSync(PROJ, { recursive: true });
const { spawnSync } = await import("node:child_process");
spawnSync("npm", ["init", "-y"], { cwd: PROJ, stdio: "ignore" });
spawnSync("npm", ["install", join(ROOT, `build/prts-mcp-rust-local-${readFileSync(join(ROOT, "Cargo.toml"), "utf8").match(/^version\s*=\s*"([^"]+)"/m)[1]}.tgz`)], { cwd: PROJ, stdio: "ignore" });

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// 1. stdio bin: initialize → tools/call (bundled data) → EOF exit 0.
{
  const child = spawn(BIN("prts-mcp-ts-stdio"), [], { env: baseEnv(), stdio: ["pipe", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !out.includes("serverInfo")) await sleep(50);
  check("stdio initialize responds", out.includes("serverInfo"));
  send({ jsonrpc: "2.0", id: 2, method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_stages", arguments: {} } });
  while (Date.now() < deadline + 8000 && !out.includes('"id":3')) await sleep(50);
  const callLine = out.split("\n").find((l) => l.includes('"id":3'));
  check("stdio tools/call uses bundled data", Boolean(callLine) && !callLine.includes("数据暂不可用"), callLine?.slice(0, 90));
  // stdout purity: only JSON lines.
  check("stdout is pure protocol", out.split("\n").filter(Boolean).every((l) => l.startsWith("{")));
  child.stdin.end();
  const [code] = await once(child, "exit");
  check("stdio EOF exits 0 via launcher", code === 0, `code=${code}`);
}

// 2. HTTP bins (ts + ts-bun): default HTTP, /health, tool call, then SIGTERM.
for (const name of ["prts-mcp-ts", "prts-mcp-ts-bun"]) {
  const child = spawn(BIN(name), [], { env: baseEnv({ PORT: "0" }), stdio: ["pipe", "pipe", "pipe"] });
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  const start = Date.now();
  while (Date.now() - start < 5000 && !/listening on (\S+)/.test(err)) await sleep(50);
  const m = err.match(/listening on 127\.0\.0\.1:(\S+) /);
  const port = m?.[1];
  if (port === "NaN" || !port) {
    // ephemeral: discover via /proc — instead assert log presence and skip HTTP probe
    check(`${name} HTTP log present`, Boolean(m), err.slice(0, 120));
  }
  if (port && /^\d+$/.test(port) && Number(port) > 0) {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    check(`${name} /health`, res.status === 200 && (await res.text()) === '{"status":"ok"}');
    const r2 = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } }),
    });
    check(`${name} initialize over HTTP`, r2.status === 200 && r2.headers.get("mcp-session-id"));
  } else {
    // PORT=0 → ephemeral; find the bound port from ss
    const { execFileSync } = await import("node:child_process");
    const table = execFileSync("ss", ["-ltnpH"], { encoding: "utf8" });
    const line = table
      .split("\n")
      .find((l) => l.includes(`prts-mcp-${name === "prts-mcp-ts-bun" ? "ts-bun" : "ts"}"`));
    const p = line?.trim().split(/\s+/)[3]?.split(":").pop();
    if (p) {
      const res = await fetch(`http://127.0.0.1:${p}/health`);
      check(`${name} /health (ephemeral ${p})`, res.status === 200);
    } else check(`${name} found listener`, false);
  }
  child.kill("SIGTERM");
  const [code, signal] = await once(child, "exit");
  check(`${name} SIGTERM mirrors signal death`, signal === "SIGTERM" || code === 143, `code=${code} sig=${signal}`);
}

// 3. stdout/stderr passthrough & argv: --transport stdio on prts-mcp-ts? Not
//    a documented arg for ts bins (TS bins don't switch); verify argv reaches
//    the binary via prts-mcp-rust-only flag absence — instead verify exit code
//    propagation: kill child via invalid GAMEDATA? Use env error path: PORT
//    busy → binary exits 1, launcher must exit 1.
{
  const holder = await import("node:net").then(({ createServer }) => {
    const s = createServer();
    s.listen(39990, "127.0.0.1");
    return s;
  });
  await sleep(200);
  const child = spawn(BIN("prts-mcp-ts"), [], { env: baseEnv({ PORT: "39990" }), stdio: ["pipe", "pipe", "pipe"] });
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  const [code] = await Promise.race([once(child, "exit"), sleep(8000).then(() => ["timeout"])]);
  check("launcher propagates child exit code 1", code === 1, `code=${code} err=${err.slice(-120)}`);
  holder.close();
}

// 4. private: true — pack refuse on publish attempt (quick sanity)
{
  const { execFileSync } = await import("node:child_process");
  let refused = false;
  try {
    execFileSync("npm", ["publish"], { cwd: `${PROJ}/node_modules/prts-mcp-rust-local`, stdio: "pipe" });
  } catch (e) {
    refused = true;
  }
  const pkgJson = JSON.parse(readFileSync(`${PROJ}/node_modules/prts-mcp-rust-local/package.json`, "utf8"));
  check(
    "npm publish fails & package is private:true",
    refused && pkgJson.private === true && !pkgJson.publishConfig,
  );
}

console.log(failures === 0 ? "NPM_VERIFY_PASS" : `NPM_VERIFY_FAIL(${failures})`);
process.exit(failures === 0 ? 0 : 1);
