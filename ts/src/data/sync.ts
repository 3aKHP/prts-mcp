/**
 * GitHub-backed data sync for PRTS-MCP (TypeScript implementation).
 *
 * Mirrors the behaviour of python/src/prts_mcp/data/sync.py:
 * - Downloads GitHub Release zip assets (gamedata excel/levels, storyjson)
 *   only when the release tag has changed.
 * - Falls back gracefully to cached / bundled data when the network is
 *   unavailable.
 * - Skips the upstream check entirely when cached data is fresher than the TTL.
 */

import { existsSync, statSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import AdmZip from "adm-zip";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const GAMEDATA_FILES: readonly string[] = [
  "zh_CN/gamedata/excel/character_table.json",
  "zh_CN/gamedata/excel/handbook_info_table.json",
  "zh_CN/gamedata/excel/charword_table.json",
  "zh_CN/gamedata/excel/story_review_table.json",
  "zh_CN/gamedata/excel/enemy_handbook_table.json",
  "zh_CN/gamedata/excel/stage_table.json",
  "zh_CN/gamedata/excel/zone_table.json",
  "zh_CN/gamedata/excel/item_table.json",
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

/**
 * Parse GITHUB_MIRRORS env var into a list of proxy base URLs (trailing slash stripped).
 *
 * Unset / empty  → [] (direct only, no cascade)
 * "https://ghproxy.net"              → ["https://ghproxy.net"]
 * "https://a.example,https://b.example" → ["https://a.example", "https://b.example"]
 *
 * Mirror URL format (ghproxy-style): <mirror>/<original_url>
 * e.g. "https://ghproxy.net/https://raw.githubusercontent.com/..."
 */
function parseMirrors(): string[] {
  return (process.env["GITHUB_MIRRORS"] ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

/** Return [url, mirroredUrl1, mirroredUrl2, ...] */
function urlCandidates(url: string): string[] {
  return [url, ...parseMirrors().map((m) => `${m}/${url}`)];
}

/**
 * fetch() wrapper that cascades through URL candidates on failure.
 *
 * - A fresh AbortSignal.timeout is created per attempt so an earlier
 *   timeout does not consume the budget for later candidates.
 * - HTTP 4xx from the direct URL propagates immediately (resource is
 *   genuinely missing — mirrors won't help).
 * - Network error or HTTP 5xx from any candidate → try the next one.
 */
async function fetchCascading(
  url: string,
  options: Omit<RequestInit, "signal">,
  timeoutMs: number,
): Promise<Response> {
  const candidates = urlCandidates(url);
  let lastErr: unknown = new Error("All URL candidates failed");
  for (let i = 0; i < candidates.length; i++) {
    try {
      const res = await fetch(candidates[i], {
        ...options,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return res;
      lastErr = new Error(`HTTP ${res.status}`);
      // Direct 4xx → the resource does not exist; mirrors cannot help.
      if (i === 0 && res.status >= 400 && res.status < 500) break;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
  /** Optional validator returning missing or invalid zip entries. */
  validateZip?: (zipPath: string) => string[];
}

/** Describes a GitHub Release zip asset that should be extracted locally. */
export interface ReleaseArchiveSpec {
  owner: string;
  repo: string;
  assetName: string;
  localZip: string;
  localRoot: string;
  requiredFiles: readonly string[];
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
    const res = await fetchCascading(url, { headers: githubHeaders() }, timeoutMs);
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
 * Release sync decision tree:
 *   1. Cache is fresh AND zip exists → up_to_date (skip API call)
 *   2. Network failure → offline_fallback / no_data
 *   3. Tag unchanged AND zip exists → up_to_date (refresh fetchedAt)
 *   4. Tag changed or zip missing → downloadReleaseAsset → updated / fallback
 */
export async function syncRelease(
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

function archiveFilesPresent(spec: ReleaseArchiveSpec, root = spec.localRoot): boolean {
  return spec.requiredFiles.every((f) => {
    const p = join(root, f);
    return existsSync(p) && statSync(p).isFile();
  });
}

function archiveMissingFiles(spec: ReleaseArchiveSpec, root: string): string[] {
  return spec.requiredFiles.filter((f) => {
    const p = join(root, f);
    return !existsSync(p) || !statSync(p).isFile();
  });
}

function extractMetaPath(spec: ReleaseArchiveSpec): string {
  return join(dirname(spec.localZip), "extract_meta.json");
}

interface ExtractMeta {
  commitSha: string;
  dataRoot: string;
}

async function loadExtractMeta(spec: ReleaseArchiveSpec): Promise<ExtractMeta | null> {
  try {
    const value = JSON.parse(await readFile(extractMetaPath(spec), "utf-8")) as {
      commit_sha?: unknown;
      data_root?: unknown;
    };
    if (typeof value.commit_sha !== "string" || value.commit_sha.length === 0) return null;
    if (typeof value.data_root !== "string" || value.data_root.length === 0) return null;
    const root = resolve(spec.localRoot);
    const dataRoot = resolve(spec.localRoot, value.data_root);
    const rel = relative(root, dataRoot);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
    if (!existsSync(dataRoot) || !statSync(dataRoot).isDirectory()) return null;
    return { commitSha: value.commit_sha, dataRoot };
  } catch {
    return null;
  }
}

async function saveExtractMeta(
  spec: ReleaseArchiveSpec,
  commitSha: string,
  dataRoot: string,
): Promise<void> {
  const path = extractMetaPath(spec);
  const tmp = `${path}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmp, JSON.stringify({
    commit_sha: commitSha,
    data_root: relative(spec.localRoot, dataRoot).replaceAll("\\", "/"),
  }, null, 2), "utf-8");
  await rename(tmp, path);
}

function validateArchiveZip(zipPath: string, requiredFiles: readonly string[]): string[] {
  try {
    const zip = new AdmZip(zipPath);
    const entries = new Set(zip.getEntries().filter((entry) => !entry.isDirectory).map((entry) => entry.entryName));
    return requiredFiles.filter((file) => !entries.has(file));
  } catch (err) {
    return [`${basename(zipPath)} is not a valid zip: ${errorMessage(err)}`];
  }
}

async function safeExtractZip(zipPath: string, localRoot: string): Promise<void> {
  const root = resolve(localRoot);
  const zip = new AdmZip(zipPath);
  const tmpPaths: string[] = [];
  try {
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;
      const dest = resolve(localRoot, entry.entryName);
      const rel = relative(root, dest);
      if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new Error(`Unsafe zip member path: ${entry.entryName}`);
      }

      await mkdir(dirname(dest), { recursive: true });
      const tmp = `${dest}.tmp`;
      await writeFile(tmp, entry.getData());
      tmpPaths.push(tmp);
      await rename(tmp, dest);
      tmpPaths.pop();
    }
  } catch (err) {
    for (const tmp of tmpPaths) {
      try {
        await unlink(tmp);
      } catch {
        // best-effort cleanup
      }
    }
    throw err;
  }
}

async function extractReleaseTree(
  spec: ReleaseArchiveSpec,
  commitSha: string,
): Promise<string> {
  const releases = join(spec.localRoot, ".releases");
  await mkdir(releases, { recursive: true });
  const releaseKey = createHash("sha256").update(commitSha).digest("hex").slice(0, 16);
  const generation = `${releaseKey}-${randomUUID().replaceAll("-", "")}`;
  const staging = join(releases, `.${generation}.tmp`);
  const activated = join(releases, generation);
  try {
    await safeExtractZip(spec.localZip, staging);
    const missing = archiveMissingFiles(spec, staging);
    if (missing.length > 0) {
      throw new Error(`Archive extraction missing required files: ${missing.slice(0, 10).join("; ")}`);
    }
    await rename(staging, activated);
    return activated;
  } catch (err) {
    await rm(staging, { recursive: true, force: true });
    throw err;
  }
}

async function archiveActivationSha(
  spec: ReleaseArchiveSpec,
  releaseSha: string | null,
): Promise<string> {
  if (releaseSha !== null) return releaseSha;
  const digest = createHash("sha256").update(await readFile(spec.localZip)).digest("hex");
  return `local-${digest}`;
}

async function pruneReleaseTrees(
  spec: ReleaseArchiveSpec,
  keep: Set<string>,
): Promise<void> {
  const releases = join(spec.localRoot, ".releases");
  try {
    for (const name of await readdir(releases)) {
      const candidate = join(releases, name);
      if (!keep.has(candidate)) {
        await rm(candidate, { recursive: true, force: true });
      }
    }
  } catch {
    // Best-effort retention cleanup must not roll back an activated release.
  }
}

/**
 * Download a GitHub Release zip asset and extract it into localRoot.
 *
 * This keeps the gamedata distribution path aligned with storyjson releases
 * while preserving the existing on-disk ArknightsGameData layout.
 */
export async function syncReleaseArchive(
  spec: ReleaseArchiveSpec,
  forceCheck = false,
): Promise<SyncResult> {
  const releaseResult = await syncRelease({
    owner: spec.owner,
    repo: spec.repo,
    assetName: spec.assetName,
    localZip: spec.localZip,
    validateZip: (zipPath) => validateArchiveZip(zipPath, spec.requiredFiles),
  }, forceCheck);

  const dummySpec: RepoSpec = {
    owner: spec.owner,
    repo: spec.repo,
    branch: "releases",
    files: spec.requiredFiles,
    localRoot: spec.localRoot,
  };

  const extractMeta = await loadExtractMeta(spec);
  const activeRoot = extractMeta?.dataRoot ?? spec.localRoot;
  const filesOk = archiveFilesPresent(spec, activeRoot);
  if (releaseResult.status === "no_data") {
    return filesOk
      ? {
          spec: dummySpec,
          status: "offline_fallback",
          commitSha: releaseResult.commitSha,
          error: releaseResult.error,
        }
      : {
          spec: dummySpec,
          status: "no_data",
          commitSha: releaseResult.commitSha,
          error: releaseResult.error,
        };
  }

  const extractedSha = extractMeta?.commitSha ?? null;
  const shouldExtract = releaseResult.status === "updated"
    || !filesOk
    || extractedSha === null
    || (releaseResult.commitSha !== null && extractedSha !== releaseResult.commitSha);
  if (shouldExtract) {
    try {
      const activationSha = await archiveActivationSha(spec, releaseResult.commitSha);
      const activatedRoot = await extractReleaseTree(spec, activationSha);
      await saveExtractMeta(spec, activationSha, activatedRoot);
      await pruneReleaseTrees(spec, new Set([activeRoot, activatedRoot]));
      return {
        spec: dummySpec,
        status: "updated",
        commitSha: activationSha,
        error: null,
      };
    } catch (err) {
      const error = errorMessage(err);
      return archiveFilesPresent(spec, activeRoot)
        ? {
            spec: dummySpec,
            status: "offline_fallback",
            commitSha: releaseResult.commitSha,
            error,
          }
        : {
            spec: dummySpec,
            status: "no_data",
            commitSha: releaseResult.commitSha,
            error,
          };
    }

  }

  return {
    spec: dummySpec,
    status: releaseResult.status,
    commitSha: releaseResult.commitSha,
    error: releaseResult.error,
  };
}
