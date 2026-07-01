"""Story tool registrations — events, chapters, dialogue, summaries, search, memoirs, characters.

Split from server.py. Covers 9 tools that read story data from the
synced zh_CN.zip via the story submodules.
"""
from __future__ import annotations

from typing import Annotated

from pydantic import Field

from prts_mcp.data.stores import ZipStore
from prts_mcp.data.story import (
    list_story_events as _list_story_events,
    list_stories as _list_stories,
    read_story as _read_story,
    read_activity as _read_activity,
    search_stories as _search_stories,
    get_story_summary as _get_story_summary,
    get_operator_memoirs as _get_operator_memoirs,
    find_character_appearances as _find_character_appearances,
    find_speakers_in as _find_speakers_in,
)
from prts_mcp.startup_sync import _require_story_zip


def register_story_tools(mcp) -> None:  # type: ignore[no-untyped-def]
    """Register the 9 story-backed tools on the given FastMCP instance."""

    @mcp.tool()
    def list_story_events(
        category: Annotated[str | None, Field(default=None, description="可选过滤分类。\"main\" = 主线章节，\"activities\" = 活动剧情（含联动），\"memoirs\" = 干员密录。不填则返回全部活动。")] = None,
    ) -> str:
        """列出明日方舟剧情活动列表。

        返回格式：每行 `- [类型] 活动ID：名称（N 章）`，类型为 MAINLINE / ACTIVITY /
        MINI_ACTIVITY / NONE 之一。获取活动 ID 后，可调用 list_stories 查看该活动的章节列表。
        category="memoirs" 可列出所有干员密录。
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
        include_summaries: Annotated[bool, Field(default=False, description="是否附带梗概，默认 False。设为 True 时顶部附活动级长摘要（若有）、每章下方附一句话梗概。")] = False,
    ) -> str:
        """列出指定活动的所有剧情章节（按官方顺序排列）。

        返回格式：每行 `- 章节编号 [标签] 章节名（key: story_key）`，其中 story_key
        可直接传入 read_story 读取该章台词。设 include_summaries=True 时，顶部附活动级
        长摘要（若有），每章下方附一句话梗概——可一次性了解活动整体剧情脉络。
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

        summaries: dict[str, str] = {}
        event_summary_text = ""
        if include_summaries:
            try:
                with ZipStore(zip_path) as store:
                    if store.exists("zh_CN/storyinfo.json"):
                        raw = store.read_json("zh_CN/storyinfo.json")
                        if isinstance(raw, dict):
                            summaries = {str(k): str(v) for k, v in raw.items() if v}
                    if store.exists("zh_CN/event_summaries.json"):
                        raw_ev = store.read_json("zh_CN/event_summaries.json")
                        if isinstance(raw_ev, dict):
                            event_summary_text = str(raw_ev.get(event_id) or "").strip()
            except Exception:
                pass

        lines = []
        if event_summary_text:
            lines.append(event_summary_text)
            lines.append("")
        for ch in chapters:
            tag = f"[{ch.avg_tag}] " if ch.avg_tag else ""
            lines.append(f"- {ch.story_code} {tag}{ch.story_name}（key: {ch.story_key}）")
            if include_summaries:
                summary = summaries.get(ch.story_key, "")
                if summary:
                    lines.append(f"  {summary}")
        return "\n".join(lines)

    @mcp.tool()
    def get_story_summary(
        story_key: Annotated[str, Field(description="章节 key，如 \"activities/act31side/level_act31side_01_beg\"（可从 list_stories 获取）。")],
    ) -> str:
        """获取单章剧情的梗概。

        返回指定章节的故事摘要。优先使用 LLM 生成的长摘要（zh_CN/summaries.json），
        未就绪时回退到官方一句话梗概（zh_CN/storyinfo.json），最后回退到章节
        JSON 中的 storyInfo 字段。

        如需获取整个活动的章节概览，请使用 list_stories(include_summaries=True)。
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
    def search_stories(
        pattern: Annotated[str, Field(description="正则表达式搜索模式，大小写不敏感。")],
        character: Annotated[str | None, Field(default=None, description="按说话角色名过滤（仅匹配 dialog 行），如「博士」、「阿米娅」。")] = None,
        line_type: Annotated[str | None, Field(default=None, description="台词类型过滤：dialog（对话）、narration（旁白）、choice（选项）。")] = None,
        context_lines: Annotated[int, Field(default=1, ge=0, le=5, description="匹配行前后的上下文行数，默认 1。设 0 则只返回匹配行本身。")] = 1,
        max_results: Annotated[int, Field(default=30, ge=1, le=100, description="最多返回条数，默认 30。")] = 30,
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

    @mcp.tool()
    def get_operator_memoirs(
        name: Annotated[str, Field(description="干员的游戏内中文名，如「阿米娅」、「能天使」。")],
    ) -> str:
        """根据干员名称查询干员密录剧情。

        返回干员的密录章节列表，包含章节 key（story_key）和元数据。
        获取 story_key 后可传入 read_story 读取密录台词。
        若需先查找正确的干员名称，可用 search（scope=operators）搜索干员数据。
        """
        from prts_mcp.config import Config
        cfg = Config.load()
        try:
            zip_path = _require_story_zip(cfg)
        except RuntimeError as e:
            return str(e)

        try:
            result = _get_operator_memoirs(zip_path, name)
        except KeyError as e:
            return str(e)
        except Exception as e:
            return f"查询干员密录失败：{e}"

        lines = [
            f"# {result.operator_name}（code: {result.internal_code}，id: {result.operator_id}）",
            f"共 {result.total_chapters} 章密录\n",
        ]
        for ch in result.chapters:
            lines.append(f"- {ch.story_code} {ch.story_name}（key: {ch.story_key}）")
        return "\n".join(lines)

    @mcp.tool()
    def find_character_appearances(
        name: Annotated[str, Field(description="角色名（干员中文名或「博士」）。speaks 按对话角色名精确匹配，mentioned 按名字在台词/旁白文本中的子串匹配——请使用完整名字以免误报（如「阿」会命中「阿米娅」）。")],
        scope: Annotated[str | None, Field(default=None, description="限定活动 ID，如「act31side」。不填则检索全部活动。")] = None,
        max_events: Annotated[int, Field(default=50, ge=1, le=200, description="最多返回章节数，默认 50。")] = 50,
    ) -> str:
        """查找某个角色在剧情中的出场（说话或被提及）。

        返回该角色「说话」（speaks，作为对话发言者）或「被提及」（mentioned，
        名字出现在任意台词/旁白文本中）的所有章节，每章标注 speaks / mentioned /
        两者皆有。适合快速定位一个角色的剧情登场分布。如需精确台词，可用返回的
        story_key 调用 read_story。
        """
        from prts_mcp.config import Config
        cfg = Config.load()
        try:
            zip_path = _require_story_zip(cfg)
        except RuntimeError as e:
            return str(e)

        try:
            result = _find_character_appearances(
                zip_path, name, scope=scope, max_events=max_events,
            )
        except ValueError as e:
            return str(e)
        except KeyError as e:
            return str(e)
        except Exception as e:
            return f"查询角色出场失败：{e}"

        if not result.appearances:
            scope_note = f"（限定活动：{scope!r}）" if scope else ""
            return f"未找到「{name}」的出场记录。{scope_note}"

        parts = [f"# 「{result.name}」的出场（共 {result.total_chapters} 章）"]
        for ap in result.appearances:
            tags = []
            if ap.speaks:
                tags.append("speaks")
            if ap.mentioned:
                tags.append("mentioned")
            tag = "+".join(tags)
            name_disp = f"{ap.story_code} {ap.story_name}".strip()
            parts.append(
                f"- [{tag}] {ap.event_id} / {name_disp}（key: {ap.story_key}）"
            )
        return "\n".join(parts)

    @mcp.tool()
    def find_speakers_in(
        event_id: Annotated[str, Field(description="活动 ID，如 \"act31side\"（可从 list_story_events 获取）。")],
    ) -> str:
        """列出某活动中的所有发言角色及其台词数。

        返回该活动所有章节中去重后的对话发言者，按台词句数降序排列。适合了解
        一个活动的角色戏份分布。如需读取某角色说的具体内容，可结合
        search_stories(character=...) 过滤。
        """
        from prts_mcp.config import Config
        cfg = Config.load()
        try:
            zip_path = _require_story_zip(cfg)
        except RuntimeError as e:
            return str(e)

        try:
            speakers = _find_speakers_in(zip_path, event_id)
        except KeyError as e:
            return str(e)
        except Exception as e:
            return f"查询发言角色失败：{e}"

        if not speakers:
            return f"活动 {event_id!r} 暂无对话发言者数据。"

        parts = [f"# {event_id} 的发言角色（共 {len(speakers)} 位）"]
        for sp in speakers:
            parts.append(f"- {sp.name}（{sp.line_count} 句）")
        return "\n".join(parts)
