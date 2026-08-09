/**
 * PRTS Wiki API client with rate limiting.
 * Mirrors python/src/prts_mcp/api/prts_wiki.py.
 */

import { randomUUID } from "node:crypto";

import {
  PRTS_API_ENDPOINT,
  RATE_LIMIT_INTERVAL,
  USER_AGENT,
} from "../config.js";
import { stripWikitext } from "../utils/sanitizer.js";
import { renderTemplateData, TemplateRenderError } from "./templateRenderer.js";

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

async function prtsPost(params: Record<string, string | number>): Promise<unknown> {
  await rateLimit();
  const res = await fetch(PRTS_API_ENDPOINT, {
    method: "POST",
    headers: { ...DEFAULT_HEADERS, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)])),
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
const REDIRECT_SNIPPET_RE = /#\s*(?:重定向|REDIRECT)/i;

const NAMED_ENTITIES: Record<string, string> = {
  quot: '"', amp: "&", lt: "<", gt: ">", apos: "'", nbsp: " ",
  mdash: "—", ndash: "–", hellip: "…",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  copy: "©", reg: "®", trade: "™",
  times: "×", divide: "÷", plusmn: "±",
  bull: "•", middot: "·", shy: "­",
};

function unescapeHTMLEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-zA-Z]+);/g, (_, name) => NAMED_ENTITIES[name] ?? `&${name};`);
}

