from __future__ import annotations

import json
import logging
import os
import sys
import threading
from pathlib import Path

from typing import Annotated, Callable

from mcp.server.fastmcp import FastMCP
from pydantic import Field

from prts_mcp.api.prts_wiki import (
    search_prts as _search_prts,
    read_page as _read_page,
    list_sections as _list_sections,
    get_categories as _get_categories,
    get_links as _get_links,
    get_template_data as _get_template_data,
)
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
from prts_mcp.data.search import search_operator_data as _search_operator_data
from prts_mcp.data.story import (
    list_story_events as _list_story_events,
    list_stories as _list_stories,
    read_story as _read_story,
    read_activity as _read_activity,
    search_stories as _search_stories,
    get_event_summary as _get_event_summary,
    get_story_summary as _get_story_summary,
)

logging.basicConfig(
    stream=sys.stderr,
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
_logger = logging.getLogger("prts_mcp.server")

mcp = FastMCP("PRTS_Wiki_Assistant")
_SYNC_RETRY_DELAYS_SECONDS = (30, 120, 600)


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


@mcp.tool()
async def get_operator_archives(
    operator_name: Annotated[str, Field(description="干员的游戏内中文名，如「阿米娅」、「能天使」。")],
) -> str:
    """获取指定干员的档案资料。

    返回干员的客观履历、个人档案（基础档案及解锁档案）等背景故事文本。
    若需查询干员的职业、稀有度等数值信息，请使用 get_operator_basic_info；
    若需查询语音台词，请使用 get_operator_voicelines。
    """
    return _get_archives(operator_name)


@mcp.tool()
async def get_operator_voicelines(
    operator_name: Annotated[str, Field(description="干员的游戏内中文名，如「阿米娅」、「能天使」。")],
) -> str:
    """获取指定干员的所有语音台词记录。

    返回包含触发条件（如「交谈1」、「晋升后交谈」、「信赖提升后交谈」）及对应
    台词文本的完整列表。此工具仅返回语音文本；若需查询干员背景故事或客观
    履历，请使用 get_operator_archives。
    """
    return _get_voicelines(operator_name)


@mcp.tool()
async def get_operator_basic_info(
    operator_name: Annotated[str, Field(description="干员的游戏内中文名，如「阿米娅」、「能天使」。")],
) -> str:
    """获取指定干员的基本数值信息。

    返回干员的职业、子职业、稀有度（星级）、所属阵营、招募标签、天赋名称
    及描述等结构化信息。适合快速了解干员定位；若需完整背景故事请使用
    get_operator_archives，若需语音台词请使用 get_operator_voicelines。
    """
    return _get_basic_info(operator_name)


def _require_story_zip(cfg: "Config") -> Path:
    """Return effective_storyjson_zip or raise RuntimeError."""
    if not cfg.has_story_data:
        raise RuntimeError(
            "剧情数据未就绪。请设置 STORYJSON_PATH 环境变量指向 zh_CN.zip，"
            "或等待服务器自动从 GitHub Release 下载完成后重试。"
        )
    return cfg.effective_storyjson_zip


@mcp.tool()
def list_enemies(
    threat_level: Annotated[str | None, Field(default=None, description="按威胁等级过滤：boss（领袖）、elite（精英）、normal（普通）。不填则返回全部。")] = None,
    limit: Annotated[int, Field(default=50, description="返回数量上限，默认 50。")] = 50,
    offset: Annotated[int, Field(default=0, description="分页偏移量，默认 0。")] = 0,
    full: Annotated[bool, Field(default=False, description="返回全部敌人（忽略 limit/offset）。不推荐常规使用，密集输出极易污染上下文。仅在需要完整扫描时使用。")] = False,
) -> str:
    """列出敌方图鉴，支持按威胁等级过滤和分页。

    默认返回前 50 条。若需翻页，增大 offset 即可。
    若只想看领袖/BOSS 级敌人，设置 threat_level=\"boss\"。
    不推荐使用 full=true，图鉴共有 1500+ 条目。
    """
    return _list_enemies(threat_level=threat_level, limit=limit, offset=offset, full=full)


@mcp.tool()
def get_enemy_info(
    name: Annotated[str, Field(description="敌人的游戏内中文名，如「源石虫」、「霜星」。")],
) -> str:
    """获取指定敌人的详细图鉴资料。

    返回该敌人的威胁等级、描述、攻击方式、伤害类型和特殊能力等信息。
    """
    return _get_enemy_info(name)


@mcp.tool()
def search_enemies(
    pattern: Annotated[str, Field(description="正则表达式模式，如 '萨卡兹|骑士'。")],
    max_results: Annotated[int, Field(default=30, description="返回结果数量上限，默认 30。")] = 30,
) -> str:
    """在敌人图鉴中进行全文正则搜索。

    搜索范围包含敌人名称、描述和特殊能力文本。可用于探索特定种族、
    阵营或关键词相关的敌人信息。
    """
    return _search_enemies(pattern, max_results=max_results)


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
    max_results: Annotated[int, Field(default=30, description="最多返回条数，默认 30。")] = 30,
) -> str:
    """在关卡数据库中执行全文正则搜索。

    搜索范围覆盖关卡名称、编号、描述。返回匹配关卡的基本信息块。
    """
    return _search_stages(pattern, max_results=max_results)


