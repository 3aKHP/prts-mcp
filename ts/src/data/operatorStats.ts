/**
 * Operator stat-panel (面板数值) reader — character_table phases backed.
 * Mirrors python/src/prts_mcp/data/operator_stats.py. character_table.json
 * carries only two attribute keyframes per elite phase (Lv1 and LvMax);
 * mid-level panels are linearly interpolated between the frames and
 * rounded half away from zero — the community-verified in-game formula.
 * Consumes operator's shared accessors, so the operator domain's caches
 * and activation clearing apply unchanged; no new dataset.
 */
import { hasOperatorData, loadConfig } from "../config.js";
import { excelMissingMessage } from "./messages.js";
import { getCharacterTable, resolveCharId } from "./operator.js";
import { roundHalfAway } from "../utils/numbers.js";

// Curated panel field set (raw key, Chinese label). Booleans and exotic
// combat flags stay out on purpose — this is the in-game status screen.
const PANEL_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ["maxHp", "生命上限"],
  ["atk", "攻击"],
  ["def", "防御"],
  ["magicResistance", "法术抗性"],
  ["cost", "部署费用"],
  ["blockCnt", "阻挡数"],
  ["attackSpeed", "攻击速度"],
  ["baseAttackTime", "攻击间隔（秒）"],
  ["respawnTime", "再部署时间（秒）"],
];

interface AttributeFrame {
  level?: number;
  data?: Record<string, unknown>;
}

interface PhaseEntry {
  maxLevel?: number;
  attributesKeyFrames?: AttributeFrame[];
}

interface FavorFrame {
  level?: number;
  data?: Record<string, unknown>;
}

interface PotentialRank {
  description?: string;
}

interface StatsCharacterEntry {
  phases?: Array<PhaseEntry | null>;
  favorKeyFrames?: Array<FavorFrame | null>;
  potentialRanks?: Array<PotentialRank | null>;
}

export type PanelAttributes = Record<string, number | null>;

export interface OperatorStatsPhasePayload {
  phase: number;
  max_level: number | null;
  keyframes: { lv1: PanelAttributes; lv_max: PanelAttributes };
}

export interface OperatorStatsOverviewPayload {
  name: string;
  char_id: string;
  phases: OperatorStatsPhasePayload[];
  favor_bonus: PanelAttributes;
  potential: string[];
}

export interface OperatorStatsDetailPayload {
  name: string;
  char_id: string;
  phase: number;
  level: number;
  max_level: number;
  attributes: PanelAttributes;
  favor_bonus: PanelAttributes;
  potential: string[];
}

export type OperatorStatsPayload = OperatorStatsOverviewPayload | OperatorStatsDetailPayload;

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function projectPanel(frame: Record<string, unknown>): PanelAttributes {
  const panel: PanelAttributes = {};
  for (const [key] of PANEL_FIELDS) panel[key] = (frame[key] ?? null) as number | null;
  return panel;
}

export function interpolateAttributes(
  lo: Record<string, unknown>,
  hi: Record<string, unknown>,
  level: number,
  loLevel: number,
  hiLevel: number,
): PanelAttributes {
  // Numeric fields interpolate linearly (0 decimals when both frame
  // values are integral, else 2); anything else — including a degenerate
  // frame span — takes the upper frame's value when numeric, else the
  // lower frame's.
  const panel: PanelAttributes = {};
  const span = hiLevel - loLevel;
  for (const [key] of PANEL_FIELDS) {
    const loValue = lo[key];
    const hiValue = hi[key];
    if (span <= 0 || !isNumber(loValue) || !isNumber(hiValue)) {
      panel[key] = isNumber(hiValue) ? hiValue : (isNumber(loValue) ? loValue : null);
      continue;
    }
    const ratio = (level - loLevel) / span;
    const raw = loValue + (hiValue - loValue) * ratio;
    const integral = Number.isInteger(loValue) && Number.isInteger(hiValue);
    panel[key] = integral ? Math.trunc(roundHalfAway(raw, 0)) : roundHalfAway(raw, 2);
  }
  return panel;
}

function favorBonus(info: StatsCharacterEntry): PanelAttributes {
  // Non-zero curated fields of the max-trust keyframe (typically atk/def).
  const frames = (info.favorKeyFrames ?? []).filter(
    (f): f is FavorFrame => typeof f === "object" && f !== null,
  );
  if (frames.length === 0) return {};
  const data = frames[frames.length - 1]!.data ?? {};
  const bonus: PanelAttributes = {};
  for (const [key] of PANEL_FIELDS) {
    const value = data[key];
    if (isNumber(value) && value !== 0) bonus[key] = value;
  }
  return bonus;
}

function potential(info: StatsCharacterEntry): string[] {
  const out: string[] = [];
  for (const rank of info.potentialRanks ?? []) {
    if (typeof rank === "object" && rank !== null && rank.description) out.push(rank.description);
  }
  return out;
}

