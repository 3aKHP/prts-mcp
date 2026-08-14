/**
 * Shared GameData attribute helpers.
 *
 * Holds the mValue unwrap used by enemy stats and stage-enemy level parsing;
 * previously duplicated across enemy.ts and stageEnemy.ts. Mirrors
 * python/src/prts_mcp/data/gamedata_attrs.py.
 */

export interface MValue {
  m_defined?: boolean;
  m_value?: unknown;
}

/** Unwrap {m_defined, m_value} if present, else return as-is. */
export function mValue<T>(obj: unknown, defaultValue: T): T;
export function mValue<T>(obj: unknown, defaultValue?: T): T | undefined;
export function mValue<T>(obj: unknown, defaultValue?: T): T | unknown {
  if (obj && typeof obj === "object" && "m_value" in obj) {
    return (obj as MValue).m_value;
  }
  return obj ?? defaultValue;
}
