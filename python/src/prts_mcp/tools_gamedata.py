"""GameData tool registrations — operators, enemies, stages, items, search.

Split from server.py. Covers 12 tools that read local gamedata tables
(via the store abstraction) and format results as markdown text.
"""
from __future__ import annotations

from typing import Annotated, Literal

from pydantic import Field

from prts_mcp.data.operator import (
    get_operator_archives as _get_archives,
    get_operator_voicelines as _get_voicelines,
    get_operator_basic_info as _get_basic_info,
)
from prts_mcp.data.enemy import (
    list_enemies as _list_enemies,
    get_enemy_info as _get_enemy_info,
    search_enemies as _search_enemies,
)
from prts_mcp.data.stage import (
    build_stages_listing as _build_stages_listing,
    render_stages_listing as _render_stages_listing,
    get_stage_info as _get_stage_info,
    search_stages as _search_stages,
)
from prts_mcp.data.item import (
    list_items as _list_items,
    get_item_info as _get_item_info,
    search_items as _search_items,
)
from prts_mcp.data.stage_enemy import (
    get_stage_enemies as _get_stage_enemies,
    get_enemy_appearances as _get_enemy_appearances,
    get_enemy_stage_info as _get_enemy_stage_info,
)
from prts_mcp.data.search import search_operator_data as _search_operator_data
from prts_mcp.output import OUTPUT_CHANNEL, render_result


