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
// Text cleanup helpers
// ---------------------------------------------------------------------------

const CSS_JS_RE =
  /@(font-face|keyframes|media|import|charset|namespace|supports|page)[^{]*\{[^}]*\}|\(window\.RLQ\s*\|\|\s*\[\]\)\.push\([^)]*\)|<style[^>]*>.*?<\/style>|<script[^>]*>.*?<\/script>/gis;

const HTML_TAG_RE = /<[^>]+>/g;

function unescapeHTMLEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function cleanSnippet(snippet: string): string {
  // Remove JSON key-value fragments from technical data pages
  snippet = snippet.replace(/\s*"[^"]*"\s*:\s*"[^"]*"\s*,?\s*/g, " ");
  // Remove isolated pipe-value artifacts with Chinese keys
  snippet = snippet.replace(/\|[一-鿿\w]+\s*=[^\n]*/g, "");
  snippet = snippet.replace(/#重定向|#REDIRECT/g, "");
  // Collapse whitespace
  snippet = snippet.replace(/[ \t]+/g, " ");
  snippet = snippet.replace(/,{2,}/g, "");
  snippet = snippet.replace(/\n{2,}/g, "\n");
  return snippet.replace(/^[ ,\n]+|[ ,\n]+$/g, "");
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
    srnamespace: 0,
    format: "json",
  })) as { query?: { search?: Array<{ title: string; snippet: string }> } };

  return (data.query?.search ?? []).map((item) => {
    let snippet = stripWikitext(item.snippet ?? "");
    snippet = unescapeHTMLEntities(snippet);
    snippet = cleanSnippet(snippet);
    return { title: item.title, snippet };
  });
}

/**
 * Fetch rendered plain-text content for a PRTS wiki page.
 * Mirrors prts_wiki.read_page().
 */
export async function readPage(title: string): Promise<string> {
  const data = (await prtsGet({
    action: "parse",
    page: title,
    prop: "text",
    format: "json",
  })) as {
    error?: { info?: string };
    parse?: { text?: { "*"?: string } };
  };

  if (data.error?.info) {
    return `页面 '${title}' 未找到或内容为空。`;
  }

  const htmlText = data.parse?.text?.["*"] ?? "";
  if (!htmlText) {
    return `页面 '${title}' 未找到或内容为空。`;
  }

  // Remove CSS rules and inline JS that survive HTML stripping as noise
  let text = htmlText.replace(CSS_JS_RE, "");
  // Strip HTML tags
  text = text.replace(HTML_TAG_RE, "");
  // Decode remaining HTML entities
  text = unescapeHTMLEntities(text);
  // Collapse whitespace
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}
