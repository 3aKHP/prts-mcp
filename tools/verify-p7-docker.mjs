#!/usr/bin/env node
/**
 * P7 docker verification (local tags only — nothing is pushed):
 *
 *  1. Both profiles build from the staged contexts.
 *  2. TS profile: default HTTP :3000, PRTS_MCP_ROOT=/app, 4-volume layout,
 *     bundled /app/data fallback serves with empty volumes.
 *  3. GHCR profile: default stdio handshake; PRTS_TRANSPORT=http honors
 *     python int(PORT) semantics (non-numeric → exit 1 + message).
 *  4. Real in-container sync from a local GitHub mirror writes the 4
 *     volumes; the OLD TS oracle and the OLD GHCR (python) implementation
 *     then read the Rust-written volumes successfully.
 *
 * Requires: docker, bun, uv (outer repo python env), node >=22.
 */
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, copyFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = new URL("..", import.meta.url).pathname;
const OUTER = join(ROOT, ".reference/ts-v2.8.1");
const TS = join(ROOT, ".reference/ts-v2.8.1/ts");
const DATA_RELEASE_DIR = join(ROOT, ".runtime/data");
const VOL = join(ROOT, ".runtime/docker-vol");
const GATEWAY = "172.17.0.1";
const TS_IMAGE = "prts-mcp-rust:ts-local";
const GHCR_IMAGE = "prts-mcp-rust:ghcr-local";

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail.slice(0, 180)}` : ""}`);
  if (!ok) failures++;
};
const sh = (cmd, args = [], opts = {}) =>
  execFileSync(cmd, args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], ...opts });

// ---------------------------------------------------------------------------
// Mirror fixture: the REAL data release (datarev-…-r2) served as GitHub.
// ---------------------------------------------------------------------------

function findDataRelease() {
  const candidates = readdirSync(DATA_RELEASE_DIR).filter((d) => d.startsWith("datarev-"));
  if (candidates.length === 0) throw new Error("no datarev release under .runtime/data (run tools/fetch-data.mjs)");
  return candidates.sort().at(-1);
}

function buildMirrorFixture(tag) {
  const releaseDir = join(DATA_RELEASE_DIR, tag);
  const fixtureDir = join(ROOT, ".runtime/docker-mirror");
  rmSync(fixtureDir, { recursive: true, force: true });
  mkdirSync(fixtureDir, { recursive: true });
  const gh = (asset) =>
    `https://github.com/3aKHP/arknights-data-pipeline/releases/download/${tag}/${asset}`;
  const assetLines = [];
  for (const asset of ["manifest.json", "zh_CN-excel.zip", "zh_CN-levels.zip", "zh_CN.zip"]) {
    const from = join(releaseDir, asset);
    if (!existsSync(from)) throw new Error(`release ${tag} lacks ${asset}`);
    copyFileSync(from, join(fixtureDir, asset));
    assetLines.push(`${gh(asset)} ${asset}`);
  }
  writeFileSync(join(fixtureDir, "assets.txt"), assetLines.join("\n") + "\n");
  const releases = [
    {
      tag_name: tag,
      created_at: "2026-10-08T05:00:00Z",
      assets: ["manifest.json", "zh_CN-excel.zip", "zh_CN-levels.zip", "zh_CN.zip"].map((name) => ({
        name,
        browser_download_url: gh(name),
      })),
    },
  ];
  writeFileSync(join(fixtureDir, "releases.json"), JSON.stringify(releases));
  return fixtureDir;
}

