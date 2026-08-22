/**
 * LOCAL_IMAGE=false path: MediaWiki artwork backend.
 * Mirrors python/src/prts_mcp/data/artwork_mediawiki.py.
 *
 * Owns filename→label parsing, the LRU image cache, and the two MediaWiki
 * orchestrations (list via allimages + CharinfoV2, get via imageinfo + safe
 * download). Fetches exclusively through the api client (api/prtsWiki.ts);
 * returns string messages or ListOutcome / GetOutcome for the tool layer
 * to wrap.
 */

import { BASE_ILLUST_LABELS, DEFAULT_VARIANT, type VariantName } from "./images.js";
import { CacheMetrics } from "./cacheMetrics.js";
import type { CacheStat } from "../cacheStats.js";
import type { Config } from "../config.js";
import {
  downloadImageSafe,
  getImageinfo,
  getTemplateData,
  listAllimages,
} from "../api/prtsWiki.js";
import { compareIds } from "./sort.js";
import {
  normalizedArtworkFormName,
  renderList,
  type GetOutcome,
  type ListOutcome,
} from "./artworkFormat.js";

const IMAGE_CACHE_MAX_BYTES = 256 * 1024 * 1024; // 256 MiB (#85 §4.2)
const _imageCache = new Map<string, Buffer>();
let _imageCacheTotal = 0;
const imageCacheMetrics = new CacheMetrics();

export const VARIANT_WIDTH: Record<string, number> = { large: 1024, preview: 256 };

function imageCacheKey(artworkId: string, variant: string): string {
  return `${artworkId}|${variant}`;
}

export function imageCacheGet(artworkId: string, variant: string): Buffer | null {
  const key = imageCacheKey(artworkId, variant);
  const v = _imageCache.get(key);
  imageCacheMetrics.access(v !== undefined);
  if (v === undefined) return null;
  _imageCache.delete(key);
  _imageCache.set(key, v); // move to end (LRU)
  return v;
}

export function imageCachePut(artworkId: string, variant: string, data: Buffer): void {
  const key = imageCacheKey(artworkId, variant);
  const existing = _imageCache.get(key);
  if (existing !== undefined) {
    _imageCache.delete(key);
    _imageCacheTotal -= existing.byteLength;
  }
  _imageCache.set(key, data);
  _imageCacheTotal += data.byteLength;
  while (_imageCacheTotal > IMAGE_CACHE_MAX_BYTES && _imageCache.size > 0) {
    const oldest = _imageCache.keys().next().value;
    if (oldest === undefined) break;
    const evicted = _imageCache.get(oldest);
    _imageCache.delete(oldest);
    if (evicted !== undefined) _imageCacheTotal -= evicted.byteLength;
  }
}

export function getCacheStats(): Record<string, CacheStat> {
  return {
    image_cache: imageCacheMetrics.snapshot(_imageCache.size > 0, _imageCache.size, _imageCacheTotal),
  };
}

function mediawikiBaseLabel(suffix: string): string {
  const base = suffix.replace(/\+$/, "");
  const plus = suffix.endsWith("+");
  let label = BASE_ILLUST_LABELS[base];
  if (label === undefined) label = base ? `立绘 ${base}` : "立绘";
  if (plus) label += "（变体）";
  return label;
}

function mediawikiFashionLabel(
  rest: string,
  charinfo: Record<string, unknown>,
): string {
  let num = "";
  for (const ch of rest.slice(4)) {
    if (/[0-9]/.test(ch)) num += ch;
    else break;
  }
  let label: string | null = null;
  if (num) {
    const v = charinfo[`时装${num}名称`];
    if (typeof v === "string" && v) label = v;
  }
  if (label === null) label = num ? `时装 ${num}` : "时装";
  return label;
}

export function labelFromFilename(
  filename: string,
  charinfo: Record<string, unknown>,
): string | null {
  if (!filename.endsWith(".png")) return null;
  const base = filename.slice(0, -4);
  const first = base.indexOf("_");
  const second = base.indexOf("_", first + 1);
  if (first < 0 || second < 0) return null;
  const name = base.slice(first + 1, second);
  const suffix = base.slice(second + 1);
  let form: string | null = null;
  if (name.includes("(")) {
    const b = name.indexOf("(");
    const e = name.indexOf(")", b);
    if (0 <= b && b < e) form = name.slice(b + 1, e);
  }
  let label: string;
  if (suffix.startsWith("skin")) {
    label = mediawikiFashionLabel(suffix, charinfo);
  } else if (suffix.endsWith("b")) {
    return null; // 建筑小人
  } else {
    label = mediawikiBaseLabel(suffix);
  }
  if (form) label += `（${form}）`;
  return label;
}

/** Return the declaring operator segment for a listable MediaWiki artwork. */
export function operatorFromFilename(filename: string): string | null {
  if (!filename.endsWith(".png") || !filename.startsWith("立绘_")) return null;
  if (labelFromFilename(filename, {}) === null) return null;
  const base = filename.slice(0, -4);
  const separator = base.indexOf("_", "立绘_".length);
  if (separator < 0) return null;
  const operatorName = base.slice("立绘_".length, separator);
  return operatorName || null;
}

