"""Story tool registrations — events, chapters, dialogue, summaries, search, memoirs, characters.

Split from server.py. Covers 9 tools that read story data from the
synced zh_CN.zip via the story submodules.
"""
from __future__ import annotations

from typing import Annotated

from pydantic import Field

from prts_mcp.data.story import (
    build_story_events_listing as _build_story_events_listing,
    render_story_events_listing as _render_story_events_listing,
    build_stories_listing as _build_stories_listing,
    render_stories_listing as _render_stories_listing,
    read_story as _read_story,
    read_activity as _read_activity,
    build_story_search as _build_story_search,
    render_story_search as _render_story_search,
    get_story_summary as _get_story_summary,
    build_operator_memoirs as _build_operator_memoirs,
    render_operator_memoirs as _render_operator_memoirs,
    build_character_appearances as _build_character_appearances,
    render_character_appearances as _render_character_appearances,
    build_speakers_in_event as _build_speakers_in_event,
    render_speakers_in_event as _render_speakers_in_event,
)
from prts_mcp.startup_sync import _require_story_zip
from prts_mcp.output import render_result, text_result


def register_story_tools(mcp) -> None:  # type: ignore[no-untyped-def]
    """Register the 9 story-backed tools on the given MCPServer instance."""

    @mcp.tool()
    def list_story_events(
        category: Annotated[str | None, Field(default=None, description="可选过滤分类。\"main\" = 主线章节，\"activities\" = 活动剧情（含联动），\"memoirs\" = 干员密录。不填则返回全部活动。")] = None,
    ) -> object:
        """列出明日方舟剧情活动列表。

        返回格式：每行 `- [类型] 活动ID：名称（N 章）`，类型为 MAINLINE / ACTIVITY /
        MINI_ACTIVITY / NONE 之一。获取活动 ID 后可调用 list_stories 查看该活动的章节列表。
        """
        from prts_mcp.config import Config
        cfg = Config.load()
        try:
            zip_path = _require_story_zip(cfg)
        except RuntimeError as e:
            return text_result(str(e))

        try:
            data = _build_story_events_listing(zip_path, category=category)
        except Exception as e:
            return text_result(f"读取活动列表失败：{e}")
        return render_result(data, _render_story_events_listing(data))

    @mcp.tool()
    def list_stories(
        event_id: Annotated[str, Field(description="活动 ID，如 \"act31side\"（可从 list_story_events 获取）。")],
        include_summaries: Annotated[bool, Field(default=False, description="是否附带梗概，默认 False。设为 True 时顶部附活动级长摘要（若有）、每章下方附一句话梗概。")] = False,
    ) -> object:
        """列出指定活动的所有剧情章节（按官方顺序排列）。

        返回格式：每行 `- 章节编号 [标签] 章节名（key: story_key）`，其中 story_key 可直接
        传入 read_story 读取该章台词。设 include_summaries=True 可一次性了解活动整体剧情脉络。
        """
        from prts_mcp.config import Config
        cfg = Config.load()
        try:
            zip_path = _require_story_zip(cfg)
        except RuntimeError as e:
            return text_result(str(e))

        try:
            data = _build_stories_listing(
                zip_path, event_id, include_summaries=include_summaries,
            )
        except KeyError:
            return text_result(f"未找到活动：{event_id!r}。请先调用 list_story_events 确认活动 ID。")
        except Exception as e:
            return text_result(f"读取章节列表失败：{e}")
        return render_result(data, _render_stories_listing(data))

    @mcp.tool()
    def get_story_summary(
        story_key: Annotated[str, Field(description="章节 key，如 \"activities/act31side/level_act31side_01_beg\"（可从 list_stories 获取）。")],
    ) -> object:
        """获取单章剧情的梗概。

        返回指定章节的故事摘要，优先长摘要，未就绪时回退到官方一句话梗概。
        整个活动的章节概览见 list_stories(include_summaries=True)。
        """
        from prts_mcp.config import Config
        cfg = Config.load()
        try:
            zip_path = _require_story_zip(cfg)
        except RuntimeError as e:
            return text_result(str(e))

        try:
            return text_result(_get_story_summary(zip_path, story_key))
        except KeyError:
            return text_result(f"未找到剧情章节：{story_key!r}。请通过 list_stories 确认章节 key。")
        except Exception as e:
            return text_result(f"读取梗概失败：{e}")

    @mcp.tool()
    def read_story(
        story_key: Annotated[str, Field(description="章节 key，如 \"activities/act31side/level_act31side_01_beg\"（可从 list_stories 获取）。")],
        include_narration: Annotated[bool, Field(default=True, description="是否包含旁白和场景描述，默认 True。设为 False 可只保留对话台词。")] = True,
    ) -> object:
        """读取单章剧情的完整台词。

        返回格式：首行为【活动名】章节名，随后按顺序输出对话（`角色：台词`）、
        旁白（`*旁白文本*`）和选项（`【选项】文本`）。
        """
        from prts_mcp.config import Config
        cfg = Config.load()
        try:
            zip_path = _require_story_zip(cfg)
        except RuntimeError as e:
            return text_result(str(e))

        try:
            chapter = _read_story(zip_path, story_key, include_narration=include_narration)
        except KeyError:
            return text_result(f"未找到剧情：{story_key!r}。")
        except Exception as e:
            return text_result(f"读取剧情失败：{e}")

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
        return text_result("\n".join(parts))

    @mcp.tool()
    def read_activity(
        event_id: Annotated[str, Field(description="活动 ID，如 \"act31side\"（可从 list_story_events 获取）。")],
        include_narration: Annotated[bool, Field(default=True, description="是否包含旁白，默认 True。")] = True,
        page: Annotated[int | None, Field(default=None, description="分页页码（从 1 开始）。不填则返回全部章节。")] = None,
        page_size: Annotated[int, Field(default=5, ge=1, le=20, description="每页章节数，默认 5。")] = 5,
    ) -> object:
        """读取整个活动的完整剧情台词（按官方章节顺序合并）。

        返回各章节台词的合并文本，格式与 read_story 一致，章节间以分隔标题区分。
        单次文本量可能较大，建议用 page 分批获取，返回末尾会提示是否还有后续内容。
        """
        from prts_mcp.config import Config
        cfg = Config.load()
        try:
            zip_path = _require_story_zip(cfg)
        except RuntimeError as e:
            return text_result(str(e))

        try:
            result = _read_activity(
                zip_path, event_id,
                include_narration=include_narration,
                page=page,
                page_size=page_size,
            )
        except KeyError:
            return text_result(f"未找到活动：{event_id!r}。请先调用 list_story_events 确认活动 ID。")
        except Exception as e:
            return text_result(f"读取活动剧情失败：{e}")

        chapters = result.chapters
        total = result.total_chapters
        has_more = result.has_more

        if result.page_out_of_range:
            total_pages = (total + page_size - 1) // page_size
            return text_result(
                f"页码超出范围：{event_id} 共 {total} 章，按 page_size={page_size} "
                f"分页共 {total_pages} 页，请求的 page={page} 不存在。"
            )

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

        return text_result("\n".join(parts))

    @mcp.tool()
    def search_stories(
        pattern: Annotated[str, Field(description="正则表达式搜索模式，大小写不敏感。")],
        character: Annotated[str | None, Field(default=None, description="按说话角色名过滤（仅匹配 dialog 行），如「博士」、「阿米娅」。")] = None,
        line_type: Annotated[str | None, Field(default=None, description="台词类型过滤：dialog（对话）、narration（旁白）、choice（选项）。")] = None,
        context_lines: Annotated[int, Field(default=1, ge=0, le=5, description="匹配行前后的上下文行数，默认 1。设 0 则只返回匹配行本身。")] = 1,
        max_results: Annotated[int, Field(default=30, ge=1, le=100, description="最多返回条数，默认 30。")] = 30,
        event_id: Annotated[str | None, Field(default=None, description="限定活动 ID，如「act31side」。不填则搜索全部活动。")] = None,
    ) -> object:
        """在剧情台词中执行全文正则搜索，支持角色和台词类型过滤。

        返回格式：以 `[stories/活动ID/章节编号 L行号]` 标注位置，命中行前缀 `>>> ` 标记，
        上下文行以 4 空格缩进显示。
        """
        from prts_mcp.config import Config
        cfg = Config.load()
        try:
            zip_path = _require_story_zip(cfg)
        except RuntimeError as e:
            return text_result(str(e))

        try:
            data = _build_story_search(
                zip_path,
                pattern,
                character=character,
                line_type=line_type,
                context_lines=context_lines,
                max_results=max_results,
                event_id=event_id,
            )
        except Exception as e:
            return text_result(f"剧情搜索失败：{e}")
        if isinstance(data, str):
            return text_result(data)
        return render_result(data, _render_story_search(data))

    @mcp.tool()
    def get_operator_memoirs(
        name: Annotated[str, Field(description="干员的游戏内中文名，如「阿米娅」、「能天使」。")],
    ) -> object:
        """根据干员名称查询干员密录剧情。

        返回干员的密录章节列表，含章节 key（story_key）和元数据。
        获取 story_key 后可传入 read_story 读取密录台词。
        """
        from prts_mcp.config import Config
        cfg = Config.load()
        try:
            zip_path = _require_story_zip(cfg)
        except RuntimeError as e:
            return text_result(str(e))

        try:
            data = _build_operator_memoirs(zip_path, name)
        except KeyError as e:
            return text_result(str(e))
        except Exception as e:
            return text_result(f"查询干员密录失败：{e}")
        return render_result(
            data,
            _render_operator_memoirs(data),
            summary=f"{data['operator_name']} 的密录列表（共 {data['total']} 章）",
        )

    @mcp.tool()
    def find_character_appearances(
        name: Annotated[str, Field(description="角色名（干员中文名或「博士」）。speaks 按对话角色名精确匹配，mentioned 按名字在台词/旁白文本中的子串匹配——请使用完整名字以免误报（如「阿」会命中「阿米娅」）。")],
        scope: Annotated[str | None, Field(default=None, description="限定活动 ID，如「act31side」。不填则检索全部活动。")] = None,
        max_events: Annotated[int, Field(default=50, ge=1, le=200, description="最多返回章节数，默认 50。")] = 50,
    ) -> object:
        """查找某个角色在剧情中的出场（说话或被提及）。

        返回该角色作为对话发言者（speaks）或名字出现在台词/旁白文本中（mentioned）的所有章节，
        每章标注 speaks / mentioned / 两者皆有，适合快速定位角色的登场分布。
        如需精确台词，可用返回的 story_key 调用 read_story。
        """
        from prts_mcp.config import Config
        cfg = Config.load()
        try:
            zip_path = _require_story_zip(cfg)
        except RuntimeError as e:
            return text_result(str(e))

        try:
            data = _build_character_appearances(
                zip_path, name, scope=scope, max_events=max_events,
            )
        except ValueError as e:
            return text_result(str(e))
        except KeyError as e:
            return text_result(str(e))
        except Exception as e:
            return text_result(f"查询角色出场失败：{e}")
        return render_result(data, _render_character_appearances(data))

    @mcp.tool()
    def find_speakers_in(
        event_id: Annotated[str, Field(description="活动 ID，如 \"act31side\"（可从 list_story_events 获取）。")],
    ) -> object:
        """列出某活动中的所有发言角色及其台词数。

        返回该活动去重后的对话发言者，按台词句数降序排列，适合了解角色戏份分布。
        读取某角色说的具体内容可用 search_stories(character=...) 过滤。
        """
        from prts_mcp.config import Config
        cfg = Config.load()
        try:
            zip_path = _require_story_zip(cfg)
        except RuntimeError as e:
            return text_result(str(e))

        try:
            data = _build_speakers_in_event(zip_path, event_id)
        except KeyError as e:
            return text_result(str(e))
        except Exception as e:
            return text_result(f"查询发言角色失败：{e}")
        return render_result(data, _render_speakers_in_event(data))