@mcp.tool()
def list_story_events(
    category: Annotated[str | None, Field(default=None, description="可选过滤分类。\"main\" = 主线章节，\"activities\" = 活动剧情（含联动）。不填则返回全部活动。")] = None,
) -> str:
    """列出明日方舟剧情活动列表。

    返回格式：每行 `- [类型] 活动ID：名称（N 章）`，类型为 MAINLINE / ACTIVITY /
    MINI_ACTIVITY 之一。获取活动 ID 后，可调用 list_stories 查看该活动的章节列表。
    """
    from prts_mcp.config import Config
    cfg = Config.load()
    try:
        zip_path = _require_story_zip(cfg)
    except RuntimeError as e:
        return str(e)

    try:
        events = _list_story_events(zip_path, category=category)
    except Exception as e:
        return f"读取活动列表失败：{e}"

    if not events:
        return f"未找到符合条件的活动（category={category!r}）。"

    lines = []
    for ev in events:
        lines.append(f"- [{ev.entry_type}] {ev.event_id}：{ev.name}（{ev.story_count} 章）")
    return "\n".join(lines)


@mcp.tool()
def list_stories(
    event_id: Annotated[str, Field(description="活动 ID，如 \"act31side\"（可从 list_story_events 获取）。")],
    include_summaries: Annotated[bool, Field(default=False, description="是否附带每章梗概，默认 False。")] = False,
) -> str:
    """列出指定活动的所有剧情章节（按官方顺序排列）。

    返回格式：每行 `- 章节编号 [标签] 章节名（key: story_key）`，其中 story_key
    可直接传入 read_story 读取该章台词。设置 include_summaries=True 时每章下方会
    附带梗概。如需一次性了解活动整体剧情脉络，可使用 get_event_summary。
    """
    from prts_mcp.config import Config
    from prts_mcp.data.stores import ZipStore
    cfg = Config.load()
    try:
        zip_path = _require_story_zip(cfg)
    except RuntimeError as e:
        return str(e)

    try:
        chapters = _list_stories(zip_path, event_id)
    except KeyError:
        return f"未找到活动：{event_id!r}。请先调用 list_story_events 确认活动 ID。"
    except Exception as e:
        return f"读取章节列表失败：{e}"

    if not chapters:
        return f"活动 {event_id!r} 暂无剧情章节。"

    summaries: dict[str, str] = {}
    if include_summaries:
        try:
            with ZipStore(zip_path) as store:
                if store.exists("zh_CN/storyinfo.json"):
                    raw = store.read_json("zh_CN/storyinfo.json")
                    if isinstance(raw, dict):
                        summaries = {str(k): str(v) for k, v in raw.items() if v}
        except Exception:
            pass

    lines = []
    for ch in chapters:
        tag = f"[{ch.avg_tag}] " if ch.avg_tag else ""
        lines.append(f"- {ch.story_code} {tag}{ch.story_name}（key: {ch.story_key}）")
        if include_summaries:
            summary = summaries.get(ch.story_key, "")
            if summary:
                lines.append(f"  {summary}")
    return "\n".join(lines)


