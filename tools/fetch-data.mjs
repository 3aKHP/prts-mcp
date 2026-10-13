#!/usr/bin/env node
/**
 * Pin the P0 data-package snapshot: download the GameData excel/levels/story
 * zips, their release manifests, and representative image assets from the
 * fixed upstream releases into .runtime/data/ and record SHA-256 + sizes in
 * contracts/data-manifest.json (snapshot section).
 *
 * The pinned versions are exactly the newest `datarev-*` and `images-*`
 * releases observed when this tool first ran (2026-10-11); they are pinned by
 * tag, never by "latest", so re-running is byte-reproducible. Upstream moving
 * on does not silently refresh this snapshot — later phases may pin newer tags
 * via an explicit manifest edit.
 *
 * Usage: node tools/fetch-data.mjs
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MANIFEST_PATH = join(ROOT, "contracts", "data-manifest.json");
const DATA_DIR = join(ROOT, ".runtime", "data");
const UPSTREAM = "3aKHP/arknights-data-pipeline";

const PINNED = {
  data: {
    tag: "datarev-26-10-08-04-51-28-56071834-r2",
    assets: [
      "manifest.json",
      "zh_CN-excel.zip",
      "zh_CN-levels.zip",
      "zh_CN.zip",
    ],
  },
  images: {
    tag: "images-26-10-08-04-51-28-56071834",
    // Representative assets only in P0: build state + full index. The delta
    // zip (63 MB) and full image shards are P6 scope.
    assets: ["images-build-state.json", "index.json"],
  },
};

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fetchAsset(tag, name) {
  const target = join(DATA_DIR, tag, name);
  if (!existsSync(target)) {
    const url = `https://github.com/${UPSTREAM}/releases/download/${tag}/${name}`;
    mkdirSync(dirname(target), { recursive: true });
    execFileSync("curl", ["-sSL", "--max-time", "600", "-o", target, url], {
      stdio: ["ignore", "inherit", "inherit"],
    });
  }
  return {
    name,
    bytes: statSync(target).size,
    sha256: sha256(target),
    path: `.runtime/data/${tag}/${name}`,
  };
}

const snapshot = { pinned_at: "2026-10-11", repo: UPSTREAM, datasets: {} };
for (const [key, spec] of Object.entries(PINNED)) {
  snapshot.datasets[key] = {
    release_tag: spec.tag,
    assets: spec.assets.map((name) => fetchAsset(spec.tag, name)),
  };
}

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
manifest.data_snapshot = snapshot;
writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
console.log("data snapshot pinned:");
for (const [key, ds] of Object.entries(snapshot.datasets)) {
  for (const a of ds.assets) console.log(`  ${ds.release_tag}/${a.name} ${a.bytes}B ${a.sha256.slice(0, 12)}…`);
}
