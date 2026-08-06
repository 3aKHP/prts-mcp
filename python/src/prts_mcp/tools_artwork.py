"""Operator artwork (立绘) tool — list illusts/skins and get image variants.

Consumes AKDP image assets synced in ``LOCAL_IMAGE=true`` mode. Registered
only when ``IMAGES_ENABLED=true`` (see server.py).
"""
from __future__ import annotations

import base64
import json
import logging
from pathlib import Path
from typing import Annotated, Literal

from pydantic import Field

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


async def _do_list(operator_name: str) -> object:
    char_id = _resolve_char_id(operator_name)
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
    png_path = gen_dir / variant_meta.file
    if not png_path.is_file():
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