@mcp.tool()
def get_event_summary(
    event_id: Annotated[str, Field(description="活动 ID，如 \"act31side\"（可从 list_story_events 获取）。")],
) -> str:
    """获取指定活动的章节梗概概览。

    返回活动的所有章节编号、标题和每章故事简介，按官方顺序排列，
    适合快速了解一个活动的整体剧情脉络。如需读取完整台词，请使用
    read_story 或 read_activity。
    """
    from prts_mcp.config import Config
    cfg = Config.load()
    try:
        zip_path = _require_story_zip(cfg)
    except RuntimeError as e:
        return str(e)

    try:
        return _get_event_summary(zip_path, event_id)
    except Exception as e:
        return f"读取活动梗概失败：{e}"


@mcp.tool()
def get_story_summary(
    story_key: Annotated[str, Field(description="章节 key，如 \"activities/act31side/level_act31side_01_beg\"（可从 list_stories 获取）。")],
) -> str:
    """获取单章剧情的梗概。

    返回指定章节的故事摘要。优先使用 LLM 生成的长摘要（zh_CN/summaries.json），
    未就绪时回退到官方一句话梗概（zh_CN/storyinfo.json），最后回退到章节
    JSON 中的 storyInfo 字段。

    如需获取整个活动的章节概览，请使用 get_event_summary。
    """
    from prts_mcp.config import Config
    cfg = Config.load()
    try:
        zip_path = _require_story_zip(cfg)
    except RuntimeError as e:
        return str(e)

    try:
        return _get_story_summary(zip_path, story_key)
    except KeyError:
        return f"未找到剧情章节：{story_key!r}。请通过 list_stories 确认章节 key。"
    except Exception as e:
        return f"读取梗概失败：{e}"


@mcp.tool()
def read_story(
    story_key: Annotated[str, Field(description="章节 key，如 \"activities/act31side/level_act31side_01_beg\"（可从 list_stories 获取）。")],
    include_narration: Annotated[bool, Field(default=True, description="是否包含旁白和场景描述，默认 True。设为 False 可只保留对话台词。")] = True,
) -> str:
    """读取单章剧情的完整台词。

    返回格式：首行为【活动名】章节名，随后按顺序输出对话（`角色：台词`）、
    旁白（`*旁白文本*`）和选项（`【选项】文本`）。story_key 可从 list_stories
    的返回结果中获取。
    """
    from prts_mcp.config import Config
    cfg = Config.load()
    try:
        zip_path = _require_story_zip(cfg)
    except RuntimeError as e:
        return str(e)

    try:
        chapter = _read_story(zip_path, story_key, include_narration=include_narration)
    except KeyError:
        return f"未找到剧情：{story_key!r}。"
    except Exception as e:
        return f"读取剧情失败：{e}"

    parts = [f"【{chapter.event_name}】{chapter.story_name}"]
    if chapter.story_info:
        parts.append(f"简介：{chapter.story_info}\n")
    for ln in chapter.lines:
        if ln.type == "dialog":
            role = ln.role or "（旁白）"
            parts.append(f"{role}：{ln.text}")
        elif ln.type == "narration":
            parts.append(f"*{ln.text}*")
        elif ln.type == "choice":
            parts.append(f"【选项】{ln.text}")
    return "\n".join(parts)


