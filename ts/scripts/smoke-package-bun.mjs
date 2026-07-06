#!/usr/bin/env node
/**
 * Pack the npm package, install it with Bun in a temporary project, then run
 * the published Bun bin through the shared HTTP MCP smoke harness.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDir, "..");
const tempRoot = mkdtempSync(join(tmpdir(), "prts-bun-package-smoke-"));
const isWindows = process.platform === "win32";

function npmCommand() {
  return isWindows ? "npm.cmd" : "npm";
}

function bunCommand() {
  if (process.versions.bun) return process.execPath;
  return isWindows ? "bun.exe" : "bun";
}

function pathKey(env) {
  return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const usesCmdWrapper = isWindows && /\.(?:cmd|bat)$/i.test(command);
    const spawnCommand = usesCmdWrapper ? process.env.ComSpec ?? "cmd.exe" : command;
    const spawnArgs = usesCmdWrapper ? ["/d", "/s", "/c", command, ...args] : args;
    const child = spawn(spawnCommand, spawnArgs, {
      cwd: options.cwd ?? packageRoot,
      env: options.env ?? process.env,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });

    let stdout = "";
    let stderr = "";
    if (options.capture) {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
    }

    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolveRun({ stdout, stderr });
        return;
      }
      const detail = options.capture && stderr ? `\n${stderr}` : "";
      reject(new Error(`${command} ${args.join(" ")} failed with ${signal ?? `exit code ${code}`}${detail}`));
    });
  });
}

function parsePackOutput(stdout) {
  const entries = JSON.parse(stdout);
  if (!Array.isArray(entries) || entries.length === 0 || typeof entries[0].filename !== "string") {
    throw new Error(`Unexpected npm pack output: ${stdout}`);
  }
  return entries[0].filename;
}

function installedBinPath() {
  return join(tempRoot, "node_modules", ".bin", isWindows ? "prts-mcp-ts-bun.exe" : "prts-mcp-ts-bun");
}

function assertInstalledBin() {
  const bin = installedBinPath();
  if (!existsSync(bin)) {
    throw new Error(`Installed Bun bin is missing: ${bin}`);
  }
  if (statSync(bin).size <= 0) {
    throw new Error(`Installed Bun bin is empty: ${bin}`);
  }
}

function smokeServerCommand() {
  if (!isWindows) return ["prts-mcp-ts-bun"];

  // Bun's Windows .exe shim starts the right server, but it can leave the
  // grandchild Bun process attached after the smoke harness kills the shim.
  // CI runs the real package bin on Linux; local Windows smoke verifies the
  // installed bin exists and starts the installed Bun entry file directly.
  return [bunCommand(), join(tempRoot, "node_modules", "prts-mcp-ts", "dist", "server-bun.js")];
}

async function main() {
  try {
    for (const file of ["dist/server.js", "dist/server-bun.js"]) {
      const path = join(packageRoot, file);
      if (!existsSync(path)) {
        throw new Error(`${file} is missing. Run bun run build:bun before package smoke.`);
      }
    }

    console.log("Packing prts-mcp-ts ...");
    const pack = await run(npmCommand(), ["pack", "--pack-destination", tempRoot, "--json"], {
      capture: true,
    });
    const tarball = join(tempRoot, parsePackOutput(pack.stdout));

    console.log("Installing packed tarball with Bun ...");
    await run(bunCommand(), ["add", tarball], { cwd: tempRoot });

    assertInstalledBin();

    const env = { ...process.env };
    const key = pathKey(env);
    env[key] = `${join(tempRoot, "node_modules", ".bin")}${delimiter}${env[key] ?? ""}`;
    const serverCommand = smokeServerCommand();

    console.log("Running installed Bun package entrypoint through HTTP MCP smoke ...");
    await run(
      bunCommand(),
      [join(packageRoot, "scripts", "smoke-http.mjs"), "--fixture-data", "--", ...serverCommand],
      { cwd: tempRoot, env },
    );
  } finally {
    try {
      rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup: preserve the original smoke failure.
    }
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Bun package smoke failed: ${message}`);
  process.exit(1);
});
