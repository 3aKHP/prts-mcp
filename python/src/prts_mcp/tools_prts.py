"""PRTS Wiki tool registrations — search, read, sections, categories, links, template.

Split from server.py. Each register_* function receives the FastMCP instance
and attaches the tool handlers.
"""
from __future__ import annotations

import json

from typing import Annotated

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
    """Register the 6 PRTS Wiki tools on the given FastMCP instance."""

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
        标题，再将标题传入 read_prts_page 获取完整内容。
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
    async def read_prts_page(
        page_title: Annotated[str, Field(description="词条标题，需与维基页面标题完全一致，如「阿米娅」、「整合运动」。建议通过 search_prts 获取准确标题后再传入。")],
        section_index: Annotated[int | None, Field(default=None, description="可选章节编号（从 list_prts_sections 获取）。不填则返回整页内容；填入编号如 1 则仅返回该节。")] = None,
    ) -> str:
        """读取 PRTS 维基指定词条的纯文本内容。

        返回该词条经过清洗的纯文本，已去除 CSS、HTML 标签和实体，
        内容可能较长。强烈建议先调用 list_prts_sections 查看目录结构，
        再用 section_index 按需读取特定章节，避免整页内容过载。
        不填 section_index 时返回整页。
        """
        return await _read_page(page_title, section_index=section_index)

    @mcp.tool()
    async def list_prts_sections(
        page_title: Annotated[str, Field(description="词条标题，需与维基页面标题完全一致，如「阿米娅」。")],
    ) -> str:
        """列出 PRTS 维基页面的目录（章节列表）。

        返回章节编号、层级和标题，其中以 T- 开头的编号表示该节来自模板嵌入
        （如角色信息框）。获取编号后可传入 read_prts_page 的 section_index
        参数按需读取特定章节，避免一次加载整页内容。
        """
        try:
            sections = await _list_sections(page_title)
        except RuntimeError as e:
            return str(e)
        if not sections:
            return f"页面 '{page_title}' 没有章节目录。"
        lines = []
        for s in sections:
            lines.append(f"[{s['index']}] L{s['level']} {s['line']}")
        return "\n".join(lines)

    @mcp.tool()
    async def get_prts_categories(
        page_title: Annotated[str, Field(description="词条标题，如「阿米娅」、「塔露拉」。")],
    ) -> str:
        """获取 PRTS 维基页面的分类标签。

        返回该页面所属的所有分类，如「干员」「术师干员」「属于罗德岛的干员」。
        可用于理解页面类型和所属体系，辅助导航和发现相关页面。
        """
        try:
            cats = await _get_categories(page_title)
        except RuntimeError as e:
            return str(e)
        if not cats:
            return f"页面 '{page_title}' 没有分类标签。"
        return "\n".join(f"- {c}" for c in cats)

    @mcp.tool()
    async def get_prts_links(
        page_title: Annotated[str, Field(description="词条标题，如「阿米娅」。")],
        direction: Annotated[str, Field(default="outbound", description="链接方向：outbound（页面引用的链接，默认）或 inbound（引用该页面的链接）。")] = "outbound",
        limit: Annotated[int, Field(default=30, description="返回链接数量上限，默认 30。")] = 30,
    ) -> str:
        """获取 PRTS 维基页面的相关链接。

        outbound 返回该页面引用的所有其他词条链接；inbound 返回所有引用了该页面的
        词条链接（反向链接）。可用于探索维基的知识图谱关系。
        """
        if direction not in ("outbound", "inbound"):
            return "无效的 direction 参数，可选值：outbound、inbound。"
        try:
            result = await _get_links(page_title, direction=direction, limit=limit)
        except RuntimeError as e:
            return str(e)
        links = result["links"]
        if not links:
            return f"页面 '{page_title}' 没有{'出站' if direction == 'outbound' else '入站'}链接。"
        total = result["total"]
        has_more = result["has_more"]
        suffix = f"\n（共 {total} 条，还有更多）" if has_more else f"\n（共 {total} 条）"
        return "\n".join(f"- {ln}" for ln in links) + suffix

    @mcp.tool()
    async def get_prts_template(
        page_title: Annotated[str, Field(description="词条标题，如「阿米娅」。")],
    ) -> str:
        """获取 PRTS 维基页面的结构化模板数据。

        提取页面中所有模板调用的键值对，返回按模板名分组的 dict。
        典型模板：干员页面的 CharinfoV2（干员名、稀有度、职业、所属等），
        敌人页面的 敌人信息/common2（名称、地位级别、描述、伤害类型等），
        物品页面的 道具信息（名称、用途、获得方式等）。
        """
        try:
            templates = await _get_template_data(page_title)
        except RuntimeError as e:
            return str(e)
        except Exception as e:
            return f"获取页面 '{page_title}' 的模板数据失败：{e}"
        if not templates:
            return f"页面 '{page_title}' 未找到可提取的模板数据。"

        return json.dumps(templates, ensure_ascii=False, indent=2)
