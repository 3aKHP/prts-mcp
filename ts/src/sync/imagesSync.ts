/**
 * AKDP image asset sync for LOCAL_IMAGE=true mode.
 * Mirrors python/src/prts_mcp/sync/images_sync.py.
 *
 * Discovers ``images-*`` GitHub Releases from the arknights-data-pipeline
 * factory, downloads baseline shard zips + delta zips, and atomically
 * activates a generation directory of PNG files indexed by ``index.json``.
 *
 * Moved from data/imagesSync into the sync/ tier in P3.B (it is a sync
 * state machine, not a data reader). Reuses the shared sync primitives —
 * cascading transport, atomic activation, cross-process locking, offline
 * fallback — but keeps an images-specific discovery path: images Releases
 * are tag-isolated from ``data-*`` Releases and cannot use the
 * ``/releases/latest`` endpoint (see
 * arknights-data-pipeline/docs/image-index-schema.md §6).
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { SCHEMA_VERSION, parseIndex, type ImagesIndex } from "../data/images.js";
import { withArchiveActivationLock, safeExtractZip } from "./releaseActivation.js";
import {
  assetUrl,
  latestReleaseByPrefix,
  listReleases,
  listReleasesPaginated,
  type GithubRelease,
  type ReleaseSpec,
} from "./releaseDiscovery.js";
import { type RepoSpec, type SyncResult } from "./types.js";
import { fetchCascading, githubHeaders, streamCascading } from "./transport.js";
import {
  IMAGES_META,
  activeGeneration,
  loadMeta,
  pruneGenerations,
  releasesDir,
  saveMeta,
  versionHash,
} from "./generationStore.js";

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
// imported from the sync tier — data and images releases share the pattern.
// ---------------------------------------------------------------------------

function releaseDownloadUrl(tag: string, assetName: string): string {
  return (
    `https://github.com/${IMAGES_REPO_OWNER}/${IMAGES_REPO}` +
    `/releases/download/${tag}/${assetName}`
  );
}

/** Extract the version from any ``images-*`` tag (baseline or delta). */
function imagesTagVersion(tag: unknown): string | null {
  if (typeof tag !== "string") return null;
  if (tag.startsWith(BASELINE_PREFIX)) return tag.slice(BASELINE_PREFIX.length);
  if (tag.startsWith(DELTA_PREFIX)) return tag.slice(DELTA_PREFIX.length);
  return null;
}

/**
 * Enumerate ``(version, release)`` deltas with baseline < v <= current.
 *
 * Version strings are fixed-width (``YY-MM-DD-HH-MM-SS_hash``), so
 * lexicographic order is chronological — do not trust ``created_at``.
 * Duplicate versions fail closed (null). Versions the pipeline never
 * published as a Release cannot be enumerated here; the final sha256
 * verification remains the authoritative completeness gate (#179).
 */
