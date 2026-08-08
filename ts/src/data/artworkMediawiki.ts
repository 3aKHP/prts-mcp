/**
 * LOCAL_IMAGE=false path: filename→label parsing and LRU image cache.
 * Mirrors python/src/prts_mcp/data/artwork_mediawiki.py.
 *
 * Lives in the data layer so artworkTools.ts stays orchestration-only,
 * matching the true-mode boundary (data/images.ts ↔ artworkTools.ts).
 */

const IMAGE_CACHE_MAX_BYTES = 256 * 1024 * 1024; // 256 MiB (#85 §4.2)
const _imageCache = new Map<string, Buffer>();
let _imageCacheTotal = 0;

const MEDIAWIKI_BASE_LABELS: Record<string, string> = {
  "1": "精英零立绘",
  "2": "精英二立绘",
};
export const VARIANT_WIDTH: Record<string, number> = { large: 1024, preview: 256 };

function imageCacheKey(artworkId: string, variant: string): string {
  return `${artworkId}|${variant}`;
}

export function imageCacheGet(artworkId: string, variant: string): Buffer | null {
  const key = imageCacheKey(artworkId, variant);
  const v = _imageCache.get(key);
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

function mediawikiBaseLabel(suffix: string): string {
  const base = suffix.replace(/\+$/, "");
  const plus = suffix.endsWith("+");
  let label = MEDIAWIKI_BASE_LABELS[base];
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
  return name.trim().replaceAll("（", "(").replaceAll("）", ")");
}

/** Check that a MediaWiki artwork belongs to its requested operator. */
export function artworkBelongsToOperator(filename: string, operatorName: string): boolean {
  const artworkOperator = operatorFromFilename(filename);
  if (artworkOperator === null) return false;
  const requested = normalizedOperatorName(operatorName);
  const actual = normalizedOperatorName(artworkOperator);
  if (requested === actual) return true;
  return requested === actual.replace(/\([^()]*\)$/, "");
}
