/**
 * PRTS Wiki API client with rate limiting.
 * Mirrors python/src/prts_mcp/api/prts_wiki.py.
 */

import {
  PRTS_API_ENDPOINT,
  RATE_LIMIT_INTERVAL,
  USER_AGENT,
} from "../config.js";
import { stripWikitext } from "../utils/sanitizer.js";

// ---------------------------------------------------------------------------
// Rate limiter
// ---------------------------------------------------------------------------

// Tracks the earliest time the next request is allowed to fire.
// Updated immediately (before any await) so concurrent callers each
// reserve a distinct slot — avoiding the check-then-act race.
let nextAllowedTime = 0;

async function rateLimit(): Promise<void> {
  const now = Date.now();
  const intervalMs = RATE_LIMIT_INTERVAL * 1000;
  // Reserve a slot: advance nextAllowedTime by one interval.
  const slot = Math.max(now, nextAllowedTime);
  nextAllowedTime = slot + intervalMs;
  const waitMs = slot - now;
  if (waitMs > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
  }
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

const DEFAULT_HEADERS = { "User-Agent": USER_AGENT };

async function prtsGet(params: Record<string, string | number>): Promise<unknown> {
  await rateLimit();
  const url = new URL(PRTS_API_ENDPOINT);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), {
    headers: DEFAULT_HEADERS,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`PRTS API error: HTTP ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SearchResult {
  title: string;
  snippet: string;
}

/**
 * Search PRTS wiki and return a list of { title, snippet } objects.
 * Mirrors prts_wiki.search_prts().
 */
export async function searchPrts(
  query: string,
  limit = 5
): Promise<SearchResult[]> {
  const data = (await prtsGet({
    action: "query",
    list: "search",
    srsearch: query,
    srlimit: limit,
    format: "json",
  })) as { query?: { search?: Array<{ title: string; snippet: string }> } };

  return (data.query?.search ?? []).map((item) => ({
    title: item.title,
    snippet: stripWikitext(item.snippet ?? ""),
  }));
}

/**
 * Fetch plain-text extract for a PRTS wiki page.
 * Mirrors prts_wiki.read_page().
 */
export async function readPage(title: string): Promise<string> {
  const data = (await prtsGet({
    action: "query",
    titles: title,
    prop: "extracts",
    explaintext: "1",
    format: "json",
  })) as { query?: { pages?: Record<string, { extract?: string }> } };

  const pages = data.query?.pages ?? {};
  for (const page of Object.values(pages)) {
    if (page.extract) return stripWikitext(page.extract);
  }
  return `页面 '${title}' 未找到或内容为空。`;
}