function phaseSummary(index: number, phase: PhaseEntry): OperatorStatsPhasePayload {
  const frames = (phase.attributesKeyFrames ?? []).filter(
    (f): f is AttributeFrame => typeof f === "object" && f !== null,
  );
  return {
    phase: index,
    max_level: phase.maxLevel ?? null,
    keyframes: {
      lv1: frames.length > 0 ? projectPanel(frames[0]!.data ?? {}) : {},
      lv_max: frames.length > 0 ? projectPanel(frames[frames.length - 1]!.data ?? {}) : {},
    },
  };
}

export function buildOperatorStats(
  name: string,
  phase?: number | null,
  level?: number | null,
): OperatorStatsPayload | string {
  const cfg = loadConfig();
  if (!hasOperatorData(cfg)) return excelMissingMessage("干员")();

  const charId = resolveCharId(name);
  if (charId === null) {
    return `未找到干员 '${name}'。请使用游戏内中文名称（如'阿米娅'）。`;
  }

  const info = (getCharacterTable()[charId] ?? {}) as StatsCharacterEntry;
  const phases = (info.phases ?? []).filter(
    (p): p is PhaseEntry => typeof p === "object" && p !== null,
  );
  if (phases.length === 0) {
    return `干员 '${name}' 暂无面板数据。`;
  }

  const hasPhase = phase !== undefined && phase !== null;
  const hasLevel = level !== undefined && level !== null;
  if (hasPhase !== hasLevel) {
    return "phase 与 level 必须同时提供（如 精英2 Lv40 → phase=2, level=40），或同时省略以查看各阶段关键帧。";
  }

  const favor = favorBonus(info);
  const pots = potential(info);

  if (!hasPhase) {
    return {
      name,
      char_id: charId,
      phases: phases.map((p, i) => phaseSummary(i, p)),
      favor_bonus: favor,
      potential: pots,
    };
  }

  const requestedPhase = phase as number;
  if (!(requestedPhase >= 0 && requestedPhase < phases.length)) {
    return `phase 必须在 0..${phases.length - 1} 之间（该干员共 ${phases.length} 个精英阶段）。`;
  }

  const target = phases[requestedPhase]!;
  const frames = (target.attributesKeyFrames ?? []).filter(
    (f): f is AttributeFrame => typeof f === "object" && f !== null,
  );
  const maxLevel = target.maxLevel ?? 0;
  if (typeof level !== "number" || !(level >= 1 && level <= maxLevel)) {
    return `level 必须在 1..${maxLevel} 之间（精英${requestedPhase} 的等级上限为 ${maxLevel}）。`;
  }

  const lo = frames[0]!;
  const hi = frames[frames.length - 1]!;
  return {
    name,
    char_id: charId,
    phase: requestedPhase,
    level,
    max_level: maxLevel,
    attributes: interpolateAttributes(
      lo.data ?? {},
      hi.data ?? {},
      level,
      lo.level ?? 1,
      hi.level ?? maxLevel,
    ),
    favor_bonus: favor,
    potential: pots,
  };
}

function formatValue(value: number | null): string {
  if (value === null) return "None";
  if (Number.isInteger(value)) return `${value}`;
  return `${value}`;
}

function renderBonus(favor: PanelAttributes, potential: string[]): string[] {
  const lines: string[] = [];
  const labels = new Map(PANEL_FIELDS);
  const favorEntries = Object.entries(favor);
  if (favorEntries.length > 0) {
    const parts = favorEntries.map(([k, v]) => `${labels.get(k) ?? k}+${formatValue(v)}`);
    lines.push(`\n## 满信赖加成\n\n- ${parts.join("，")}`);
  }
  if (potential.length > 0) {
    lines.push("\n## 潜能加成\n\n" + potential.map((p) => `- ${p}`).join("\n"));
  }
  return lines;
}

export function renderOperatorStats(data: OperatorStatsPayload): string {
  const lines: string[] = [`# ${data.name} - 面板数值`];
  const labels = new Map(PANEL_FIELDS);
  if ("attributes" in data) {
    lines.push(`\n**精英${data.phase} Lv${data.level}**（上限 Lv${data.max_level}）\n`);
    for (const [key] of PANEL_FIELDS) {
      lines.push(`- ${labels.get(key)}：${formatValue(data.attributes[key] ?? null)}`);
    }
  } else {
    for (const phase of data.phases) {
      lines.push(`\n## 精英${phase.phase}（Lv1-${formatValue(phase.max_level)}）\n`);
      for (const [key] of PANEL_FIELDS) {
        lines.push(
          `- ${labels.get(key)}：Lv1 ${formatValue(phase.keyframes.lv1[key] ?? null)}` +
            ` / Lv满 ${formatValue(phase.keyframes.lv_max[key] ?? null)}`,
        );
      }
    }
  }
  lines.push(...renderBonus(data.favor_bonus, data.potential));
  return lines.join("\n");
}
