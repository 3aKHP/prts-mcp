"""Operator stat-panel (面板数值) reader — character_table phases backed.

Mirrors ts/src/data/operatorStats.ts. ``character_table.json`` carries
only two attribute keyframes per elite phase (Lv1 and LvMax); mid-level
panels are linearly interpolated between the frames and rounded half away
from zero — the community-verified in-game formula (aceship calculator
et al.). Consumes operator's shared accessors, so the operator domain's
caches and activation clearing apply unchanged; no new dataset.
"""
from __future__ import annotations

from typing import Any

from prts_mcp.config import Config
from prts_mcp.data.messages import excel_missing_message
from prts_mcp.data.operator import _load_character_table, resolve_char_id
from prts_mcp.utils.numbers import round_half_away

# Curated panel field set (raw key, Chinese label). Booleans and exotic
# combat flags stay out on purpose — this is the in-game status screen.
PANEL_FIELDS: tuple[tuple[str, str], ...] = (
    ("maxHp", "生命上限"),
    ("atk", "攻击"),
    ("def", "防御"),
    ("magicResistance", "法术抗性"),
    ("cost", "部署费用"),
    ("blockCnt", "阻挡数"),
    ("attackSpeed", "攻击速度"),
    ("baseAttackTime", "攻击间隔（秒）"),
    ("respawnTime", "再部署时间（秒）"),
)


def _get_config() -> Config:
    return Config.load()


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _project_panel(frame: dict[str, Any]) -> dict[str, Any]:
    """Project one keyframe's raw attribute dict onto the curated fields."""
    return {key: frame.get(key) for key, _label in PANEL_FIELDS}


def interpolate_attributes(
    lo: dict[str, Any],
    hi: dict[str, Any],
    level: int,
    lo_level: int,
    hi_level: int,
) -> dict[str, Any]:
    """Interpolate one panel between two keyframes at ``level``.

    Numeric fields interpolate linearly (0 decimals when both frame
    values are integral, else 2); anything else — including a degenerate
    frame span — takes the upper frame's value when numeric, else the
    lower frame's.
    """
    panel: dict[str, Any] = {}
    span = hi_level - lo_level
    for key, _label in PANEL_FIELDS:
        lo_value, hi_value = lo.get(key), hi.get(key)
        if span <= 0 or not _is_number(lo_value) or not _is_number(hi_value):
            # Non-numeric or malformed fields project as None (TS twin
            # coerces to null) rather than passing raw strings/bools.
            panel[key] = (
                hi_value if _is_number(hi_value)
                else lo_value if _is_number(lo_value)
                else None
            )
            continue
        ratio = (level - lo_level) / span
        raw = float(lo_value) + (float(hi_value) - float(lo_value)) * ratio
        integral = float(lo_value).is_integer() and float(hi_value).is_integer()
        if integral:
            panel[key] = int(round_half_away(raw, 0))
        else:
            panel[key] = round_half_away(raw, 2)
    return panel


def _favor_bonus(info: dict[str, Any]) -> dict[str, Any]:
    """Non-zero curated fields of the max-trust keyframe (typically atk/def)."""
    frames = [f for f in (info.get("favorKeyFrames") or []) if isinstance(f, dict)]
    if not frames:
        return {}
    data = frames[-1].get("data") or {}
    return {
        key: data.get(key)
        for key, _label in PANEL_FIELDS
        if _is_number(data.get(key)) and data.get(key) != 0
    }


def _potential(info: dict[str, Any]) -> list[str]:
    return [
        desc
        for rank in info.get("potentialRanks") or []
        if isinstance(rank, dict) and (desc := rank.get("description"))
    ]


def _phase_summary(index: int, phase: dict[str, Any]) -> dict[str, Any]:
    frames = [f for f in (phase.get("attributesKeyFrames") or []) if isinstance(f, dict)]
    max_level = phase.get("maxLevel")
    # Panels are always fully projected (missing frames → all-None fields)
    # so the renderer can index keys unconditionally, mirroring the TS
    # `?? null` behavior on malformed hand-made data roots.
    lv1 = _project_panel((frames[0].get("data") if frames else None) or {})
    lv_max = _project_panel((frames[-1].get("data") if frames else None) or {})
    return {
        "phase": index,
        "max_level": max_level,
        "keyframes": {"lv1": lv1, "lv_max": lv_max},
    }


