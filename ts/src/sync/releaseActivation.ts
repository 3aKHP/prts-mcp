/**
 * Release-archive activation: cross-process lock + generation tree + staging.
 *
 * Mirrors python/src/prts_mcp/sync/release_activation.py. Owns the activation
 * lock that serializes release-tree changes across Python and TypeScript
 * processes, plus the ``.releases/<gen>/`` generation tree, staging,
 * extract-meta pointer, zip validate/extract, and retention prune.
 * data/sync re-exports these during the P2.B migration.
 */
import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  lstat,
  readdir,
  rename,
  rm,
  unlink,
  utimes,
  writeFile,
  readFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import AdmZip from "adm-zip";

import { type ReleaseArchiveSpec, type ReleaseSpec, errorMessage } from "./types.js";

const ACTIVATION_LOCK_TIMEOUT_MS = 120_000;
const ACTIVATION_LOCK_STALE_MS = 30 * 60_000;
const ACTIVATION_LOCK_OWNER_GRACE_MS = 10_000;
const ACTIVATION_LOCK_HEARTBEAT_MS = 60_000;
const RELEASE_RETENTION_MS = 24 * 60 * 60_000;

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

export {
  ACTIVATION_LOCK_HEARTBEAT_MS,
  ACTIVATION_LOCK_OWNER_GRACE_MS,
  ACTIVATION_LOCK_STALE_MS,
  ACTIVATION_LOCK_TIMEOUT_MS,
  RELEASE_RETENTION_MS,
  archiveFilesPresent,
  archiveMissingFiles,
  archiveActivationSha,
  extractMetaPath,
  loadExtractMeta,
  pruneReleaseTrees,
  releasesPath,
  saveExtractMeta,
  stageReleaseTree,
  validateArchiveZip,
};
export type { ExtractMeta, ActivationLockTiming };
