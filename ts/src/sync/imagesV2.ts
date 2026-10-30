/** Minimal LTS v2 consumer: rebuild selected parts, without Rust reuse optimizations. */
import { isDeepStrictEqual } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, writeFile, readdir, unlink, rename, rm, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import AdmZip from "adm-zip";
import { parseIndex } from "../data/images.js";
import { parseV2, type V2Index, type V2Part } from "../data/imagesV2.js";
import { activeGeneration, loadMeta, saveMeta, releasesDir, pruneGenerations } from "./generationStore.js";
import { safeExtractZip } from "./releaseActivation.js";
import { streamCascading } from "./transport.js";
async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
export async function syncV2(root: string, tag: string, keys: readonly string[], base: string,
  readSmall: (url: string) => Promise<Buffer | null>): Promise<{ version: string; changed: boolean }> {
  const read = async (versionTag: string): Promise<V2Index> => {
    const bytes = await readSmall(`${base}/${versionTag}/index.json`);
    const index = bytes && parseV2(JSON.parse(bytes.toString("utf8")));
    if (!index || versionTag !== `images2-${index.currentVersion}`) throw new Error("invalid v2 index identity");
    return index;
  };
  const index = await read(tag);
  const meta = await loadMeta(root);
  if (meta?.schemaVersion === "akdp-images/v2") {
    if (typeof meta.currentVersion === "string" && meta.currentVersion > index.currentVersion) throw new Error("refusing image version downgrade");
    if (meta.currentVersion === index.currentVersion && Array.isArray(meta.shardsSynced)
        && keys.length === new Set(meta.shardsSynced).size && keys.every(k => (meta.shardsSynced as unknown[]).includes(k))
        && await activeGeneration(root)) return { version: index.currentVersion, changed: false };
  }
  const chain: [string, V2Part[]][] = [];
  let current = index;
  while (true) {
    if (current.baselineVersion !== index.baselineVersion || !isDeepStrictEqual(current.baselineParts, index.baselineParts)) throw new Error("baseline lineage changed");
    chain.push([`images2-${current.currentVersion}`, current.deltaParts]);
    if (current.currentVersion === index.baselineVersion) break;
    current = await read(`images2-${current.previousVersion}`);
  }
  const tree = await releasesDir(root);
  await mkdir(tree, { recursive: true });
  const name = `v2-${randomUUID().replaceAll("-", "")}`;
  const stage = join(tree, `.${name}.tmp`);
  await mkdir(stage);
  try {
    const jobs: [string, V2Part[]][] = [[`images2-baseline-${index.baselineVersion}`, index.baselineParts], ...chain.reverse()];
    for (const [versionTag, parts] of jobs) {
      for (const part of parts) {
        if (!keys.includes(part.group)) continue;
        const archive = join(stage, ".part.zip");
        await streamCascading(`${base}/${versionTag}/${part.file}`, archive);
        if ((await stat(archive)).size !== part.bytes || await hashFile(archive) !== part.sha256) throw new Error("v2 ZIP digest mismatch");
        const zip = new AdmZip(archive), entries = zip.getEntries();
        if (entries.length !== Object.keys(part.members).length || new Set(entries.map(e => e.entryName)).size !== entries.length) throw new Error("v2 ZIP member mismatch");
        for (const entry of entries) {
          const member = part.members[entry.entryName], bytes = entry.getData();
          if (!member || bytes.length !== member.bytes || createHash("sha256").update(bytes).digest("hex") !== member.sha256) throw new Error("v2 member digest mismatch");
        }
        await safeExtractZip(archive, stage);
        await unlink(archive);
      }
    }
    const view = parseIndex(index)!;
    const expected = new Map<string, { bytes: number; sha256: string }>();
    for (const entry of Object.values(view.artworks)) {
      for (const [tier, variant] of Object.entries(entry.variants)) {
        if (variant && keys.includes(`${entry.shard}-${tier}`)) expected.set(variant.file, variant);
      }
    }
    for (const name of await readdir(stage)) if (name.endsWith(".png") && !expected.has(name)) await unlink(join(stage, name));
    for (const [file, member] of expected) {
      if ((await stat(join(stage, file))).size !== member.bytes || await hashFile(join(stage, file)) !== member.sha256) throw new Error("v2 target digest mismatch");
    }
    await writeFile(join(stage, "index.json"), JSON.stringify(index));
    const generation = { schemaVersion: "akdp-images/v2", baselineVersion: index.baselineVersion, currentVersion: index.currentVersion, shardsSynced: [...keys] };
    await saveMeta(stage, generation);
    const activated = join(tree, name);
    await rename(stage, activated);
    await saveMeta(root, { ...generation, generation_root: relative(root, activated).replaceAll("\\", "/") });
    await pruneGenerations(tree, activated);
    return { version: index.currentVersion, changed: true };
  } finally { await rm(stage, { recursive: true, force: true }); }
}
