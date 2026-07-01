"""GameData tool registrations — operators, enemies, stages, items, search.

Split from server.py. Covers 16 tools that read local gamedata tables
(via the store abstraction) and format results as markdown text.
"""
from __future__ import annotations

from typing import Annotated

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
    list_stages as _list_stages,
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


def register_gamedata_tools(mcp) -> None:  # type: ignore[no-untyped-def]
    """Register the 16 GameData-backed tools on the given FastMCP instance."""

    @mcp.tool()
    async def get_operator_archives(
        name: Annotated[str, Field(description="干员的游戏内中文名，如「阿米娅」、「能天使」。")],
    ) -> str:
        """获取指定干员的档案资料。

        返回干员的客观履历、个人档案（基础档案及解锁档案）等背景故事文本。
        若需查询干员的职业、稀有度等数值信息，请使用 get_operator_basic_info；
        若需查询语音台词，请使用 get_operator_voicelines。
        """
        return _get_archives(name)

    @mcp.tool()
    async def get_operator_voicelines(
        name: Annotated[str, Field(description="干员的游戏内中文名，如「阿米娅」、「能天使」。")],
    ) -> str:
        """获取指定干员的所有语音台词记录。

        返回包含触发条件（如「交谈1」、「晋升后交谈」、「信赖提升后交谈」）及对应
        台词文本的完整列表。此工具仅返回语音文本；若需查询干员背景故事或客观
        履历，请使用 get_operator_archives。
        """
        return _get_voicelines(name)

    @mcp.tool()
    async def get_operator_basic_info(
        name: Annotated[str, Field(description="干员的游戏内中文名，如「阿米娅」、「能天使」。")],
    ) -> str:
        """获取指定干员的基本数值信息。

        返回干员的职业、子职业、稀有度（星级）、所属阵营、招募标签、天赋名称
        及描述等结构化信息。适合快速了解干员定位；若需完整背景故事请使用
        get_operator_archives，若需语音台词请使用 get_operator_voicelines。
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

        默认返回前 50 条。若需翻页，增大 offset 即可。
        若只想看领袖/BOSS 级敌人，设置 threat_level="boss"。
        不推荐使用 full=true，图鉴共有 1500+ 条目。
        """
        return _list_enemies(threat_level=threat_level, limit=limit, offset=offset, full=full)

    @mcp.tool()
    def get_enemy_info(
        name: Annotated[str, Field(description="敌人的游戏内中文名，如「源石虫」、「霜星」。")],
        stage_id: Annotated[str | None, Field(default=None, description="可选关卡 ID；设置后返回该关卡内的敌人等级/覆盖后的战斗属性。")] = None,
    ) -> str:
        """获取指定敌人的详细图鉴资料。

        默认返回该敌人的威胁等级、描述、攻击方式、伤害类型和特殊能力等图鉴信息。
        若提供 stage_id，则返回该敌人在指定关卡内的等级与关卡覆盖后的战斗属性。
        """
        if stage_id:
            return _get_enemy_stage_info(name, stage_id)
        return _get_enemy_info(name)

    @mcp.tool()
    def search_enemies(
        pattern: Annotated[str, Field(description="正则表达式模式，如 '萨卡兹|骑士'。")],
        max_results: Annotated[int, Field(default=30, ge=1, le=100, description="返回结果数量上限，默认 30。")] = 30,
    ) -> str:
        """在敌人图鉴中进行全文正则搜索。

        搜索范围包含敌人名称、描述和特殊能力文本。可用于探索特定种族、
        阵营或关键词相关的敌人信息。
        """
        return _search_enemies(pattern, max_results=max_results)

    @mcp.tool()
    def get_stage_enemies(
        stage_id: Annotated[str, Field(description="关卡 ID，如 'main_00-01'（可从 list_stages 获取）。")],
    ) -> str:
        """获取指定关卡实际出场的敌人列表。

        基于关卡 level JSON 的 SPAWN 动作统计实际出怪，并合并 enemy_database 中
        对应该关卡敌人等级的战斗属性。
        """
        return _get_stage_enemies(stage_id)

    @mcp.tool()
    def get_enemy_appearances(
        name: Annotated[str, Field(description="敌人的游戏内中文名或 enemyId，如「源石虫」或 enemy_1007_slime。")],
        limit: Annotated[int, Field(default=50, description="返回数量上限，默认 50。")] = 50,
        offset: Annotated[int, Field(default=0, description="分页偏移量，默认 0。")] = 0,
    ) -> str:
        """反向查询指定敌人实际出现在哪些关卡。

        只统计关卡 level JSON 中 SPAWN 动作真正刷出的敌人，不把 enemyDbRefs 中
        未实际出场的引用计入结果。
        """
        return _get_enemy_appearances(name, limit=limit, offset=offset)

    @mcp.tool()
    def list_stages(
        chapter: Annotated[str | None, Field(default=None, description="按所属章节（zoneId）过滤，如 'main_0'。不填则返回全部。")] = None,
        type: Annotated[str | None, Field(default=None, description="按关卡类型过滤：MAIN（主线）/ ACTIVITY（活动）/ SUB（支线）/ DAILY（每日）/ CAMPAIGN（剿灭）/ CLIMB_TOWER（爬塔）/ SPECIAL_STORY（特殊故事）/ GUIDE（教程）。不填则返回全部。")] = None,
        limit: Annotated[int, Field(default=50, description="返回数量上限，默认 50。")] = 50,
        offset: Annotated[int, Field(default=0, description="分页偏移量，默认 0。")] = 0,
    ) -> str:
        """列出关卡列表，支持按章节和类型过滤。

        返回格式：每行 `- **关卡名** [类型] 编号 — 难度 — 区域`。
        获取 stage_id 后可传入 get_stage_info 查看详情。
        """
        return _list_stages(chapter=chapter, type=type, limit=limit, offset=offset)

    @mcp.tool()
    def get_stage_info(
        stage_id: Annotated[str, Field(description="关卡 ID，如 'main_00-01'（可从 list_stages 获取）。")],
    ) -> str:
        """获取指定关卡的详细信息。

        返回关卡的编号、类型、难度、所属区域、理智消耗、掉落奖励、解锁条件等。
        """
        return _get_stage_info(stage_id)

    @mcp.tool()
    def search_stages(
        pattern: Annotated[str, Field(description="正则表达式搜索模式，大小写不敏感。例如 'H10'、'切尔诺伯格'。")],
        max_results: Annotated[int, Field(default=30, ge=1, le=100, description="最多返回条数，默认 30。")] = 30,
    ) -> str:
        """在关卡数据库中执行全文正则搜索。

        搜索范围覆盖关卡名称、编号、描述。返回匹配关卡的基本信息块。
        """
        return _search_stages(pattern, max_results=max_results)

    @mcp.tool()
    def list_items(
        category: Annotated[str | None, Field(default=None, description="按物品分类过滤，如 MATERIAL（材料）、NORMAL（普通）、CONSUME（消耗品）。不填则返回全部可见物品。")] = None,
        limit: Annotated[int, Field(default=50, description="返回数量上限，默认 50。")] = 50,
        offset: Annotated[int, Field(default=0, description="分页偏移量，默认 0。")] = 0,
    ) -> str:
        """列出物品/材料列表，支持按分类过滤和分页。

        返回物品名称、分类、类型、稀有度、ID 和简短用途。适合查找材料、
        货币、凭证等 item_table 物品。
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
    def search_items(
        pattern: Annotated[str, Field(description="正则表达式搜索模式，如「源岩|装置」。")],
        max_results: Annotated[int, Field(default=30, ge=1, le=100, description="返回结果数量上限，默认 30。")] = 30,
    ) -> str:
        """在物品/材料数据中进行全文正则搜索。

        搜索范围包含物品名称、描述、用途、获取方式和类型。
        """
        return _search_items(pattern, max_results=max_results)

    @mcp.tool()
    def list_search_scopes() -> str:
        """列出所有可搜索的数据域及其内容类型。

        返回可用搜索域的名称和简介，帮助 Agent 选择合适的搜索工具和 scope 参数。
        无需参数，始终返回当前服务器支持的所有搜索域。
        """
        return (
            "可用搜索域：\n"
            "- operators：干员数据（名称、基本信息描述、档案文本、语音台词）\n"
            "  使用 search_data(scope=\"operators\") 搜索。\n"
            "- stories：剧情台词（对话、旁白、选项），按活动/章节组织，支持按角色和台词类型过滤。\n"
            "  使用 search_stories 搜索。\n"
            "- stages：关卡数据（名称、编号、描述、类型、掉落、解锁条件）。\n"
            "  使用 list_stages / get_stage_info / search_stages 查询。\n"
            "- enemies：敌人图鉴（名称、威胁等级、描述、属性）。\n"
            "  使用 list_enemies / get_enemy_info / search_enemies 查询。\n"
            "- items：物品/材料（名称、描述、用途、掉落、商店关联）。\n"
            "  使用 list_items / get_item_info / search_items 查询。\n"
            "- memoirs：干员密录剧情，可通过 get_operator_memoirs 按干员名查找。\n"
            "  获取 story_key 后使用 read_story 读取完整台词。"
        )

    @mcp.tool()
    def search_data(
        pattern: Annotated[str, Field(description="正则表达式搜索模式，大小写不敏感。例如「博士」、「法术伤害」。")],
        scope: Annotated[str, Field(default="operators", description="搜索域，目前支持 \"operators\"。")] = "operators",
        max_results: Annotated[int, Field(default=30, ge=1, le=100, description="最多返回条数，默认 30。")] = 30,
    ) -> str:
        """在干员数据中执行全文正则搜索。

        搜索范围覆盖干员名称、攻击属性描述、档案文本和语音台词。
        返回带领域标签（operators/basic、operators/archives、operators/voicelines）的
        匹配结果，包含匹配字段名和完整文本。

        如需搜索剧情台词，请使用 search_stories。
        """
        if scope != "operators":
            return f"不支持的搜索域：{scope!r}。当前仅支持 scope=\"operators\"。"
        return _search_operator_data(pattern, max_results=max_results)
