/**
 * Release sync: zip download + manifest verify + the release state machine.
 *
 * Mirrors python/src/prts_mcp/sync/release.py. Owns CacheMeta, the
 * release-asset download, the optional factory-manifest verification, and
 * syncRelease. data/sync re-exports these during the P2.B migration; the
 * archive/pair state machine still lives there until P2.B.2.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { type RepoSpec, type SyncResult, errorMessage } from "./types.js";
import { type ReleaseSpec, TAG_PREFIX, checkLatestRelease } from "./releaseDiscovery.js";
import {
  AssetNotFoundError,
  fetchCascading,
  githubHeaders,
  parseMirrors,
  type FetchResponse,
} from "./transport.js";
import { withArchiveActivationLock } from "./releaseActivation.js";

/** Versioned contract shared with the arknights-data-pipeline manifest. */
export const DATA_CONTRACT_VERSION = "prts-mcp-data/v1";

/** Skip the upstream SHA check if cached data is fresher than this (seconds). */
const CACHE_TTL_SECONDS = 3600;

/** Persisted metadata about the last successful sync. */
interface CacheMeta {
  repo: string;
  branch: string;
  commitSha: string;
  /** ISO 8601 UTC timestamp, e.g. "2025-01-01T00:00:00.000Z" */
  fetchedAt: string;
  files: string[];
}

function cacheIsFresh(cache: CacheMeta): boolean {
  try {
    const ageMs = Date.now() - new Date(cache.fetchedAt).getTime();
    return ageMs < CACHE_TTL_SECONDS * 1000;
  } catch {
    return false;
  }
}

function releaseZipError(spec: ReleaseSpec): string | null {
  if (!existsSync(spec.localZip)) return "zip file is missing";
  try {
    const missing = spec.validateZip?.(spec.localZip) ?? [];
    if (missing.length === 0) return null;
    return missing.slice(0, 10).join("; ");
  } catch (err) {
    return `${basename(spec.localZip)} is not a valid zip: ${errorMessage(err)}`;
  }
}

function releaseCachePath(spec: ReleaseSpec): string {
  return join(dirname(spec.localZip), "release_meta.json");
}

async function loadReleaseMeta(spec: ReleaseSpec): Promise<CacheMeta | null> {
  try {
    const text = await readFile(releaseCachePath(spec), "utf-8");
    const value = JSON.parse(text) as {
      repo?: unknown;
      branch?: unknown;
      commit_sha?: unknown;
      commitSha?: unknown;
      fetched_at?: unknown;
      fetchedAt?: unknown;
      files?: unknown;
    };
    const commitSha = value.commit_sha ?? value.commitSha;
    const fetchedAt = value.fetched_at ?? value.fetchedAt;
    if (
      typeof value.repo !== "string"
      || typeof value.branch !== "string"
      || typeof commitSha !== "string"
      || commitSha.length === 0
      || typeof fetchedAt !== "string"
      || fetchedAt.length === 0
      || !Array.isArray(value.files)
    ) return null;
    return {
      repo: value.repo,
      branch: value.branch,
      commitSha,
      fetchedAt,
      files: value.files.filter((file): file is string => typeof file === "string"),
    };
  } catch {
    return null;
  }
}

async function saveReleaseMeta(
  spec: ReleaseSpec,
  meta: CacheMeta
): Promise<void> {
  const p = releaseCachePath(spec);
  const tmp = join(dirname(p), `.${basename(p)}.${randomUUID().replaceAll("-", "")}.tmp`);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(tmp, JSON.stringify({
    repo: meta.repo,
    branch: meta.branch,
    commit_sha: meta.commitSha,
    fetched_at: meta.fetchedAt,
    files: meta.files,
  }, null, 2), "utf-8");
  await rename(tmp, p);
}

/**
 * Download the release asset zip atomically, then write cache metadata.
 * Uses write-to-tmp-then-rename for crash safety.
 */
