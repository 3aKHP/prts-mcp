from __future__ import annotations

import logging
import os
import sys
import threading
from pathlib import Path

from typing import Annotated

from mcp.server.fastmcp import FastMCP
from pydantic import Field

from prts_mcp.api.prts_wiki import search_prts as _search_prts, read_page as _read_page
from prts_mcp.data.operator import (
    get_operator_archives as _get_archives,
    get_operator_voicelines as _get_voicelines,
    get_operator_basic_info as _get_basic_info,
)
from prts_mcp.data.story import (
    list_story_events as _list_story_events,
    list_stories as _list_stories,
    read_story as _read_story,
    read_activity as _read_activity,
)

logging.basicConfig(
    stream=sys.stderr,
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
_logger = logging.getLogger("prts_mcp.server")

mcp = FastMCP("PRTS_Wiki_Assistant")


@mcp.tool()
async def search_prts(
    query: Annotated[str, Field(description="搜索关键词，支持中文，如「罗德岛」、「整合运动」。")],
    limit: Annotated[int, Field(default=5, description="返回结果数量上限，默认 5，最大建议不超过 10。")] = 5,
) -> str:
    """搜索 PRTS 明日方舟中文维基词条。

    返回匹配词条的标题和简短摘要列表。这是探索维基的第一步：当需要查找
    不确定的专有名词、干员、关卡或世界观设定时，先用此工具搜索获取准确
    标题，再将标题传入 read_prts_page 获取完整内容。
    """
    results = await _search_prts(query, limit)
    if not results:
        return f"未找到与 '{query}' 相关的词条。"
    parts = []
    for r in results:
        parts.append(f"**{r['title']}**\n{r['snippet']}")
    return "\n\n---\n\n".join(parts)


@mcp.tool()
async def read_prts_page(
    page_title: Annotated[str, Field(description="词条标题，需与维基页面标题完全一致，如「阿米娅」、「整合运动」。建议通过 search_prts 获取准确标题后再传入。")],
) -> str:
    """读取 PRTS 维基指定词条的纯文本内容。

    返回该词条经过清洗的纯文本，已去除 Wikitext 模板、文件链接和 HTML 标签，
    内容可能较长。强烈建议先调用 search_prts 确认词条的准确标题，避免因
    拼写错误导致读取失败。
    """
    return await _read_page(page_title)


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
) -> str:
    """列出指定活动的所有剧情章节（按官方顺序排列）。

    返回格式：每行 `- 章节编号 [标签] 章节名（key: story_key）`，其中 story_key
    可直接传入 read_story 读取该章台词。如需一次性读取整个活动，可使用
    read_activity。
    """
    from prts_mcp.config import Config
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

    lines = []
    for ch in chapters:
        tag = f"[{ch.avg_tag}] " if ch.avg_tag else ""
        lines.append(f"- {ch.story_code} {tag}{ch.story_name}（key: {ch.story_key}）")
    return "\n".join(lines)


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


def _run_startup_sync() -> None:
    """Check upstream GitHub and download data files if outdated.

    Skipped when GAMEDATA_PATH is explicitly set to a custom location —
    in that case the user is managing their own data and we must not
    overwrite it.
    """
    from prts_mcp.config import Config, _DEFAULT_GAMEDATA_PATH
    from prts_mcp.data.sync import GAMEDATA_FILES, RepoSpec, ReleaseSpec, sync_all, sync_release

    cfg = Config.load()
    if cfg.is_custom_gamedata:
        _logger.info(
            "GAMEDATA_PATH is set to a custom location (%s); auto-sync disabled.",
            cfg.gamedata_path,
        )
    else:
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
            _log_sync_result(r)

    # Always try to sync storyjson from GitHub Release (unless user supplied their own zip)
    if "STORYJSON_PATH" not in os.environ:
        release_spec = ReleaseSpec(
            owner="3aKHP",
            repo="ArknightsStoryJson",
            asset_name="zh_CN.zip",
            local_zip=cfg.storyjson_zip,
        )
        r = sync_release(release_spec)
        _log_sync_result(r)


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