async function main() {
  const tag = findDataRelease();
  const fixtureDir = buildMirrorFixture(tag);
  const mirror = spawn("node", [join(ROOT, "tools/images-mirror.mjs"), fixtureDir], {
    env: { PATH: process.env.PATH, MIRROR_HOST: "0.0.0.0" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const mirrorPort = JSON.parse((await readLine(mirror.stdout)).trim()).port;
  const mirrorUrl = `http://${GATEWAY}:${mirrorPort}/`;
  console.log(`mirror: ${mirrorUrl} (release ${tag})`);

  // 1. Build both images.
  try {
    sh("docker", ["build", "-t", TS_IMAGE, join(ROOT, "build/docker/ts")]);
    check("docker build ts profile", true);
  } catch (e) {
    check("docker build ts profile", false, e.stderr || String(e));
  }
  try {
    sh("docker", ["build", "-t", GHCR_IMAGE, join(ROOT, "build/docker/ghcr")]);
    check("docker build ghcr profile", true);
  } catch (e) {
    check("docker build ghcr profile", false, e.stderr || String(e));
  }

  // Fresh 4-volume layout. The containers run as root (image parity), so
  // previous-run volume content is root-owned — reset through docker.
  mkdirSync(VOL, { recursive: true });
  sh("docker", [
    "run", "--rm", "-v", `${VOL}:/v`, "ubuntu:24.04", "sh", "-c",
    `rm -rf /v/gamedata /v/gamedata-levels /v/storyjson /v/images /v/.gamedata_pair.json ` +
      `&& mkdir -p /v/gamedata /v/gamedata-levels /v/storyjson /v/images ` +
      `&& chown -R ${process.getuid()}:${process.getgid()} /v`,
  ]);
  const volArgs = [
    "-v", `${join(VOL, "gamedata")}:/data/gamedata`,
    "-v", `${join(VOL, "gamedata-levels")}:/data/gamedata-levels`,
    "-v", `${join(VOL, "storyjson")}:/data/storyjson`,
    "-v", `${join(VOL, "images")}:/data/images`,
  ];

  // 2. GHCR profile FIRST (before volumes are written): stdio default +
  //    bundled fallback, no mirror (offline container). Custom-but-empty
  //    GAMEDATA_PATH disables auto-sync AND forces the /app/data bundle
  //    fallback — no volume mounts, no network.
  const offlineEnv = [
    "-e", "GAMEDATA_PATH=/tmp/empty", "-e", "STORYJSON_PATH=/tmp/none.zip",
  ];
  {
    const input = [
      { jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 3, method: "tools/call",
        params: { name: "list_stages", arguments: {} } },
    ].map((m) => JSON.stringify(m)).join("\n") + "\n";
    const run = spawnSync("docker", ["run", "--rm", "-i", ...offlineEnv, GHCR_IMAGE], {
      input,
      encoding: "utf-8",
      timeout: 60000,
    });
    const ok = run.status === 0 && run.stdout.includes("serverInfo") && run.stdout.includes("关卡列表");
    check("ghcr default stdio + bundled /app/data serves list_stages", ok,
      `status=${run.status} ${run.stdout.slice(0, 120)}`);
  }
  {
    // PORT semantics on the http branch.
    const bad = spawnSync("docker", ["run", "--rm", "-e", "PRTS_TRANSPORT=http", "-e", "PORT=abc", GHCR_IMAGE], {
      encoding: "utf-8", timeout: 30000,
    });
    check(
      "ghcr PRTS_TRANSPORT=http PORT=abc exits 1 with message",
      bad.status === 1 && /PORT must be numeric, got 'abc'\. Exiting\./.test(bad.stderr),
      `status=${bad.status} ${bad.stderr.slice(-140)}`,
    );
    // stdio branch ignores PORT entirely.
    const stdio = spawnSync("docker", ["run", "--rm", "-i", ...offlineEnv, "-e", "PORT=abc", GHCR_IMAGE], {
      input: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      }) + "\n",
      encoding: "utf-8", timeout: 30000,
    });
    check("ghcr stdio ignores PORT=abc", stdio.status === 0 && stdio.stdout.includes("serverInfo"));
  }

  // 3. TS profile: default HTTP on :3000; offline container first proves the
  //    bundle fallback, then we restart it with the mirror to do a REAL sync.
  {
    const container = "prts-p7-ts-offline";
    spawnSync("docker", ["rm", "-f", container], { encoding: "utf-8" });
    const off = spawnSync("docker", [
      "run", "-d", "--name", container, "-p", "127.0.0.1:39995:3000",
      "-e", "GAMEDATA_PATH=/tmp/empty", "-e", "STORYJSON_PATH=/tmp/none.zip",
      TS_IMAGE,
    ], { encoding: "utf-8", timeout: 60000 });
    const started = off.status === 0;
    let healthOk = false, bundleOk = false, logs = "";
    if (started) {
      for (let i = 0; i < 60 && !healthOk; i++) {
        await sleep(300);
        try {
          const res = await fetch("http://127.0.0.1:39995/health");
          healthOk = res.status === 200 && (await res.text()) === '{"status":"ok"}';
        } catch {}
      }
      const call = await mcpCall("http://127.0.0.1:39995", "list_stages");
      bundleOk = call.ok && !call.text.includes("数据暂不可用");
      logs = sh("docker", ["logs", container], { maxBuffer: 1 << 22 });
    }
    check("ts profile default HTTP :3000 /health", healthOk);
    check("ts profile bundled /app/data fallback (empty volumes, offline)", bundleOk, logs.slice(0, 160));
    spawnSync("docker", ["rm", "-f", container], { encoding: "utf-8" });
  }

  // 4. TS profile with the local mirror: REAL in-container sync → 4 volumes.
  {
    const container = "prts-p7-ts-sync";
    spawnSync("docker", ["rm", "-f", container], { encoding: "utf-8" });
    const run = spawnSync("docker", [
      "run", "-d", "--name", container, "-p", "127.0.0.1:39996:3000",
      "-e", `GITHUB_MIRRORS=${mirrorUrl}`,
      ...volArgs, TS_IMAGE,
    ], { encoding: "utf-8", timeout: 60000 });
    if (run.status !== 0) {
      check("ts sync container starts", false, run.stderr);
    } else {
      // Wait for the durable sync markers. NOTE: with the 4 subdirectory
      // mounts (the old images' layout) /data itself is container-local, so
      // the pair pointer lives in the overlay — the durable markers are the
      // per-root extract_meta.json files plus the story zip. Same for the
      // old TS image; not a Rust deviation.
      const markers = [
        join(VOL, "gamedata/archives/extract_meta.json"),
        join(VOL, "gamedata-levels/archives/extract_meta.json"),
        join(VOL, "storyjson/zh_CN.zip"),
      ];
      let synced = false;
      for (let i = 0; i < 240 && !synced; i++) {
        await sleep(1000);
        synced = markers.every((m) => existsSync(m));
      }
      check("in-container Rust sync completes (pair pointer + story zip)", synced,
        sh("docker", ["logs", container], { maxBuffer: 1 << 22 }).slice(-400));

      if (synced) {
        const call = await mcpCall("http://127.0.0.1:39996", "search", { pattern: "阿米娅", scope: "operators", limit: 3 });
        check("synced volume serves search via HTTP", call.ok, call.text.slice(0, 140));

        // 4a. OLD TS oracle (dist stdio entry) reads the Rust-written volume.
        const tsInput = [
          { jsonrpc: "2.0", id: 1, method: "initialize",
            params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
          { jsonrpc: "2.0", method: "notifications/initialized" },
          { jsonrpc: "2.0", id: 2, method: "tools/call",
            params: { name: "search", arguments: { pattern: "阿米娅", scope: "operators", limit: 3 } } },
        ].map((m) => JSON.stringify(m)).join("\n") + "\n";
        const ts = spawnSync("bun", [join(TS, "dist/server-stdio.js")], {
          env: {
            PATH: process.env.PATH, HOME: process.env.HOME,
            GAMEDATA_PATH: join(VOL, "gamedata"),
            STORYJSON_PATH: join(VOL, "storyjson/zh_CN.zip"),
            GITHUB_MIRRORS: "", IMAGES_ENABLED: "true",
          },
          input: tsInput,
          encoding: "utf-8", timeout: 120000, maxBuffer: 1 << 24,
        });
        const tsOut = ts.stdout ?? "";
        const tsOk = ts.status === 0 && tsOut.includes("serverInfo") && tsOut.includes("阿米娅");
        check("OLD TS (bun dist/server-stdio) reads Rust-written volume", tsOk,
          `status=${ts.status} ${tsOut.slice(0, 140)}`);

        // 4b. OLD GHCR (python impl, GHCR image source) reads the same
        //     volume through its data layer (Config.load + resolve_char_id).
        const py = spawnSync("uv", [
          "run", "--directory", join(OUTER, "python"), "--locked", "python", "-c",
          [
            "from prts_mcp.config import Config",
            "from prts_mcp.data.operator import resolve_char_id",
            "import os.path",
            'cfg = Config.load()',
            'cid = resolve_char_id("阿米娅")',
            "story = cfg.storyjson_zip",
            'print("OK", cid, os.path.isfile(story) if story else False)',
          ].join("\n"),
        ], {
          encoding: "utf-8",
          timeout: 180000,
          maxBuffer: 1 << 24,
          env: {
            ...process.env,
            GAMEDATA_PATH: join(VOL, "gamedata"),
            STORYJSON_PATH: join(VOL, "storyjson/zh_CN.zip"),
          },
        });
        const pyOut = py.stdout ?? "";
        const pyErr = py.stderr ?? "";
        const pyOk = py.status === 0 && /OK char_\S+ True/.test(pyOut);
        check("OLD GHCR (python Config.load + resolve_char_id) reads Rust volume", pyOk,
          `${py.error ? String(py.error) : ""} ${pyOut.slice(0, 120)} ${pyErr.slice(-200)}`);
      }
      spawnSync("docker", ["rm", "-f", container], { encoding: "utf-8" });
    }
  }

  mirror.kill();
  console.log(failures === 0 ? "DOCKER_VERIFY_PASS" : `DOCKER_VERIFY_FAIL(${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

function readLine(stream) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (d) => {
      buf += d;
      const i = buf.indexOf("\n");
      if (i >= 0) {
        stream.off("data", onData);
        resolve(buf.slice(0, i));
      }
    };
    stream.on("data", onData);
    stream.once("error", reject);
  });
}

async function mcpCall(origin, name, args = {}) {
  try {
    const init = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      }),
    });
    const sid = init.headers.get("mcp-session-id");
    const res = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": sid,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }),
    });
    const text = await res.text();
    const data = text.split("\n").find((l) => l.startsWith("data: "))?.slice(6);
    const parsed = JSON.parse(data);
    const toolText = parsed?.result?.content?.[0]?.text ?? "";
    return { ok: res.status === 200 && !parsed?.error && Boolean(toolText), text: toolText };
  } catch (e) {
    return { ok: false, text: String(e) };
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
