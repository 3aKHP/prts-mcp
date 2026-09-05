/**
 * GitHub Release discovery: tag-prefix-filtered list / latest / asset_url.
 *
 * Mirrors python/src/prts_mcp/sync/release_discovery.py. Extracted from
 * data/sync (P2.A): the arknights-data-pipeline repo hosts both ``data-*``
 * and ``images-*`` releases, so data sync filters by tag prefix instead of
 * using /releases/latest. data/sync re-exports these and ReleaseSpec during
 * the P2.A→P2.B migration.
 */
import { fetchCascading, githubHeaders } from "./transport.js";

export const TAG_PREFIX = "data-";
const DATAREV_TAG_PREFIX = "datarev-";

// A data versionId is fixed-width "YY-MM-DD-HH-MM-SS_hash", so lexicographic
// order is chronological order and (versionId, revision) tuples order without
// any date parsing.
const VID_RE = /^\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}_[0-9a-f]+$/;
const DATAREV_TAG_RE = /^datarev-(?<vid>.+)-r(?<rev>\d+)$/;
const DATAREV_SUFFIX_RE = /^(?<vid>\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}_[0-9a-f]+)-r(?<rev>\d+)$/;

/** Parsed data release identity: versionId plus publication revision. */
export interface DataTagVersion {
  versionId: string;
  revision: number;
}

/**
 * Parse a data release tag into {versionId, revision}.
 *
 * `data-<versionId>` is a normal release (revision 1);
 * `datarev-<versionId>-r<N>` is an immutable repair revision published by the
 * factory's manual SOP. Anything else (images-*, unknown tags) is not a data
 * release. Mirrors akdp.check.parse_release_tag.
 */
export function parseDataTag(tag: string): DataTagVersion | null {
  const match = DATAREV_TAG_RE.exec(tag);
  if (match?.groups) {
    return { versionId: match.groups.vid, revision: Number(match.groups.rev) };
  }
  if (tag.startsWith(TAG_PREFIX)) {
    return { versionId: tag.slice(TAG_PREFIX.length), revision: 1 };
  }
  return null;
}

/**
 * Strip the data/datarev namespace prefix from a release tag.
 *
 * `data-<vid>` → `<vid>`; `datarev-<vid>-r<N>` → `<vid>-r<N>`. The result is
 * the canonical commitSha persisted in release_meta/extract_meta/
 * .gamedata_pair and shown in logs.
 */
export function tagSuffix(tag: string): string {
  if (tag.startsWith(DATAREV_TAG_PREFIX)) return tag.slice(DATAREV_TAG_PREFIX.length);
  if (tag.startsWith(TAG_PREFIX)) return tag.slice(TAG_PREFIX.length);
  return tag;
}

/**
 * Parse a stored commitSha (tag suffix) into {versionId, revision}.
 *
 * `<vid>-r<N>` (written for datarev releases) → revision N; a bare versionId
 * → revision 1. Sentinel values ("unknown", "legacy", "local-<digest>") and
 * any future format return null so callers fall back to plain string
 * comparison.
 */
export function parseReleaseSuffix(suffix: string): DataTagVersion | null {
  const match = DATAREV_SUFFIX_RE.exec(suffix);
  if (match?.groups) {
    return { versionId: match.groups.vid, revision: Number(match.groups.rev) };
  }
  if (VID_RE.test(suffix)) return { versionId: suffix, revision: 1 };
  return null;
}

function tupleKey(v: DataTagVersion): string {
  return `${v.versionId}\u0000${v.revision}`;
}

/** True when *b* is strictly newer than *a* (tuple order). */
function isNewer(a: DataTagVersion, b: DataTagVersion): boolean {
  if (a.versionId !== b.versionId) return b.versionId > a.versionId;
  return b.revision > a.revision;
}

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

/**
 * List releases page by page until *stop* matches or history runs out.
 *
 * GitHub caps per_page at 100, so a caller that must see releases older
 * than the newest 100 (e.g. images delta-chain enumeration back to the
 * baseline release, #179) paginates until *stop* returns true for a release
 * in the current page or a short page ends the list. Returns null on any
 * network/API failure or when maxPages passes without *stop* matching —
 * fail closed, because the caller cannot prove its history window is
 * complete.
 */
export async function listReleasesPaginated(
  owner: string,
  repo: string,
  stop: (release: GithubRelease) => boolean,
  opts: { maxPages?: number; timeoutMs?: number } = {},
): Promise<GithubRelease[] | null> {
  const maxPages = opts.maxPages ?? 20;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const releases: GithubRelease[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const url =
      `https://api.github.com/repos/${owner}/${repo}/releases?per_page=100&page=${page}`;
    let data: unknown;
    try {
      const res = await fetchCascading(url, { headers: githubHeaders() }, timeoutMs);
      data = await res.json();
    } catch {
      return null;
    }
    if (!Array.isArray(data)) return null;
    releases.push(...(data as GithubRelease[]));
    if (
      data.some((r) => typeof r === "object" && r !== null && stop(r as GithubRelease))
    ) {
      return releases;
    }
    if (data.length < 100) return releases;
  }
  return null;
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

/**
 * Pick the newest data release across the data-/datarev- namespaces.
 *
 * Orders by (versionId, revision) tuple instead of created_at, so a repair
 * revision outranks the release it fixes and a re-published older release
 * can no longer win (rollback-by-republication). Two releases claiming the
 * same tuple is an upstream integrity violation: throw so callers cannot
 * attempt a blind network fallback.
 */
export function latestDataRelease(
  releases: GithubRelease[],
): GithubRelease | null {
  let best: { key: DataTagVersion; release: GithubRelease } | null = null;
  const seen = new Set<string>();
  for (const release of releases) {
    if (release["draft"] || release["prerelease"]) continue;
    const tag = release["tag_name"];
    if (typeof tag !== "string") continue;
    const parsed = parseDataTag(tag);
    if (!parsed) continue;
    const key = tupleKey(parsed);
    if (seen.has(key)) {
      console.warn(
        `[sync] duplicate data release identity (versionId=${parsed.versionId}, `
        + `revision=${parsed.revision}) claimed by "${tag}"; failing closed`,
      );
      throw new Error("duplicate data release identity");
    }
    seen.add(key);
    if (best === null || isNewer(best.key, parsed)) best = { key: parsed, release };
  }
  return best?.release ?? null;
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

/**
 * Return the latest data release tag and asset download URL.
 *
 * Uses the releases list API with tag-prefix filtering instead of
 * ``/releases/latest``, because the data-pipeline repo also hosts
 * ``images-*`` releases that may be promoted to "Latest" on GitHub, and a
 * ``datarev-`` repair revision must outrank the ``data-`` release it fixes
 * even though it is never marked latest. Returns null on network failure or
 * when no matching release/asset is found.
 */
export async function checkLatestRelease(
  spec: ReleaseSpec,
  timeoutMs = 10_000
): Promise<{ tag: string; url: string } | null> {
  const releases = await listReleases(spec.owner, spec.repo, timeoutMs);
  if (releases === null) return null;
  const latest = latestDataRelease(releases);
  if (!latest) return null;
  const tag = latest["tag_name"];
  if (typeof tag !== "string") return null;
  const url = assetUrl(latest, spec.assetName);
  if (!url) return null;
  return { tag, url };
}