function normalizedOperatorName(name: string): string {
  // Identical normalization to artworkLocal.normalizedArtworkFormName;
  // kept as a thin alias so ownership checks read locally.
  return normalizedArtworkFormName(name);
}

/** Check that a MediaWiki artwork belongs to its requested operator. */
export function artworkBelongsToOperator(filename: string, operatorName: string): boolean {
  const artworkOperator = operatorFromFilename(filename);
  if (artworkOperator === null) return false;
  const requested = normalizedOperatorName(operatorName);
  const actual = normalizedOperatorName(artworkOperator);
  // artworkId is opaque and list-scoped. A base-name request must not be
  // able to retrieve a transformed form (or vice versa) by reusing a token.
  return requested === actual;
}

export async function listArtworksMediawiki(operatorName: string): Promise<ListOutcome | string> {
  const normalizedName = normalizedArtworkFormName(operatorName);
  const prefix = `立绘_${normalizedName}_`;
  let files: { name: string; size: number; mime: string }[];
  let templates: Record<string, Record<string, unknown>>;
  try {
    files = await listAllimages(prefix);
    templates = await getTemplateData(normalizedName);
  } catch (err) {
    return `查询 PRTS 立绘失败：${err instanceof Error ? err.message : String(err)}`;
  }
  const rawCharinfo = templates["CharinfoV2"];
  const charinfo = rawCharinfo && typeof rawCharinfo === "object"
    ? (rawCharinfo as Record<string, unknown>)
    : {};
  const artworks: Array<{
    artwork_id: string;
    label: string;
    kind: string;
    variants: Record<string, Record<string, never>>;
  }> = [];
  for (const f of files) {
    const label = labelFromFilename(f.name, charinfo);
    if (label === null) continue;
    artworks.push({
      artwork_id: f.name,
      label,
      kind: f.name.includes("skin") ? "skin" : "base",
      variants: { large: {}, preview: {} },
    });
  }
  artworks.sort((a, b) => compareIds(a.artwork_id, b.artwork_id));
  if (artworks.length === 0) {
    return `未找到「${operatorName}」的立绘。建议先用 search_prts 确认名称。`;
  }
  const data = {
    operator_name: operatorName,
    source: "mediawiki",
    total: artworks.length,
    artworks,
  };
  const markdown = renderList(operatorName, artworks);
  return {
    data,
    markdown,
    summary: `「${operatorName}」共 ${artworks.length} 张立绘（PRTS MediaWiki），详见 structuredContent`,
  };
}

export async function getArtworkMediawiki(
  operatorName: string,
  artworkId: string | undefined,
  variant: VariantName | undefined,
  cfg: Config,
): Promise<GetOutcome | string> {
  if (!artworkId) {
    return "action=get 时必须提供 artwork_id。请先用 action=list 获取。";
  }
  if (!artworkBelongsToOperator(artworkId, operatorName)) {
    return (
      `该 artwork_id 不属于干员「${operatorName}」。artwork_id 为不透明 token，请用 action=list 重新获取。`
    );
  }
  if (variant === "original") {
    return (
      "LOCAL_IMAGE=false 模式不提供 original 变体（PRTS 原图常超 1 MiB 安全上限）。请使用 large 或 preview。"
    );
  }
  const chosen: VariantName = variant ?? DEFAULT_VARIANT;
  const width = VARIANT_WIDTH[chosen];
  if (width === undefined) {
    return `不支持的变体：${chosen}。false 模式可选 large / preview。`;
  }
  let info;
  try {
    info = await getImageinfo(artworkId, width);
  } catch (err) {
    return `查询 PRTS 图片信息失败：${err instanceof Error ? err.message : String(err)}`;
  }
  if (info === null) {
    return `找不到文件「${artworkId}」。请用 action=list 重新获取。`;
  }
  const imgUrl = info.thumburl ?? info.url;
  if (!imgUrl) return `「${artworkId}」无 ${chosen} 变体。`;
  let imageBytes: Buffer | null = cfg.prtsImageCache ? imageCacheGet(artworkId, chosen) : null;
  if (imageBytes === null) {
    try {
      imageBytes = Buffer.from(await downloadImageSafe(imgUrl));
    } catch (err) {
      return `下载图片失败：${err instanceof Error ? err.message : String(err)}`;
    }
    if (cfg.prtsImageCache && imageBytes !== null) {
      imageCachePut(artworkId, chosen, imageBytes);
    }
  }
  const imageBase64 = imageBytes.toString("base64");
  // CharinfoV2 is not re-fetched in get (list already provided the precise
  // label); derive a best-effort label from the filename.
  const label = labelFromFilename(artworkId, {}) ?? artworkId;
  const mime = info.mime ?? "image/png";
  const markdown =
    `**${label}**（${operatorName}）\n` +
    `变体：${chosen}｜来源：PRTS MediaWiki\n` +
    `artwork_id：\`${artworkId}\``;
  const data = {
    operator_name: operatorName,
    artwork_id: artworkId,
    label,
    variant: chosen,
    source: "mediawiki",
    width: info.width,
    height: info.height,
    bytes: imageBytes.byteLength,
  };
  return {
    markdown,
    imageB64: imageBase64,
    mime,
    data,
    summary: `${operatorName} 的「${label}」（${chosen}，PRTS MediaWiki）`,
  };
}
