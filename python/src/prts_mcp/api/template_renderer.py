"""Parse and render top-level MediaWiki template data safely."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Awaitable, Callable
import xml.etree.ElementTree as ET


class TemplateRenderError(RuntimeError):
    """Raised when structured template fields cannot be rendered completely."""


@dataclass
class _Part:
    name: str | None
    value: str
    needs_render: bool


@dataclass
class _Template:
    name: str
    parts: list[_Part]
    comment: str


def _text_without_comments(elem: ET.Element) -> str:
    pieces = [elem.text or ""]
    for child in elem:
        if child.tag != "comment":
            pieces.append("".join(child.itertext()))
        pieces.append(child.tail or "")
    return "".join(pieces)


def _content_to_wikitext(elem: ET.Element) -> str:
    pieces = [elem.text or ""]
    for child in elem:
        if child.tag == "comment":
            pieces.append(f"<!--{child.text or ''}-->")
        else:
            pieces.append(_node_to_wikitext(child))
        pieces.append(child.tail or "")
    return "".join(pieces)


def _part_to_wikitext(part: ET.Element) -> str:
    value = part.find("value")
    if value is None:
        raise TemplateRenderError("模板字段缺少 value 节点。")
    name = part.find("name")
    rendered_value = _content_to_wikitext(value)
    if name is None or "index" in name.attrib:
        return f"|{rendered_value}"
    rendered_name = _text_without_comments(name).strip()
    return f"|{rendered_name}={rendered_value}" if rendered_name else f"|{rendered_value}"


def _node_to_wikitext(elem: ET.Element) -> str:
    if elem.tag == "template":
        title = elem.find("title")
        if title is None:
            raise TemplateRenderError("嵌套模板缺少 title 节点。")
        name = _text_without_comments(title).strip()
        if not name:
            raise TemplateRenderError("嵌套模板 title 为空。")
        return "{{" + name + "".join(_part_to_wikitext(part) for part in elem.findall("part")) + "}}"

    if elem.tag == "tplarg":
        name = elem.find("title")
        if name is None:
            raise TemplateRenderError("模板参数缺少 title 节点。")
        title = _text_without_comments(name).strip()
        if not title:
            raise TemplateRenderError("模板参数 title 为空。")
        return "{{{" + title + "".join(_part_to_wikitext(part) for part in elem.findall("part")) + "}}}"

    if elem.tag == "link":
        target = elem.find("target")
        if target is None:
            raise TemplateRenderError("链接缺少 target 节点。")
        target_text = _content_to_wikitext(target).strip()
        if not target_text:
            raise TemplateRenderError("链接 target 为空。")
        parts = "".join(_part_to_wikitext(part) for part in elem.findall("part"))
        return f"[[{target_text}{parts}]]"

    if elem.tag == "comment":
        return f"<!--{elem.text or ''}-->"

    raise TemplateRenderError(f"不支持的模板字段节点：{elem.tag}。")


def _parse_templates(xml: str) -> list[_Template]:
    try:
        root = ET.fromstring(xml)
    except ET.ParseError as exc:
        raise TemplateRenderError("页面模板数据格式无效。") from exc

    templates: list[_Template] = []
    for elem in root.findall("template"):
        title = elem.find("title")
        if title is None:
            continue
        name = _text_without_comments(title).strip()
        if not name:
            continue

        comment = ""
        for child in title.findall("comment"):
            if child.text:
                comment = child.text.strip()

        parts: list[_Part] = []
        for part in elem.findall("part"):
            value = part.find("value")
            if value is None:
                continue
            name_elem = part.find("name")
            part_name = None
            if name_elem is not None and "index" not in name_elem.attrib:
                candidate = _text_without_comments(name_elem).strip()
                part_name = candidate or None

            meaningful_children = [child for child in value if child.tag != "comment"]
            if meaningful_children:
                source = _content_to_wikitext(value)
                if source.strip():
                    parts.append(_Part(part_name, source, True))
                continue

            plain = _text_without_comments(value).strip()
            if plain:
                parts.append(_Part(part_name, plain, False))
        templates.append(_Template(name, parts, comment))
    return templates


async def render_template_data(
    title: str,
    xml: str,
    render_batch: Callable[[str, list[str]], Awaitable[list[str]]],
) -> dict[str, dict[str, Any]]:
    """Return top-level template fields with nested syntax rendered to text."""
    templates = _parse_templates(xml)
    render_sources = [part.value for template in templates for part in template.parts if part.needs_render]
    rendered_values = await render_batch(title, render_sources) if render_sources else []
    if len(rendered_values) != len(render_sources):
        raise TemplateRenderError("模板字段渲染结果数量不匹配。")

    rendered_iter = iter(rendered_values)
    result: dict[str, dict[str, Any]] = {}
    for template in templates:
        entry: dict[str, Any] = {}
        positional: list[str] = []
        for part in template.parts:
            value = next(rendered_iter) if part.needs_render else part.value
            if not value:
                continue
            if part.name is None:
                positional.append(value)
            else:
                entry[part.name] = value
        if positional:
            entry["_positional"] = positional
        if template.comment:
            entry["_comment"] = template.comment
        if entry:
            result[template.name] = entry
    return result
