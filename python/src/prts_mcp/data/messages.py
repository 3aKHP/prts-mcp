"""Shared user-facing message builders for gamedata data modules.

Canonical families so every domain renders missing-data and validation
messages identically (the audit found four drifted wording families).
Importable without the dataset-access contract — story modules adopt the
validation helpers too. The TS mirror is ``ts/src/data/messages.ts``.
"""
from __future__ import annotations

from typing import Callable

from prts_mcp.config import Config


def excel_missing_message(label: str) -> Callable[[], str]:
    """Canonical missing-data message for excel-path datasets."""

    def message() -> str:
        config = Config.load()
        return (
            f"{label}数据暂不可用。容器启动时的 auto-sync 可能仍在进行中，请稍后重试；"
            "若持续出现此提示，请检查网络连接或提供 GITHUB_TOKEN 以降低限速风险。"
            f"（当前同步目标路径：{str(config.excel_path)}）"
        )

    return message


def levels_missing_message(label: str) -> Callable[[], str]:
    """Canonical missing-data message for levels-path datasets."""

    def message() -> str:
        config = Config.load()
        return (
            f"{label}数据暂不可用。请等待服务器自动从 GitHub Release 同步 "
            f"zh_CN-levels.zip 完成后重试。（当前同步目标路径：{config.levels_path}）"
        )

    return message


def validate_bounds(
    name: str,
    value: int,
    *,
    minimum: int | None = None,
    maximum: int | None = None,
) -> str | None:
    """Return the canonical violation message, or None when in bounds."""
    if minimum is not None and value < minimum:
        return f"{name} 必须 >= {minimum}。"
    if maximum is not None and value > maximum:
        return f"{name} 必须 <= {maximum}。"
    return None


def regex_error_message(exc: BaseException) -> str:
    return f"正则表达式无效：{exc}"
