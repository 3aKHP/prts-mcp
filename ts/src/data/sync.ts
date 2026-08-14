/**
 * GitHub-backed data sync for PRTS-MCP (TypeScript implementation).
 *
 * Mirrors python/src/prts_mcp/data/sync.py. The HTTP transport, release
 * discovery, release-archive activation, and the release state machine now
 * live in the sync/ tier (sync/transport, sync/releaseDiscovery,
 * sync/releaseActivation, sync/release); this module re-exports them so
 * existing `./sync.js` consumers keep resolving, and retains the GameData-pair
 * state machine (syncReleaseArchive / syncReleaseArchivePair), which moves to
 * sync/gamedataPair in P2.B.2.
 */
import { realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

// State-machine symbols the pair code below calls (local bindings) + barrel
// re-exports preserving the `./sync.js` namespace for importers and tests.
import {
  type ReleaseArchiveSpec,
  type RepoSpec,
  type SyncResult,
  errorMessage,
} from "../sync/types.js";
import { type ReleaseSpec } from "../sync/releaseDiscovery.js";
import {
  archiveActivationSha,
  archiveFilesPresent,
  loadExtractMeta,
  pruneReleaseTrees,
  releasesPath,
  saveExtractMeta,
  stageReleaseTree,
  validateArchiveZip,
  withArchiveActivationLock,
} from "../sync/releaseActivation.js";
import { syncRelease } from "../sync/release.js";

export { AssetNotFoundError, fetchCascading, githubHeaders } from "../sync/transport.js";
export {
  type GithubRelease,
  type ReleaseSpec,
  TAG_PREFIX,
  assetUrl,
  checkLatestRelease,
  latestReleaseByPrefix,
  listReleases,
} from "../sync/releaseDiscovery.js";
export {
  type ReleaseArchiveSpec,
  type RepoSpec,
  type SyncStatus,
  type SyncResult,
  errorMessage,
} from "../sync/types.js";
export { safeExtractZip, withArchiveActivationLock } from "../sync/releaseActivation.js";
export {
  DATA_CONTRACT_VERSION,
  downloadReleaseAsset,
  syncRelease,
} from "../sync/release.js";

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

const GAMEDATA_PAIR_META = ".gamedata_pair.json";

// ===========================================================================
// GameData pair state machine — moves to sync/gamedataPair in P2.B.2.
// Calls the relocated release / releaseActivation helpers via the imports
// above (bare-name lookup in this module's namespace).
// ===========================================================================

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
    const path = gamedataPairPath(excelSpec, levelsSpec);
    const pathInfo = await lstat(path);
    if (!pathInfo.isFile() || pathInfo.isSymbolicLink()) return null;
    const value = JSON.parse(
      await readFile(path, "utf-8"),
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
  const pathInfo = await lstat(path).catch(() => null);
  const current = pathInfo?.isFile() && !pathInfo.isSymbolicLink()
    ? await loadGamedataPair(excelSpec, levelsSpec)
    : null;
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
  let commitSha: string;
  let excelRoot: string;
  let levelsRoot: string;
  if (excelMeta === null && levelsMeta === null) {
    commitSha = "legacy";
    excelRoot = excelSpec.localRoot;
    levelsRoot = levelsSpec.localRoot;
  } else if (
    excelMeta !== null
    && levelsMeta !== null
    && excelMeta.commitSha === levelsMeta.commitSha
  ) {
    commitSha = excelMeta.commitSha;
    excelRoot = excelMeta.dataRoot;
    levelsRoot = levelsMeta.dataRoot;
  } else {
    return;
  }
  if (!archiveFilesPresent(excelSpec, excelRoot)) return;
  if (!archiveFilesPresent(levelsSpec, levelsRoot)) return;
  await saveGamedataPair(
    excelSpec,
    levelsSpec,
    commitSha,
    excelRoot,
    levelsRoot,
  );
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
