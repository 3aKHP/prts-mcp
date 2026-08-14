/**
 * Enemy combat-stats extraction and m_defined override merging.
 *
 * Extracted from data/enemy.ts (extractEnemyStats) and data/stageEnemy.ts
 * (mergeDefined / stageSpecificEnemyData / overwrittenEnemyName /
 * formatStats) in P3.A. Pure dict logic only — no store/config; callers pass
 * the shared dataset accessor's result (levels) so this module stays
 * side-effect-free. Mirrors python/src/prts_mcp/data/enemy_stats.py.
 *
 * NOTE: pythonFloatString / formatNumber / formatFloatLike are TS-only
 * exports with no Python counterpart (Python uses native str()/f-string
 * formatting); they live here because both stat paths consume them.
 */
import { mValue, type MValue } from "./gamedataAttrs.js";

// ---------------------------------------------------------------------------
// enemy_database.json entry shapes (moved from enemy.ts)
// ---------------------------------------------------------------------------

export interface EnemyDbAttrs {
  maxHp?: MValue;
  atk?: MValue;
  def?: MValue;
  magicResistance?: MValue;
  moveSpeed?: MValue;
  baseAttackTime?: MValue;
  attackSpeed?: MValue;
  massLevel?: MValue;
  hpRecoveryPerSec?: MValue;
  spRecoveryPerSec?: MValue;
  lifePointReduce?: MValue;
  stunImmune?: MValue;
  silenceImmune?: MValue;
  sleepImmune?: MValue;
  frozenImmune?: MValue;
  levitateImmune?: MValue;
  disarmedCombatImmune?: MValue;
  fearedImmune?: MValue;
  palsyImmune?: MValue;
  attractImmune?: MValue;
  [key: string]: MValue | undefined;
}

export interface EnemySkill {
  prefabKey?: string;
  priority?: number;
  cooldown?: number;
  initCooldown?: number;
  spData?: { spCost?: MValue };
  blackboard?: Array<{ key?: string; value?: unknown }>;
}

export interface EnemyDbEntry {
  attributes?: EnemyDbAttrs;
  skills?: EnemySkill[] | null;
  talentBlackboard?: Array<{ key?: string; value?: unknown }>;
}

export interface EnemyStatsPayload {
  max_hp: string | null;
  atk: string | null;
  def: string | null;
  resistance: string | null;
  move_speed: string | null;
  attack_interval: string | null;
  attack_speed: string | null;
  mass_level: string | null;
  hp_recovery_per_sec: string | null;
  immunities: string[];
  life_point_reduce: string | null;
  skills: Array<{
    prefab: string;
    timing: string;
    blackboard: string;
  }>;
}

// ---------------------------------------------------------------------------
// TS-only Python-formatting shims
// ---------------------------------------------------------------------------

/** Mimic Python str(float): integers render with a trailing ".0". */
export function pythonFloatString(value: unknown): string {
  if (typeof value === "number" && Number.isInteger(value)) return `${value}.0`;
  return String(value ?? 0);
}

/**
 * Locale-independent thousands separator for ANY number, mirroring Python's
 * unconditional `f"{n:,}"` (the extract path's maxHp formatting).
 */
