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
import { cp, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { SCHEMA_VERSION, parseIndex } from "./images.js";
import {
  fetchCascading,
  githubHeaders,
  safeExtractZip,
  withArchiveActivationLock,
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
const IMAGES_META = ".images_meta.json";
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
// Discovery (tag-prefix filtered; /releases/latest is not usable — schema §6)
// ---------------------------------------------------------------------------

interface GithubRelease {
  tag_name?: unknown;
  created_at?: unknown;
  assets?: unknown;
  [key: string]: unknown;
}

async function listReleases(timeoutMs = 10_000): Promise<GithubRelease[] | null> {
  const url = `https://api.github.com/repos/${IMAGES_REPO_OWNER}/${IMAGES_REPO}/releases?per_page=100`;
  try {
    const res = await fetchCascading(url, { headers: githubHeaders() }, timeoutMs);
    const data = await res.json();
    return Array.isArray(data) ? (data as GithubRelease[]) : null;
  } catch {
    return null;
  }
}

function latestReleaseByPrefix(
  releases: GithubRelease[],
  prefix: string,
  opts: { excludePrefix?: string } = {},
): GithubRelease | null {
  const candidates: GithubRelease[] = [];
  for (const release of releases) {
    const tag = release["tag_name"];
    if (typeof tag !== "string" || !tag.startsWith(prefix)) continue;
    if (opts.excludePrefix && tag.startsWith(opts.excludePrefix)) continue;
    candidates.push(release);
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) =>
    String(b["created_at"] ?? "").localeCompare(String(a["created_at"] ?? "")),
  );
  return candidates[0];
}

function assetUrl(release: GithubRelease, assetName: string): string | null {
  const assets = release["assets"];
  if (!Array.isArray(assets)) return null;
  for (const a of assets) {
    if (typeof a === "object" && a !== null && (a as Record<string, unknown>)["name"] === assetName) {
      const url = (a as Record<string, unknown>)["browser_download_url"];
      if (typeof url === "string") return url;
    }
  }
  return null;
}

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

async function downloadLarge(url: string, dest: string, timeoutMs = 300_000): Promise<void> {
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
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(tmp, buf);
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

async function activeGeneration(imageDir: string): Promise<string | null> {
  const meta = await loadMeta(imageDir);
  if (meta === null) return null;
  const rel = meta["generation_root"];
  if (typeof rel !== "string" || rel.length === 0) return null;
  const base = resolve(imageDir);
  const gen = resolve(base, rel);
  const relCheck = relative(base, gen);
  if (relCheck === ".." || relCheck.startsWith(`..${sep}`) || isAbsolute(relCheck)) {
    return null;
  }
  try {
    const info = await stat(gen);
    if (!info.isDirectory()) return null;
    await stat(join(gen, "index.json"));
    return gen;
  } catch {
    return null;
  }
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
    const ver = meta?.["current_version"];
    return {
      spec,
      status: "offline_fallback",
      commitSha: typeof ver === "string" ? ver : null,
      error,
    };
  }
  return { spec, status: "no_data", commitSha: null, error };
}

async function syncImagesLocked(
  imageDir: string,
  shardKeys: readonly string[],
  forceCheck: boolean,
): Promise<SyncResult> {
  const spec = dummySpec(imageDir);

  const releases = await listReleases();
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

  const meta = await loadMeta(imageDir);
  const genDir = await activeGeneration(imageDir);
  if (
    !forceCheck
    && meta !== null
    && genDir !== null
    && meta["current_version"] === currentVersion
    && meta["baseline_version"] === baselineVersion
  ) {
    return { spec, status: "up_to_date", commitSha: currentVersion, error: null };
  }

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
      && meta["baseline_version"] === baselineVersion;
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

    // Delta: overlay incremental PNGs (sentinel delta extracts nothing).
    const deltaAsset = `${DELTA_ASSET_PREFIX}${currentVersion}.zip`;
    const deltaUrl = assetUrl(deltaRelease, deltaAsset);
    if (deltaUrl !== null) {
      const deltaZip = join(staging, ".delta.zip");
      try {
        await downloadLarge(deltaUrl, deltaZip);
        await safeExtractZip(deltaZip, staging);
      } catch (err) {
        // sentinel/empty delta or transient failure — non-fatal
        log("INFO", `Delta extract skipped: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        await unlink(deltaZip).catch(() => undefined);
      }
    }

    // Authoritative index.json + generation meta.
    await writeFile(join(staging, "index.json"), indexBytes);
    const genMeta: Record<string, unknown> = {
      schemaVersion: SCHEMA_VERSION,
      baselineVersion,
      currentVersion,
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
