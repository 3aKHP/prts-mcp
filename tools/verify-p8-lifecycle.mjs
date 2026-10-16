#!/usr/bin/env node
/**
 * P8 FINAL-live lifecycle evidence (docs/07 P8): one complete
 * update → offline recovery → old-volume read-back chain, plus a live
 * public-upstream re-run summary slot (the live differential itself is
 * `node tools/verify.mjs --live` and is re-run at P8 acceptance).
 *
 *  1. Complete update: fresh volume, Rust syncs the REAL datarev release
 *     from a local mirror; tools serve the new data.
 *  2. Offline recovery: network replaced by a dead mirror, server restarted
 *     on the same volume — data intact, tools serve, no destructive resync.
 *  3. Old-volume read-back:
 *     a. the P2-era PAIR-pointer volume written by the REAL TS sync code;
 *     b. by default the P6-era full-size images volume written by REAL TS
 *        syncImages (2802 artworks). --images-volume overrides that source;
 *        M1B CI uses five synthetic artworks written by the same TS sync.
 */
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = new URL("..", import.meta.url).pathname;
const RUST = join(ROOT, "target/release/prts-mcp-rust");
const DATA_RELEASE_DIR = join(ROOT, ".runtime/data");
const WORK = join(ROOT, ".runtime/p8-lifecycle");

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail.slice(0, 160)}` : ""}`);
  if (!ok) failures++;
};
const gh = (tag, asset) => `https://github.com/3aKHP/arknights-data-pipeline/releases/download/${tag}/${asset}`;

function buildMirror(tag) {
  const releaseDir = join(DATA_RELEASE_DIR, tag);
  const fixtureDir = join(WORK, "mirror");
  mkdirSync(fixtureDir, { recursive: true });
  const lines = [];
  for (const asset of ["manifest.json", "zh_CN-excel.zip", "zh_CN-levels.zip", "zh_CN.zip"]) {
    execFileSync("cp", [join(releaseDir, asset), join(fixtureDir, asset)]);
    lines.push(`${gh(tag, asset)} ${asset}`);
  }
  writeFileSync(join(fixtureDir, "assets.txt"), lines.join("\n") + "\n");
  writeFileSync(join(fixtureDir, "releases.json"), JSON.stringify([
    { tag_name: tag, created_at: "2026-10-08T05:00:00Z",
      assets: ["manifest.json", "zh_CN-excel.zip", "zh_CN-levels.zip", "zh_CN.zip"].map((name) => ({ name, browser_download_url: gh(tag, name) })) },
  ]));
  return fixtureDir;
}

function startRustHttp(vol, mirrors) {
  // XDG_DATA_HOME (NOT GAMEDATA_PATH): a custom GAMEDATA_PATH disables
  // auto-sync by contract — the lifecycle needs the sync to RUN into the
  // volume, so the default-path branch with a redirected XDG root is used.
  const child = spawn(RUST, ["--transport", "http"], {
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME,
      XDG_DATA_HOME: vol,
      GITHUB_MIRRORS: mirrors,
      IMAGES_ENABLED: "false",
      HOST: "127.0.0.1", PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.errText = "";
  child.stderr.on("data", (d) => (child.errText += d));
  child.waitLog = async (needle, limitMs = 300000) => {
    const start = Date.now();
    while (!child.errText.includes(needle) && Date.now() - start < limitMs) await sleep(150);
    return child.errText.includes(needle);
  };
  return child;
}

async function toolCall(child, name, args) {
  // Discover ephemeral port via ss.
  const table = execFileSync("ss", ["-ltnpH"], { encoding: "utf-8" });
  const line = table.split("\n").find((l) => l.includes(`pid=${child.pid},`));
  const port = line?.trim().split(/\s+/)[3]?.split(":").pop();
  const origin = `http://127.0.0.1:${port}`;
  const init = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } }),
  });
  const sid = init.headers.get("mcp-session-id");
  const res = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": sid },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await res.text();
  const data = JSON.parse(text.split("\n").find((l) => l.startsWith("data: "))?.slice(6) ?? "{}");
  return data?.result?.content?.[0]?.text ?? "";
}

function stdioCall(env, calls) {
  const child = spawn(RUST, ["--transport", "stdio"], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, GITHUB_MIRRORS: "", IMAGES_ENABLED: "true", ...env },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  for (const [id, name, args] of calls) send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  return new Promise((resolve) => {
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    const wanted = new Set(calls.map(([id]) => id));
    const timer = setInterval(() => {
      const seen = new Set([...out.matchAll(/"id":(\d+)/g)].map((m) => m[1]));
      if ([...wanted].every((id) => seen.has(String(id)))) {
        clearInterval(timer);
        child.stdin.end();
        const resp = (id) => {
          const line = out.split("\n").find((l) => l.includes(`"id":${id},`) || l.includes(`"id":${id}}`));
          return line ? JSON.parse(line) : null;
        };
        resolve(Object.fromEntries(calls.map(([id]) => [id, resp(id)])));
      }
    }, 100);
    setTimeout(() => { clearInterval(timer); child.kill("SIGKILL"); resolve({}); }, 120000);
  });
}

