from __future__ import annotations

import logging
import os
import sys
from pathlib import Path

from mcp.server.fastmcp import FastMCP

from prts_mcp.api.prts_wiki import search_prts as _search_prts, read_page as _read_page
from prts_mcp.data.operator import get_operator_archives as _get_archives, get_operator_voicelines as _get_voicelines

logging.basicConfig(
    stream=sys.stderr,
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
_logger = logging.getLogger("prts_mcp.server")

mcp = FastMCP("PRTS_Wiki_Assistant")


@mcp.tool()
async def search_prts(query: str, limit: int = 5) -> str:
    """搜索 PRTS 明日方舟中文维基词条。返回匹配的词条标题和摘要。"""
    results = await _search_prts(query, limit)
    if not results:
        return f"未找到与 '{query}' 相关的词条。"
    parts = []
    for r in results:
        parts.append(f"**{r['title']}**\n{r['snippet']}")
    return "\n\n---\n\n".join(parts)


@mcp.tool()
async def read_prts_page(page_title: str) -> str:
    """读取 PRTS 维基指定词条的纯文本内容。"""
    return await _read_page(page_title)


@mcp.tool()
async def get_operator_archives(operator_name: str) -> str:
    """获取指定干员的档案资料（使用游戏内中文名，如"阿米娅"）。"""
    return _get_archives(operator_name)


@mcp.tool()
async def get_operator_voicelines(operator_name: str) -> str:
    """获取指定干员的语音记录（使用游戏内中文名，如"阿米娅"）。"""
    return _get_voicelines(operator_name)


def _run_startup_sync() -> None:
    """Check upstream GitHub repos and download data files if outdated.

    Skipped when GAMEDATA_PATH is overridden to a non-default location
    (e.g. a read-only Docker volume mount managed by the user).
    """
    from prts_mcp.config import _DEFAULT_GAMEDATA_PATH
    from prts_mcp.data.sync import GAMEDATA_FILES, RepoSpec, sync_all

    override = os.environ.get("GAMEDATA_PATH")
    if override and Path(override).resolve() != _DEFAULT_GAMEDATA_PATH.resolve():
        _logger.info("GAMEDATA_PATH is overridden (%s); skipping auto-sync.", override)
        return

    specs = [
        RepoSpec(
            owner="Kengxxiao",
            repo="ArknightsGameData",
            branch="master",
            files=GAMEDATA_FILES,
            local_root=_DEFAULT_GAMEDATA_PATH,
        )
    ]

    results = sync_all(specs)
    for r in results:
        repo = r.spec.repo
        sha_short = r.commit_sha[:8] if r.commit_sha else "unknown"
        if r.status == "updated":
            _logger.info("Data updated from GitHub (%s @ %s).", repo, sha_short)
        elif r.status == "up_to_date":
            _logger.info("Data is up to date (%s @ %s).", repo, sha_short)
        elif r.status == "offline_fallback":
            _logger.warning(
                "Network unavailable; using cached data (%s @ %s). Error: %s",
                repo,
                sha_short,
                r.error,
            )
        elif r.status == "no_data":
            _logger.warning(
                "No data available for %s. Operator tools will be non-functional. Error: %s",
                repo,
                r.error,
            )


def main() -> None:
    _run_startup_sync()
    mcp.run()


if __name__ == "__main__":
    main()
