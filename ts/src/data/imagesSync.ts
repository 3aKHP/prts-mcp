/**
 * AKDP image asset sync for LOCAL_IMAGE=true mode.
 * Mirrors python/src/prts_mcp/data/images_sync.py.
 *
 * Discovers ``images-*`` GitHub Releases from the arknights-data-pipeline
 * factory, downloads baseline shard zips + delta zips, and atomically
 * activates a generation directory of PNG files indexed by ``index.json``.
 *
 * Reuses the JSON sync's reliability primitives (cascading mirrors, atomic
 * activation, cross-process locking, offline fallback) from sync.ts, but
 * uses an images-specific discovery path: images Releases are tag-isolated
 * from ``data-*`` Releases and cannot use ``/releases/latest`` (see
 * arknights-data-pipeline/docs/image-index-schema.md §6).
 */

import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, existsSync, readFileSync, statSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { SCHEMA_VERSION, parseIndex, type ImagesIndex } from "./images.js";
import {
  assetUrl,
  fetchCascading,
  githubHeaders,
  latestReleaseByPrefix,
  listReleases,
  safeExtractZip,
  withArchiveActivationLock,
  type GithubRelease,
  type ReleaseSpec,
  type RepoSpec,
  type SyncResult,
} from "./sync.js";

export const IMAGES_REPO_OWNER = "3aKHP";
export const IMAGES_REPO = "arknights-data-pipeline";

const DELTA_PREFIX = "images-";
const BASELINE_PREFIX = "images-baseline-";
const DELTA_ASSET_PREFIX = "images-delta-";

const DEFAULT_SHARD_KEYS = [
  "chararts-large",
  "chararts-preview",
  "skinpack-large",
  "skinpack-preview",
] as const;
const ORIGINAL_SHARD_KEYS = [
  "chararts-original",
  "skinpack-original",
] as const;
const RETENTION_MS = 24 * 60 * 60 * 1000;
export const IMAGES_META = ".images_meta.json";
const IMAGES_LOCK = ".images.lock";

export function neededShardKeys(includeOriginal: boolean): readonly string[] {
  return includeOriginal
    ? [...DEFAULT_SHARD_KEYS, ...ORIGINAL_SHARD_KEYS]
    : DEFAULT_SHARD_KEYS;
}