export async function downloadReleaseAsset(
  spec: ReleaseSpec,
  tag: string,
  assetUrl: string,
  timeoutMs = 120_000
): Promise<void> {
  const tmp = join(
    dirname(spec.localZip),
    `.${basename(spec.localZip)}.${randomUUID().replaceAll("-", "")}.tmp`,
  );
  await mkdir(dirname(spec.localZip), { recursive: true });
  try {
    const res = await fetchCascading(
      assetUrl,
      { headers: githubHeaders(), redirect: "follow" },
      timeoutMs,
    ).catch((err: unknown) => {
      throw new Error(`${errorMessage(err)} downloading ${spec.assetName}`);
    });
    await writeFile(tmp, Buffer.from(await res.arrayBuffer()));
    const missing = spec.validateZip?.(tmp) ?? [];
    if (missing.length > 0) {
      throw new Error(`Downloaded ${spec.assetName} is missing required entries: ${missing.join(", ")}`);
    }
    if (spec.verifyManifest) {
      await verifyReleaseManifest(spec, tag, tmp, timeoutMs);
    }
    await rename(tmp, spec.localZip);

    const commitSha = tag.startsWith(TAG_PREFIX) ? tag.slice(TAG_PREFIX.length) : tag;
    await saveReleaseMeta(spec, {
      repo: `${spec.owner}/${spec.repo}`,
      branch: "releases",
      commitSha,
      fetchedAt: new Date().toISOString(),
      files: [spec.assetName],
    });
  } catch (err) {
    try { await unlink(tmp); } catch { /* best-effort */ }
    throw err;
  }
}

async function verifyReleaseManifest(
  spec: ReleaseSpec,
  tag: string,
  assetPath: string,
  timeoutMs: number,
): Promise<void> {
  const manifestUrl = tag === "unknown"
    ? `https://github.com/${spec.owner}/${spec.repo}/releases/latest/download/manifest.json`
    : `https://github.com/${spec.owner}/${spec.repo}/releases/download/${tag}/manifest.json`;
  let response: FetchResponse;
  try {
    response = await fetchCascading(
      manifestUrl, { headers: githubHeaders(), redirect: "follow" }, timeoutMs,
    );
  } catch (err) {
    // Direct URL confirmed 404 → release predates the manifest asset.
    if (err instanceof AssetNotFoundError) return;
    throw new Error(`manifest unavailable for ${tag}: ${errorMessage(err)}`);
  }
  let manifest: unknown;
  try {
    manifest = await response.json();
  } catch (err) {
    throw new Error(`manifest for ${tag} is invalid: ${errorMessage(err)}`);
  }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    throw new Error(`manifest for ${tag} is invalid: manifest root must be an object`);
  }
  const typedManifest = manifest as {
    assets?: Record<string, { size?: number; sha256?: string }>;
    contractVersion?: unknown;
    source?: { versionId?: unknown };
  };
  if (typedManifest.contractVersion !== DATA_CONTRACT_VERSION) {
    throw new Error(`manifest for ${tag} has unsupported contractVersion`);
  }
  if (
    tag.startsWith("data-")
    && typedManifest.source?.versionId !== tag.slice("data-".length)
  ) {
    throw new Error(`manifest source version does not match release tag ${tag}`);
  }
  const expected = typedManifest.assets?.[spec.assetName];
  if (typeof expected?.size !== "number" || typeof expected.sha256 !== "string") {
    throw new Error(`manifest for ${tag} has no valid entry for ${spec.assetName}`);
  }
  const bytes = await readFile(assetPath);
  const actualSha = createHash("sha256").update(bytes).digest("hex");
  if (expected.size !== bytes.byteLength || expected.sha256 !== actualSha) {
    throw new Error(
      `manifest mismatch for ${spec.assetName}: expected `
      + `${expected.size}/${expected.sha256}, got ${bytes.byteLength}/${actualSha}`,
    );
  }
}