def register_gamedata_tools(mcp) -> None:  # type: ignore[no-untyped-def]
    """Register the 12 GameData-backed tools on the given FastMCP instance."""

    @mcp.tool()
    async def get_operator_archives(
        name: Annotated[str, Field(description="干员的游戏内中文名，如「阿米娅」、「能天使」。")],
    ) -> str:
        """获取指定干员的档案资料。

        返回干员的客观履历、个人档案（基础档案及解锁档案）等背景故事文本。
        数值信息见 get_operator_basic_info，语音台词见 get_operator_voicelines。
        """
        return _get_archives(name)

    @mcp.tool()
    async def get_operator_voicelines(
        name: Annotated[str, Field(description="干员的游戏内中文名，如「阿米娅」、「能天使」。")],
    ) -> str:
        """获取指定干员的所有语音台词记录。

        返回触发条件（如「交谈1」、「晋升后交谈」、「信赖提升后交谈」）及对应台词文本的
        完整列表。背景故事与客观履历见 get_operator_archives。
        """
        return _get_voicelines(name)

    @mcp.tool()
    async def get_operator_basic_info(
        name: Annotated[str, Field(description="干员的游戏内中文名，如「阿米娅」、「能天使」。")],
    ) -> str:
        """获取指定干员的基本数值信息。

        返回干员的职业、子职业、稀有度（星级）、所属阵营、招募标签、天赋名称及描述等
        结构化信息，适合快速了解干员定位。完整背景故事见 get_operator_archives。
        """
        return _get_basic_info(name)

    @mcp.tool()
    def list_enemies(
        threat_level: Annotated[str | None, Field(default=None, description="按威胁等级过滤：boss（领袖）、elite（精英）、normal（普通）。不填则返回全部。")] = None,
        limit: Annotated[int, Field(default=50, description="返回数量上限，默认 50。")] = 50,
        offset: Annotated[int, Field(default=0, description="分页偏移量，默认 0。")] = 0,
        full: Annotated[bool, Field(default=False, description="返回全部敌人（忽略 limit/offset）。不推荐常规使用，密集输出极易污染上下文。仅在需要完整扫描时使用。")] = False,
    ) -> str:
        """列出敌方图鉴，支持按威胁等级过滤和分页。

        默认返回前 50 条；翻页增大 offset，只看领袖/BOSS 设 threat_level="boss"。
        图鉴共 1500+ 条目，不推荐 full=true。
        """
        return _list_enemies(threat_level=threat_level, limit=limit, offset=offset, full=full)

    @mcp.tool()
    def get_enemy_info(
        name: Annotated[str, Field(description="敌人的游戏内中文名，如「源石虫」、「霜星」。")],
        stage_id: Annotated[str | None, Field(default=None, description="可选关卡 ID；设置后返回该关卡内的敌人等级/覆盖后的战斗属性。")] = None,
    ) -> str:
        """获取指定敌人的详细图鉴资料。

        默认返回威胁等级、描述、攻击方式、伤害类型和特殊能力等图鉴信息。
        提供 stage_id 时改为返回该敌人在指定关卡内的等级与关卡覆盖后的战斗属性。
        """
        if stage_id:
            return _get_enemy_stage_info(name, stage_id)
        return _get_enemy_info(name)

    @mcp.tool()
    def get_stage_enemies(
        stage_id: Annotated[str, Field(description="关卡 ID，如 'main_00-01'（可从 list_stages 获取）。")],
    ) -> str:
        """获取指定关卡实际出场的敌人列表。

        只统计关卡内真正刷出的敌人，并附上其在该关卡等级下的战斗属性。
        反向查询某敌人出现在哪些关卡见 get_enemy_appearances。
        """
        return _get_stage_enemies(stage_id)

    @mcp.tool()
    def get_enemy_appearances(
        name: Annotated[str, Field(description="敌人的游戏内中文名或 enemyId，如「源石虫」或 enemy_1007_slime。")],
        limit: Annotated[int, Field(default=50, description="返回数量上限，默认 50。")] = 50,
        offset: Annotated[int, Field(default=0, description="分页偏移量，默认 0。")] = 0,
    ) -> str:
        """反向查询指定敌人实际出现在哪些关卡。

        只统计该敌人真正刷出的关卡，不计入引用但未实际出场的关卡。
        """
        return _get_enemy_appearances(name, limit=limit, offset=offset)

    @mcp.tool()
    def list_stages(
        chapter: Annotated[str | None, Field(default=None, description="按所属章节（zoneId）过滤，如 'main_0'。不填则返回全部。")] = None,
        type: Annotated[str | None, Field(default=None, description="按关卡类型过滤：MAIN（主线）/ ACTIVITY（活动）/ SUB（支线）/ DAILY（每日）/ CAMPAIGN（剿灭）/ CLIMB_TOWER（爬塔）/ SPECIAL_STORY（特殊故事）/ GUIDE（教程）。不填则返回全部。")] = None,
        limit: Annotated[int, Field(default=50, description="返回数量上限，默认 50。")] = 50,
        offset: Annotated[int, Field(default=0, description="分页偏移量，默认 0。")] = 0,
    ) -> object:
        # Keep the return annotation as object: FastMCP auto-wraps -> str tools
        # into outputSchema={result:string} plus duplicate structuredContent.
        # Explicit CallToolResult delivery requires bypassing that wrapper.
        """列出关卡列表，支持按章节和类型过滤。

        返回格式：每行 `- **关卡名** [类型] 编号 — 难度 — 区域`。
        获取 stage_id 后可传入 get_stage_info 查看详情。
        """
        data = _build_stages_listing(chapter=chapter, type=type, limit=limit, offset=offset)
        if isinstance(data, str):
            # Error / missing-data path: text only, no structuredContent.
            return render_result(None, data, channel=OUTPUT_CHANNEL)
        return render_result(
            data, _render_stages_listing(data), channel=OUTPUT_CHANNEL
        )

    @mcp.tool()
    def get_stage_info(
        stage_id: Annotated[str, Field(description="关卡 ID，如 'main_00-01'（可从 list_stages 获取）。")],
    ) -> str:
        """获取指定关卡的详细信息。

        返回关卡的编号、类型、难度、所属区域、理智消耗、掉落奖励、解锁条件等。
        关卡实际出场的敌人见 get_stage_enemies。
        """
        return _get_stage_info(stage_id)

    @mcp.tool()
    def list_items(
        category: Annotated[str | None, Field(default=None, description="按物品分类过滤，如 MATERIAL（材料）、NORMAL（普通）、CONSUME（消耗品）。不填则返回全部可见物品。")] = None,
        limit: Annotated[int, Field(default=50, description="返回数量上限，默认 50。")] = 50,
        offset: Annotated[int, Field(default=0, description="分页偏移量，默认 0。")] = 0,
    ) -> str:
        """列出物品/材料列表，支持按分类过滤和分页。

        返回每个物品的名称、分类、类型、稀有度、ID 和简短用途，适合查找材料、货币、凭证等。
        """
        return _list_items(category=category, limit=limit, offset=offset)

    @mcp.tool()
    def get_item_info(
        name: Annotated[str, Field(description="物品中文名或 itemId，如「固源岩」、「招聘许可」或 \"30012\"。")],
    ) -> str:
        """获取指定物品/材料的详细信息。

        返回物品的描述、用途、获取方式、掉落关卡、基建产出和商店/凭证关联等。
        """
        return _get_item_info(name)

    @mcp.tool()
    def search(
        scope: Annotated[Literal["operators", "enemies", "stages", "items"], Field(description="搜索域（必填）：operators（干员）/ enemies（敌人）/ stages（关卡）/ items（物品）。")],
        pattern: Annotated[str, Field(description="正则表达式搜索模式，大小写不敏感。")],
        max_results: Annotated[int, Field(default=30, ge=1, le=100, description="返回结果数量上限，默认 30。")] = 30,
    ) -> str:
        """在指定数据域中执行全文正则搜索。

        scope 选择搜索域：operators（名称/属性/档案/语音）、enemies（图鉴）、
        stages（关卡）、items（物品/材料）。返回带域标签的匹配结果。
        剧情台词搜索见 search_stories。
        """
        searchers = {
            "operators": _search_operator_data,
            "enemies": _search_enemies,
            "stages": _search_stages,
            "items": _search_items,
        }
        fn = searchers.get(scope)
        if fn is None:
            return f"不支持的搜索域：{scope!r}。可选：operators、enemies、stages、items。"
        return fn(pattern, max_results=max_results)