function enumerateDeltaChain(
  releases: GithubRelease[],
  baselineVersion: string,
  currentVersion: string,
): Array<[string, GithubRelease]> | null {
  const chain: Array<[string, GithubRelease]> = [];
  for (const release of releases) {
    const tag = release["tag_name"];
    if (typeof tag !== "string" || tag.startsWith(BASELINE_PREFIX)) continue;
    const version = imagesTagVersion(tag);
    if (version === null) continue;
    if (baselineVersion < version && version <= currentVersion) {
      chain.push([version, release]);
    }
  }
  if (new Set(chain.map(([version]) => version)).size !== chain.length) {
    return null;
  }
  chain.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return chain;
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

  let releases = await listReleases(IMAGES_REPO_OWNER, IMAGES_REPO);
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
  const tagVersion = deltaTag.slice(DELTA_PREFIX.length);

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
  // still drives a real GitHub API call here; a TTL freshness skip is deferred.
  if (
    meta !== null
    && genDir !== null
    && meta["currentVersion"] === tagVersion
    && sameShards
  ) {
    return { spec, status: "up_to_date", commitSha: tagVersion, error: null };
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

  // The index is authoritative for currentVersion; the latest delta tag is
  // only a discovery hint. A drift between the two would pick the wrong
  // chain endpoint and delta asset names — fail closed (#179).
  const currentVersion = index.currentVersion;
  if (!currentVersion || currentVersion !== tagVersion) {
    return offlineOrNoData(
      imageDir,
      "index.json currentVersion does not match the latest images delta tag",
    );
  }

  // Fast path is only valid when the prior generation sits on the same
  // baseline, syncs the same shards, and is not ahead of the authoritative
  // index. A rollback (prior current > index current) drops the fast path
  // and rebuilds from baseline + the full chain (#179).
  const priorCurrent = meta?.["currentVersion"];
  const baselineUnchanged =
    meta !== null
    && genDir !== null
    && meta["baselineVersion"] === baselineVersion
    && sameShards
    && typeof priorCurrent === "string"
    && priorCurrent <= currentVersion;
  const applyAfter =
    baselineUnchanged && typeof priorCurrent === "string"
      ? priorCurrent
      : baselineVersion;

  // Delta-chain enumeration must see every images release back to
  // applyAfter; the newest-100 page may not reach that far (#179).
  const coversChainStart = (release: GithubRelease): boolean => {
    const version = imagesTagVersion(release["tag_name"]);
    return version !== null && version <= applyAfter;
  };
  if (!releases.some(coversChainStart)) {
    const paged = await listReleasesPaginated(
      IMAGES_REPO_OWNER,
      IMAGES_REPO,
      coversChainStart,
    );
    if (paged === null) {
      return offlineOrNoData(
        imageDir,
        "Release history does not cover the images baseline",
      );
    }
    releases = paged;
  }

  const chain = enumerateDeltaChain(releases, baselineVersion, currentVersion);
  if (chain === null) {
    return offlineOrNoData(imageDir, "images delta chain has duplicate versions");
  }

  const pending = chain.filter(([version]) => version > applyAfter);
  // Fail fast on a missing delta asset *before* the ~1.5 GB baseline
  // download, so a broken chain never burns the transfer budget (#179).
  for (const [chainVersion, chainRelease] of pending) {
    if (assetUrl(chainRelease, `${DELTA_ASSET_PREFIX}${chainVersion}.zip`) === null) {
      return offlineOrNoData(
        imageDir,
        `images delta asset missing: ${DELTA_ASSET_PREFIX}${chainVersion}.zip`,
      );
    }
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

    if (baselineUnchanged && genDir !== null) {
      // Fast path: reuse prior PNGs, overlay only the newer deltas.
      await cp(genDir, staging, { recursive: true });
      await unlink(join(staging, "index.json")).catch(() => undefined);
      await unlink(join(staging, IMAGES_META)).catch(() => undefined);
    } else {
      const baselineTag = `${BASELINE_PREFIX}${baselineVersion}`;
      for (const shardKey of shardKeys) {
        const shardFile = index.shards[shardKey] ?? "";
        if (!shardFile) continue;
        const shardZip = join(staging, `.${shardKey}.zip`);
        await streamCascading(releaseDownloadUrl(baselineTag, shardFile), shardZip);
        await safeExtractZip(shardZip, staging);
        await unlink(shardZip).catch(() => undefined);
      }
    }

    // Delta chain: overlay every pending incremental in version order.
    // A download/extract failure must propagate (not be swallowed) so a
    // half-applied chain never activates — the authoritative index.json
    // would otherwise reference PNGs that are absent. Sentinel deltas
    // (empty zips) extract cleanly and pass through.
    let seq = 0;
    for (const [chainVersion, chainRelease] of pending) {
      seq += 1;
      const deltaUrl = assetUrl(chainRelease, `${DELTA_ASSET_PREFIX}${chainVersion}.zip`);
      if (deltaUrl === null) {
        // vanished since the pre-download check
        throw new Error(
          `images delta asset missing: ${DELTA_ASSET_PREFIX}${chainVersion}.zip`,
        );
      }
      const deltaZip = join(staging, ".delta.zip");
      await streamCascading(deltaUrl, deltaZip);
      await safeExtractZip(deltaZip, staging);
      await unlink(deltaZip).catch(() => undefined);
      log("INFO", `Applied images delta ${chainVersion.slice(0, 16)} (${seq}/${pending.length})`);
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
