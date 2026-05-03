import type { ReleaseArchiveSpec, ReleaseSpec } from "./sync.js";
import { GAMEDATA_FILES } from "./sync.js";
import AdmZip from "adm-zip";

export const STORYJSON_REQUIRED_FILES = [
  "zh_CN/gamedata/excel/story_review_table.json",
  "zh_CN/storyinfo.json",
] as const;
const STORYJSON_REVIEW_TABLE = "zh_CN/gamedata/excel/story_review_table.json";

export interface ReleaseDatasetSpec {
  datasetId: string;
  owner: string;
  repo: string;
  assetName: string;
  requiredFiles: readonly string[];
  validateZip?: (zipPath: string) => string[];
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
  validateZip: validateStoryjsonZip,
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
    validateZip: dataset.validateZip,
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

function missingEntries(zip: AdmZip, requiredFiles: readonly string[]): string[] {
  const names = new Set(zip.getEntries().map((entry) => entry.entryName));
  return requiredFiles.filter((path) => !names.has(path));
}

function storyPath(storyKey: string): string {
  return `zh_CN/gamedata/story/${storyKey}.json`;
}

export function validateStoryjsonZip(zipPath: string): string[] {
  const zip = new AdmZip(zipPath);
  const missing = missingEntries(zip, STORYJSON_REQUIRED_FILES);
  if (missing.includes(STORYJSON_REVIEW_TABLE)) return missing;

  let table: Record<string, { infoUnlockDatas?: Array<{ storyTxt?: string }> }>;
  try {
    const entry = zip.getEntry(STORYJSON_REVIEW_TABLE);
    if (!entry) return missing;
    table = JSON.parse(entry.getData().toString("utf-8")) as typeof table;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return [...missing, `${STORYJSON_REVIEW_TABLE} is unreadable: ${message}`];
  }

  const names = new Set(zip.getEntries().map((entry) => entry.entryName));
  const storyPaths = Object.values(table)
    .flatMap((entry) => entry.infoUnlockDatas ?? [])
    .map((data) => data.storyTxt)
    .filter((storyKey): storyKey is string => Boolean(storyKey))
    .map(storyPath)
    .sort();

  return [...missing, ...storyPaths.filter((path) => !names.has(path))];
}