function cleanSnippet(snippet: string): string {
  // Remove JSON key-value fragments from technical data pages
  snippet = snippet.replace(/\s*"[^"]*"\s*:\s*"[^"]*"\s*,?\s*/g, " ");
  // Remove isolated pipe-value artifacts with Chinese keys
  snippet = snippet.replace(/\|[一-鿿\w]+\s*=[^\n]*/g, "");
  snippet = snippet.replace(REDIRECT_SNIPPET_RE, "");
  // Collapse whitespace
  snippet = snippet.replace(/[ \t]+/g, " ");
  snippet = snippet.replace(/,{2,}/g, "");
  snippet = snippet.replace(/\n{2,}/g, "\n");
  return snippet.replace(/^[ ,\n]+|[ ,\n]+$/g, "");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TECHNICAL_PAGE_PATTERNS = [
  /\/(?:spine|data|db|lua|json|module)(?:$|[/:._-])/i,
  /\.(?:json|lua)$/i,
  /^(?:Widget|Template|Module|MediaWiki|模块|模板):/i,
];

function isTechnicalPage(title: string): boolean {
  return TECHNICAL_PAGE_PATTERNS.some((p) => p.test(title));
}

function isRedirectLike(snippet: string): boolean {
  return REDIRECT_SNIPPET_RE.test(snippet);
}

async function resolveRedirectTitle(title: string): Promise<string | null> {
  try {
    const data = (await prtsGet({
      action: "query",
      redirects: 1,
      titles: title,
      format: "json",
    })) as {
      query?: {
        redirects?: Array<{ from?: string; to?: string }>;
      };
    };
    for (const item of data.query?.redirects ?? []) {
      if (item.from === title && item.to) return item.to;
    }
  } catch {
    return null;
  }
  return null;
}

function stripHtml(text: string): string {
  let out = text.replace(CSS_JS_RE, "");
  out = out.replace(HTML_TAG_RE, "");
  out = unescapeHTMLEntities(out);
  out = out.replace(/[ \t]+/g, " ");
  out = out.replace(/\n{3,}/g, "\n\n");
  return out.trim();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SearchResult {
  title: string;
  snippet: string;
}

export interface SearchResponse {
  totalHits: number;
  results: SearchResult[];
}

/**
 * Search PRTS wiki.
 * Mirrors prts_wiki.search_prts().
 */
export async function searchPrts(
  query: string,
  limit = 5,
  searchMode: "text" | "title" = "text",
  filterTechnical = true,
): Promise<SearchResponse> {
  const fetchLimit = filterTechnical ? limit * 2 : limit;
  const params: Record<string, string | number> = {
    action: "query",
    list: "search",
    srsearch: query,
    srlimit: fetchLimit,
    srnamespace: 0,
    srinfo: "totalhits",
    srprop: "snippet|redirecttitle",
    format: "json",
  };
  if (searchMode === "title") {
    params.srwhat = "title";
  }
  const data = (await prtsGet(params)) as {
    query?: {
      searchinfo?: { totalhits: number };
      search?: Array<{
        title: string;
        snippet: string;
        redirecttitle?: string;
      }>;
    };
  };
  const totalHits = data.query?.searchinfo?.totalhits ?? 0;
  const results: SearchResult[] = [];
  for (const item of data.query?.search ?? []) {
    let title = item.title;
    const rawSnippet = item.snippet ?? "";
    if (!item.redirecttitle && isRedirectLike(rawSnippet)) {
      title = await resolveRedirectTitle(title) ?? title;
    }
    if (filterTechnical && isTechnicalPage(title)) continue;
    if (results.length >= limit) break;
    let snippet = stripWikitext(rawSnippet);
    snippet = unescapeHTMLEntities(snippet);
    snippet = cleanSnippet(snippet);
    results.push({ title, snippet });
  }
  return { totalHits, results };
}

/**
 * Fetch rendered plain-text content for a PRTS wiki page.
 * Mirrors prts_wiki.read_page().
 */
export async function readPage(
  title: string,
  sectionIndex?: number,
): Promise<string> {
  const params: Record<string, string | number> = {
    action: "parse",
    page: title,
    prop: "text",
    format: "json",
  };
  if (sectionIndex !== undefined) {
    params.section = sectionIndex;
  }
  const data = (await prtsGet(params)) as {
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

  return stripHtml(htmlText);
}

/** Mirrors prts_wiki.list_sections(). */
export async function listSections(
  title: string,
): Promise<Array<{ index: string; level: string; line: string; fromTitle: string }>> {
  const data = (await prtsGet({
    action: "parse",
    page: title,
    prop: "sections",
    format: "json",
  })) as {
    error?: { info?: string };
    parse?: {
      sections?: Array<{
        index: string;
        level: string;
        line: string;
        fromtitle: string;
      }>;
    };
  };

  if (data.error?.info) {
    throw new Error(`页面 '${title}' 未找到。`);
  }

  return (data.parse?.sections ?? []).map((s) => ({
    index: s.index ?? "",
    level: s.level ?? "",
    line: s.line ?? "",
    fromTitle: s.fromtitle ?? "",
  }));
}

/** Mirrors prts_wiki.get_categories(). */
export async function getCategories(title: string): Promise<string[]> {
  const data = (await prtsGet({
    action: "parse",
    page: title,
    prop: "categories",
    format: "json",
  })) as {
    error?: { info?: string };
    parse?: { categories?: Array<{ "*": string }> };
  };

  if (data.error?.info) {
    throw new Error(`页面 '${title}' 未找到。`);
  }

  return (data.parse?.categories ?? []).map((c) => c["*"]);
}

export interface LinksResult {
  title: string;
  links: string[];
  total: number;
  hasMore: boolean;
}

/** Mirrors prts_wiki.get_links(). */
export async function getLinks(
  title: string,
  direction: "outbound" | "inbound" = "outbound",
  limit = 30,
): Promise<LinksResult> {
  if (direction === "outbound") {
    const data = (await prtsGet({
      action: "parse",
      page: title,
      prop: "links",
      format: "json",
    })) as {
      error?: { info?: string };
      parse?: { links?: Array<{ "*": string }> };
    };

    if (data.error?.info) {
      throw new Error(`页面 '${title}' 未找到。`);
    }

    const allLinks = (data.parse?.links ?? []).map((l) => l["*"]);
    return {
      title,
      links: allLinks.slice(0, limit),
      total: allLinks.length,
      hasMore: allLinks.length > limit,
    };
  }

  if (direction !== "inbound") {
    throw new Error(`无效的 direction 参数：${JSON.stringify(direction)}，可选值：outbound、inbound。`);
  }

  // inbound: use list=backlinks
  const data = (await prtsGet({
    action: "query",
    list: "backlinks",
    bltitle: title,
    bllimit: Math.min(limit, 500),
    blnamespace: 0,
    format: "json",
  })) as {
    continue?: unknown;
    query?: { backlinks?: Array<{ title: string }> };
  };

  const backlinks = data.query?.backlinks ?? [];
  const links = backlinks.map((bl) => bl.title);
  return {
    title,
    links: links.slice(0, limit),
    total: links.length,
    hasMore: "continue" in data,
  };
}

async function renderTemplateBatch(title: string, values: string[]): Promise<string[]> {
  if (values.length === 0) return [];

  const prefix = `PRTSMCP_${randomUUID().replaceAll("-", "")}`;
  const markers = values.map((_, index) => [
    `${prefix}_BEGIN_${index}_`,
    `${prefix}_END_${index}_`,
  ] as const);
  const text = values.map((value, index) => {
    const [begin, end] = markers[index]!;
    return `${begin}\n${value}\n${end}`;
  }).join("\n\n");

  let data: unknown;
  try {
    data = await prtsPost({
      action: "parse",
      title,
      text,
      prop: "text",
      format: "json",
    });
  } catch (error) {
    throw new TemplateRenderError("模板字段渲染请求失败。", { cause: error });
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new TemplateRenderError("模板字段渲染响应格式无效。");
  }
  const response = data as { error?: unknown; parse?: unknown };
  if (
    typeof response.error === "object"
    && response.error !== null
    && !Array.isArray(response.error)
    && "info" in response.error
  ) {
    throw new TemplateRenderError("模板字段渲染请求失败。");
  }

  const parse = typeof response.parse === "object" && response.parse !== null && !Array.isArray(response.parse)
    ? response.parse as { text?: unknown }
    : undefined;
  const textNode = typeof parse?.text === "object" && parse.text !== null && !Array.isArray(parse.text)
    ? parse.text as { "*"?: unknown }
    : undefined;
  if (typeof textNode?.["*"] !== "string") {
    throw new TemplateRenderError("模板字段渲染响应格式无效。");
  }

  const rendered = stripHtml(textNode["*"]);
  if (!rendered) throw new TemplateRenderError("模板字段渲染结果为空。");
  return markers.map(([begin, end]) => {
    if (rendered.split(begin).length !== 2 || rendered.split(end).length !== 2) {
      throw new TemplateRenderError("模板字段渲染边界无效。");
    }
    const start = rendered.indexOf(begin) + begin.length;
    const finish = rendered.indexOf(end, start);
    return rendered.slice(start, finish).trim();
  });
}

/** Mirrors prts_wiki.get_template_data(). */
export async function getTemplateData(
  title: string,
): Promise<Record<string, Record<string, unknown>>> {
  const data = (await prtsGet({
    action: "parse",
    page: title,
    prop: "parsetree",
    format: "json",
  })) as {
    error?: { info?: string };
    parse?: { parsetree?: { "*"?: string } };
  };

  if (data.error?.info) {
    throw new Error(`页面 '${title}' 未找到。`);
  }

  const xml = data.parse?.parsetree?.["*"] ?? "";
  if (!xml) {
    throw new Error(`页面 '${title}' 无 parsetree 数据。`);
  }

  return renderTemplateData(title, xml, renderTemplateBatch);
}

// ---------------------------------------------------------------------------
// Image helpers (LOCAL_IMAGE=false MediaWiki fallback)
//
// Mirrors prts_wiki.list_allimages / get_imageinfo / download_image_safe.
// Used by operator_artwork when LOCAL_IMAGE=false to discover File: titles,
// fetch variant URLs, and download pixel data under the full #85 boundary.
// ---------------------------------------------------------------------------

const ALLOWED_IMAGE_HOSTS = ["media.prts.wiki"] as const;
const ALLOWED_IMAGE_MIMES = ["image/png", "image/jpeg", "image/webp"] as const;
const MAX_IMAGE_BYTES = 1024 * 1024; // 1 MiB decoded cap (#85)

export function imageMagicOk(data: Uint8Array, mime: string): boolean {
  if (mime === "image/png") {
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return sig.every((b, i) => data[i] === b);
  }
  if (mime === "image/jpeg") {
    return data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  }
  if (mime === "image/webp") {
    const riff = [0x52, 0x49, 0x46, 0x46];
    const webp = [0x57, 0x45, 0x42, 0x50];
    return riff.every((b, i) => data[i] === b) && webp.every((b, i) => data[i + 8] === b);
  }
  return false;
}

export interface AllimagesEntry {
  name: string;
  size: number;
  mime: string;
}

/** Mirrors prts_wiki.list_allimages(). */
export async function listAllimages(prefix: string, limit = 50): Promise<AllimagesEntry[]> {
  const params: Record<string, string | number> = {
    action: "query",
    list: "allimages",
    aiprefix: prefix,
    ailimit: limit,
    aiprop: "name|size|mime",
    format: "json",
  };
  const results: AllimagesEntry[] = [];
  let pages = 0;
  for (;;) {
    if (++pages > 50) throw new Error("allimages pagination exceeded 50 pages");
    const data = (await prtsGet(params)) as {
      query?: { allimages?: Array<{ name?: string; size?: number; mime?: string }> };
      continue?: Record<string, string>;
    };
    for (const a of data.query?.allimages ?? []) {
      results.push({ name: a.name ?? "", size: a.size ?? 0, mime: a.mime ?? "" });
    }
    const cont = data.continue;
    if (!cont) break;
    Object.assign(params, cont);
  }
  return results;
}

export interface ImageinfoResult {
  url?: string;
  thumburl?: string;
  width?: number;
  height?: number;
  mime?: string;
  size?: number;
}

/** Mirrors prts_wiki.get_imageinfo(). */
export async function getImageinfo(title: string, width?: number): Promise<ImageinfoResult | null> {
  const fullTitle = title.startsWith("File:") ? title : `File:${title}`;
  const params: Record<string, string | number> = {
    action: "query",
    titles: fullTitle,
    prop: "imageinfo",
    iiprop: "url|size|mime",
    format: "json",
  };
  if (width !== undefined) params.iiurlwidth = width;
  const data = (await prtsGet(params)) as {
    query?: { pages?: Record<string, { imageinfo?: Array<Record<string, unknown>> }> };
  };
  for (const page of Object.values(data.query?.pages ?? {})) {
    const ii = page.imageinfo;
    if (ii && ii.length > 0) {
      const info = ii[0];
      return {
        url: info["url"] as string | undefined,
        thumburl: info["thumburl"] as string | undefined,
        width: info["width"] as number | undefined,
        height: info["height"] as number | undefined,
        mime: info["mime"] as string | undefined,
        size: info["size"] as number | undefined,
      };
    }
  }
  return null;
}

/** Mirrors prts_wiki.download_image_safe(). */
export async function downloadImageSafe(url: string): Promise<Uint8Array> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !(ALLOWED_IMAGE_HOSTS as readonly string[]).includes(parsed.hostname)) {
    throw new Error(`image URL host not allowed: ${parsed.hostname}`);
  }
  await rateLimit();
  const res = await fetch(url, {
    headers: DEFAULT_HEADERS,
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`image fetch HTTP ${res.status}`);
  const finalUrl = new URL(res.url);
  if (finalUrl.protocol !== "https:" || !(ALLOWED_IMAGE_HOSTS as readonly string[]).includes(finalUrl.hostname)) {
    throw new Error(`redirected to disallowed URL: ${res.url}`);
  }
  const ctype = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!(ALLOWED_IMAGE_MIMES as readonly string[]).includes(ctype)) {
    throw new Error(`bad content-type: ${JSON.stringify(ctype)}`);
  }
  if (res.body === null) throw new Error("response body is null");
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > MAX_IMAGE_BYTES) {
          throw new Error(`image exceeds ${MAX_IMAGE_BYTES} byte cap`);
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (!imageMagicOk(data, ctype)) {
    throw new Error(`magic bytes mismatch for ${JSON.stringify(ctype)}`);
  }
  return data;
}
