/**
 * Process-lifetime, aggregate-only HTTP and session instrumentation.
 *
 * This module deliberately stores no request payloads, tool results, client
 * addresses, or session identifiers.
 */
import type { CacheStats } from "./cacheStats.js";

interface MemoryUsage {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
}

export interface SessionObservation {
  createdAtMs: number;
  lastActivityMs: number;
}

interface ToolCounters {
  total: number;
  inFlight: number;
  durationMsTotal: number;
  durationMsMax: number;
  rssAfterMaxBytes: number;
}

interface RequestToken {
  startedAtNs: bigint;
  toolName?: string;
}

// Tool names are protocol input. Keep this allow-list fixed so an invalid
// caller-supplied name cannot become a retained metric label or grow memory.
const METRIC_TOOL_NAMES = new Set([
  "search_prts",
  "prts_page",
  "get_operator_archives",
  "get_operator_voicelines",
  "get_operator_basic_info",
  "list_story_events",
  "list_stories",
  "read_story",
  "read_activity",
  "search",
  "search_stories",
  "get_story_summary",
  "list_enemies",
  "get_enemy_info",
  "get_stage_enemies",
  "get_enemy_appearances",
  "list_stages",
  "get_stage_info",
  "list_items",
  "get_item_info",
  "get_operator_memoirs",
  "find_character_appearances",
  "find_speakers_in",
  "operator_artwork",
]);

function toolNameFromBody(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const message = body as Record<string, unknown>;
  if (message["method"] !== "tools/call") return undefined;
  const params = message["params"];
  if (typeof params !== "object" || params === null || Array.isArray(params)) return undefined;
  const name = (params as Record<string, unknown>)["name"];
  return typeof name === "string" && METRIC_TOOL_NAMES.has(name) ? name : undefined;
}

function durationMs(startedAtNs: bigint): number {
  return Number(process.hrtime.bigint() - startedAtNs) / 1_000_000;
}

/** Collect aggregate metrics for the Streamable HTTP server lifetime. */
export class RuntimeMetrics {
  private readonly startedAtMs = Date.now();
  private requestsInFlight = 0;
  private requestsTotal = 0;
  private httpErrorsTotal = 0;
  private requestDurationMsTotal = 0;
  private requestDurationMsMax = 0;
  private rssHighWaterBytes = 0;
  private sessionsInitializedTotal = 0;
  private sessionsClosedTotal = 0;
  private sessionsEvictedTotal = 0;
  private readonly tools = new Map<string, ToolCounters>();

  beginRequest(body: unknown): RequestToken {
    this.requestsInFlight += 1;
    const toolName = toolNameFromBody(body);
    if (toolName !== undefined) {
      const counters = this.toolCounters(toolName);
      counters.inFlight += 1;
    }
    return { startedAtNs: process.hrtime.bigint(), toolName };
  }

  finishRequest(token: RequestToken, statusCode: number): void {
    const elapsedMs = durationMs(token.startedAtNs);
    this.requestsInFlight -= 1;
    this.requestsTotal += 1;
    this.requestDurationMsTotal += elapsedMs;
    this.requestDurationMsMax = Math.max(this.requestDurationMsMax, elapsedMs);
    if (statusCode >= 400) this.httpErrorsTotal += 1;

    const memory = process.memoryUsage();
    this.rssHighWaterBytes = Math.max(this.rssHighWaterBytes, memory.rss);
    if (token.toolName !== undefined) {
      const counters = this.toolCounters(token.toolName);
      counters.inFlight -= 1;
      counters.total += 1;
      counters.durationMsTotal += elapsedMs;
      counters.durationMsMax = Math.max(counters.durationMsMax, elapsedMs);
      counters.rssAfterMaxBytes = Math.max(counters.rssAfterMaxBytes, memory.rss);
    }
  }

  sessionInitialized(): void {
    this.sessionsInitializedTotal += 1;
  }

  sessionClosed(): void {
    this.sessionsClosedTotal += 1;
  }

  sessionEvicted(): void {
    this.sessionsEvictedTotal += 1;
  }

  snapshot(
    serverVersion: string,
    idleTimeoutMs: number | null,
    sessions: Iterable<SessionObservation>,
    cache: CacheStats,
  ): Record<string, unknown> {
    const now = Date.now();
    const memory = process.memoryUsage() as MemoryUsage;
    this.rssHighWaterBytes = Math.max(this.rssHighWaterBytes, memory.rss);
    const observedSessions = [...sessions];
    const ages = observedSessions.map((session) => now - session.createdAtMs);
    const idleAges = observedSessions.map((session) => now - session.lastActivityMs);

    return {
      schema_version: "prts-mcp.metrics/v1",
      server: { version: serverVersion, uptime_ms: now - this.startedAtMs },
      process: {
        rss_bytes: memory.rss,
        heap_total_bytes: memory.heapTotal,
        heap_used_bytes: memory.heapUsed,
        external_bytes: memory.external,
        array_buffers_bytes: memory.arrayBuffers,
        rss_high_water_bytes: this.rssHighWaterBytes,
      },
      requests: {
        in_flight: this.requestsInFlight,
        total: this.requestsTotal,
        http_errors_total: this.httpErrorsTotal,
        duration_ms_total: this.requestDurationMsTotal,
        duration_ms_max: this.requestDurationMsMax,
      },
      tool_calls: {
        in_flight: [...this.tools.values()].reduce((total, counters) => total + counters.inFlight, 0),
        total: [...this.tools.values()].reduce((total, counters) => total + counters.total, 0),
        by_name: Object.fromEntries(
          [...this.tools.entries()].map(([name, counters]) => [name, {
            total: counters.total,
            in_flight: counters.inFlight,
            duration_ms_total: counters.durationMsTotal,
            duration_ms_max: counters.durationMsMax,
            rss_after_max_bytes: counters.rssAfterMaxBytes,
          }]),
        ),
      },
      sessions: {
        idle_timeout_ms: idleTimeoutMs,
        active: observedSessions.length,
        oldest_age_ms: ages.length === 0 ? 0 : Math.max(...ages),
        max_idle_age_ms: idleAges.length === 0 ? 0 : Math.max(...idleAges),
        initialized_total: this.sessionsInitializedTotal,
        // Includes idle-evicted sessions; evicted_total is its reason subset.
        closed_total: this.sessionsClosedTotal,
        evicted_total: this.sessionsEvictedTotal,
      },
      cache,
    };
  }

  private toolCounters(name: string): ToolCounters {
    let counters = this.tools.get(name);
    if (counters === undefined) {
      counters = { total: 0, inFlight: 0, durationMsTotal: 0, durationMsMax: 0, rssAfterMaxBytes: 0 };
      this.tools.set(name, counters);
    }
    return counters;
  }
}
