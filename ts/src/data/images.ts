/**
 * Image artwork index schema, data loading and label construction.
 * Mirrors python/src/prts_mcp/data/images.py.
 *
 * Consumes the AKDP ``akdp-images/v1`` index.json (frozen schema in
 * arknights-data-pipeline/docs/image-index-schema.md). Semantic labels are
 * joined from ``skin_table.json`` at the consumer side; the index carries no
 * display names, keeping the schema stable across game versions.
 */

import { registerActivationListener } from "../activation.js";
import { loadConfig } from "../config.js";
import type { CacheStat } from "../cacheStats.js";
import { defineDataset, excelStore, type DatasetAccess } from "./datasetAccess.js";

export const SCHEMA_VERSION = "akdp-images/v1";
export const VARIANT_ORDER = ["original", "large", "preview"] as const;
export type VariantName = (typeof VARIANT_ORDER)[number];
export const DEFAULT_VARIANT: VariantName = "large";

// ---------------------------------------------------------------------------
// Index schema types
// ---------------------------------------------------------------------------

export interface VariantMeta {
  file: string;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
}

export interface ArtworkEntry {
  skinId: string;
  kind: string; // "base" | "skin"
  shard: string; // "chararts" | "skinpack"
  sinceVersion: string;
  variants: Partial<Record<VariantName, VariantMeta>>;
}

export interface ImagesIndex {
  schemaVersion: string;
  baselineVersion: string;
  currentVersion: string;
  shards: Record<string, string>;
  artworks: Record<string, ArtworkEntry>;
}

interface RawVariant {
  file?: unknown;
  w?: unknown;
  h?: unknown;
  bytes?: unknown;
  sha256?: unknown;
}

function parseVariant(raw: unknown): VariantMeta | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw as RawVariant;
  if (
    typeof v.file !== "string"
    || typeof v.w !== "number"
    || typeof v.h !== "number"
    || typeof v.bytes !== "number"
    || typeof v.sha256 !== "string"
  ) {
    return null;
  }
  return {
    file: v.file,
    width: v.w,
    height: v.h,
    bytes: v.bytes,
    sha256: v.sha256,
  };
}

/**
 * Parse a raw index.json value. Returns null on schema mismatch.
 *
 * The schema is frozen at ``akdp-images/v1``; an unfamiliar schemaVersion is
 * rejected so a future incompatible index does not silently misparse.
 */
export function parseIndex(data: unknown): ImagesIndex | null {
  if (typeof data !== "object" || data === null) return null;
  const root = data as Record<string, unknown>;
  if (root["schemaVersion"] !== SCHEMA_VERSION) return null;

  const artworks: Record<string, ArtworkEntry> = {};
  const rawArtworks = root["artworks"];
  if (typeof rawArtworks === "object" && rawArtworks !== null) {
    for (const [skinId, entry] of Object.entries(rawArtworks)) {
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry as Record<string, unknown>;
      const variants: Partial<Record<VariantName, VariantMeta>> = {};
      for (const vname of VARIANT_ORDER) {
        const parsed = parseVariant(e[vname]);
        if (parsed !== null) variants[vname] = parsed;
      }
      if (Object.keys(variants).length === 0) continue;
      artworks[skinId] = {
        skinId,
        kind: typeof e["kind"] === "string" ? e["kind"] : "base",
        shard: typeof e["shard"] === "string" ? e["shard"] : "",
        sinceVersion:
          typeof e["sinceVersion"] === "string" ? e["sinceVersion"] : "",
        variants,
      };
    }
  }

  const shards: Record<string, string> = {};
  const rawShards = root["shards"];
  if (typeof rawShards === "object" && rawShards !== null) {
    for (const [k, v] of Object.entries(rawShards)) {
      if (typeof v === "string") shards[k] = v;
    }
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    baselineVersion:
      typeof root["baselineVersion"] === "string" ? root["baselineVersion"] : "",
    currentVersion:
      typeof root["currentVersion"] === "string" ? root["currentVersion"] : "",
    shards,
    artworks,
  };
}

// ---------------------------------------------------------------------------
// skin_table.json loading (charSkins mapping)
// ---------------------------------------------------------------------------

/** Subset of a charSkins entry — only the fields label construction reads. */
export interface CharSkinLike {
  displaySkin?: { skinName?: unknown };
}

function getCharSkinsImpl(): Record<string, CharSkinLike> {
  const ep = loadConfig().effectiveExcelPath;
  if (ep === null) return {};
  const store = excelStore();
  if (!store.exists("skin_table.json")) return {};
  const table = store.readJson<{ charSkins?: unknown }>("skin_table.json");
  return table.charSkins && typeof table.charSkins === "object"
    ? (table.charSkins as Record<string, CharSkinLike>)
    : {};
}

const imagesAccess: DatasetAccess = defineDataset({
  name: "images",
  loaders: {
    char_skins: { load: getCharSkinsImpl, onError: "empty" },
  },
});

const _getCharSkins = imagesAccess.loader<Record<string, CharSkinLike>>("char_skins");

/**
 * Load the ``charSkins`` mapping from ``skin_table.json``.
 *
 * Returns an empty mapping when excel data is unavailable or the file is
 * absent (the bundled fallback does not ship skin_table); callers fall back
 * to skinId-derived labels in that case.
 */
export function getCharSkins(): Record<string, CharSkinLike> {
  return _getCharSkins();
}

export function clearImageCaches(): void {
  imagesAccess.clear();
}

export function getCacheStats(): Record<string, CacheStat> {
  return imagesAccess.stats();
}

registerActivationListener(clearImageCaches);

// ---------------------------------------------------------------------------
// Label construction
// ---------------------------------------------------------------------------

export const BASE_ILLUST_LABELS: Record<string, string> = {
  "1": "精英零立绘",
  "2": "精英二立绘",
};

/**
 * Construct a human-readable label for an artwork ``skinId``.
 *
 * Priority:
 * - ``@`` fashion skins → ``displaySkin.skinName`` (e.g. "报童"); falls back
 *   to a theme-derived placeholder when the skin name is unavailable.
 * - ``#N`` base illusts → programmatic label from the number suffix
 *   (e.g. "精英二立绘"); a ``+`` suffix appends "（变体）".
 * - Unknown shapes → a tolerant fallback using the raw skinId.
 *
 * Labels intentionally omit the operator name: ``operator_artwork`` list is
 * already scoped to one operator, so the label only needs to distinguish
 * that operator's illusts/skins from each other.
 */
export function buildArtworkLabel(
  skinId: string,
  charSkins?: Record<string, CharSkinLike>,
): string {
  const skins = charSkins ?? getCharSkins();
  const entry = skins[skinId];

  // Fashion skin (@): prefer displaySkin.skinName.
  const atIdx = skinId.indexOf("@");
  if (atIdx >= 0) {
    const display = entry?.displaySkin;
    if (display && typeof display.skinName === "string" && display.skinName) {
      return display.skinName;
    }
    const theme = skinId.slice(atIdx + 1).split("#")[0];
    return theme ? `时装（${theme}）` : "时装";
  }

  // Base illust (#N): programmatic label from the number suffix.
  const hashIdx = skinId.indexOf("#");
  const suffix = hashIdx >= 0 ? skinId.slice(hashIdx + 1) : "";
  const baseNum = suffix.replace(/\+$/, "");
  const plus = suffix.endsWith("+");
  let label = BASE_ILLUST_LABELS[baseNum];
  if (label === undefined) {
    label = baseNum ? `立绘 ${baseNum}` : "立绘";
  }
  if (plus) label += "（变体）";
  return label;
}
