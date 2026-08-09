"""PRTS Wiki tool registrations — search, read, sections, categories, links, template.

Split from server.py. Each register_* function receives the MCPServer instance
and attaches the tool handlers.
"""
from __future__ import annotations

import json

from typing import Annotated, Literal

from pydantic import Field

from prts_mcp.api.template_renderer import TemplateRenderError
from prts_mcp.api.prts_wiki import (
    search_prts as _search_prts,
    read_page as _read_page,
    list_sections as _list_sections,
    get_categories as _get_categories,
    get_links as _get_links,
    get_template_data as _get_template_data,
)
from prts_mcp.output import render_result, text_result


async def _build_prts_search(
    query: str,
    limit: int = 5,
    search_mode: str = "text",
    filter_technical: bool = True,
) -> dict | str:
    """Build the structured payload for PRTS keyword search."""
    if search_mode not in ("text", "title"):
        return "无效的 search_mode 参数，可选值：text、title。"
    result = await _search_prts(
        query, limit, search_mode=search_mode, filter_technical=filter_technical,
    )
    return {
        "query": query,
        "search_mode": search_mode,
        "filters": {
            "limit": limit,
            "filter_technical": filter_technical,
        },
        "total": result["totalhits"],
        "results": [
            {
                "title": r["title"],
                "snippet": r["snippet"],
            }
            for r in result["results"]
        ],
    }


def _render_prts_search(data: dict) -> str:
    """Render a PRTS search payload to markdown."""
    query = data["query"]
    results = data["results"]
    if not results:
        return f"未找到与 '{query}' 相关的词条。"
    header = f"# 搜索 \"{query}\"（共 {data['total']} 条匹配）\n"
    parts = []
    for r in results:
        parts.append(f"**{r['title']}**\n{r['snippet']}")
    return header + "\n\n---\n\n".join(parts)


def register_prts_tools(mcp) -> None:  # type: ignore[no-untyped-def]
    """Register the 2 PRTS Wiki tools on the given MCPServer instance."""

    @mcp.tool()
    async def search_prts(
        query: Annotated[str, Field(description="搜索关键词，支持中文，如「罗德岛」、「整合运动」。")],
        limit: Annotated[int, Field(default=5, description="返回结果数量上限，默认 5，最大建议不超过 10。")] = 5,
        search_mode: Annotated[str, Field(default="text", description="搜索模式：text（全文搜索，默认）或 title（仅搜索标题）。")] = "text",
        filter_technical: Annotated[bool, Field(default=True, description="是否过滤 /spine、/data 等技术页面，默认 True。")] = True,
    ) -> object:
        """搜索 PRTS 明日方舟中文维基词条。

        返回匹配词条的标题、简短摘要列表及匹配总数。查询专有名词、干员、关卡或世界观设定
        时先用此工具拿到准确标题，再传入 prts_page 获取完整内容。
        """
        try:
            data = await _build_prts_search(
                query,
                limit,
                search_mode=search_mode,
                filter_technical=filter_technical,
            )
        except Exception as e:
            return text_result(f"搜索 PRTS 失败：{e}")
        if isinstance(data, str):
            return text_result(data)
        return render_result(data, _render_prts_search(data))

    @mcp.tool()
    async def prts_page(
        page_title: Annotated[str, Field(description="词条标题，需与维基页面标题完全一致，如「阿米娅」。建议先用 search_prts 获取准确标题。")],
        action: Annotated[Literal["read", "sections", "categories", "links", "template"], Field(description="操作（必填）：read=读取正文 / sections=章节目录 / categories=分类标签 / links=相关链接 / template=顶层模板的结构化、已渲染字段数据。")],
        section_index: Annotated[int | None, Field(default=None, description="仅 action=read 生效：章节编号（从 action=sections 获取）。不填返回整页。")] = None,
        direction: Annotated[Literal["outbound", "inbound"], Field(default="outbound", description="仅 action=links 生效：outbound（出链，默认）或 inbound（入站）。")] = "outbound",
        limit: Annotated[int, Field(default=30, ge=1, le=100, description="仅 action=links 生效：返回链接数量上限，默认 30。")] = 30,
    ) -> object:
        """读取 PRTS 维基页面的正文或元数据，按 action 分派。

        推荐流程：先用 action="sections" 看目录（每行 `[编号] L层级 标题`，T- 前缀表示模板
        嵌入的节），再用 action="read" + section_index 读特定章节，避免整页过载。其余 action：
        categories 返回分类标签；links 返回相关链接（outbound 出链 / inbound 反向链接）；
        template 返回顶层模板的结构化、已渲染字段数据（如干员 CharinfoV2、敌人 敌人信息/common2、物品 道具信息）。
        """
        try:
            if action == "read":
                return text_result(await _read_page(page_title, section_index=section_index))
            if action == "sections":
                sections = await _list_sections(page_title)
                if not sections:
                    return text_result(f"页面 '{page_title}' 没有章节目录。")
                return text_result(
                    "\n".join(f"[{s['index']}] L{s['level']} {s['line']}" for s in sections)
                )
            if action == "categories":
                cats = await _get_categories(page_title)
                if not cats:
                    return text_result(f"页面 '{page_title}' 没有分类标签。")
                return text_result("\n".join(f"- {c}" for c in cats))
            if action == "links":
                result = await _get_links(page_title, direction=direction, limit=limit)
                links = result["links"]
                if not links:
                    return text_result(
                        f"页面 '{page_title}' 没有{'出站' if direction == 'outbound' else '入站'}链接。"
                    )
                total = result["total"]
                has_more = result["has_more"]
                suffix = f"\n（共 {total} 条，还有更多）" if has_more else f"\n（共 {total} 条）"
                return text_result("\n".join(f"- {ln}" for ln in links) + suffix)
            # action == "template"
            templates = await _get_template_data(page_title)
            if not templates:
                return text_result(f"页面 '{page_title}' 未找到可提取的模板数据。")
            return text_result(json.dumps(templates, ensure_ascii=False, indent=2))
        except TemplateRenderError:
            return text_result('模板字段渲染失败。请改用 action="read" 获取正文。')
        except RuntimeError as e:
            return text_result(str(e))
        except Exception as e:
            return text_result(f"访问 PRTS 页面失败：{e}")
