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