@mcp.tool()
def read_activity(
    event_id: Annotated[str, Field(description="活动 ID，如 \"act31side\"（可从 list_story_events 获取）。")],
    include_narration: Annotated[bool, Field(default=True, description="是否包含旁白，默认 True。")] = True,
    page: Annotated[int | None, Field(default=None, description="分页页码（从 1 开始）。不填则返回全部章节。")] = None,
    page_size: Annotated[int, Field(default=5, description="每页章节数，默认 5。")] = 5,
) -> str:
    """读取整个活动的完整剧情台词（按官方章节顺序合并）。

    适合需要了解完整活动故事的场景。返回各章节台词的合并文本，格式与
    read_story 一致，章节间以分隔标题区分。单次活动文本量可能较大，建议
    使用 page 参数分批获取；返回结果末尾会附上 total_chapters 和 has_more
    字段，便于判断是否还有后续内容。
    """
    from prts_mcp.config import Config
    cfg = Config.load()
    try:
        zip_path = _require_story_zip(cfg)
    except RuntimeError as e:
        return str(e)

    try:
        result = _read_activity(
            zip_path, event_id,
            include_narration=include_narration,
            page=page,
            page_size=page_size,
        )
    except KeyError:
        return f"未找到活动：{event_id!r}。请先调用 list_story_events 确认活动 ID。"
    except Exception as e:
        return f"读取活动剧情失败：{e}"

    chapters = result.chapters
    total = result.total_chapters
    has_more = result.has_more

    header = f"【{result.event_name}】共 {total} 章"
    if page is not None:
        header += f"，当前第 {page} 页（{len(chapters)} 章）"
        if has_more:
            header += f"，还有更多（下一页：page={page + 1}）"
    parts = [header, ""]

    for chapter in chapters:
        tag = f"[{chapter.avg_tag}]" if chapter.avg_tag else ""
        parts.append(f"=== {chapter.story_code} {tag} {chapter.story_name} ===")
        for ln in chapter.lines:
            if ln.type == "dialog":
                role = ln.role or "（旁白）"
                parts.append(f"{role}：{ln.text}")
            elif ln.type == "narration":
                parts.append(f"*{ln.text}*")
            elif ln.type == "choice":
                parts.append(f"【选项】{ln.text}")
        parts.append("")

    return "\n".join(parts)


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
        "  使用 list_enemies / get_enemy_info / search_enemies 查询。"
    )


