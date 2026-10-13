#!/usr/bin/env node
/**
 * P7 packaging: build the local distribution directory and npm tarball.
 *
 * Layout produced (docs/04 native 发布目录 / docs/09 本地分发):
 *
 *   build/package/prts-mcp-rust-local/
 *     package.json          private:true, 3 compat bins (JS launchers)
 *     LICENSE / NOTICE      copied from the outer repo
 *     bin/                  5 native binaries + 3 launcher shims
 *     data/                 bundled read-only fallback (gamedata/gamedata-levels/storyjson)
 *
 * Usage:
 *   node tools/package-native.mjs --data-source <dir> [--skip-build]
 *     --data-source <dir>  directory with gamedata/ (a gamedata ROOT),
 *                          gamedata-levels/, storyjson/zh_CN.zip — TS layout.
 *                          Optional; without it the package ships no bundle.
 *     --skip-build         reuse target/release binaries as-is.
 *   npm pack runs inside the staged dir; the tarball lands in build/.
 */
import { execFileSync } from "node:child_process";
import { existsSync, copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const skipBuild = args.includes("--skip-build");
const dataSource = flag("--data-source");

const NATIVE_BINS = [
  "prts-mcp-rust",
  "prts-mcp-ts",
  "prts-mcp-ts-bun",
  "prts-mcp-ts-stdio",
  "prts-mcp",
];
const LAUNCHERS = ["prts-mcp-ts", "prts-mcp-ts-bun", "prts-mcp-ts-stdio"];

function copyTree(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (entry.name === ".releases" || entry.name === ".gamedata_pair.json" || entry.name === "archives") {
      continue; // bundle carries the activated content, not release plumbing
    }
    const from = join(src, entry.name);
    const to = join(dst, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isFile()) copyFileSync(from, to);
  }
}

// 1. Release binaries.
if (!skipBuild) {
  console.log("[package] cargo build --locked --release");
  execFileSync("cargo", ["build", "--locked", "--release"], { cwd: ROOT, stdio: "inherit" });
}
for (const bin of NATIVE_BINS) {
  const path = join(ROOT, "target/release", bin);
  if (!existsSync(path)) throw new Error(`missing release binary ${bin}; build first`);
}

// 2. Stage the package dir.
const stage = join(ROOT, "build/package/prts-mcp-rust-local");
rmSync(join(ROOT, "build/package"), { recursive: true, force: true });
mkdirSync(join(stage, "bin"), { recursive: true });

for (const bin of NATIVE_BINS) {
  copyFileSync(join(ROOT, "target/release", bin), join(stage, "bin", bin));
}
for (const launcher of LAUNCHERS) {
  copyFileSync(join(ROOT, "packaging/launcher.js"), join(stage, "bin", `${launcher}.js`));
}

// 3. Bundled data (TS package layout: data/gamedata + data/gamedata-levels
//    + data/storyjson/zh_CN.zip). Bundled content = the ACTIVATED generation
//    (release plumbing stripped above), exactly what the read-only fallback
//    wants to expose.
if (dataSource) {
  const required = ["gamedata"];
  for (const dir of required) {
    if (!existsSync(join(dataSource, dir))) {
      throw new Error(`--data-source must contain ${dir}/`);
    }
  }
  copyTree(join(dataSource, "gamedata"), join(stage, "data/gamedata"));
  if (existsSync(join(dataSource, "gamedata-levels"))) {
    copyTree(join(dataSource, "gamedata-levels"), join(stage, "data/gamedata-levels"));
  }
  if (existsSync(join(dataSource, "storyjson/zh_CN.zip"))) {
    mkdirSync(join(stage, "data/storyjson"), { recursive: true });
    copyFileSync(
      join(dataSource, "storyjson/zh_CN.zip"),
      join(stage, "data/storyjson/zh_CN.zip"),
    );
  }
}

// 4. Package metadata + legal files. The outer repo owns LICENSE/NOTICE;
//    this local package redistributes them unchanged alongside the binaries.
const version = readFileSync(join(ROOT, "Cargo.toml"), "utf-8").match(/^version\s*=\s*"([^"]+)"/m)[1];
writeFileSync(
  join(stage, "package.json"),
  JSON.stringify(
    {
      name: "prts-mcp-rust-local",
      version,
      description:
        "Local Rust replication of PRTS-MCP TS v2.8.1 (private; never published — docs/09)",
      private: true,
      license: "MIT",
      type: "commonjs",
      bin: Object.fromEntries(LAUNCHERS.map((name) => [name, `bin/${name}.js`])),
      engines: { node: ">=18" },
      files: ["bin/", "data/", "LICENSE", "NOTICE", "THIRD-PARTY-NOTICES.txt"],
      prtsMcpLocal: {
        note: "private local distribution; the public prts-mcp-ts npm package is NOT replaced (docs/09)",
        binaries: NATIVE_BINS,
        platform: "linux-x64-glibc",
      },
    },
    null,
    2,
  ) + "\n",
);
copyFileSync(join(ROOT, "../../LICENSE"), join(stage, "LICENSE"));
copyFileSync(join(ROOT, "../../NOTICE"), join(stage, "NOTICE"));
copyFileSync(join(ROOT, "vendor/quickjs-regexp/NOTICES.txt"), join(stage, "THIRD-PARTY-NOTICES.txt"));

// 5. Docker build contexts (two profiles share one payload; local tags).
function stageDocker(profile, dockerfile) {
  const ctx = join(ROOT, "build/docker", profile);
  rmSync(ctx, { recursive: true, force: true });
  mkdirSync(join(ctx, "bin"), { recursive: true });
  for (const bin of NATIVE_BINS) {
    copyFileSync(join(stage, "bin", bin), join(ctx, "bin", bin));
  }
  copyTree(join(stage, "data"), join(ctx, "data"));
  copyFileSync(join(stage, "NOTICE"), join(ctx, "NOTICE"));
  copyFileSync(join(stage, "LICENSE"), join(ctx, "LICENSE"));
  copyFileSync(join(stage, "THIRD-PARTY-NOTICES.txt"), join(ctx, "THIRD-PARTY-NOTICES.txt"));
  copyFileSync(join(ROOT, "docker", dockerfile), join(ctx, "Dockerfile"));
  return ctx;
}
const dockerContexts = {
  ts: stageDocker("ts", "rust-ts.Dockerfile"),
  ghcr: stageDocker("ghcr", "rust-ghcr.Dockerfile"),
};

// 6. npm pack (tarball into build/).
console.log("[package] npm pack");
const tarball = execFileSync("npm", ["pack", "--pack-destination", join(ROOT, "build")], {
  cwd: stage,
  encoding: "utf-8",
}).trim();
const size = statSync(join(ROOT, "build", tarball)).size;

const summary = {
  stage,
  tarball: join("build", basename(tarball)),
  bytes: size,
  bundled_data: Boolean(dataSource),
  docker_contexts: dockerContexts,
};
console.log(JSON.stringify(summary, null, 2));