function withThousands(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Int-gated thousands separator for unknown values, mirroring Python
 * format_stats's `isinstance(hp, int)` gate (the stage-enemies compact path).
 */
export function formatNumber(value: unknown): string {
  if (typeof value === "number" && Number.isInteger(value)) {
    return withThousands(value);
  }
  return String(value ?? 0);
}

// ---------------------------------------------------------------------------
// Stats extraction (moved from enemy.ts)
// ---------------------------------------------------------------------------

const IMMUNITY_LABELS: Record<string, string> = {
  stunImmune: "眩晕",
  silenceImmune: "沉默",
  sleepImmune: "睡眠",
  frozenImmune: "冻结",
  levitateImmune: "浮空",
  disarmedCombatImmune: "缴械",
  fearedImmune: "恐惧",
  palsyImmune: "瘫痪",
  attractImmune: "牵引",
};

export function extractEnemyStats(dbEntry: EnemyDbEntry): EnemyStatsPayload {
  const attrs = dbEntry.attributes ?? {};
  const hp = mValue<number>(attrs.maxHp, 0) ?? 0;
  const atk = mValue<number>(attrs.atk, 0) ?? 0;
  const def = mValue<number>(attrs.def, 0) ?? 0;
  const res = mValue<number>(attrs.magicResistance);
  const speed = mValue<number>(attrs.moveSpeed, 0) ?? 0;
  const atkTime = mValue<number>(attrs.baseAttackTime, 0) ?? 0;
  const atkSpeed = mValue<number>(attrs.attackSpeed, 100) ?? 100;
  const mass = mValue<number>(attrs.massLevel, 0) ?? 0;
  const hpRec = mValue<number>(attrs.hpRecoveryPerSec, 0) ?? 0;
  const lpr = mValue<number>(attrs.lifePointReduce, 0) ?? 0;

  const immunities: string[] = [];
  for (const [key, label] of Object.entries(IMMUNITY_LABELS)) {
    if (mValue<boolean>(attrs[key], false)) immunities.push(label);
  }

  const skills = (Array.isArray(dbEntry.skills) ? dbEntry.skills : []).map((s) => {
    const prefab = s.prefabKey ?? "未知";
    const cd = s.cooldown;
    const initCd = s.initCooldown;
    const spCost = mValue<number>(s.spData?.spCost);
    const cdParts: string[] = [];
    if (cd) cdParts.push(`冷却 ${cd}s`);
    if (initCd && initCd !== cd) cdParts.push(`初始 ${initCd}s`);
    if (spCost) cdParts.push(`SP ${spCost}`);
    const bbStrs = (Array.isArray(s.blackboard) ? s.blackboard : [])
      .slice(0, 6)
      .filter((b) => b.value != null)
      .map((b) => {
        const value = typeof b.value === "number" ? pythonFloatString(b.value) : b.value;
        return `${b.key ?? ""}=${value}`;
      });
    return {
      prefab,
      timing: cdParts.join("，"),
      blackboard: bbStrs.join("，"),
    };
  });

  return {
    max_hp: hp ? withThousands(hp) : null,
    atk: atk ? String(atk) : null,
    def: def ? String(def) : null,
    resistance: res !== undefined && res !== null ? pythonFloatString(res) : null,
    move_speed: speed ? pythonFloatString(speed) : null,
    attack_interval: atkTime ? `${pythonFloatString(atkTime)}s` : null,
    attack_speed: atkSpeed !== 100 ? pythonFloatString(atkSpeed) : null,
    mass_level: mass ? String(mass) : null,
    hp_recovery_per_sec: hpRec ? pythonFloatString(hpRec) : null,
    immunities,
    life_point_reduce: lpr ? String(lpr) : null,
    skills,
  };
}

// ---------------------------------------------------------------------------
// m_defined override merging (moved from stageEnemy.ts)
// ---------------------------------------------------------------------------

export function mergeDefined(base: unknown, override: unknown): unknown {
  if (!override || typeof override !== "object") return base;
  const overrideRecord = override as Record<string, unknown>;
  if ("m_defined" in overrideRecord && "m_value" in overrideRecord) {
    return overrideRecord["m_defined"] ? overrideRecord["m_value"] : base;
  }
  const merged: Record<string, unknown> =
    base && typeof base === "object" && !Array.isArray(base)
      ? { ...(base as Record<string, unknown>) }
      : {};
  for (const [key, value] of Object.entries(overrideRecord)) {
    if (value && typeof value === "object" && (value as MValue).m_defined === false) continue;
    merged[key] = mergeDefined(merged[key], value);
  }
  return merged;
}

/** Resolve the effective enemyData for one enemy at one stage level. */
export function stageSpecificEnemyData(
  levels: Record<string, Record<number, unknown>> | null | undefined,
  enemyId: string,
  level: number,
  overwritten?: unknown,
): Record<string, unknown> | null {
  const dbEntry = (levels ?? {})[enemyId] ?? {};
  const base = dbEntry[level] ?? dbEntry[0];
  if (!base) return overwritten && typeof overwritten === "object" ? overwritten as Record<string, unknown> : null;
  const merged = mergeDefined(base, overwritten);
  return merged && typeof merged === "object" ? merged as Record<string, unknown> : base as Record<string, unknown>;
}

export function overwrittenEnemyName(overwritten: unknown): string | null {
  if (!overwritten || typeof overwritten !== "object") return null;
  const record = overwritten as Record<string, unknown>;
  const name = record.name ?? record.prefabKey;
  const value = mValue(name);
  return value ? String(value) : null;
}

/** One-line compact stat summary for stage-enemies listings. */
export function formatStats(
  enemyData: { attributes?: EnemyDbAttrs | Record<string, unknown> } | null,
): string {
  if (!enemyData) return "无数据库记录";
  const attrs = (enemyData.attributes ?? {}) as Record<string, unknown>;
  const hp = mValue(attrs.maxHp, 0);
  const atk = mValue(attrs.atk, 0);
  const defense = mValue(attrs.def, 0);
  const res = mValue(attrs.magicResistance, 0);
  const speed = mValue(attrs.moveSpeed, 0);
  const atkTime = mValue(attrs.baseAttackTime, 0);
  const parts = [`HP ${formatNumber(hp)}`, `ATK ${atk}`, `DEF ${defense}`, `RES ${res}`];
  if (speed) parts.push(`移速 ${pythonFloatString(speed)}`);
  if (atkTime) parts.push(`攻击间隔 ${pythonFloatString(atkTime)}s`);
  return parts.join("；");
}
