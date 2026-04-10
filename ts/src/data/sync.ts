/**
 * GitHub-backed data sync for PRTS-MCP (TypeScript implementation).
 *
 * Mirrors the behaviour of python/src/prts_mcp/data/sync.py exactly:
 * - Checks the upstream commit SHA via the GitHub Commits API.
 * - Downloads required game data files only when the upstream has changed.
 * - Falls back gracefully to cached / bundled data when the network is
 *   unavailable.
 * - Skips the upstream check entirely when cached data is fresher than the TTL.
 */

import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const GAMEDATA_FILES: readonly string[] = [
  "zh_CN/gamedata/excel/character_table.json",
  "zh_CN/gamedata/excel/handbook_info_table.json",
  "zh_CN/gamedata/excel/charword_table.json",
  "zh_CN/gamedata/excel/story_review_table.json",
];

const GITHUB_UA = "PRTS-MCP-Bot/0.1 (Arknights fan-creation helper)";

/** Skip the upstream SHA check if cached data is fresher than this (seconds). */
const CACHE_TTL_SECONDS = 3600;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Describes an upstream GitHub repository and the files required from it. */
export interface RepoSpec {
  owner: string;
  repo: string;
  branch: string;
  files: readonly string[];
  /** Absolute path to the local directory where files are written. */
  localRoot: string;
}

/** Persisted metadata about the last successful sync. */
interface CacheMeta {
  repo: string;
  branch: string;
  commitSha: string;
  /** ISO 8601 UTC timestamp, e.g. "2025-01-01T00:00:00.000Z" */
  fetchedAt: string;
  files: string[];
}

export type SyncStatus =
  | "updated"
  | "up_to_date"
  | "offline_fallback"
  | "no_data";

export interface SyncResult {
  spec: RepoSpec;
  status: SyncStatus;
  commitSha: string | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "User-Agent": GITHUB_UA };
  const token = process.env["GITHUB_TOKEN"];
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

function cacheMetaPath(spec: RepoSpec): string {
  return join(spec.localRoot, "cache_meta.json");
}

async function loadCacheMeta(spec: RepoSpec): Promise<CacheMeta | null> {
  try {
    const text = await readFile(cacheMetaPath(spec), "utf-8");
    return JSON.parse(text) as CacheMeta;
  } catch {
    return null;
  }
}

async function saveCacheMeta(
  spec: RepoSpec,
  meta: CacheMeta
): Promise<void> {
  const p = cacheMetaPath(spec);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(meta, null, 2), "utf-8");
}

function cacheIsFresh(cache: CacheMeta): boolean {
  try {
    const ageMs = Date.now() - new Date(cache.fetchedAt).getTime();
    return ageMs < CACHE_TTL_SECONDS * 1000;
  } catch {
    return false;
  }
}

