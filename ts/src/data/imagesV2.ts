/** Pure v2 validation; mirrors Python data/images_v2.py. */
export const V2_SCHEMA = "akdp-images/v2";
export interface V2Member { bytes: number; sha256: string; group: string }
export interface V2Part { file: string; bytes: number; sha256: string; group: string; members: Record<string, V2Member> }
export interface V2Index {
  schemaVersion: typeof V2_SCHEMA; baselineVersion: string; currentVersion: string;
  previousVersion: string | null; baselineParts: V2Part[]; deltaParts: V2Part[];
  artworks: Record<string, Record<string, unknown>>;
}
function record(v: unknown): Record<string, unknown> | null { return typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null; }
function flat(v: unknown): v is string { return typeof v === "string" && v !== "" && v !== "." && v !== ".." && !/[\/\\\0:]/.test(v); }
function digest(v: unknown): boolean { return typeof v === "string" && /^[0-9a-fA-F]{64}$/.test(v); }
function positive(v: unknown): v is number { return typeof v === "number" && Number.isSafeInteger(v) && v > 0; }
export function parseV2(data: unknown): V2Index | null {
  try {
    const raw = record(data);
    if (!raw || raw.schemaVersion !== V2_SCHEMA || !flat(raw.currentVersion) || !flat(raw.baselineVersion) || raw.baselineVersion > raw.currentVersion) return null;
    if (raw.baselineVersion === raw.currentVersion) {
      if (raw.previousVersion != null || !Array.isArray(raw.deltaParts) || raw.deltaParts.length !== 0) return null;
    } else if (!flat(raw.previousVersion) || raw.previousVersion < raw.baselineVersion || raw.previousVersion >= raw.currentVersion) return null;
    for (const parts of [raw.baselineParts, raw.deltaParts]) {
      if (!Array.isArray(parts) || parts.length > 997) return null;
      const files = new Set<string>(), members = new Set<string>();
      for (const value of parts) {
        const part = record(value);
        if (!part || typeof part.group !== "string" || !flat(part.file) || files.has(part.file) || !positive(part.bytes) || part.bytes >= 2 * 1024**3 || !digest(part.sha256)) return null;
        const map = record(part.members);
        if (!map || Object.keys(map).length === 0) return null;
        files.add(part.file);
        for (const [name, value] of Object.entries(map)) {
          const member = record(value);
          if (!flat(name) || members.has(name) || !member || !positive(member.bytes) || !digest(member.sha256) || member.group !== part.group) return null;
          members.add(name);
        }
      }
    }
    const artworks = record(raw.artworks), names = new Set<string>();
    if (!artworks) return null;
    for (const value of Object.values(artworks)) {
      const artwork = record(value);
      if (!artwork) return null;
      let count = 0;
      for (const tier of ["original", "large", "preview"]) {
        if (!(tier in artwork)) continue;
        const variant = record(artwork[tier]);
        if (!variant || !flat(variant.file) || names.has(variant.file) || !digest(variant.sha256)
            || ![variant.bytes, variant.w, variant.h].every(positive) || !["chararts", "skinpack"].includes(String(artwork.shard))) return null;
        names.add(variant.file); count++;
      }
      if (count === 0) return null;
    }
    return raw as unknown as V2Index;
  } catch { return null; }
}