@mcp.tool()
def search_data(
    pattern: Annotated[str, Field(description="正则表达式搜索模式，大小写不敏感。例如「博士」、「法术伤害」。")],
    scope: Annotated[str, Field(default="operators", description="搜索域，目前支持 \"operators\"。")] = "operators",
    max_results: Annotated[int, Field(default=30, description="最多返回条数，默认 30。")] = 30,
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


@mcp.tool()
def search_stories(
    pattern: Annotated[str, Field(description="正则表达式搜索模式，大小写不敏感。")],
    character: Annotated[str | None, Field(default=None, description="按说话角色名过滤（仅匹配 dialog 行），如「博士」、「阿米娅」。")] = None,
    line_type: Annotated[str | None, Field(default=None, description="台词类型过滤：dialog（对话）、narration（旁白）、choice（选项）。")] = None,
    context_lines: Annotated[int, Field(default=1, description="匹配行前后的上下文行数，默认 1。设 0 则只返回匹配行本身。")] = 1,
    max_results: Annotated[int, Field(default=30, description="最多返回条数，默认 30。")] = 30,
    event_id: Annotated[str | None, Field(default=None, description="限定活动 ID，如「act31side」。不填则搜索全部活动。")] = None,
) -> str:
    """在剧情台词中执行全文正则搜索，支持角色和台词类型过滤。

    返回格式：以 `[stories/活动ID/章节编号 L行号]` 标注位置，
    命中行前缀 `>>> ` 标记，上下文行以 4 空格缩进显示。
    可结合 list_story_events 和 list_stories 确认活动 ID 后过滤到特定活动。
    """
    from prts_mcp.config import Config
    cfg = Config.load()
    try:
        zip_path = _require_story_zip(cfg)
    except RuntimeError as e:
        return str(e)

    try:
        return _search_stories(
            zip_path,
            pattern,
            character=character,
            line_type=line_type,
            context_lines=context_lines,
            max_results=max_results,
            event_id=event_id,
        )
    except Exception as e:
        return f"剧情搜索失败：{e}"


def _sync_needs_retry(status: str) -> bool:
    return status in {"offline_fallback", "no_data"}


def _run_initial_sync(label: str, sync_func: Callable[[], bool]) -> bool:
    """Run the first sync attempt, treating unexpected exceptions as retry-needed."""
    try:
        return sync_func()
    except Exception as exc:  # noqa: BLE001
        _logger.exception("%s sync threw unexpectedly: %s", label, exc)
        return True


def _schedule_sync_retry(label: str, sync_func: Callable[[], bool], attempt: int = 0) -> None:
    delay = _SYNC_RETRY_DELAYS_SECONDS[attempt] if attempt < len(_SYNC_RETRY_DELAYS_SECONDS) else None
    if delay is None:
        _logger.warning(
            "%s sync still needs retry after %s attempts; waiting for next process start.",
            label,
            len(_SYNC_RETRY_DELAYS_SECONDS),
        )
        return

    def _retry() -> None:
        try:
            needs_retry = sync_func()
        except Exception as exc:  # noqa: BLE001
            _logger.exception("%s retry sync threw unexpectedly: %s", label, exc)
            needs_retry = True
        if needs_retry:
            _schedule_sync_retry(label, sync_func, attempt + 1)

    timer = threading.Timer(delay, _retry)
    timer.daemon = True
    timer.start()
    _logger.info("%s sync will retry in %ss.", label, delay)


def _run_startup_sync() -> None:
    """Check upstream GitHub and download data files if outdated.

    Skipped when GAMEDATA_PATH is explicitly set to a custom location —
    in that case the user is managing their own data and we must not
    overwrite it.
    """
    from prts_mcp.config import Config, _DEFAULT_GAMEDATA_PATH
    from prts_mcp.data.datasets import GAMEDATA_EXCEL, STORY_ZH_CN
    from prts_mcp.data.sync import sync_release, sync_release_archive

    cfg = Config.load()
    if cfg.is_custom_gamedata:
        _logger.info(
            "GAMEDATA_PATH is set to a custom location (%s); auto-sync disabled.",
            cfg.gamedata_path,
        )
    else:
        archive_spec = GAMEDATA_EXCEL.archive_spec(
            local_zip=_DEFAULT_GAMEDATA_PATH / "archives" / "zh_CN-excel.zip",
            local_root=_DEFAULT_GAMEDATA_PATH,
        )

        def _sync_gamedata() -> bool:
            r = sync_release_archive(archive_spec)
            _log_sync_result(r)
            if r.status == "updated":
                from prts_mcp.data.operator import clear_operator_caches
                from prts_mcp.data.enemy import clear_enemy_caches

                clear_operator_caches()
                clear_enemy_caches()
                from prts_mcp.data.stage import clear_stage_caches as _clear_stages
                _clear_stages()
            return _sync_needs_retry(r.status)

        needs_retry = _run_initial_sync("Gamedata", _sync_gamedata)
        if needs_retry:
            _schedule_sync_retry("Gamedata", _sync_gamedata)

    # Always try to sync storyjson from GitHub Release (unless user supplied their own zip)
    if "STORYJSON_PATH" not in os.environ:
        release_spec = STORY_ZH_CN.release_spec(cfg.storyjson_zip)

        def _sync_storyjson() -> bool:
            r = sync_release(release_spec)
            _log_sync_result(r)
            return _sync_needs_retry(r.status)

        needs_retry = _run_initial_sync("Storyjson", _sync_storyjson)
        if needs_retry:
            _schedule_sync_retry("Storyjson", _sync_storyjson)


def _log_sync_result(r) -> None:
    repo = r.spec.repo
    sha_short = r.commit_sha[:8] if r.commit_sha else "unknown"
    if r.status == "updated":
        _logger.info("Data updated from GitHub (%s @ %s).", repo, sha_short)
    elif r.status == "up_to_date":
        _logger.info("Data is up to date (%s @ %s).", repo, sha_short)
    elif r.status == "offline_fallback":
        _logger.warning(
            "Network unavailable; using cached data (%s @ %s). Error: %s",
            repo, sha_short, r.error,
        )
    elif r.status == "no_data":
        _logger.warning(
            "Sync failed for %s — no data available. Error: %s",
            repo, r.error,
        )


def main() -> None:
    t = threading.Thread(target=_run_startup_sync, daemon=True, name="prts-sync")
    t.start()
    mcp.run()


if __name__ == "__main__":
    main()