function filesPresent(spec: RepoSpec): boolean {
  return spec.files.every((f) => existsSync(join(spec.localRoot, f)));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return the latest commit SHA from GitHub, or `null` on any failure.
 */
export async function checkUpstreamSha(
  spec: RepoSpec,
  timeoutMs = 10_000
): Promise<string | null> {
  const url = `https://api.github.com/repos/${spec.owner}/${spec.repo}/commits/${spec.branch}`;
  try {
    const res = await fetch(url, {
      headers: githubHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { sha: string };
    return data.sha;
  } catch {
    return null;
  }
}

/**
 * Download all required files atomically, then write cache metadata.
 *
 * Uses a write-to-tmp-then-rename pattern so partially downloaded files
 * never appear to the data loader as complete.
 */
export async function downloadFiles(
  spec: RepoSpec,
  sha: string,
  timeoutMs = 60_000
): Promise<void> {
  const tmpPairs: Array<[tmp: string, dest: string]> = [];
  try {
    for (const filePath of spec.files) {
      const url = `https://raw.githubusercontent.com/${spec.owner}/${spec.repo}/${spec.branch}/${filePath}`;
      const res = await fetch(url, {
        headers: githubHeaders(),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${filePath}`);

      const dest = join(spec.localRoot, filePath);
      const tmp = dest + ".tmp";
      await mkdir(dirname(dest), { recursive: true });
      // Write raw bytes to preserve exact encoding from upstream.
      await writeFile(tmp, Buffer.from(await res.arrayBuffer()));
      tmpPairs.push([tmp, dest]);
    }

    // All downloads succeeded — atomically rename into place.
    for (const [tmp, dest] of tmpPairs) {
      await rename(tmp, dest);
    }
    tmpPairs.length = 0;

    await saveCacheMeta(spec, {
      repo: `${spec.owner}/${spec.repo}`,
      branch: spec.branch,
      commitSha: sha,
      fetchedAt: new Date().toISOString(),
      files: [...spec.files],
    });
  } catch (err) {
    // Clean up any temp files on failure.
    for (const [tmp] of tmpPairs) {
      try {
        await unlink(tmp);
      } catch {
        // best-effort cleanup
      }
    }
    throw err;
  }
}

/**
 * Check upstream and download files if needed.
 *
 * Decision tree (mirrors Python sync.py):
 *   1. Cache is fresh AND files exist → up_to_date (skip API call)
 *   2. Call GitHub commits API:
 *      a. Network failure:
 *           files present → offline_fallback
 *           no files      → no_data
 *      b. SHA matches cache AND files present → up_to_date (refresh fetchedAt)
 *      c. Otherwise → downloadFiles()
 *           success → updated
 *           failure → files present → offline_fallback / no files → no_data
 */
export async function syncRepo(spec: RepoSpec): Promise<SyncResult> {
  const cache = await loadCacheMeta(spec);
  const filesOk = filesPresent(spec);

  // Fast path: cache is fresh, no need to hit the API.
  if (cache !== null && filesOk && cacheIsFresh(cache)) {
    return {
      spec,
      status: "up_to_date",
      commitSha: cache.commitSha,
      error: null,
    };
  }

  const upstreamSha = await checkUpstreamSha(spec);

  if (upstreamSha === null) {
    return filesOk
      ? {
          spec,
          status: "offline_fallback",
          commitSha: cache?.commitSha ?? null,
          error: "Network unavailable",
        }
      : {
          spec,
          status: "no_data",
          commitSha: null,
          error: "Network unavailable and no cached data",
        };
  }

  if (cache !== null && cache.commitSha === upstreamSha && filesOk) {
    // Refresh fetchedAt so the TTL resets from now.
    await saveCacheMeta(spec, { ...cache, fetchedAt: new Date().toISOString() });
    return {
      spec,
      status: "up_to_date",
      commitSha: upstreamSha,
      error: null,
    };
  }

  try {
    await downloadFiles(spec, upstreamSha);
    return { spec, status: "updated", commitSha: upstreamSha, error: null };
  } catch (err) {
    const error = errorMessage(err);
    return filesOk
      ? {
          spec,
          status: "offline_fallback",
          commitSha: cache?.commitSha ?? null,
          error,
        }
      : { spec, status: "no_data", commitSha: null, error };
  }
}

/** Sync each RepoSpec sequentially and return all results. */
export async function syncAll(specs: RepoSpec[]): Promise<SyncResult[]> {
  const results: SyncResult[] = [];
  for (const spec of specs) {
    results.push(await syncRepo(spec));
  }
  return results;
}

// ---------------------------------------------------------------------------
// Release-based sync (for zh_CN.zip from GitHub Releases)
// ---------------------------------------------------------------------------

const GITHUB_RELEASES_LATEST_URL =
  "https://api.github.com/repos/{owner}/{repo}/releases/latest";
const TAG_PREFIX = "upstream-";

/** Describes a GitHub Release asset to download as a local zip. */
export interface ReleaseSpec {
  owner: string;
  repo: string;
  /** Asset filename in the release, e.g. "zh_CN.zip". */
  assetName: string;
  /** Absolute destination path for the downloaded zip. */
  localZip: string;
}

function releaseCachePath(spec: ReleaseSpec): string {
  return join(dirname(spec.localZip), "release_meta.json");
}

async function loadReleaseMeta(spec: ReleaseSpec): Promise<CacheMeta | null> {
  try {
    const text = await readFile(releaseCachePath(spec), "utf-8");
    return JSON.parse(text) as CacheMeta;
  } catch {
    return null;
  }
}

async function saveReleaseMeta(
  spec: ReleaseSpec,
  meta: CacheMeta
): Promise<void> {
  const p = releaseCachePath(spec);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(meta, null, 2), "utf-8");
}

/**
 * Fetch the latest release tag and asset download URL.
 * Returns null on any network or API failure.
 */
export async function checkLatestRelease(
  spec: ReleaseSpec,
  timeoutMs = 10_000
): Promise<{ tag: string; url: string } | null> {
  const url = GITHUB_RELEASES_LATEST_URL.replace("{owner}", spec.owner).replace(
    "{repo}",
    spec.repo
  );
  try {
    const res = await fetch(url, {
      headers: githubHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as {
      tag_name: string;
      assets: Array<{ name: string; browser_download_url: string }>;
    };
    const asset = data.assets.find((a) => a.name === spec.assetName);
    if (!asset) return null;
    return { tag: data.tag_name, url: asset.browser_download_url };
  } catch {
    return null;
  }
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
  const tmp = spec.localZip + ".tmp";
  await mkdir(dirname(spec.localZip), { recursive: true });
  try {
    const res = await fetch(assetUrl, {
      headers: githubHeaders(),
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${spec.assetName}`);
    await writeFile(tmp, Buffer.from(await res.arrayBuffer()));
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

/**
 * Check latest GitHub Release and download the zip if the tag has changed.
 *
 * Decision tree mirrors syncRepo:
 *   1. Cache is fresh AND zip exists → up_to_date (skip API call)
 *   2. Network failure → offline_fallback / no_data
 *   3. Tag unchanged AND zip exists → up_to_date (refresh fetchedAt)
 *   4. Tag changed or zip missing → downloadReleaseAsset → updated / fallback
 */
export async function syncRelease(spec: ReleaseSpec): Promise<SyncResult> {
  // Use a dummy RepoSpec so the result shape is compatible with syncAll logging.
  const dummySpec: RepoSpec = {
    owner: spec.owner,
    repo: spec.repo,
    branch: "releases",
    files: [spec.assetName],
    localRoot: dirname(spec.localZip),
  };

  const cache = await loadReleaseMeta(spec);
  const zipOk = existsSync(spec.localZip);

  if (cache !== null && zipOk && cacheIsFresh(cache)) {
    return { spec: dummySpec, status: "up_to_date", commitSha: cache.commitSha, error: null };
  }

  const latest = await checkLatestRelease(spec);

  if (latest === null) {
    return zipOk
      ? { spec: dummySpec, status: "offline_fallback", commitSha: cache?.commitSha ?? null, error: "Network unavailable" }
      : { spec: dummySpec, status: "no_data", commitSha: null, error: "Network unavailable and no cached zip" };
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
