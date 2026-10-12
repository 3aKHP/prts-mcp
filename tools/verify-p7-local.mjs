#!/usr/bin/env node
/**
 * P7 standalone-directory verification: the packaged native directory
 * (bin/ + data/, no Node, no Bun, no source tree) serves the full LOCAL
 * business surface from the bundled read-only data — docs/07 完成条件
 * "仅 Rust binary 即可跑全部本地业务".
 *
 * Run with an EMPTY PATH to prove the binary needs no JS runtime.
 * Wiki tools (search_prts/prts_page + MediaWiki artwork) need the network
 * and are covered by the differential/live suites, not this offline check.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = new URL("..", import.meta.url).pathname;
const STAGE = join(ROOT, "build/package/prts-mcp-rust-local");
const BIN = join(STAGE, "bin/prts-mcp-rust");
const EMPTY = join(ROOT, ".runtime/fixtures/empty-gamedata-v1");
const IMAGES_VOL = join(ROOT, ".runtime/images-fullscale/rust-volume");

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail.slice(0, 150)}` : ""}`);
  if (!ok) failures++;
};

if (!existsSync(BIN)) {
  console.error("standalone package missing; run node tools/package-native.mjs --data-source …");
  process.exit(2);
}

function stdioRound(calls) {
  return new Promise((resolve, reject) => {
    // PATH deliberately empty: pure-native proof (glibc only).
    const child = spawn(BIN, ["--transport", "stdio"], {
      env: {
        GAMEDATA_PATH: EMPTY, // custom-but-empty → bundled data fallback
        STORYJSON_PATH: `${EMPTY}/none.zip`,
        GITHUB_MIRRORS: "",
        IMAGES_ENABLED: "true",
        LOCAL_IMAGE: "true",
        PRTS_IMAGE_DIR: IMAGES_VOL,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 9, method: "tools/list" });
    for (const [id, name, args] of calls) {
      send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    }
    const wanted = new Set([9, ...calls.map(([id]) => id)]);
    const deadline = Date.now() + 120000;
    const timer = setInterval(() => {
      const seen = new Set([...out.matchAll(/"id":(\d+)/g)].map((m) => m[1]));
      if ([...wanted].every((id) => seen.has(String(id))) || Date.now() > deadline) {
        clearInterval(timer);
        child.stdin.end();
        resolve({ out, err, status: "done" });
      }
    }, 120);
    child.on("exit", (code) => reject(new Error(`child exited early code=${code}: ${err.slice(0, 200)}`)));
  });
}

const calls = [
  [10, "list_stages", {}],
  [11, "search", { pattern: "阿米娅", scope: "operators", limit: 3 }],
  [12, "list_story_events", {}],
  [13, "operator_artwork", { action: "list", operator_name: "阿米娅" }],
];
const { out, err } = await stdioRound(calls);
const responseOf = (id) => {
  const line = out.split("\n").find((l) => l.includes(`"id":${id},`) || l.includes(`"id":${id}}`));
  return line ? JSON.parse(line) : null;
};

check("standalone binary runs with empty PATH (no Node/Bun)", !err.includes("error"));
const toolsList = responseOf(9);
check(
  "tools/list exposes all 24 tools",
  toolsList?.result?.tools?.length === 24,
  `count=${toolsList?.result?.tools?.length}`,
);
const listStages = responseOf(10);
check(
  "gamedata: list_stages from bundled data",
  listStages?.result?.content?.[0]?.text?.includes("关卡列表"),
  listStages?.result?.content?.[0]?.text?.slice(0, 80),
);
const search = responseOf(11);
check(
  "search operators from bundled data",
  search?.result?.content?.[0]?.text?.includes("阿米娅"),
  search?.result?.content?.[0]?.text?.slice(0, 80),
);
const events = responseOf(12);
check(
  "story: list_story_events from bundled zip",
  Boolean(events?.result?.content?.[0]?.text) && !events?.error,
  events?.result?.content?.[0]?.text?.slice(0, 80),
);
const artwork = responseOf(13);
const artworkText = artwork?.result?.content?.[0]?.text ?? "";
check(
  "images: operator_artwork local list from real images volume",
  artworkText.includes("的立绘"),
  artworkText.slice(0, 90),
);

console.log(failures === 0 ? "LOCAL_VERIFY_PASS" : `LOCAL_VERIFY_FAIL(${failures})`);
process.exit(failures === 0 ? 0 : 1);
