"""LOCAL_IMAGE=false path: MediaWiki artwork backend.

Owns filename→label parsing, the LRU image cache, and the two MediaWiki
orchestrations (list via allimages + CharinfoV2, get via imageinfo +
safe download). Fetches exclusively through the ``api`` client
(:mod:`prts_mcp.api.prts_wiki`); returns ``str`` messages or
:class:`artwork_format.ListOutcome` / :class:`artwork_format.GetOutcome`
for the tool layer to wrap.

Mirrors ts/src/data/artworkMediawiki.ts.
"""
from __future__ import annotations

import base64
import threading
from collections import OrderedDict
from typing import Any, Mapping

from prts_mcp.api.prts_wiki import (
    download_image_safe,
    get_imageinfo,
    get_template_data,
    list_allimages,
)
from prts_mcp.config import Config
from prts_mcp.data.artwork_format import GetOutcome, ListOutcome, render_list
from prts_mcp.data.artwork_local import normalized_artwork_form_name
from prts_mcp.data.images import (
    BASE_ILLUST_LABELS,
    DEFAULT_VARIANT,
)

_IMAGE_CACHE_LOCK = threading.Lock()
_image_cache: "OrderedDict[str, bytes]" = OrderedDict()
_IMAGE_CACHE_MAX_BYTES = 256 * 1024 * 1024  # 256 MiB (#85 §4.2)

VARIANT_WIDTH: Mapping[str, int] = {"large": 1024, "preview": 256}


def _image_cache_key(artwork_id: str, variant: str) -> str:
    return f"{artwork_id}|{variant}"


def image_cache_get(artwork_id: str, variant: str) -> bytes | None:
    key = _image_cache_key(artwork_id, variant)
    with _IMAGE_CACHE_LOCK:
        if key in _image_cache:
            _image_cache.move_to_end(key)
            return _image_cache[key]
    return None


def image_cache_put(artwork_id: str, variant: str, data: bytes) -> None:
    key = _image_cache_key(artwork_id, variant)
    with _IMAGE_CACHE_LOCK:
        _image_cache[key] = data
        _image_cache.move_to_end(key)
        total = sum(len(v) for v in _image_cache.values())
        while total > _IMAGE_CACHE_MAX_BYTES and _image_cache:
            _, evicted = _image_cache.popitem(last=False)
            total -= len(evicted)


def cache_stats() -> dict[str, dict]:
    """Return ``{cache_name: {loaded, count, bytes}}`` for instrumentation (#104)."""
    with _IMAGE_CACHE_LOCK:
        count = len(_image_cache)
        total = sum(len(v) for v in _image_cache.values())
    return {
        "image_cache": {"loaded": count > 0, "count": count, "bytes": total},
    }


def _mediawiki_base_label(suffix: str) -> str:
    base = suffix.rstrip("+")
    plus = "+" in suffix
    label = BASE_ILLUST_LABELS.get(base)
    if label is None:
        label = f"立绘 {base}" if base else "立绘"
    if plus:
        label += "（变体）"
    return label


def _mediawiki_fashion_label(rest: str, charinfo: Mapping[str, Any]) -> str:
    """rest is like 'skin3' (optionally 'skin2_sp'); leading digits = skin N."""
    num = ""
    for ch in rest[4:]:
        if ch.isdigit():
            num += ch
        else:
            break
    label: str | None = None
    if num:
        val = charinfo.get(f"时装{num}名称")
        if isinstance(val, str) and val:
            label = val
    if label is None:
        label = f"时装 {num}" if num else "时装"
    return label


def label_from_filename(
    filename: str, charinfo: Mapping[str, Any],
) -> str | None:
    """Derive a label from a PRTS filename like ``立绘_阿米娅_2.png``.

    Returns None for files we do not expose (建筑小人 ``_Nb``, non-png, or
    names that don't match the ``立绘_<name>_<suffix>`` shape). Multi-form
    operators carry the form in the name segment: ``立绘_阿米娅(近卫)_2.png``.
    """
    if not filename.endswith(".png"):
        return None
    base = filename[:-4]
    parts = base.split("_", 2)
    if len(parts) < 3:
        return None
    name = parts[1]
    suffix = parts[2]
    form: str | None = None
    if "(" in name:
        b = name.find("(")
        e = name.find(")", b)
        if 0 <= b < e:
            form = name[b + 1:e]
    if suffix.startswith("skin"):
        label = _mediawiki_fashion_label(suffix, charinfo)
    elif suffix.endswith("b"):
        return None  # 建筑小人
    else:
        label = _mediawiki_base_label(suffix)
    if form:
        label += f"（{form}）"
    return label


def operator_from_filename(filename: str) -> str | None:
    """Return the declaring operator segment for a listable MediaWiki artwork."""
    if not filename.endswith(".png") or not filename.startswith("立绘_"):
        return None
    if label_from_filename(filename, {}) is None:
        return None
    base = filename[:-4]
    separator = base.find("_", len("立绘_"))
    if separator < 0:
        return None
    operator_name = base[len("立绘_"):separator]
    return operator_name or None


