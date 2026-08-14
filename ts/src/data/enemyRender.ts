/**
 * Enemy handbook rendering: the shared card and stats block.
 *
 * Extracted from data/enemy.ts in P3.A — the first render module in the
 * repo, setting the pattern (pure dict → markdown lines; callers join).
 * renderHandbookCard kills the 7-field duplication between renderEnemyInfo
 * and the search card. Mirrors python/src/prts_mcp/data/enemy_render.py.
 *
 * TS-only: renderStatsBlock applies the hasEnemyStatsContent guard
 * (Python has no counterpart — its call sites keep the always-true
 * `if stats:` check; a pre-existing cross-implementation divergence).
 */
import type { EnemyStatsPayload } from "./enemyStats.js";

/** The handbook fields renderHandbookCard reads (both info and search pay). */
export interface HandbookCardFields {
  name: string;
  enemy_id: string;
  enemy_index: string;
  level_label: string;
  description: string;
  attack_type: string;
  ability: string;
  damage_types_label: string;
  enemy_tags: string[];
}

function hasEnemyStatsContent(stats: EnemyStatsPayload): boolean {
  const scalarFields = [
    "max_hp",
    "atk",
    "def",
    "resistance",
    "move_speed",
    "attack_interval",
    "attack_speed",
    "mass_level",
    "hp_recovery_per_sec",
    "life_point_reduce",
  ] as const;
  return scalarFields.some((field) => Boolean(stats[field])) ||
    stats.immunities.length > 0 ||
    stats.skills.length > 0;
}

export function renderHandbookCard(
  entry: HandbookCardFields,
  includeEnemyId = false,
): string[] {
  const lines: string[] = [];
  if (entry.name) {
    lines.push(`# ${entry.name} - 敌人图鉴\n`);
    if (includeEnemyId) lines.push(`- **ID**：${entry.enemy_id}`);
  }

  if (entry.enemy_index) lines.push(`- **编号**：${entry.enemy_index}`);
  if (entry.level_label) lines.push(`- **威胁等级**：${entry.level_label}`);
  if (entry.description) lines.push(`- **描述**：${entry.description}`);
  if (entry.attack_type) lines.push(`- **攻击方式**：${entry.attack_type}`);
  if (entry.ability) lines.push(`- **特殊能力**：${entry.ability}`);
  if (entry.damage_types_label) lines.push(`- **伤害类型**：${entry.damage_types_label}`);
  if (entry.enemy_tags.length > 0) lines.push(`- **标签**：${entry.enemy_tags.join("、")}`);
  return lines;
}

export function renderStatsBlock(stats: EnemyStatsPayload): string[] {
  if (!hasEnemyStatsContent(stats)) return [];
  const lines: string[] = ["## 战斗属性"];
  for (const [field, label] of [
    ["max_hp", "最大生命"],
    ["atk", "攻击力"],
    ["def", "防御力"],
    ["resistance", "法术抗性"],
    ["move_speed", "移动速度"],
    ["attack_interval", "攻击间隔"],
    ["attack_speed", "攻击速度"],
    ["mass_level", "重量等级"],
    ["hp_recovery_per_sec", "每秒生命回复"],
  ] as const) {
    const val = stats[field];
    if (val) lines.push(`- **${label}**：${val}`);
  }
  if (stats.immunities.length > 0) lines.push(`- **免疫**：${stats.immunities.join("、")}`);
  if (stats.life_point_reduce) lines.push(`- **生命值扣除**：${stats.life_point_reduce}`);
  if (stats.skills.length > 0) {
    lines.push("\n## 技能");
    for (const skill of stats.skills) {
      const parts = [`- **${skill.prefab}**`];
      if (skill.timing) parts.push(`（${skill.timing}）`);
      if (skill.blackboard) parts.push(": " + skill.blackboard);
      lines.push(parts.join(""));
    }
  }
  return lines;
}
