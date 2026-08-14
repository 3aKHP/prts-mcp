/**
 * GitHub-backed data sync for PRTS-MCP (TypeScript implementation).
 *
 * The full sync state machine — HTTP transport, release discovery,
 * release-archive activation, the release state machine, and the GameData-pair
 * state machine — now lives in the ``sync/`` tier. This module is a re-export
 * barrel preserving the `./sync.js` import paths for consumers and tests.
 */
export { AssetNotFoundError, fetchCascading, githubHeaders } from "../sync/transport.js";
export {
  type GithubRelease,
  type ReleaseSpec,
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
export { syncReleaseArchive, syncReleaseArchivePair } from "../sync/gamedataPair.js";

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
