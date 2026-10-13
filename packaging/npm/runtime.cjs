"use strict";
// Shared npm launch bridge only; tool/protocol/data behavior stays in Rust.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const meta = require("./package.json");
const targets = require("./platforms.json");
const profiles = new Set(["prts-mcp", "prts-mcp-ts", "prts-mcp-ts-bun", "prts-mcp-ts-stdio"]);

function resolve(profile) {
  if (!profiles.has(profile)) throw new Error("不支持的 PRTS-MCP 启动入口。");
  if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("PRTS-MCP 的 npm 入口需要 Node.js 22 或更高版本。");
  const entry = Object.entries(targets).find(([, t]) => t.os === process.platform && t.arch === process.arch);
  if (!entry) throw new Error(`PRTS-MCP 暂不支持 ${process.platform}/${process.arch}；请使用支持的平台。`);
  const [id, target] = entry;
  if (process.platform === "linux") {
    const glibc = process.report?.getReport().header.glibcVersionRuntime;
    const parts = glibc?.split(".").map(Number);
    if (!parts || parts[0] < 2 || parts[0] === 2 && parts[1] < 28) {
      throw new Error("PRTS-MCP 的 Linux npm 包需要 glibc 2.28 或更高版本；不支持 musl/Alpine。");
    }
  }
  const name = `@3akhp/prts-mcp-${id}`;
  let nativePath;
  try { nativePath = require.resolve(`${name}/package.json`); } catch {
    throw new Error(`缺少平台包 ${name}@${meta.version}。请重新安装入口包并启用 optional dependencies（不要使用 --omit=optional）；也可使用对应平台的原生发行版。`);
  }
  const native = JSON.parse(fs.readFileSync(nativePath, "utf8"));
  const nativeRoot = path.dirname(nativePath);
  const build = JSON.parse(fs.readFileSync(path.join(nativeRoot, "BUILD.json"), "utf8"));
  const dataPath = require.resolve("@3akhp/prts-mcp-data/package.json");
  const data = JSON.parse(fs.readFileSync(dataPath, "utf8"));
  const bundleRoot = path.join(path.dirname(dataPath), "data");
  const bundle = JSON.parse(fs.readFileSync(path.join(bundleRoot, "BUNDLE.json"), "utf8"));
  if ([native.version, build.version, data.version, bundle.productVersion].some(v => v !== meta.version)
      || build.target !== target.target || build.platform !== id || build.dirty) {
    throw new Error("PRTS-MCP 平台程序、启动器或备用数据版本不一致；请重新安装同一精确版本。");
  }
  const executable = path.join(nativeRoot, "bin", profile + (process.platform === "win32" ? ".exe" : ""));
  if (!fs.existsSync(executable)) throw new Error(`PRTS-MCP 平台包缺少可执行程序：${profile}。请重新安装。`);
  return { executable, bundleRoot };
}

function run(profile) {
  let resolved;
  try { resolved = resolve(profile); } catch (error) {
    process.stderr.write(`PRTS-MCP: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  const child = spawn(resolved.executable, ["--bundle-root", resolved.bundleRoot,
    ...(process.platform === "win32" ? ["--launcher-parent-pid", String(process.pid)] : []), ...process.argv.slice(2)], {
    stdio: "inherit", env: process.env, shell: false,
  });
  const forwarders = new Map();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    const forward = () => { if (child.exitCode === null && child.signalCode === null) child.kill(signal); };
    forwarders.set(signal, forward);
    process.on(signal, forward);
  }
  const cleanup = () => { for (const [signal, forward] of forwarders) process.off(signal, forward); };
  child.once("error", error => {
    cleanup();
    process.stderr.write(`PRTS-MCP: 无法启动原生程序：${error.message}\n`);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    cleanup();
    if (signal && process.platform !== "win32") {
      try { process.kill(process.pid, signal); } catch {}
    }
    process.exitCode = code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 1);
  });
}

module.exports = { run, resolve };