function log(level: "INFO" | "WARN" | "ERROR", msg: string): void {
  const ts = new Date().toISOString();
  process.stderr.write(`${ts} ${level} prts_mcp.images_sync: ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Discovery helpers (listReleases, latestReleaseByPrefix, assetUrl) are
// imported from sync — data and images releases share the same pattern.
// ---------------------------------------------------------------------------

function releaseDownloadUrl(tag: string, assetName: string): string {
  return (
    `https://github.com/${IMAGES_REPO_OWNER}/${IMAGES_REPO}` +
    `/releases/download/${tag}/${assetName}`
  );
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

async function downloadSmall(url: string, timeoutMs = 30_000): Promise<Buffer | null> {
  try {
    const res = await fetchCascading(
      url,
      { headers: githubHeaders(), redirect: "follow" },
      timeoutMs,
    );
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

// TS uses a single total deadline (AbortSignal.timeout) whereas Python's
// httpx.stream uses a per-socket timeout; 30 min covers the largest
// ORIGINAL_IMAGE shard (~3.6 GB) on slow links. A per-chunk AbortSignal
// refresh would be ideal but needs a custom read loop.
async function downloadLarge(url: string, dest: string, timeoutMs = 1_800_000): Promise<void> {
  const tmp = join(
    dirname(dest),
    `.${basename(dest)}.${randomUUID().replaceAll("-", "")}.tmp`,
  );
  await mkdir(dirname(dest), { recursive: true });
  try {
    const res = await fetchCascading(
      url,
      { headers: githubHeaders(), redirect: "follow" },
      timeoutMs,
    );
    // Stream the shard to disk so multi-hundred-MB baseline zips do not stay
    // resident; mirrors python's httpx.stream chunked write. fetchCascading
    // returns a real Response at runtime but FetchResponse omits body to stay
    // decoupled from DOM, so narrow res via unknown instead of `any` (#100).
    // Readable.fromWeb still needs a cast — Node 22's Uint8Array generic makes
    // its parameter type incompatible at compile time (runtime is fine).
    const body = (res as unknown as { body: ReadableStream | null }).body;
    if (body === null) throw new Error("download response body is null");
    await pipeline(Readable.fromWeb(body as any), createWriteStream(tmp));
    await rename(tmp, dest);
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Generation state (.images_meta.json + .releases/<gen>/)
// ---------------------------------------------------------------------------

function metaPath(root: string): string {
  return join(root, IMAGES_META);
}

async function loadMeta(root: string): Promise<Record<string, unknown> | null> {
  try {
    const data = JSON.parse(await readFile(metaPath(root), "utf-8"));
    return typeof data === "object" && data !== null && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function saveMeta(root: string, meta: Record<string, unknown>): Promise<void> {
  const path = metaPath(root);
  const tmp = join(
    dirname(path),
    `.${basename(path)}.${randomUUID().replaceAll("-", "")}.tmp`,
  );
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmp, JSON.stringify(meta, null, 2), "utf-8");
  await rename(tmp, path);
}

/** Synchronous active-generation resolver — shared by sync and tool layers. */
export function activeGenerationSync(imageDir: string): string | null {
  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(readFileSync(join(imageDir, IMAGES_META), "utf-8"));
  } catch {
    return null;
  }
  const rel = meta["generation_root"];
  if (typeof rel !== "string" || rel.length === 0) return null;
  const base = resolve(imageDir);
  const gen = resolve(base, rel);
  const relCheck = relative(base, gen);
  if (relCheck === ".." || relCheck.startsWith(`..${sep}`) || isAbsolute(relCheck)) {
    return null;
  }
  try {
    if (!statSync(gen).isDirectory()) return null;
    statSync(join(gen, "index.json"));
    return gen;
  } catch {
    return null;
  }
}

async function activeGeneration(imageDir: string): Promise<string | null> {
  return activeGenerationSync(imageDir);
}

async function releasesDir(imageDir: string): Promise<string> {
  const dir = join(imageDir, ".releases");
  await mkdir(dir, { recursive: true });
  return dir;
}

function versionHash(version: string): string {
  return createHash("sha256").update(version).digest("hex").slice(0, 16);
}

async function pruneGenerations(releasesDir: string, keep: string): Promise<void> {
  const cutoff = Date.now() - RETENTION_MS;
  let entries: string[];
  try {
    entries = await readdir(releasesDir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const candidate = join(releasesDir, name);
    if (candidate === keep) continue;
    try {
      const info = await stat(candidate);
      if (info.mtimeMs >= cutoff) continue;
      if (info.isDirectory()) {
        await rm(candidate, { recursive: true, force: true });
      }
    } catch {
      // best-effort retention cleanup
    }
  }
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

function dummySpec(imageDir: string): RepoSpec {
  return {
    owner: IMAGES_REPO_OWNER,
    repo: IMAGES_REPO,
    branch: "releases",
    files: ["images"],
    localRoot: imageDir,
  };
}

async function offlineOrNoData(imageDir: string, error: string): Promise<SyncResult> {
  const spec = dummySpec(imageDir);
  if ((await activeGeneration(imageDir)) !== null) {
    const meta = await loadMeta(imageDir);
    const ver = meta?.["currentVersion"];
    return {
      spec,
      status: "offline_fallback",
      commitSha: typeof ver === "string" ? ver : null,
      error,
    };
  }
  return { spec, status: "no_data", commitSha: null, error };
}

function shardVariantNames(shardKeys: readonly string[]): Set<string> {
  return new Set(shardKeys.map((k) => k.split("-").pop()!));
}

/** Verify each synced variant PNG matches its index sha256 (#100). */
async function verifyVariantHashes(
  staging: string,
  index: ImagesIndex,
  shardKeys: readonly string[],
): Promise<void> {
  const wanted = shardVariantNames(shardKeys);
  let checked = 0;
  let mismatches = 0;
  for (const [skinId, entry] of Object.entries(index.artworks)) {
    for (const [vname, variant] of Object.entries(entry.variants)) {
      if (!variant || !wanted.has(vname)) continue;
      const pngPath = join(staging, variant.file);
      if (!existsSync(pngPath)) {
        // Incomplete shard: a wanted variant's file is absent.
        mismatches += 1;
        checked += 1;
        if (mismatches <= 3) {
          log("WARN", `images sha256 mismatch: ${skinId}/${vname} file missing: ${variant.file}`);
        }
        continue;
      }
      const actual = createHash("sha256").update(await readFile(pngPath)).digest("hex");
      checked += 1;
      if (actual !== variant.sha256) {
        mismatches += 1;
        if (mismatches <= 3) {
          log("WARN", `images sha256 mismatch: ${skinId}/${vname} expected ${variant.sha256.slice(0, 12)} got ${actual.slice(0, 12)}`);
        }
      }
    }
  }
  if (mismatches) {
    throw new Error(`images sha256 verification failed: ${mismatches} of ${checked} variants mismatch`);
  }
}

async function syncImagesLocked(
  imageDir: string,
  shardKeys: readonly string[],
  forceCheck: boolean,
): Promise<SyncResult> {
  const spec = dummySpec(imageDir);

  const releases = await listReleases(IMAGES_REPO_OWNER, IMAGES_REPO);
  if (releases === null) {
    return offlineOrNoData(imageDir, "Network unavailable");
  }

  const deltaRelease = latestReleaseByPrefix(releases, DELTA_PREFIX, {
    excludePrefix: BASELINE_PREFIX,
  });
  if (deltaRelease === null) {
    return offlineOrNoData(imageDir, "No images delta release found");
  }

  const deltaTag = String(deltaRelease["tag_name"] ?? "");
  const currentVersion = deltaTag.slice(DELTA_PREFIX.length);

  const meta = await loadMeta(imageDir);
  const genDir = await activeGeneration(imageDir);
  const syncedRaw = meta?.["shardsSynced"];
  const syncedSet = Array.isArray(syncedRaw) ? new Set(syncedRaw as string[]) : null;
  const sameShards = syncedSet !== null
    && shardKeys.length === syncedSet.size
    && shardKeys.every((k) => syncedSet.has(k));

  // Tag-level shortcut: if the release tag's currentVersion and the shard
  // set already match the active generation, skip the ~1.1 MB index.json
  // download. baselineVersion rides in index.json but cannot change without
  // a new delta tag, so tag equality implies baseline equality. force_check
  // still drives a real API call here; a TTL freshness skip is deferred.
  if (
    meta !== null
    && genDir !== null
    && meta["currentVersion"] === currentVersion
    && sameShards
  ) {
    return { spec, status: "up_to_date", commitSha: currentVersion, error: null };
  }

  // Tag differs (or first sync) → download index.json and rebuild.
  const indexUrl = assetUrl(deltaRelease, "index.json");
  const indexBytes = indexUrl !== null ? await downloadSmall(indexUrl) : null;
  if (indexBytes === null) {
    return offlineOrNoData(imageDir, "Failed to download index.json");
  }

  let indexData: unknown;
  try {
    indexData = JSON.parse(indexBytes.toString("utf-8"));
  } catch {
    return { spec, status: "no_data", commitSha: null, error: "index.json is unreadable" };
  }

  const index = parseIndex(indexData);
  if (index === null) {
    return { spec, status: "no_data", commitSha: null, error: "index.json schema mismatch" };
  }

  const baselineVersion = index.baselineVersion;

  // --- Rebuild a new generation -----------------------------------------
  const relDir = await releasesDir(imageDir);
  const generation = `${versionHash(currentVersion)}-${randomUUID().replaceAll("-", "")}`;
  const staging = join(relDir, `.${generation}.tmp`);
  const activated = join(relDir, generation);
  let stagingExists = false;
  try {
    await mkdir(staging, { recursive: true });
    stagingExists = true;

    const baselineUnchanged =
      meta !== null
      && genDir !== null
      && meta["baselineVersion"] === baselineVersion
      && sameShards;
    if (baselineUnchanged && genDir !== null) {
      // Fast path: reuse prior PNGs, overlay only the new delta.
      await cp(genDir, staging, { recursive: true });
      await unlink(join(staging, "index.json")).catch(() => undefined);
      await unlink(join(staging, IMAGES_META)).catch(() => undefined);
    } else {
      const baselineTag = `${BASELINE_PREFIX}${baselineVersion}`;
      for (const shardKey of shardKeys) {
        const shardFile = index.shards[shardKey] ?? "";
        if (!shardFile) continue;
        const shardZip = join(staging, `.${shardKey}.zip`);
        await downloadLarge(releaseDownloadUrl(baselineTag, shardFile), shardZip);
        await safeExtractZip(shardZip, staging);
        await unlink(shardZip).catch(() => undefined);
      }
    }

    // Delta: overlay incremental PNGs. A download/extract failure must
    // propagate (not be swallowed) so a half-applied delta never activates —
    // the authoritative index.json would otherwise reference PNGs that are
    // absent. The sentinel delta (empty zip) downloads and extracts without
    // raising, so it passes through cleanly.
    const deltaAsset = `${DELTA_ASSET_PREFIX}${currentVersion}.zip`;
    const deltaUrl = assetUrl(deltaRelease, deltaAsset);
    if (deltaUrl !== null) {
      const deltaZip = join(staging, ".delta.zip");
      await downloadLarge(deltaUrl, deltaZip);
      await safeExtractZip(deltaZip, staging);
      await unlink(deltaZip).catch(() => undefined);
    }

    // Verify every synced variant's sha256 against the index before
    // activation (#100): a corrupted or tampered shard must not activate.
    await verifyVariantHashes(staging, index, shardKeys);

    // Authoritative index.json + generation meta.
    await writeFile(join(staging, "index.json"), indexBytes);
    const genMeta: Record<string, unknown> = {
      schemaVersion: SCHEMA_VERSION,
      baselineVersion,
      currentVersion,
      shardsSynced: [...shardKeys],
    };
    await saveMeta(staging, genMeta);

    // Atomic activation.
    await rm(activated, { recursive: true, force: true });
    await rename(staging, activated);
    stagingExists = false;

    // Top-level meta points at the active generation.
    await saveMeta(imageDir, {
      ...genMeta,
      generation_root:
        relative(imageDir, activated).replaceAll("\\", "/") || ".",
    });
    await pruneGenerations(relDir, activated);

    log(
      "INFO",
      `Images synced: baseline=${baselineVersion.slice(0, 16)} current=${currentVersion.slice(0, 16)} (${Object.keys(index.artworks).length} artworks)`,
    );
    return { spec, status: "updated", commitSha: currentVersion, error: null };
  } catch (err) {
    if (stagingExists) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
    return offlineOrNoData(imageDir, err instanceof Error ? err.message : String(err));
  }
}

export async function syncImages(
  imageDir: string,
  opts: { includeOriginal?: boolean; forceCheck?: boolean } = {},
): Promise<SyncResult> {
  await mkdir(imageDir, { recursive: true });
  const shardKeys = neededShardKeys(opts.includeOriginal ?? false);
  const lockSpec: ReleaseSpec = {
    owner: IMAGES_REPO_OWNER,
    repo: IMAGES_REPO,
    assetName: "images-sync",
    localZip: join(imageDir, ".images-sync"),
  };
  try {
    return await withArchiveActivationLock(
      lockSpec,
      () => syncImagesLocked(imageDir, shardKeys, opts.forceCheck ?? false),
      IMAGES_LOCK,
    );
  } catch (err) {
    return offlineOrNoData(imageDir, err instanceof Error ? err.message : String(err));
  }
}
