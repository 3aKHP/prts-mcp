"""Artwork result shapes and the shared markdown list renderer.

Both artwork backends (:mod:`prts_mcp.data.artwork_local` and
:mod:`prts_mcp.data.artwork_mediawiki`) return either a plain ``str``
(content-only message) or one of the outcome named tuples defined here;
the tool layer (:mod:`prts_mcp.tools_artwork`) owns the output-channel
wrapping, so data modules never import :mod:`prts_mcp.output`.
"""
from __future__ import annotations

from typing import NamedTuple


class ListOutcome(NamedTuple):
    """A successful list action: structured payload + markdown + summary."""

    data: dict
    markdown: str
    summary: str


class GetOutcome(NamedTuple):
    """A successful get action: image bytes (base64) + metadata payload."""

    markdown: str
    image_b64: str
    mime: str
    data: dict
    summary: str


def normalized_artwork_form_name(operator_name: str) -> str:
    """Normalize only the punctuation accepted by artwork form aliases."""
    return operator_name.strip().replace("（", "(").replace("）", ")")


def render_list(operator_name: str, artworks: list[dict]) -> str:
    """Render the shared artwork list markdown (used by both backends)."""
    header = f"# 「{operator_name}」的立绘（共 {len(artworks)} 张）\n"
    lines = []
    for art in artworks:
        variants = "/".join(art["variants"].keys())
        lines.append(f"- **{art['label']}**｜`{art['artwork_id']}`｜变体：{variants}")
    return header + "\n".join(lines)
