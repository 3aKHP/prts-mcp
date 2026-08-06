"""Operator artwork (立绘) tool — list illusts/skins and get image variants.

Consumes AKDP image assets synced in ``LOCAL_IMAGE=true`` mode. Registered
only when ``IMAGES_ENABLED=true`` (see server.py).
"""
from __future__ import annotations

import base64
import json
import logging
import threading
from collections import OrderedDict
from pathlib import Path
from typing import Annotated, Any, Literal, Mapping

from pydantic import Field

from prts_mcp.api.prts_wiki import (
    download_image_safe as _download_image_safe,
    get_imageinfo as _get_imageinfo,
    get_template_data as _get_template_data,
    list_allimages as _list_allimages,
)
from prts_mcp.config import Config, activation_snapshot
from prts_mcp.data.images import (
    DEFAULT_VARIANT,
    _load_char_skins,
    build_artwork_label,
    parse_index,
)
from prts_mcp.data.images_sync import _active_generation
from prts_mcp.data.operator import _resolve_char_id
from prts_mcp.output import render_image_result, render_result, text_result

_logger = logging.getLogger(__name__)


def _images_generation() -> Path | None:
    """Return the active images generation directory, or None when unavailable."""
    cfg = Config.load()
    if not cfg.images_enabled:
        return None
    return _active_generation(cfg.images_path)


def _load_index(gen_dir: Path):
    """Parse index.json from a generation dir; None on missing/unreadable."""
    index_path = gen_dir / "index.json"
    if not index_path.is_file():
        return None
    try:
        return parse_index(json.loads(index_path.read_text("utf-8")))
    except (OSError, ValueError):
        return None


def _char_id_of(skin_id: str) -> str:
    """Extract the charId prefix from a skinId.

    ``char_002_amiya#1+`` → ``char_002_amiya``;
    ``char_002_amiya@epoque#4`` → ``char_002_amiya``.
    """
    return skin_id.split("#", 1)[0].split("@", 1)[0]


def _data_not_ready() -> object:
    return text_result(
        "立绘数据未就绪。可能原因：IMAGES_ENABLED 未开启，或图片同步仍在进行中。"
        "请稍后重试；若持续不可用，请检查网络或 GITHUB_TOKEN。"
    )


# ---------------------------------------------------------------------------
# LOCAL_IMAGE=false MediaWiki path
#
# Data flows entirely from PRTS: allimages for file discovery, parsetree
# (CharinfoV2 时装N名称) for fashion labels, imageinfo for variant URLs,
# and download_image_safe for the pixel payload under the #85 boundary.
# True (AKDP) and false (MediaWiki) modes share no data dependency.
# ---------------------------------------------------------------------------

_IMAGE_CACHE_LOCK = threading.Lock()
_image_cache: "OrderedDict[str, bytes]" = OrderedDict()
_IMAGE_CACHE_MAX_BYTES = 256 * 1024 * 1024  # 256 MiB (#85 §4.2)

_MEDIAWIKI_BASE_LABELS: Mapping[str, str] = {"1": "精英零立绘", "2": "精英二立绘"}
_VARIANT_WIDTH: Mapping[str, int] = {"large": 1024, "preview": 256}


def _image_cache_key(artwork_id: str, variant: str) -> str:
    return f"{artwork_id}|{variant}"


def _image_cache_get(artwork_id: str, variant: str) -> bytes | None:
    key = _image_cache_key(artwork_id, variant)
    with _IMAGE_CACHE_LOCK:
        if key in _image_cache:
            _image_cache.move_to_end(key)
            return _image_cache[key]
    return None


def _image_cache_put(artwork_id: str, variant: str, data: bytes) -> None:
    key = _image_cache_key(artwork_id, variant)
    with _IMAGE_CACHE_LOCK:
        _image_cache[key] = data
        _image_cache.move_to_end(key)
        total = sum(len(v) for v in _image_cache.values())
        while total > _IMAGE_CACHE_MAX_BYTES and _image_cache:
            _, evicted = _image_cache.popitem(last=False)
            total -= len(evicted)


def _mediawiki_base_label(suffix: str) -> str:
    base = suffix.rstrip("+")
    plus = "+" in suffix
    label = _MEDIAWIKI_BASE_LABELS.get(base)
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


