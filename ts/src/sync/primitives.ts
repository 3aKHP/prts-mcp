/**
 * Shared sync-layer filesystem primitives.
 * Mirrors python/src/prts_mcp/sync/primitives.py.
 *
 * Atomic JSON writes and retention pruning were previously re-implemented
 * per sync module (four tmp+rename copies and two prune variants); they
 * live here once.
 */

import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** Write JSON via tmp-file + atomic rename so readers never see a partial file. */
export async function atomicWriteJson(path: string, data: unknown): Promise<void> {
  const tmp = join(
    dirname(path),
    `.${basename(path)}.${randomUUID().replaceAll("-", "")}.tmp`,
  );
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
  await rename(tmp, path);
}

/**
 * Delete non-kept entries older than the retention window (best-effort).
 * Per-entry stat errors are tolerated and symlinks are removed.
 * `skipHidden` keeps dot-prefixed entries — e.g. the in-flight staging dirs
 * of a concurrent sync in the same release tree.
 */
export async function pruneOldTrees(
  directory: string,
  keep: ReadonlySet<string>,
  retentionMs: number,
  opts: { skipHidden?: boolean } = {},
): Promise<void> {
  const cutoff = Date.now() - retentionMs;
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return;
  }
  for (const name of entries) {
    if (opts.skipHidden && name.startsWith(".")) continue;
    const candidate = join(directory, name);
    if (keep.has(candidate)) continue;
    try {
      const info = await lstat(candidate);
      if (info.mtimeMs >= cutoff) continue;
      if (info.isDirectory() || info.isSymbolicLink()) {
        await rm(candidate, { recursive: true, force: true });
      }
    } catch {
      // best-effort retention cleanup
    }
  }
}
