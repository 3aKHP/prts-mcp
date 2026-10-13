#!/usr/bin/env node
// Rebuild the frozen oracle outside the product tree; never rewrite contracts.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const baseline = "e0ba36096cdd46640166b0a5db02902fa9a6a24c";
const reference = join(root, ".reference/ts-v2.8.1");
const run = (bin, args, cwd = root) => execFileSync(bin, args, { cwd, stdio: "inherit" });
const marker = join(reference, ".baseline-commit");
if (!existsSync(marker) || readFileSync(marker, "utf8").trim() !== baseline) {
  if (existsSync(reference)) throw new Error("Unidentified oracle directory; move .reference/ts-v2.8.1 aside before rebuilding");
  mkdirSync(reference, { recursive: true });
  const archive = join(root, ".reference/baseline.tar");
  run("git", ["archive", "--format=tar", `--output=${archive}`, baseline, "ts", "python", "tests/parity-fixtures", "LICENSE", "NOTICE"]);
  run("tar", ["-xf", archive, "-C", reference]);
  rmSync(archive);
  writeFileSync(marker, `${baseline}\n`);
}
const ts = join(reference, "ts");
if (!existsSync(join(ts, "node_modules"))) run("npm", ["ci", "--ignore-scripts"], ts);
if (!existsSync(join(ts, "dist/server-stdio.js"))) run("npm", ["run", "build"], ts);
run("node", ["tools/make-fixtures.mjs", "--skip-release-probe", "--runtime-only"]);
run("node", ["tools/make-images-fixture.mjs", "--runtime-only"]);
run("node", ["tools/prepare-ts-images-volume.mjs"]);

if (!process.argv.includes("--minimal")) {
  const data = JSON.parse(readFileSync(join(root, "contracts/validation-assets.json"), "utf8"));
  for (const asset of data.assets) {
    const dest = join(root, asset.path);
    mkdirSync(dirname(dest), { recursive: true });
    if (!existsSync(dest)) {
      const pending = `${dest}.partial`;
      try {
        run("curl", ["--fail", "--location", "--retry", "3", "--max-time", "600", "--output", pending,
          `https://github.com/${data.repo}/releases/download/${data.release_tag}/${asset.name}`]);
        const bytes = readFileSync(pending);
        if (bytes.length !== asset.bytes || createHash("sha256").update(bytes).digest("hex") !== asset.sha256)
          throw new Error(`Frozen asset checksum mismatch: ${asset.name}`);
        writeFileSync(dest, bytes);
      } finally { rmSync(pending, { force: true }); }
    }
    const bytes = readFileSync(dest);
    if (bytes.length !== asset.bytes || createHash("sha256").update(bytes).digest("hex") !== asset.sha256)
      throw new Error(`Cached asset checksum mismatch: ${asset.name}`);
  }
  run("node", ["tools/make-fullscale.mjs", "--runtime-only"]);
}
console.log(`Validation fixtures ready; frozen TS oracle ${baseline}`);