/**
 * Check latest GitHub Release and download the zip if the tag has changed.
 *
 * Release sync decision tree:
 *   1. Cache is fresh AND zip exists → up_to_date (skip API call)
 *   2. Network failure → offline_fallback / no_data
 *   3. Tag unchanged AND zip exists → up_to_date (refresh fetchedAt)
 *   4. Tag changed or zip missing → downloadReleaseAsset → updated / fallback
 */
async function syncReleaseLocked(
  spec: ReleaseSpec,
  forceCheck = false,
): Promise<SyncResult> {
  // Use a dummy RepoSpec so existing result logging can share the same shape.
  const dummySpec: RepoSpec = {
    owner: spec.owner,
    repo: spec.repo,
    branch: "releases",
    files: [spec.assetName],
    localRoot: dirname(spec.localZip),
  };

  const cache = await loadReleaseMeta(spec);
  const zipError = releaseZipError(spec);
  const zipOk = zipError === null;

  if (!forceCheck && cache !== null && zipOk && cacheIsFresh(cache)) {
    return { spec: dummySpec, status: "up_to_date", commitSha: cache.commitSha, error: null };
  }

  const latest = await checkLatestRelease(spec);

  if (latest === null) {
    if (zipOk) {
      return { spec: dummySpec, status: "offline_fallback", commitSha: cache?.commitSha ?? null, error: "Network unavailable" };
    }
    // No zip and API unreachable — attempt blind download via releases/latest/download/
    // (does not require the GitHub API; ghproxy and similar mirrors support this URL).
    if (parseMirrors().length > 0) {
      const blindUrl = `https://github.com/${spec.owner}/${spec.repo}/releases/latest/download/${spec.assetName}`;
      try {
        await downloadReleaseAsset(spec, "unknown", blindUrl);
        return { spec: dummySpec, status: "updated", commitSha: "unknown", error: null };
      } catch (err) {
        return { spec: dummySpec, status: "no_data", commitSha: null, error: errorMessage(err) };
      }
    }
    const error =
      existsSync(spec.localZip) && zipError
        ? `Network unavailable and no cached zip; cached zip invalid: ${zipError}`
        : "Network unavailable and no cached zip";
    return { spec: dummySpec, status: "no_data", commitSha: null, error };
  }

  const commitSha = latest.tag.startsWith(TAG_PREFIX)
    ? latest.tag.slice(TAG_PREFIX.length)
    : latest.tag;

  if (cache !== null && cache.commitSha === commitSha && zipOk) {
    await saveReleaseMeta(spec, { ...cache, fetchedAt: new Date().toISOString() });
    return { spec: dummySpec, status: "up_to_date", commitSha, error: null };
  }

  try {
    await downloadReleaseAsset(spec, latest.tag, latest.url);
    return { spec: dummySpec, status: "updated", commitSha, error: null };
  } catch (err) {
    const error = errorMessage(err);
    return zipOk
      ? { spec: dummySpec, status: "offline_fallback", commitSha: cache?.commitSha ?? null, error }
      : { spec: dummySpec, status: "no_data", commitSha: null, error };
  }
}

/** Publish a release ZIP and its metadata as one serialized operation. */
export async function syncRelease(
  spec: ReleaseSpec,
  forceCheck = false,
): Promise<SyncResult> {
  const dummySpec: RepoSpec = {
    owner: spec.owner,
    repo: spec.repo,
    branch: "releases",
    files: [spec.assetName],
    localRoot: dirname(spec.localZip),
  };
  try {
    await mkdir(dirname(spec.localZip), { recursive: true });
    return await withArchiveActivationLock(
      spec,
      () => syncReleaseLocked(spec, forceCheck),
      ".release.lock",
    );
  } catch (err) {
    const cache = await loadReleaseMeta(spec);
    return {
      spec: dummySpec,
      status: releaseZipError(spec) === null ? "offline_fallback" : "no_data",
      commitSha: cache?.commitSha ?? null,
      error: errorMessage(err),
    };
  }
}
