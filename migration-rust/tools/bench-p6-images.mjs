/**
 * P6 full-scale images sync measurement (docs/06: 完整规模图片同步测量).
 * Real upstream (3aKHP/arknights-data-pipeline images releases), no mirror,
 * no proxy. Runs the frozen TS syncImages and the Rust sync chain into two
 * isolated volumes; records durations + VmHWM/VmRSS + resulting meta into
 * artifacts/p6-images-bench.json. Requires public network; failure marks
 * the row blocked (never claimed as pass).
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RUNTIME = join(ROOT, ".runtime", "images-fullscale");
const TS = join(ROOT, ".reference", "ts-v2.8.1", "ts");

function run(cmd, argv, env) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(cmd, argv, { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ timeout: true, out, err, durationMs: Date.now() - started });
    }, 40 * 60 * 1000);
    child.on("exit", () => {
      clearTimeout(timer);
      resolve({ timeout: false, out, err, durationMs: Date.now() - started });
    });
  });
}

function volumeStats(dir) {
  if (!existsSync(join(dir, ".images_meta.json"))) return null;
  const meta = JSON.parse(readFileSync(join(dir, ".images_meta.json"), "utf8"));
  let files = 0, bytes = 0;
  const walk = (p) => {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const full = join(p, e.name);
      // The generation tree lives under .releases/ — traverse it; skip the
      // other dot entries (locks, staging).
      if (e.isDirectory() && (e.name === ".releases" || !e.name.startsWith("."))) walk(full);
      else if (e.isFile() && e.name.endsWith(".png")) {
        files += 1;
        bytes += statSync(full).size;
      }
    }
  };
  walk(dir);
  return { meta, pngFiles: files, pngBytes: bytes };
}


const childEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  GITHUB_MIRRORS: "",
  GAMEDATA_PATH: "/nonexistent-custom",
  STORYJSON_PATH: "/nonexistent.zip",
};

const report = { started_at: new Date().toISOString(), runs: [] };

// --- TS full sync
mkdirSync(join(RUNTIME, "ts-volume"), { recursive: true });
const tsRun = await run("node", [join(ROOT, "tools", "ts-interop-peer.mjs"), "images-fullsync",
  join(RUNTIME, "ts-volume"), "false"], { ...childEnv, https_proxy: "", HTTPS_PROXY: "" });
const tsLine = tsRun.out.split("\n").filter((l) => l.startsWith("{")).pop() ?? "null";
report.runs.push({ impl: "ts", raw: JSON.parse(tsLine), timeout: tsRun.timeout, durationMs: tsRun.durationMs, volume: volumeStats(join(RUNTIME, "ts-volume")), stderrTail: tsRun.err.slice(-400) });

// --- Rust full sync
mkdirSync(join(RUNTIME, "rust-volume"), { recursive: true });
const rustRun = await run(join(ROOT, "target", "release", "examples", "images_sync_probe"),
  [join(RUNTIME, "rust-volume"), "false"], childEnv);
const rustLine = rustRun.out.split("\n").filter((l) => l.startsWith("{")).pop() ?? "null";
report.runs.push({ impl: "rust", raw: JSON.parse(rustLine), timeout: rustRun.timeout, durationMs: rustRun.durationMs, volume: volumeStats(join(RUNTIME, "rust-volume")), stderrTail: rustRun.err.slice(-400) });

mkdirSync(join(ROOT, "artifacts"), { recursive: true });
writeFileSync(join(ROOT, "artifacts", "p6-images-bench.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report.runs.map((r) => ({ impl: r.impl, status: r.raw?.status, sha: (r.raw?.commitSha ?? "").slice(0, 16), durationMs: r.durationMs, hwm: r.raw?.vmHwmKb, pngs: r.volume?.pngFiles, bytes: r.volume?.pngBytes })), null, 2));
