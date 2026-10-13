#!/usr/bin/env node
/**
 * Build the full-scale differential dataset (P4): the pinned real datarev
 * zips laid out as a GAMEDATA_PATH volume — extracted excel (excel-backed
 * GameData tools) plus the untouched zh_CN.zip story package. Recorded in
 * contracts/data-manifest.json with content hashes; deterministic given the
 * pinned .runtime/data inputs.
 */
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA_REV = join(ROOT, ".runtime", "data", "datarev-26-10-08-04-51-28-56071834-r2");
const OUT = join(ROOT, ".runtime", "fixtures", "full-story-r2");
const MANIFEST_PATH = join(ROOT, "contracts", "data-manifest.json");

const AdmZip = (await import(
  join(ROOT, ".reference", "ts-v2.8.1", "ts", "node_modules", "adm-zip", "adm-zip.js")
)).default;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "storyjson"), { recursive: true });

// excel: extract the pinned archive into the volume root.
const excelZip = new AdmZip(join(DATA_REV, "zh_CN-excel.zip"));
excelZip.extractAllTo(OUT, true);

// story: keep the pinned zip byte-for-byte (swap identity matters).
copyFileSync(join(DATA_REV, "zh_CN.zip"), join(OUT, "storyjson", "zh_CN.zip"));

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function walkFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(p));
    else out.push(p);
  }
  return out.sort();
}

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
manifest.datasets["full-story-r2"] = {
  purpose: "P4 full-scale differential: pinned real datarev excel + story package",
  source: ".runtime/data/datarev-26-10-08-04-51-28-56071834-r2 (zips pinned by fetch-data)",
  root: ".runtime/fixtures/full-story-r2",
  excel_dir: "zh_CN/gamedata/excel",
  story_zip: "storyjson/zh_CN.zip",
  story_zip_sha256: sha256(join(OUT, "storyjson", "zh_CN.zip")),
  excel_files: walkFiles(join(OUT, "zh_CN")).length,
  excel_bytes: walkFiles(join(OUT, "zh_CN")).reduce((n, p) => n + statSync(p).size, 0),
};
writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
console.log(`full-scale dataset at ${relative(ROOT, OUT)} (excel files: ${manifest.datasets["full-story-r2"].excel_files})`);
