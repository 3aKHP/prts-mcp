/**
 * Aggregate read-only cache instrumentation from each data domain.
 *
 * The data-module imports populate the dataset registry (registration side
 * effect); their order preserves the historical key order. story_search and
 * artwork_mediawiki are not on the dataset-access contract yet and are read
 * directly.
 */
import { getCacheStats as getOperatorCacheStats } from "./data/operator.js";
import { getCacheStats as getEnemyCacheStats } from "./data/enemy.js";
import { getCacheStats as getStageCacheStats } from "./data/stage.js";
import { getCacheStats as getStageEnemyCacheStats } from "./data/stageEnemy.js";
import { getCacheStats as getItemCacheStats } from "./data/item.js";
import { getCacheStats as getSearchCacheStats } from "./data/search.js";
import { getCacheStats as getStorySearchCacheStats } from "./data/storySearch.js";
import { getCacheStats as getImagesCacheStats } from "./data/images.js";
import { getCacheStats as getArtworkMediawikiCacheStats } from "./data/artworkMediawiki.js";
import { registryStats } from "./data/datasetAccess.js";

export interface CacheStat {
  loaded: boolean;
  count: number;
  hits: number;
  misses: number;
  clears: number;
  bytes?: number;
}

export type CacheStats = Record<string, Record<string, CacheStat>>;

/** Return the stable nine-domain cache projection used by debug endpoints. */
export function getCacheStats(): CacheStats {
  void getOperatorCacheStats; // noqa: side-effect imports below register the domains
  void getEnemyCacheStats;
  void getStageCacheStats;
  void getStageEnemyCacheStats;
  void getItemCacheStats;
  void getSearchCacheStats;
  void getImagesCacheStats;
  return {
    ...registryStats(),
    story_search: getStorySearchCacheStats(),
    artwork_mediawiki: getArtworkMediawikiCacheStats(),
  };
}
