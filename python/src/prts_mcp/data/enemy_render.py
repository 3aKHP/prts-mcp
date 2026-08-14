"""Enemy handbook rendering: the shared card and stats block.

Extracted from ``data/enemy`` in P3.A — the first render module in the repo,
setting the pattern (pure dict → markdown ``list[str]``; callers join).
``render_handbook_card`` kills the 7-field duplication between
``render_enemy_info`` and the search card. The TS mirror is
``ts/src/data/enemyRender.ts`` (which additionally applies the TS-only
``hasEnemyStatsContent`` guard inside ``renderStatsBlock``; Python has no
counterpart — its call sites keep the always-true ``if stats:`` check).
"""
from __future__ import annotations

from typing import Any


def render_handbook_card(entry: dict[str, Any], *, include_enemy_id: bool = False) -> list[str]:
    """Render the shared handbook header fields as markdown lines.

    ``entry`` carries the handbook payload keys (``name``, ``enemy_id``,
    ``enemy_index``, ``level_label``, ``description``, ``attack_type``,
    ``ability``, ``damage_types_label``, ``enemy_tags``); ``stats`` is
    optional and ignored here. ``include_enemy_id`` adds the ``- **ID**``
    line after the heading (the enemy-info renderer wants it; the search
    card does not).
    """
    lines: list[str] = []
    name = entry["name"]
    if name:
        lines.append(f"# {name} - 敌人图鉴\n")
        if include_enemy_id:
            lines.append(f"- **ID**：{entry['enemy_id']}")

    enemy_index = entry["enemy_index"]
    if enemy_index:
        lines.append(f"- **编号**：{enemy_index}")

    level_label = entry["level_label"]
    if level_label:
        lines.append(f"- **威胁等级**：{level_label}")

    desc = entry["description"]
    if desc:
        lines.append(f"- **描述**：{desc}")

    attack = entry["attack_type"]
    if attack:
        lines.append(f"- **攻击方式**：{attack}")

    ability = entry["ability"]
    if ability:
        lines.append(f"- **特殊能力**：{ability}")

    dt_label = entry["damage_types_label"]
    if dt_label:
        lines.append(f"- **伤害类型**：{dt_label}")

    enemy_tags = entry["enemy_tags"]
    if enemy_tags:
        lines.append(f"- **标签**：{'、'.join(enemy_tags)}")

    return lines


def render_stats_block(stats: dict[str, Any]) -> list[str]:
    """Render the ``## 战斗属性`` (+ optional ``## 技能``) section lines."""
    lines: list[str] = []
    # No leading \n here: "\n".join supplies the separator between the
    # handbook block and this section (single newline, matching the old
    # `result += _fmt_stats()` concatenation). The "## 技能" heading below
    # keeps its leading \n to reproduce the original blank line there.
    lines.append("## 战斗属性")
    for field, label in (
        ("max_hp", "最大生命"),
        ("atk", "攻击力"),
        ("def", "防御力"),
        ("resistance", "法术抗性"),
        ("move_speed", "移动速度"),
        ("attack_interval", "攻击间隔"),
        ("attack_speed", "攻击速度"),
        ("mass_level", "重量等级"),
        ("hp_recovery_per_sec", "每秒生命回复"),
    ):
        val = stats.get(field)
        if val:
            lines.append(f"- **{label}**：{val}")
    immunities = stats["immunities"]
    if immunities:
        lines.append(f"- **免疫**：{'、'.join(immunities)}")
    lpr = stats["life_point_reduce"]
    if lpr:
        lines.append(f"- **生命值扣除**：{lpr}")

    skills = stats["skills"]
    if skills:
        lines.append("\n## 技能")
        for s in skills:
            parts = [f"- **{s['prefab']}**"]
            if s["timing"]:
                parts.append(f"（{s['timing']}）")
            if s["blackboard"]:
                parts.append(": " + s["blackboard"])
            lines.append("".join(parts))

    return lines
