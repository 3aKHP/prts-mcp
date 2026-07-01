"""PRTS Wiki tool registrations — search, read, sections, categories, links, template.

Split from server.py. Each register_* function receives the FastMCP instance
and attaches the tool handlers.
"""
from __future__ import annotations

import json

from typing import Annotated, Literal

from pydantic import Field

from prts_mcp.api.prts_wiki import (
    search_prts as _search_prts,
    read_page as _read_page,
    list_sections as _list_sections,
    get_categories as _get_categories,
    get_links as _get_links,
    get_template_data as _get_template_data,
)


def register_prts_tools(mcp) -> None:  # type: ignore[no-untyped-def]
    """Register the 2 PRTS Wiki tools on the given FastMCP instance."""

    @mcp.tool()
    async def search_prts(
        query: Annotated[str, Field(description="搜索关键词，支持中文，如「罗德岛」、「整合运动」。")],
        limit: Annotated[int, Field(default=5, description="返回结果数量上限，默认 5，最大建议不超过 10。")] = 5,
        search_mode: Annotated[str, Field(default="text", description="搜索模式：text（全文搜索，默认）或 title（仅搜索标题）。")] = "text",
        filter_technical: Annotated[bool, Field(default=True, description="是否过滤 /spine、/data 等技术页面，默认 True。")] = True,
    ) -> str:
        """搜索 PRTS 明日方舟中文维基词条。

        返回匹配词条的标题和简短摘要列表，含匹配总数。这是探索维基的第一步：当需要查找
        不确定的专有名词、干员、关卡或世界观设定时，先用此工具搜索获取准确
        标题，再将标题传入 prts_page 获取完整内容。
        """
        if search_mode not in ("text", "title"):
            return "无效的 search_mode 参数，可选值：text、title。"
        result = await _search_prts(query, limit, search_mode=search_mode, filter_technical=filter_technical)
        results = result["results"]
        totalhits = result["totalhits"]
        if not results:
            return f"未找到与 '{query}' 相关的词条。"
        header = f"# 搜索 \"{query}\"（共 {totalhits} 条匹配）\n"
        parts = []
        for r in results:
            parts.append(f"**{r['title']}**\n{r['snippet']}")
        return header + "\n\n---\n\n".join(parts)

    @mcp.tool()
    async def prts_page(
        page_title: Annotated[str, Field(description="词条标题，需与维基页面标题完全一致，如「阿米娅」。建议先用 search_prts 获取准确标题。")],
        action: Annotated[Literal["read", "sections", "categories", "links", "template"], Field(description="操作（必填）：read=读取正文 / sections=章节目录 / categories=分类标签 / links=相关链接 / template=结构化模板数据。")],
        section_index: Annotated[int | None, Field(default=None, description="仅 action=read 生效：章节编号（从 action=sections 获取）。不填返回整页。")] = None,
        direction: Annotated[Literal["outbound", "inbound"], Field(default="outbound", description="仅 action=links 生效：outbound（出链，默认）或 inbound（入链）。")] = "outbound",
        limit: Annotated[int, Field(default=30, ge=1, le=100, description="仅 action=links 生效：返回链接数量上限，默认 30。")] = 30,
    ) -> str:
        """读取 PRTS 维基页面的内容或元数据（按 action 分派）。

        推荐流程：先用 action="sections" 看目录（返回 [编号] L层级 标题，T- 前缀表示
        模板嵌入的节），再用 action="read" + section_index 读特定章节，避免整页过载。
        其余 action：categories=分类标签；links=相关链接（outbound 出链 / inbound 反向
        链接，探索维基知识图谱）；template=结构化模板数据（如干员 CharinfoV2、敌人
        敌人信息/common2、物品 道具信息）。先用 search_prts 获取准确标题。
        """
        try:
            if action == "read":
                return await _read_page(page_title, section_index=section_index)
            if action == "sections":
                sections = await _list_sections(page_title)
                if not sections:
                    return f"页面 '{page_title}' 没有章节目录。"
                return "\n".join(f"[{s['index']}] L{s['level']} {s['line']}" for s in sections)
            if action == "categories":
                cats = await _get_categories(page_title)
                if not cats:
                    return f"页面 '{page_title}' 没有分类标签。"
                return "\n".join(f"- {c}" for c in cats)
            if action == "links":
                result = await _get_links(page_title, direction=direction, limit=limit)
                links = result["links"]
                if not links:
                    return f"页面 '{page_title}' 没有{'出站' if direction == 'outbound' else '入站'}链接。"
                total = result["total"]
                has_more = result["has_more"]
                suffix = f"\n（共 {total} 条，还有更多）" if has_more else f"\n（共 {total} 条）"
                return "\n".join(f"- {ln}" for ln in links) + suffix
            # action == "template"
            templates = await _get_template_data(page_title)
            if not templates:
                return f"页面 '{page_title}' 未找到可提取的模板数据。"
            return json.dumps(templates, ensure_ascii=False, indent=2)
        except RuntimeError as e:
            return str(e)
        except Exception as e:
            return f"访问 PRTS 页面失败：{e}"
