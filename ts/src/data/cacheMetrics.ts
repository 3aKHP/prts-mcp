/** Lightweight per-cache counters for read-only observability. */
import type { CacheStat } from "../cacheStats.js";

export class CacheMetrics {
  private hits = 0;
  private misses = 0;
  private clears = 0;

  access(loaded: boolean): void {
    if (loaded) this.hits += 1;
    else this.misses += 1;
  }

  clear(): void {
    this.clears += 1;
  }

  snapshot(loaded: boolean, count: number, bytes?: number): CacheStat {
    return {
      loaded,
      count,
      hits: this.hits,
      misses: this.misses,
      clears: this.clears,
      ...(bytes === undefined ? {} : { bytes }),
    };
  }
}
