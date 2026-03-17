from __future__ import annotations

from mcp.server.fastmcp import FastMCP

from prts_mcp.api.prts_wiki import search_prts as _search_prts, read_page as _read_page
from prts_mcp.data.operator import get_operator_archives as _get_archives, get_operator_voicelines as _get_voicelines

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


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
