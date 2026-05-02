import type { ReleaseArchiveSpec, ReleaseSpec } from "./sync.js";
import { GAMEDATA_FILES } from "./sync.js";

export const STORYJSON_REQUIRED_FILES = [
  "zh_CN/gamedata/excel/story_review_table.json",
  "zh_CN/storyinfo.json",
] as const;

export interface ReleaseDatasetSpec {
  datasetId: string;
  owner: string;
  repo: string;
  assetName: string;
  requiredFiles: readonly string[];
}

export const GAMEDATA_EXCEL: ReleaseDatasetSpec = {
  datasetId: "gamedata.excel",
  owner: "3aKHP",
  repo: "ArknightsGameData",
  assetName: "zh_CN-excel.zip",
  requiredFiles: GAMEDATA_FILES,
};

export const STORY_ZH_CN: ReleaseDatasetSpec = {
  datasetId: "story.zh_CN",
  owner: "3aKHP",
  repo: "ArknightsStoryJson",
  assetName: "zh_CN.zip",
  requiredFiles: STORYJSON_REQUIRED_FILES,
};

export function releaseSpecForDataset(
  dataset: ReleaseDatasetSpec,
  localZip: string,
): ReleaseSpec {
  return {
    owner: dataset.owner,
    repo: dataset.repo,
    assetName: dataset.assetName,
    localZip,
  };
}

export function archiveSpecForDataset(
  dataset: ReleaseDatasetSpec,
  localZip: string,
  localRoot: string,
): ReleaseArchiveSpec {
  return {
    owner: dataset.owner,
    repo: dataset.repo,
    assetName: dataset.assetName,
    localZip,
    localRoot,
    requiredFiles: dataset.requiredFiles,
  };
}

