"""Full-text search across operator data tables."""

from __future__ import annotations

import re

from prts_mcp.config import Config
from prts_mcp.data.operator import (
    _build_name_to_id,
    _load_character_table,
    _load_charword_table,
    _load_handbook_table,
)
from prts_mcp.utils.sanitizer import strip_wikitext


def search_operator_data(pattern: str, max_results: int = 30) -> str:
    """Search operator names, archive texts, and voice lines by regex.

    Case-insensitive.  Returns a formatted multi-block string.
    """
    config = Config.load()
    if not config.has_operator_data:
        return (
            "干员数据暂不可用。"
            "容器启动时的 auto-sync 可能仍在进行中，请稍后重试；"
            "若持续出现此提示，请检查网络连接或提供 GITHUB_TOKEN 以降低限速风险。"
            f"（当前同步目标路径：{config.excel_path}）"
        )

    try:
        regex = re.compile(pattern, re.IGNORECASE)
    except re.error as exc:
        return f"正则表达式无效：{exc}"

    ct = _load_character_table()
    handbook = _load_handbook_table().get("handbookDict", {})
    charwords = _load_charword_table().get("charWords", {})
    name_to_id = _build_name_to_id()

    # Build charId → voice entries index once to avoid O(n×m) nested loops
    charid_to_voices: dict[str, list[dict]] = {}
    for entry in charwords.values():
        cid = entry.get("charId")
        if cid and entry.get("voiceText"):
            charid_to_voices.setdefault(cid, []).append(entry)

    results: list[dict] = []

    for name, char_id in name_to_id.items():
        if len(results) >= max_results:
            break
        info = ct.get(char_id)
        if info is None:
            continue

        # --- basic: operator name ---
        if regex.search(name):
            results.append({
                "operator": name,
                "category": "basic",
                "field": "干员名称",
                "text": name,
            })
            if len(results) >= max_results:
                break

        # --- basic: description ---
        desc = info.get("description") or ""
        if desc:
            cleaned = strip_wikitext(desc)
            if regex.search(cleaned):
                results.append({
                    "operator": name,
                    "category": "basic",
                    "field": "攻击属性",
                    "text": cleaned,
                })
                if len(results) >= max_results:
                    break

        # --- archives ---
        hb_entry = handbook.get(char_id)
        if hb_entry:
            for story in hb_entry.get("storyTextAudio", []):
                if len(results) >= max_results:
                    break
                title = story.get("storyTitle", "")
                for s in story.get("stories", []):
                    if len(results) >= max_results:
                        break
                    text = s.get("storyText", "")
                    if text and regex.search(text):
                        results.append({
                            "operator": name,
                            "category": "archives",
                            "field": title,
                            "text": text,
                        })

        # --- voicelines ---
        if char_id in charid_to_voices:
            for v in charid_to_voices[char_id]:
                if len(results) >= max_results:
                    break
                if regex.search(v["voiceText"]):
                    results.append({
                        "operator": name,
                        "category": "voicelines",
                        "field": v.get("voiceTitle", "未知"),
                        "text": v["voiceText"],
                    })

    if not results:
        return f"未找到匹配 '{pattern}' 的干员数据。"

    blocks = [f"# 搜索 \"{pattern}\" 的结果（共 {len(results)} 条）"]
    for r in results:
        blocks.append(
            f"\n---\n\n"
            f"[operators/{r['category']}/{r['operator']}]\n"
            f"匹配：{r['field']}\n"
            f"{r['text']}"
        )

    return "".join(blocks)