async function main() {
  const tags = readdirSync(DATA_RELEASE_DIR).filter((d) => d.startsWith("datarev-"));
  const tag = tags.sort().at(-1);
  const mirror = spawn("node", [join(ROOT, "tools/images-mirror.mjs"), buildMirror(tag)], {
    env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "inherit"],
  });
  const portLine = await new Promise((resolve) => {
    let buf = "";
    mirror.stdout.on("data", (d) => { buf += d; const i = buf.indexOf("\n"); if (i >= 0) resolve(buf.slice(0, i)); });
  });
  const mirrorUrl = `http://127.0.0.1:${JSON.parse(portLine).port}/`;
  console.log("mirror:", mirrorUrl, "release:", tag);

  // 1. Complete update on a fresh volume.
  const vol = join(WORK, "vol");
  execFileSync("rm", ["-rf", vol]);
  mkdirSync(vol, { recursive: true });
  const dataGamedata = () => join(vol, "prts-mcp/gamedata");
  {
    const child = startRustHttp(vol, mirrorUrl);
    const listened = await child.waitLog("listening on", 30000);
    const synced = listened && (await child.waitLog("Next auto-sync check", 300000));
    const text = synced ? await toolCall(child, "search", { pattern: "阿米娅", scope: "operators", limit: 3 }) : "";
    check("complete update: fresh volume syncs real release and serves search", synced && text.includes("阿米娅"), text.slice(0, 90));
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));
  }

  // 2. Offline recovery: dead mirror, same volume, restart.
  {
    const releasesBefore = readdirSync(join(dataGamedata(), ".releases")).length;
    const metaBefore = readFileSync(join(dataGamedata(), "archives/extract_meta.json"), "utf-8");
    const child = startRustHttp(vol, "http://127.0.0.1:9/");
    const listened = await child.waitLog("listening on", 30000);
    await sleep(2500); // offline branch settles fast; then query
    const stages = listened ? await toolCall(child, "list_stages", {}) : "";
    const search = listened ? await toolCall(child, "search", { pattern: "阿米娅", scope: "operators", limit: 3 }) : "";
    const releasesAfter = readdirSync(join(dataGamedata(), ".releases")).length;
    const metaAfter = readFileSync(join(dataGamedata(), "archives/extract_meta.json"), "utf-8");
    check("offline recovery: tools still serve", stages.includes("关卡列表") && search.includes("阿米娅"), stages.slice(0, 80));
    check("offline recovery: no destructive resync", releasesAfter === releasesBefore && metaAfter === metaBefore,
      `releases ${releasesBefore}→${releasesAfter}`);
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));
  }

  // 3a. Old PAIR-pointer volume written by the REAL TS sync (P2 fixture).
  {
    const pairVol = join(ROOT, ".runtime/fixtures/activated-minimal-v1");
    const out = await stdioCall(
      { GAMEDATA_PATH: join(pairVol, "gamedata"), STORYJSON_PATH: join(pairVol, "nope.zip") },
      [[10, "list_stages", {}]],
    );
    check("old-volume read-back: TS-written pair volume serves list_stages",
      out[10]?.result?.content?.[0]?.text?.includes("关卡列表"));
  }

  // 3b. Real TS-written images volume: historical full-scale by default,
  // or the explicit representative fixture supplied by M1B validation.
  {
    const arg = process.argv.indexOf("--images-volume");
    const imgVol = arg >= 0 ? process.argv[arg + 1] : join(ROOT, ".runtime/images-fullscale/ts-volume");
    if (!existsSync(imgVol)) {
      check("old-volume read-back: TS-written images volume present", false, `${imgVol} missing`);
    } else {
      const out = await stdioCall(
        {
          GAMEDATA_PATH: join(ROOT, ".runtime/fixtures/minimal-images-v1"),
          STORYJSON_PATH: join(ROOT, ".runtime/fixtures/minimal-images-v1/does-not-exist.zip"),
          LOCAL_IMAGE: "true",
          PRTS_IMAGE_DIR: imgVol,
        },
        [[11, "operator_artwork", { action: "list", operator_name: "阿米娅" }]],
      );
      const text = out[11]?.result?.content?.[0]?.text ?? "";
      check("old-volume read-back: TS-written images volume serves artwork list",
        text.includes("的立绘"), text.slice(0, 80));
    }
  }

  mirror.kill();
  console.log(failures === 0 ? "LIFECYCLE_VERIFY_PASS" : `LIFECYCLE_VERIFY_FAIL(${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