def build_operator_stats(
    name: str,
    phase: int | None = None,
    level: int | None = None,
) -> dict | str:
    """Build an operator stat-panel payload, or an error message.

    Without ``phase``/``level`` returns every phase's keyframes plus the
    trust/potential bonuses; with both, returns the interpolated panel at
    exactly that elite phase and level.
    """
    if not _get_config().has_operator_data:
        return excel_missing_message("干员")()

    try:
        char_id = resolve_char_id(name)
        info = (_load_character_table() or {}).get(char_id) or {}
    except (FileNotFoundError, OSError, ValueError) as exc:
        # Corrupt/truncated character_table.json degrades to a message
        # (same family as the skill module).
        return str(exc)
    if char_id is None:
        return f"未找到干员 '{name}'。请使用游戏内中文名称（如'阿米娅'）。"
    phases = [p for p in (info.get("phases") or []) if isinstance(p, dict)]
    if not phases:
        return f"干员 '{name}' 暂无面板数据。"

    if (phase is None) != (level is None):
        return "phase 与 level 必须同时提供（如 精英2 Lv40 → phase=2, level=40），或同时省略以查看各阶段关键帧。"

    favor = _favor_bonus(info)
    potential = _potential(info)

    if phase is None:
        return {
            "name": name,
            "char_id": char_id,
            "phases": [_phase_summary(i, p) for i, p in enumerate(phases)],
            "favor_bonus": favor,
            "potential": potential,
        }

    if not 0 <= phase < len(phases):
        return f"phase 必须在 0..{len(phases) - 1} 之间（该干员共 {len(phases)} 个精英阶段）。"

    target = phases[phase]
    frames = [f for f in (target.get("attributesKeyFrames") or []) if isinstance(f, dict)]
    max_level = target.get("maxLevel") or 0
    if not isinstance(level, int) or isinstance(level, bool) or not 1 <= level <= max_level:
        return f"level 必须在 1..{max_level} 之间（精英{phase} 的等级上限为 {max_level}）。"

    if not frames:
        # Malformed hand-made roots may carry a phase without keyframes;
        # degrade to a message instead of an IndexError (TS twin too).
        return f"干员 '{name}' 的精英{phase}面板关键帧缺失，数据可能损坏。"

    lo, hi = frames[0], frames[-1]
    attributes = interpolate_attributes(
        lo.get("data") or {}, hi.get("data") or {},
        level, lo.get("level") or 1, hi.get("level") or max_level,
    )
    return {
        "name": name,
        "char_id": char_id,
        "phase": phase,
        "level": level,
        "max_level": max_level,
        "attributes": attributes,
        "favor_bonus": favor,
        "potential": potential,
    }


def _format_value(value: Any) -> str:
    if _is_number(value) and float(value).is_integer():
        return str(int(value))
    return str(value)


def _render_bonus(favor: dict[str, Any], potential: list[str]) -> list[str]:
    lines: list[str] = []
    if favor:
        labels = dict(PANEL_FIELDS)
        parts = [f"{labels.get(k, k)}+{_format_value(v)}" for k, v in favor.items()]
        lines.append(f"\n## 满信赖加成\n\n- {'，'.join(parts)}")
    if potential:
        lines.append("\n## 潜能加成\n\n" + "\n".join(f"- {p}" for p in potential))
    return lines


def render_operator_stats(data: dict) -> str:
    """Render an operator stat-panel payload to markdown."""
    lines = [f"# {data['name']} - 面板数值"]
    labels = dict(PANEL_FIELDS)
    if "attributes" in data:
        lines.append(f"\n**精英{data['phase']} Lv{data['level']}**（上限 Lv{data['max_level']}）\n")
        lines.extend(f"- {labels[k]}：{_format_value(v)}" for k, v in data["attributes"].items())
    else:
        for phase in data["phases"]:
            frames = phase["keyframes"]
            lines.append(
                f"\n## 精英{phase['phase']}（Lv1-{_format_value(phase['max_level'])}）\n"
            )
            for key, _label in PANEL_FIELDS:
                lines.append(
                    f"- {labels[key]}：Lv1 {_format_value(frames['lv1'][key])}"
                    f" / Lv满 {_format_value(frames['lv_max'][key])}"
                )
    lines.extend(_render_bonus(data.get("favor_bonus") or {}, data.get("potential") or []))
    return "\n".join(lines)
