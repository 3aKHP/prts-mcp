#!/usr/bin/env node
/**
 * prts-mcp-rust-local bin launcher (npm thin wrapper, docs/09).
 *
 * Locates the native binary shipped beside this file, passes the package's
 * bundled data root explicitly (internal --bundle-root argument; not a
 * public env var), and bridges argv / stdio / signals / exit code. This is
 * the ONLY Node-dependent piece — the server itself is the native binary.
 */
"use strict";

const { spawn } = require("node:child_process");
const { dirname, join } = require("node:path");
const fs = require("node:fs");

const binDir = dirname(__filename); // <package>/bin
const packageRoot = dirname(binDir);

// launcher name (prts-mcp-ts.js) maps 1:1 to the native binary name.
const launcher = __filename.split("/").pop();
const binName = launcher.replace(/\.js$/, "");
const binary = join(binDir, binName);
if (!fs.existsSync(binary)) {
  process.stderr.write(`prts-mcp-rust-local: native binary missing: ${binary}\n`);
  process.exit(127);
}

const child = spawn(binary, ["--bundle-root", join(packageRoot, "data"), ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});

function forward(signal) {
  // Re-deliver the signal to the child; the child's default disposition
  // terminates it by signal, whose status we then mirror below.
  if (!child.killed) child.kill(signal);
}
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  child.on(signal, () => {}); // keep the event loop alive until exit
  process.on(signal, () => forward(signal));
}

child.on("error", (err) => {
  process.stderr.write(`prts-mcp-rust-local: failed to start ${binName}: ${err.message}\n`);
  process.exit(127);
});

child.on("exit", (code, signal) => {
  if (signal) {
    // Mirror the child's signal death. Re-raising only works with the
    // default disposition restored (our forwarder suppressed it).
    const num = { SIGTERM: 15, SIGINT: 2, SIGHUP: 1 }[signal] ?? 0;
    try {
      for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) process.removeAllListeners(s);
      process.kill(process.pid, signal);
    } catch {
      process.exit(num ? 128 + num : 128);
    }
    process.exit(num ? 128 + num : 128); // unreachable when re-raise lands
  }
  process.exit(code == null ? 0 : code);
});