def _normalized_operator_name(name: str) -> str:
    # Identical normalization to artwork_local.normalized_artwork_form_name;
    # kept as a thin alias so ownership checks read locally.
    return normalized_artwork_form_name(name)


def artwork_belongs_to_operator(filename: str, operator_name: str) -> bool:
    """Check that a MediaWiki artwork belongs to its requested operator."""
    artwork_operator = operator_from_filename(filename)
    if artwork_operator is None:
        return False
    requested = _normalized_operator_name(operator_name)
    actual = _normalized_operator_name(artwork_operator)
    # artwork_id is opaque and list-scoped. A base-name request must not be
    # able to retrieve a transformed form (or vice versa) by reusing a token.
    return requested == actual


async def list_artworks_mediawiki(operator_name: str) -> ListOutcome | str:
    """LOCAL_IMAGE=false list: discover PRTS File: titles + CharinfoV2 labels."""
    normalized_name = normalized_artwork_form_name(operator_name)
    prefix = f"立绘_{normalized_name}_"
    try:
        files = await list_allimages(prefix)
        templates = await get_template_data(normalized_name)
    except Exception as exc:  # noqa: BLE001
        return f"查询 PRTS 立绘失败：{exc}"
    charinfo = templates.get("CharinfoV2")
    if not isinstance(charinfo, Mapping):
        charinfo = {}
    artworks: list[dict] = []
    for f in files:
        name = f.get("name", "")
        label = label_from_filename(name, charinfo)
        if label is None:
            continue
        artworks.append({
            "artwork_id": name,
            "label": label,
            "kind": "skin" if "skin" in name else "base",
            "variants": {"large": {}, "preview": {}},
        })
    artworks.sort(key=lambda a: a["artwork_id"])
    if not artworks:
        return f"未找到「{operator_name}」的立绘。建议先用 search_prts 确认名称。"
    data = {
        "operator_name": operator_name,
        "source": "mediawiki",
        "total": len(artworks),
        "artworks": artworks,
    }
    markdown = render_list(operator_name, artworks)
    return ListOutcome(
        data=data,
        markdown=markdown,
        summary=f"「{operator_name}」共 {len(artworks)} 张立绘（PRTS MediaWiki），详见 structuredContent",
    )


async def get_artwork_mediawiki(
    operator_name: str,
    artwork_id: str | None,
    variant: str | None,
    cfg: Config,
) -> GetOutcome | str:
    """LOCAL_IMAGE=false get: MediaWiki imageinfo + safe download (+ LRU)."""
    if not artwork_id:
        return "action=get 时必须提供 artwork_id。请先用 action=list 获取。"
    if not artwork_belongs_to_operator(artwork_id, operator_name):
        return (
            f"该 artwork_id 不属于干员「{operator_name}」。"
            "artwork_id 为不透明 token，请用 action=list 重新获取。"
        )
    if variant == "original":
        return (
            "LOCAL_IMAGE=false 模式不提供 original 变体（PRTS 原图常超 1 MiB 安全上限）。"
            "请使用 large 或 preview。"
        )
    chosen = variant or DEFAULT_VARIANT
    width = VARIANT_WIDTH.get(chosen)
    if width is None:
        return f"不支持的变体：{chosen}。false 模式可选 large / preview。"
    try:
        info = await get_imageinfo(artwork_id, width=width)
    except Exception as exc:  # noqa: BLE001
        return f"查询 PRTS 图片信息失败：{exc}"
    if not info:
        return f"找不到文件「{artwork_id}」。请用 action=list 重新获取。"
    img_url = info.get("thumburl") or info.get("url")
    if not img_url:
        return f"「{artwork_id}」无 {chosen} 变体。"
    image_bytes = image_cache_get(artwork_id, chosen) if cfg.prts_image_cache else None
    if image_bytes is None:
        try:
            image_bytes = await download_image_safe(img_url)
        except Exception as exc:  # noqa: BLE001 — ValueError (boundary) or httpx.HTTPError (network)
            return f"下载图片失败：{exc}"
        if cfg.prts_image_cache:
            image_cache_put(artwork_id, chosen, image_bytes)
    image_b64 = base64.b64encode(image_bytes).decode("ascii")
    # CharinfoV2 is not re-fetched in get (list already provided the precise
    # label); derive a best-effort label from the filename.
    label = label_from_filename(artwork_id, {}) or artwork_id
    mime = info.get("mime") or "image/png"
    markdown = (
        f"**{label}**（{operator_name}）\n"
        f"变体：{chosen}｜来源：PRTS MediaWiki\n"
        f"artwork_id：`{artwork_id}`"
    )
    data = {
        "operator_name": operator_name,
        "artwork_id": artwork_id,
        "label": label,
        "variant": chosen,
        "source": "mediawiki",
        "width": info.get("width"),
        "height": info.get("height"),
        "bytes": len(image_bytes),
    }
    return GetOutcome(
        markdown=markdown,
        image_b64=image_b64,
        mime=mime,
        data=data,
        summary=f"{operator_name} 的「{label}」（{chosen}，PRTS MediaWiki）",
    )
