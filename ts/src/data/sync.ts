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

import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  lstat,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import AdmZip from "adm-zip";
import type { Dispatcher } from "undici";

const NATIVE_FETCH = globalThis.fetch;
let envProxyAgent: Dispatcher | undefined;

/** The response surface shared by the global and Undici fetch runtimes. */
interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Versioned contract shared with the arknights-data-pipeline manifest. */
export const DATA_CONTRACT_VERSION = "prts-mcp-data/v1";

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
const ACTIVATION_LOCK_TIMEOUT_MS = 120_000;
const ACTIVATION_LOCK_STALE_MS = 30 * 60_000;
const ACTIVATION_LOCK_OWNER_GRACE_MS = 10_000;
const ACTIVATION_LOCK_HEARTBEAT_MS = 60_000;
const RELEASE_RETENTION_MS = 24 * 60 * 60_000;
const GAMEDATA_PAIR_META = ".gamedata_pair.json";

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

export function githubHeaders(): Record<string, string> {
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

async function fetchWithRuntimeProxy(
  url: string,
  options: Omit<RequestInit, "signal">,
  signal: AbortSignal,
): Promise<FetchResponse> {
  // Preserve test/in-process fetch overrides and Bun's native proxy support.
  if (
    globalThis.fetch !== NATIVE_FETCH
    || process.versions.bun
    || !(
      process.env["HTTP_PROXY"] || process.env["HTTPS_PROXY"]
      || process.env["http_proxy"] || process.env["https_proxy"]
    )
  ) {
    return globalThis.fetch(url, { ...options, signal });
  }
  const { EnvHttpProxyAgent, fetch: undiciFetch } = await import("undici");
  if (envProxyAgent === undefined) envProxyAgent = new EnvHttpProxyAgent();
  const response = await undiciFetch(url, {
    ...options,
    signal,
    dispatcher: envProxyAgent,
  } as Parameters<typeof undiciFetch>[1]);
  return response;
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
export async function fetchCascading(
  url: string,
  options: Omit<RequestInit, "signal">,
  timeoutMs: number,
): Promise<FetchResponse> {
  const candidates = urlCandidates(url);
  let lastErr: unknown = new Error("All URL candidates failed");
  for (let i = 0; i < candidates.length; i++) {
    try {
      const res = await fetchWithRuntimeProxy(
        candidates[i], options, AbortSignal.timeout(timeoutMs),
      );
      if (res.ok) return res;
      // Direct 404 → asset confirmed absent; record the typed error and stop
      // without trying mirrors. lastErr + break (not throw) so the typed
      // error survives to the caller even with GITHUB_MIRRORS (#100).
      if (i === 0 && res.status === 404) {
        lastErr = new AssetNotFoundError(`HTTP 404: ${candidates[i]}`);
        break;
      }
      lastErr = new Error(`HTTP ${res.status}`);
      // Other direct 4xx → the resource does not exist; mirrors cannot help.
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

/**
 * The direct release URL returned 404 — the asset genuinely does not exist.
 * Distinguished from a mirror 404 (mirror lacks the asset; the release may
 * still exist upstream) so manifest verification skips only on a confirmed
 * upstream 404 and stays fail-closed otherwise (#100).
 */
export class AssetNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssetNotFoundError";
  }
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

const TAG_PREFIX = "data-";

// ---------------------------------------------------------------------------
// Release discovery (tag-prefix filtered)
//
// The arknights-data-pipeline repo hosts both ``data-*`` and ``images-*``
// GitHub Releases.  ``/releases/latest`` may point at an ``images-*`` release
// if GitHub auto-promotes it, so data sync must filter by tag prefix instead.
// (imagesSync reuses these helpers for its own prefix filtering.)
// ---------------------------------------------------------------------------

/** Minimal shape of a GitHub Release object (only the fields we read). */
export interface GithubRelease {
  tag_name?: unknown;
  created_at?: unknown;
  assets?: unknown;
  [key: string]: unknown;
}

/** List all non-draft releases. Returns null on any network/API failure. */
export async function listReleases(
  owner: string,
  repo: string,
  timeoutMs = 10_000,
): Promise<GithubRelease[] | null> {
  const url = `https://api.github.com/repos/${owner}/${repo}/releases?per_page=100`;
  try {
    const res = await fetchCascading(url, { headers: githubHeaders() }, timeoutMs);
    const data = await res.json();
    return Array.isArray(data) ? (data as GithubRelease[]) : null;
  } catch {
    return null;
  }
}

/** Pick the newest release whose tag starts with *prefix*, sorting by created_at desc. */
export function latestReleaseByPrefix(
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

/** Extract the browser_download_url for *assetName* from a release object. */
export function assetUrl(release: GithubRelease, assetName: string): string | null {
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
  /** Verify the optional factory manifest when the release provides it. */
  verifyManifest?: boolean;
}

/** Describes a GitHub Release zip asset that should be extracted locally. */
export interface ReleaseArchiveSpec {
  owner: string;
  repo: string;
  assetName: string;
  localZip: string;
  localRoot: string;
  requiredFiles: readonly string[];
  verifyManifest?: boolean;
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
 * Return the latest ``data-*`` release tag and asset download URL.
 *
 * Uses the releases list API with tag-prefix filtering instead of
 * ``/releases/latest``, because the data-pipeline repo also hosts
 * ``images-*`` releases that may be promoted to "Latest" on GitHub.
 * Returns null on network failure or when no matching release/asset is found.
 */
export async function checkLatestRelease(
  spec: ReleaseSpec,
  timeoutMs = 10_000
): Promise<{ tag: string; url: string } | null> {
  const releases = await listReleases(spec.owner, spec.repo, timeoutMs);
  if (releases === null) return null;
  const latest = latestReleaseByPrefix(releases, TAG_PREFIX);
  if (!latest) return null;
  const tag = latest["tag_name"];
  if (typeof tag !== "string") return null;
  const url = assetUrl(latest, spec.assetName);
  if (!url) return null;
  return { tag, url };
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
    const root = realpathSync(spec.localRoot);
    const dataRoot = realpathSync(resolve(spec.localRoot, value.data_root));
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
  const tmp = join(
    dirname(path),
    `.${basename(path)}.${randomUUID().replaceAll("-", "")}.tmp`,
  );
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

export async function safeExtractZip(zipPath: string, localRoot: string): Promise<void> {
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

async function releasesPath(spec: ReleaseArchiveSpec): Promise<string> {
  const releases = join(spec.localRoot, ".releases");
  try {
    if ((await lstat(releases)).isSymbolicLink()) {
      throw new Error(`Unsafe release directory symlink: ${releases}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  await mkdir(releases, { recursive: true });
  const info = await lstat(releases);
  const rel = relative(resolve(spec.localRoot), resolve(releases));
  if (info.isSymbolicLink() || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Unsafe release directory: ${releases}`);
  }
  return releases;
}

async function stageReleaseTree(
  spec: ReleaseArchiveSpec,
  commitSha: string,
): Promise<{ staging: string; activated: string }> {
  const releases = await releasesPath(spec);
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
    return { staging, activated };
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
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(spec.localZip)) hash.update(chunk);
  const digest = hash.digest("hex");
  return `local-${digest}`;
}

interface ActivationLockTiming {
  timeoutMs?: number;
  staleMs?: number;
  ownerGraceMs?: number;
  heartbeatMs?: number;
}

export async function withArchiveActivationLock<T>(
  spec: Pick<ReleaseSpec, "localZip">,
  run: () => Promise<T>,
  lockName = ".activation.lock",
  timing: ActivationLockTiming = {},
): Promise<T> {
  const lock = join(dirname(spec.localZip), lockName);
  const owner = randomUUID().replaceAll("-", "");
  const timeoutMs = timing.timeoutMs ?? ACTIVATION_LOCK_TIMEOUT_MS;
  const staleMs = timing.staleMs ?? ACTIVATION_LOCK_STALE_MS;
  const ownerGraceMs = timing.ownerGraceMs ?? ACTIVATION_LOCK_OWNER_GRACE_MS;
  const heartbeatMs = timing.heartbeatMs ?? ACTIVATION_LOCK_HEARTBEAT_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let info;
      try {
        info = await lstat(lock);
      } catch (statErr) {
        if ((statErr as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw statErr;
      }
      if (info.isSymbolicLink()) throw new Error(`Unsafe activation lock symlink: ${lock}`);
      const ownerPath = join(lock, "owner");
      let leaseInfo = info;
      let ownerless = true;
      try {
        leaseInfo = await lstat(ownerPath);
        ownerless = false;
      } catch (ownerErr) {
        if ((ownerErr as NodeJS.ErrnoException).code !== "ENOENT") throw ownerErr;
      }
      const age = Date.now() - leaseInfo.mtimeMs;
      if (
        age > staleMs
        || (ownerless && age > ownerGraceMs)
      ) {
        const quarantine = `${lock}.stale-${randomUUID().replaceAll("-", "")}`;
        try {
          await rename(lock, quarantine);
        } catch (renameErr) {
          if ((renameErr as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw renameErr;
        }
        await rm(quarantine, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for archive activation lock: ${lock}`);
      }
      await delay(50);
    }
  }
  const ownerPath = join(lock, "owner");
  try {
    await writeFile(ownerPath, owner, "utf-8");
  } catch (err) {
    await rm(lock, { recursive: true, force: true });
    throw err;
  }
  const heartbeat = setInterval(() => {
    void readFile(ownerPath, "utf-8")
      .then((currentOwner) => {
        if (currentOwner !== owner) return;
        const now = new Date();
        return utimes(ownerPath, now, now);
      })
      .catch(() => undefined);
  }, heartbeatMs);
  heartbeat.unref();
  try {
    return await run();
  } finally {
    clearInterval(heartbeat);
    let currentOwner: string | null = null;
    try {
      currentOwner = await readFile(ownerPath, "utf-8");
    } catch {
      // A stale-lock successor owns the original path now.
    }
    if (currentOwner === owner) {
      await rm(lock, { recursive: true, force: true });
    }
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

async function pruneReleaseTrees(
  spec: ReleaseArchiveSpec,
  keep: Set<string>,
): Promise<void> {
  try {
    const releases = await releasesPath(spec);
    const cutoff = Date.now() - RELEASE_RETENTION_MS;
    for (const name of await readdir(releases)) {
      const candidate = join(releases, name);
      if (keep.has(candidate)) continue;
      const info = await lstat(candidate);
      if (info.mtimeMs >= cutoff) continue;
      if (info.isDirectory() || info.isSymbolicLink()) {
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
 * while preserving the existing on-disk game data layout.
 */
async function syncReleaseArchiveLocked(
  spec: ReleaseArchiveSpec,
  forceCheck = false,
): Promise<SyncResult> {
  const releaseResult = await syncRelease({
    owner: spec.owner,
    repo: spec.repo,
    assetName: spec.assetName,
    localZip: spec.localZip,
    validateZip: (zipPath) => validateArchiveZip(zipPath, spec.requiredFiles),
    verifyManifest: spec.verifyManifest,
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
  await pruneReleaseTrees(spec, new Set([activeRoot]));
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
    let staging: string | null = null;
    try {
      const activationSha = await archiveActivationSha(spec, releaseResult.commitSha);
      const staged = await stageReleaseTree(spec, activationSha);
      staging = staged.staging;
      const currentMeta = await loadExtractMeta(spec);
      const currentRoot = currentMeta?.dataRoot ?? spec.localRoot;
      if (
        currentMeta?.commitSha === activationSha
        && archiveFilesPresent(spec, currentRoot)
      ) {
        await rm(staged.staging, { recursive: true, force: true });
        staging = null;
        return {
          spec: dummySpec,
          status: "up_to_date",
          commitSha: activationSha,
          error: null,
        };
      }
      await rename(staged.staging, staged.activated);
      staging = null;
      if (dirname(currentRoot) === await releasesPath(spec)) {
        const now = new Date();
        await utimes(currentRoot, now, now);
      }
      await saveExtractMeta(spec, activationSha, staged.activated);
      await pruneReleaseTrees(spec, new Set([currentRoot, staged.activated]));
      return {
        spec: dummySpec,
        status: "updated",
        commitSha: activationSha,
        error: null,
      };
    } catch (err) {
      if (staging !== null) await rm(staging, { recursive: true, force: true });
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

/** Publish and activate one release archive under a shared-volume lock. */
export async function syncReleaseArchive(
  spec: ReleaseArchiveSpec,
  forceCheck = false,
): Promise<SyncResult> {
  const dummySpec: RepoSpec = {
    owner: spec.owner,
    repo: spec.repo,
    branch: "releases",
    files: spec.requiredFiles,
    localRoot: spec.localRoot,
  };
  try {
    await mkdir(dirname(spec.localZip), { recursive: true });
    return await withArchiveActivationLock(
      spec,
      () => syncReleaseArchiveLocked(spec, forceCheck),
    );
  } catch (err) {
    const active = await loadExtractMeta(spec);
    return {
      spec: dummySpec,
      status: archiveFilesPresent(spec, active?.dataRoot ?? spec.localRoot)
        ? "offline_fallback"
        : "no_data",
      commitSha: null,
      error: errorMessage(err),
    };
  }
}

interface GamedataPairMeta {
  commitSha: string;
  excelRoot: string;
  levelsRoot: string;
}

function gamedataPairPath(
  excelSpec: ReleaseArchiveSpec,
  levelsSpec: ReleaseArchiveSpec,
): string {
  const excelParent = dirname(resolve(excelSpec.localRoot));
  const levelsParent = dirname(resolve(levelsSpec.localRoot));
  if (excelParent !== levelsParent) {
    throw new Error("GameData excel and levels roots must share one parent");
  }
  return join(excelParent, GAMEDATA_PAIR_META);
}

async function loadGamedataPair(
  excelSpec: ReleaseArchiveSpec,
  levelsSpec: ReleaseArchiveSpec,
): Promise<GamedataPairMeta | null> {
  try {
    const value = JSON.parse(
      await readFile(gamedataPairPath(excelSpec, levelsSpec), "utf-8"),
    ) as {
      commit_sha?: unknown;
      excel_data_root?: unknown;
      levels_data_root?: unknown;
    };
    if (typeof value.commit_sha !== "string" || value.commit_sha.length === 0) return null;
    if (typeof value.excel_data_root !== "string" || value.excel_data_root.length === 0) return null;
    if (typeof value.levels_data_root !== "string" || value.levels_data_root.length === 0) return null;
    const excelBase = realpathSync(excelSpec.localRoot);
    const levelsBase = realpathSync(levelsSpec.localRoot);
    const excelRoot = realpathSync(resolve(excelBase, value.excel_data_root));
    const levelsRoot = realpathSync(resolve(levelsBase, value.levels_data_root));
    const excelRel = relative(excelBase, excelRoot);
    const levelsRel = relative(levelsBase, levelsRoot);
    if (excelRel === ".." || excelRel.startsWith(`..${sep}`) || isAbsolute(excelRel)) return null;
    if (levelsRel === ".." || levelsRel.startsWith(`..${sep}`) || isAbsolute(levelsRel)) return null;
    if (!archiveFilesPresent(excelSpec, excelRoot)) return null;
    if (!archiveFilesPresent(levelsSpec, levelsRoot)) return null;
    return { commitSha: value.commit_sha, excelRoot, levelsRoot };
  } catch {
    return null;
  }
}

async function saveGamedataPair(
  excelSpec: ReleaseArchiveSpec,
  levelsSpec: ReleaseArchiveSpec,
  commitSha: string,
  excelRoot: string,
  levelsRoot: string,
): Promise<void> {
  const path = gamedataPairPath(excelSpec, levelsSpec);
  const current = await loadGamedataPair(excelSpec, levelsSpec);
  if (
    current?.commitSha === commitSha
    && current.excelRoot === realpathSync(excelRoot)
    && current.levelsRoot === realpathSync(levelsRoot)
  ) return;
  const tmp = join(dirname(path), `.${basename(path)}.${randomUUID().replaceAll("-", "")}.tmp`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmp, JSON.stringify({
    commit_sha: commitSha,
    excel_data_root: relative(excelSpec.localRoot, excelRoot).replaceAll("\\", "/") || ".",
    levels_data_root: relative(levelsSpec.localRoot, levelsRoot).replaceAll("\\", "/") || ".",
  }, null, 2), "utf-8");
  await rename(tmp, path);
}

async function initializeGamedataPair(
  excelSpec: ReleaseArchiveSpec,
  levelsSpec: ReleaseArchiveSpec,
): Promise<void> {
  if (await loadGamedataPair(excelSpec, levelsSpec) !== null) return;
  const excelMeta = await loadExtractMeta(excelSpec);
  const levelsMeta = await loadExtractMeta(levelsSpec);
  const excelRoot = excelMeta?.dataRoot ?? excelSpec.localRoot;
  const levelsRoot = levelsMeta?.dataRoot ?? levelsSpec.localRoot;
  if (!archiveFilesPresent(excelSpec, excelRoot)) return;
  if (!archiveFilesPresent(levelsSpec, levelsRoot)) return;
  const commitSha = excelMeta?.commitSha === levelsMeta?.commitSha
    ? (excelMeta?.commitSha ?? "legacy")
    : "legacy-pair";
  await saveGamedataPair(
    excelSpec,
    levelsSpec,
    commitSha,
    excelRoot,
    levelsRoot,
  );
}

/** Activate GameData Excel and levels as one cross-process visible generation. */
export async function syncReleaseArchivePair(
  excelSpec: ReleaseArchiveSpec,
  levelsSpec: ReleaseArchiveSpec,
  forceCheck = false,
): Promise<readonly [SyncResult, SyncResult]> {
  const pairPath = gamedataPairPath(excelSpec, levelsSpec);
  await mkdir(dirname(pairPath), { recursive: true });
  return withArchiveActivationLock(
    { localZip: join(dirname(pairPath), "gamedata-pair") },
    async () => {
      await initializeGamedataPair(excelSpec, levelsSpec);
      const currentPair = await loadGamedataPair(excelSpec, levelsSpec);
      if (currentPair !== null) {
        const now = new Date();
        await Promise.all([
          utimes(currentPair.excelRoot, now, now).catch(() => undefined),
          utimes(currentPair.levelsRoot, now, now).catch(() => undefined),
        ]);
      }
      const excelResult = await syncReleaseArchive(excelSpec, forceCheck);
      const levelsResult = await syncReleaseArchive(levelsSpec, forceCheck);
      const excelMeta = await loadExtractMeta(excelSpec);
      const levelsMeta = await loadExtractMeta(levelsSpec);
      if (
        excelMeta !== null
        && levelsMeta !== null
        && excelMeta.commitSha === levelsMeta.commitSha
        && archiveFilesPresent(excelSpec, excelMeta.dataRoot)
        && archiveFilesPresent(levelsSpec, levelsMeta.dataRoot)
      ) {
        await saveGamedataPair(
          excelSpec,
          levelsSpec,
          excelMeta.commitSha,
          excelMeta.dataRoot,
          levelsMeta.dataRoot,
        );
      }
      return [excelResult, levelsResult] as const;
    },
    ".gamedata-pair.lock",
  );
}
