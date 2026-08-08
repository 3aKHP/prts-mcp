"""Operator artwork (立绘) tool — list illusts/skins and get image variants.

Consumes AKDP image assets synced in ``LOCAL_IMAGE=true`` mode. Registered
only when ``IMAGES_ENABLED=true`` (see server.py).
"""
from __future__ import annotations

import base64
import json
from pathlib import Path
from typing import Annotated, Literal, Mapping

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
    load_char_skins,
    build_artwork_label,
    parse_index,
)
from prts_mcp.data.artwork_mediawiki import (
    VARIANT_WIDTH,
    artwork_belongs_to_operator,
    image_cache_get,
    image_cache_put,
    label_from_filename,
)
from prts_mcp.data.images_sync import active_generation
from prts_mcp.data.operator import resolve_char_id
from prts_mcp.output import render_image_result, render_result, text_result


# These IDs represent forms that deliberately share the base character's
# display name in the game table. Keep this resolver local to artwork: other
# operator tools must retain their ordinary exact-name lookup contract.
_ARTWORK_FORM_CHAR_IDS: Mapping[str, str] = {
    "阿米娅(近卫)": "char_1001_amiya2",
    "阿米娅(医疗)": "char_1037_amiya3",
}


def _resolve_artwork_char_id(operator_name: str) -> str | None:
    """Resolve an artwork-only form alias without widening normal lookup."""
    return _ARTWORK_FORM_CHAR_IDS.get(operator_name) or resolve_char_id(operator_name)


def _images_generation() -> Path | None:
    """Return the active images generation directory, or None when unavailable."""
    cfg = Config.load()
    if not cfg.images_enabled:
        return None
    return active_generation(cfg.images_path)


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
    if not artwork_belongs_to_operator(artwork_id, operator_name):
        return text_result(
            f"该 artwork_id 不属于干员「{operator_name}」。"
            "artwork_id 为不透明 token，请用 action=list 重新获取。"
        )
    if variant == "original":
        return text_result(
            "LOCAL_IMAGE=false 模式不提供 original 变体（PRTS 原图常超 1 MiB 安全上限）。"
            "请使用 large 或 preview。"
        )
    chosen = variant or DEFAULT_VARIANT
    width = VARIANT_WIDTH.get(chosen)
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
    image_bytes = image_cache_get(artwork_id, chosen) if cfg.prts_image_cache else None
    if image_bytes is None:
        try:
            image_bytes = await _download_image_safe(img_url)
        except Exception as exc:  # noqa: BLE001 — ValueError (boundary) or httpx.HTTPError (network)
            return text_result(f"下载图片失败：{exc}")
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
        char_id = _resolve_artwork_char_id(operator_name)
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

    char_skins = load_char_skins()
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
    try:
        char_id = _resolve_artwork_char_id(operator_name)
    except (OSError, AssertionError):
        return _data_not_ready()
    if char_id is None:
        return text_result(
            f"找不到干员「{operator_name}」。建议先用 search_prts 确认准确的中文名称。"
        )
    if _char_id_of(artwork_id) != char_id:
        return text_result(
            f"该 artwork_id 不属于干员「{operator_name}」。"
            "artwork_id 为不透明 token，请用 action=list 重新获取。"
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
    char_skins = load_char_skins()
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
    """Register the ``operator_artwork`` tool on the given MCPServer instance."""

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
