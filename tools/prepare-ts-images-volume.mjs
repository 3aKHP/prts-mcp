#!/usr/bin/env node
// Real frozen TS syncImages writes a small reproducible legacy volume.
// This is scoped lifecycle evidence, not the P6 full-size image benchmark.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const AdmZip = (await import(join(root, ".reference/ts-v2.8.1/ts/node_modules/adm-zip/adm-zip.js"))).default;
const work = join(root, ".runtime/ts-images-mirror");
const volume = join(root, ".runtime/fixtures/ts-images-v1");
mkdirSync(work, { recursive: true });
rmSync(volume, { recursive: true, force: true });
const fixture = join(root, ".runtime/fixtures/minimal-images-v1/images");
const meta = JSON.parse(readFileSync(join(fixture, ".images_meta.json"), "utf8"));
const generation = join(fixture, meta.generation_root);
const index = JSON.parse(readFileSync(join(generation, "index.json"), "utf8"));
const tag = `images-baseline-${index.baselineVersion}`;
const url = (name) => `https://github.com/3aKHP/arknights-data-pipeline/releases/download/${tag}/${name}`;
const deltaTag = `images-${index.currentVersion}`;
const deltaName = `images-delta-${index.currentVersion}.zip`;
const deltaUrl = (name) => `https://github.com/3aKHP/arknights-data-pipeline/releases/download/${deltaTag}/${name}`;
const names = Object.values(index.shards);
const lines = [];
writeFileSync(join(work, "index.json"), JSON.stringify(index));
lines.push(`${deltaUrl("index.json")} index.json`);
const delta = new AdmZip();
for (const [shard, name] of Object.entries(index.shards)) {
  const zip = new AdmZip();
  for (const artwork of Object.values(index.artworks)) {
    for (const variant of ["large", "preview"]) {
      if (`${artwork.shard}-${variant}` !== shard) continue;
      const entry = artwork[variant];
      const payload = readFileSync(join(generation, entry.file));
      if (artwork.sinceVersion > index.baselineVersion) delta.addFile(entry.file, payload);
      else zip.addFile(entry.file, payload);
    }
  }
  zip.writeZip(join(work, name));
  lines.push(`${url(name)} ${name}`);
}
delta.writeZip(join(work, deltaName));
lines.push(`${deltaUrl(deltaName)} ${deltaName}`);
writeFileSync(join(work, "assets.txt"), `${lines.join("\n")}\n`);
writeFileSync(join(work, "releases.json"), JSON.stringify([{
  tag_name: deltaTag, created_at: "2026-03-01T00:00:00Z", assets: ["index.json", deltaName].map((name) => ({ name, browser_download_url: deltaUrl(name) })),
}, {
  tag_name: tag, created_at: "2026-03-01T00:00:00Z", assets: names.map((name) => ({ name, browser_download_url: url(name) })),
}]));
const mirror = spawn("node", [join(root, "tools/images-mirror.mjs"), work], {
  env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "inherit"],
});
try {
  const port = await new Promise((resolve, reject) => {
    let buffer = "";
    const timeout = setTimeout(() => reject(new Error("Image fixture mirror startup timed out")), 10000);
    mirror.once("error", (error) => { clearTimeout(timeout); reject(error); });
    mirror.stdout.on("data", (data) => {
      buffer += data;
      if (!buffer.includes("\n")) return;
      clearTimeout(timeout);
      resolve(JSON.parse(buffer.split("\n")[0]).port);
    });
  });
  const stdout = await new Promise((resolve, reject) => {
    const child = spawn("node", [join(root, "tools/ts-interop-peer.mjs"), "images-sync", volume, String(port)], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME }, stdio: ["ignore", "pipe", "inherit"],
    });
    let output = "";
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("TS image fixture sync timed out")); }, 60000);
    child.stdout.on("data", (data) => { output += data; });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error(`TS sync exited ${code}`));
      else resolve(output);
    });
  });
  const result = JSON.parse(stdout.trim().split("\n").at(-1)).result;
  if (result.status !== "updated") throw new Error(`TS image fixture sync failed: ${JSON.stringify(result)}`);
  console.log(`Frozen TS wrote representative images volume: ${volume}`);
} finally {
  mirror.kill();
}
