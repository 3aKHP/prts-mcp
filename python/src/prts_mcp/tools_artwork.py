"""Operator artwork (立绘) tool — registration and local/MediaWiki dispatch.

The data-source backends live in ``data/artwork_local`` and
``data/artwork_mediawiki``; they return ``str`` messages or
``artwork_format`` outcome tuples, and this module owns the output-channel
wrapping and the images-generation resolution (the only sync-tier touch).

Consumes AKDP image assets synced in ``LOCAL_IMAGE=true`` mode. Registered
only when ``IMAGES_ENABLED=true`` (see server.py).
"""
from __future__ import annotations

from pathlib import Path
from typing import Annotated, Literal

from pydantic import Field

from prts_mcp.activation import activation_snapshot
from prts_mcp.config import Config
from prts_mcp.data.artwork_format import GetOutcome, ListOutcome
from prts_mcp.data.artwork_local import get_artwork_local, list_artworks_local
from prts_mcp.data.artwork_mediawiki import (
    get_artwork_mediawiki,
    list_artworks_mediawiki,
)
from prts_mcp.data.images_sync import active_generation
from prts_mcp.output import render_image_result, render_result, text_result


def _images_generation() -> Path | None:
    """Return the active images generation directory, or None when unavailable."""
    cfg = Config.load()
    if not cfg.images_enabled:
        return None
    return active_generation(cfg.images_path)


async def _do_list(operator_name: str) -> object:
    cfg = Config.load()
    if not cfg.local_image:
        outcome = await list_artworks_mediawiki(operator_name)
    else:
        outcome = list_artworks_local(operator_name, _images_generation())
    if isinstance(outcome, str):
        return text_result(outcome)
    outcome: ListOutcome
    return render_result(outcome.data, outcome.markdown, summary=outcome.summary)


async def _do_get(
    operator_name: str,
    artwork_id: str | None,
    variant: str | None,
) -> object:
    cfg = Config.load()
    if not cfg.local_image:
        outcome = await get_artwork_mediawiki(operator_name, artwork_id, variant, cfg)
    else:
        if not artwork_id:
            return text_result("action=get 时必须提供 artwork_id。请先用 action=list 获取。")
        outcome = get_artwork_local(operator_name, artwork_id, variant, _images_generation())
    if isinstance(outcome, str):
        return text_result(outcome)
    outcome: GetOutcome
    return render_image_result(
        outcome.markdown,
        outcome.image_b64,
        outcome.mime,
        outcome.data,
        summary=outcome.summary,
    )


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
