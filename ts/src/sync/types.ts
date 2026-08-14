/**
 * Shared sync spec/result types + the errorMessage helper.
 *
 * Mirrors python/src/prts_mcp/sync/_types.py (types) — errorMessage is
 * TS-only (Python uses f-strings). Both live here because errorMessage is
 * consumed by BOTH release and releaseActivation; placing it in either would
 * create a release↔releaseActivation cycle. Re-exported by data/sync.
 */
import type { ReleaseSpec } from "./releaseDiscovery.js";

/** Describes an upstream GitHub repository and the files required from it. */
export interface RepoSpec {
  owner: string;
  repo: string;
  branch: string;
  files: readonly string[];
  /** Absolute path to the local directory where files are written. */
  localRoot: string;
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

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Re-export ReleaseSpec so data/sync's barrel can surface it from one place;
// its canonical home remains releaseDiscovery.
export type { ReleaseSpec };