def _label_from_filename(
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


async def _do_list_mediawiki(operator_name: str) -> object:
    """LOCAL_IMAGE=false list: discover PRTS File: titles + CharinfoV2 labels."""
    prefix = f"立绘_{operator_name}_"
    try:
        files = await _list_allimages(prefix)
        templates = await _get_template_data(operator_name)
    except Exception as exc:  # noqa: BLE001
        return text_result(f"查询 PRTS 立绘失败：{exc}")
    charinfo = templates.get("CharinfoV2")
    if not isinstance(charinfo, Mapping):
        charinfo = {}
    artworks: list[dict] = []
    for f in files:
        name = f.get("name", "")
        label = _label_from_filename(name, charinfo)
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
        return text_result(
            f"未找到「{operator_name}」的立绘。建议先用 search_prts 确认名称。"
        )
    data = {
        "operator_name": operator_name,
        "source": "mediawiki",
        "total": len(artworks),
        "artworks": artworks,
    }
    markdown = _render_list(operator_name, artworks)
    return render_result(
        data,
        markdown,
        summary=f"「{operator_name}」共 {len(artworks)} 张立绘（PRTS MediaWiki），详见 structuredContent",
    )


async def _do_get_mediawiki(
    operator_name: str,
    artwork_id: str | None,
    variant: str | None,
    cfg: Config,
) -> object:
    """LOCAL_IMAGE=false get: MediaWiki imageinfo + safe download (+ LRU)."""
    if not artwork_id:
        return text_result("action=get 时必须提供 artwork_id。请先用 action=list 获取。")
    if variant == "original":
        return text_result(
            "LOCAL_IMAGE=false 模式不提供 original 变体（PRTS 原图常超 1 MiB 安全上限）。"
            "请使用 large 或 preview。"
        )
    chosen = variant or DEFAULT_VARIANT
    width = _VARIANT_WIDTH.get(chosen)
    if width is None:
        return text_result(f"不支持的变体：{chosen}。false 模式可选 large / preview。")
    try:
        info = await _get_imageinfo(artwork_id, width=width)
    except Exception as exc:  # noqa: BLE001
        return text_result(f"查询 PRTS 图片信息失败：{exc}")
    if not info:
        return text_result(f"找不到文件「{artwork_id}」。请用 action=list 重新获取。")
    img_url = info.get("thumburl") or info.get("url")
    if not img_url:
        return text_result(f"「{artwork_id}」无 {chosen} 变体。")
    image_bytes = _image_cache_get(artwork_id, chosen) if cfg.prts_image_cache else None
    if image_bytes is None:
        try:
            image_bytes = await _download_image_safe(img_url)
        except (ValueError, OSError) as exc:
            return text_result(f"下载图片失败：{exc}")
        if cfg.prts_image_cache:
            _image_cache_put(artwork_id, chosen, image_bytes)
    image_b64 = base64.b64encode(image_bytes).decode("ascii")
    # CharinfoV2 is not re-fetched in get (list already provided the precise
    # label); derive a best-effort label from the filename.
    label = _label_from_filename(artwork_id, {}) or artwork_id
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
    return render_image_result(
        markdown,
        image_b64,
        mime,
        data,
        summary=f"{operator_name} 的「{label}」（{chosen}，PRTS MediaWiki）",
    )


async def _do_list(operator_name: str) -> object:
    cfg = Config.load()
    if not cfg.local_image:
        return await _do_list_mediawiki(operator_name)
    try:
        char_id = _resolve_char_id(operator_name)
    except (OSError, AssertionError):
        # gamedata not synced yet (effective_excel_path None or table missing).
        return _data_not_ready()
    if char_id is None:
        return text_result(
            f"找不到干员「{operator_name}」。建议先用 search_prts 确认准确的中文名称。"
        )
    gen_dir = _images_generation()
    if gen_dir is None:
        return _data_not_ready()
    index = _load_index(gen_dir)
    if index is None:
        return _data_not_ready()

    matched = sorted(
        (
            (sid, entry)
            for sid, entry in index.artworks.items()
            if _char_id_of(sid) == char_id
        ),
        key=lambda item: item[0],
    )
    if not matched:
        return text_result(f"未找到「{operator_name}」的立绘数据。")

    char_skins = _load_char_skins()
    artworks = [
        {
            "artwork_id": sid,
            "label": build_artwork_label(sid, char_skins),
            "kind": entry.kind,
            "variants": {
                v: {
                    "width": entry.variants[v].width,
                    "height": entry.variants[v].height,
                    "bytes": entry.variants[v].bytes,
                }
                for v in entry.available_variants()
            },
        }
        for sid, entry in matched
    ]
    data = {
        "operator_name": operator_name,
        "char_id": char_id,
        "total": len(artworks),
        "artworks": artworks,
    }
    markdown = _render_list(operator_name, artworks)
    return render_result(
        data,
        markdown,
        summary=f"「{operator_name}」共 {len(artworks)} 张立绘，详见 structuredContent",
    )


async def _do_get(
    operator_name: str,
    artwork_id: str | None,
    variant: str | None,
) -> object:
    cfg = Config.load()
    if not cfg.local_image:
        return await _do_get_mediawiki(operator_name, artwork_id, variant, cfg)
    if not artwork_id:
        return text_result("action=get 时必须提供 artwork_id。请先用 action=list 获取。")
    chosen = variant or DEFAULT_VARIANT
    gen_dir = _images_generation()
    if gen_dir is None:
        return _data_not_ready()
    index = _load_index(gen_dir)
    if index is None:
        return _data_not_ready()

    entry = index.artworks.get(artwork_id)
    if entry is None:
        return text_result(
            f"找不到 artwork_id「{artwork_id}」。该 ID 不透明，请用 action=list 重新获取。"
        )
    variant_meta = entry.variant(chosen)
    if variant_meta is None:
        available = "、".join(entry.available_variants()) or "无"
        return text_result(
            f"artwork_id「{artwork_id}」不提供「{chosen}」变体（可用：{available}）。"
        )
    # The file field comes from the network-downloaded index; contain it to
    # the generation dir so a malformed/compromised upstream cannot read an
    # arbitrary host file and exfiltrate it base64-encoded.
    gen_resolved = gen_dir.resolve()
    png_path = (gen_dir / variant_meta.file).resolve()
    if not png_path.is_relative_to(gen_resolved) or not png_path.is_file():
        return text_result(
            f"图片文件缺失：{variant_meta.file}。同步可能不完整，请稍后重试。"
        )
    try:
        image_bytes = png_path.read_bytes()
    except OSError as exc:
        return text_result(f"读取图片文件失败：{exc}")

    image_b64 = base64.b64encode(image_bytes).decode("ascii")
    char_skins = _load_char_skins()
    label = build_artwork_label(artwork_id, char_skins)
    markdown = (
        f"**{label}**（{operator_name}）\n"
        f"变体：{chosen}｜尺寸：{variant_meta.width}×{variant_meta.height}"
        f"｜{variant_meta.bytes} bytes\n"
        f"artwork_id：`{artwork_id}`"
    )
    data = {
        "operator_name": operator_name,
        "artwork_id": artwork_id,
        "label": label,
        "variant": chosen,
        "width": variant_meta.width,
        "height": variant_meta.height,
        "bytes": variant_meta.bytes,
        "sha256": variant_meta.sha256,
    }
    return render_image_result(
        markdown,
        image_b64,
        "image/png",
        data,
        summary=f"{operator_name} 的「{label}」（{chosen}）",
    )


def _render_list(operator_name: str, artworks: list[dict]) -> str:
    header = f"# 「{operator_name}」的立绘（共 {len(artworks)} 张）\n"
    lines = []
    for art in artworks:
        variants = "/".join(art["variants"].keys())
        lines.append(f"- **{art['label']}**｜`{art['artwork_id']}`｜变体：{variants}")
    return header + "\n".join(lines)


def register_artwork_tools(mcp) -> None:  # type: ignore[no-untyped-def]
    """Register the ``operator_artwork`` tool on the given FastMCP instance."""

    @mcp.tool()
    @activation_snapshot
    async def operator_artwork(
        operator_name: Annotated[str, Field(description="干员名称（中文），如「阿米娅」。")],
        action: Annotated[Literal["list", "get"], Field(description="操作（必填）：list=列出该干员所有立绘及 artwork_id；get=按 artwork_id 获取一张图片。")],
        artwork_id: Annotated[str | None, Field(default=None, description="仅 action=get 必填：list 返回的不透明 token，原样回传即可，不可自行构造。")] = None,
        variant: Annotated[Literal["original", "large", "preview"] | None, Field(default=None, description="仅 action=get 生效：图片变体。large=max 1024px（默认），preview=max 256px，original=原图（需服务端开启 ORIGINAL_IMAGE 同步）。")] = None,
    ) -> object:
        """查询干员立绘（精英化立绘、时装等）并获取图片。

        先用 action="list" 拿到该干员所有立绘的 artwork_id 与元数据（不返回图片），
        再用 action="get" + artwork_id 获取一张图片（base64 编码，默认 large 变体）。
        单次 get 最多返回一张图片。
        """
        if action == "list":
            return await _do_list(operator_name)
        return await _do_get(operator_name, artwork_id, variant)
