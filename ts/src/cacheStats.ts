/**
 * Aggregate read-only cache instrumentation from each data domain.
 *
 * The data-module imports populate the dataset registry (registration side
 * effect). The projection below uses an EXPLICIT fixed key order — registry
 * insertion order is transitive-import-order-driven and differs between
 * entry points, so it must not leak into the output. story_search and
 * artwork_mediawiki are not on the dataset-access contract yet and are read
 * directly. Mirrors python server.py's debug_cache projection.
 */
import "./data/operator.js";
import "./data/enemy.js";
import "./data/stage.js";
import "./data/stageEnemy.js";
import "./data/item.js";
import "./data/search.js";
import "./data/images.js";
import { getCacheStats as getStorySearchCacheStats } from "./data/storySearch.js";
import { getCacheStats as getArtworkMediawikiCacheStats } from "./data/artworkMediawiki.js";
import { datasetRegistry } from "./data/datasetAccess.js";

export interface CacheStat {
  loaded: boolean;
  count: number;
  hits: number;
  misses: number;
  clears: number;
  bytes?: number;
}

export type CacheStats = Record<string, Record<string, CacheStat>>;

const DOMAIN_ORDER = [
  "operator",
  "enemy",
  "stage",
  "stage_enemy",
  "item",
  "search",
] as const;

/** Return the stable nine-domain cache projection used by debug endpoints. */
export function getCacheStats(): CacheStats {
  const registry = datasetRegistry();
  const out: CacheStats = {};
  for (const name of DOMAIN_ORDER) {
    const access = registry.get(name);
    if (access !== undefined) out[name] = access.stats();
  }
  out["story_search"] = getStorySearchCacheStats();
  const images = registry.get("images");
  if (images !== undefined) out["images"] = images.stats();
  out["artwork_mediawiki"] = getArtworkMediawikiCacheStats();
  return out;
}
