"""Local AKDP-backed artwork backend (``LOCAL_IMAGE=true``).

Reads the synced images generation directory (index.json + PNG files) and
owns artwork-specific char-id resolution (the Amiya form aliases). Stays
free of ``sync``/``api``/``output`` imports: the generation directory is
resolved by the tool layer and passed in, and results are returned as
``str`` messages or :class:`artwork_format.ListOutcome` /
:class:`artwork_format.GetOutcome` for the tool layer to wrap.

Mirrors ts/src/data/artworkLocal.ts.
"""
from __future__ import annotations

import base64
import json
from pathlib import Path
from typing import Mapping

from prts_mcp.data.artwork_format import GetOutcome, ListOutcome, render_list
from prts_mcp.data.images import (
    DEFAULT_VARIANT,
    build_artwork_label,
    load_char_skins,
    parse_index,
)
from prts_mcp.data.operator import resolve_char_id

# These IDs represent forms that deliberately share the base character's
# display name in the game table. Keep this resolver local to artwork: other
# operator tools must retain their ordinary exact-name lookup contract.
ARTWORK_FORM_CHAR_IDS: Mapping[str, str] = {
    "阿米娅(近卫)": "char_1001_amiya2",
    "阿米娅(医疗)": "char_1037_amiya3",
}


def normalized_artwork_form_name(operator_name: str) -> str:
    """Normalize only the punctuation accepted by artwork form aliases."""
    return operator_name.strip().replace("（", "(").replace("）", ")")


def resolve_artwork_char_id(operator_name: str) -> str | None:
    """Resolve an artwork-only form alias without widening normal lookup."""
    normalized = normalized_artwork_form_name(operator_name)
    return ARTWORK_FORM_CHAR_IDS.get(normalized) or resolve_char_id(operator_name)


def char_id_of(skin_id: str) -> str:
    """Extract the charId prefix from a skinId.

    ``char_002_amiya#1+`` → ``char_002_amiya``;
    ``char_002_amiya@epoque#4`` → ``char_002_amiya``.
    """
    return skin_id.split("#", 1)[0].split("@", 1)[0]


def data_not_ready_message() -> str:
    return (
        "立绘数据未就绪。可能原因：IMAGES_ENABLED 未开启，或图片同步仍在进行中。"
        "请稍后重试；若持续不可用，请检查网络或 GITHUB_TOKEN。"
    )


def load_index(gen_dir: Path):
    """Parse index.json from a generation dir; None on missing/unreadable."""
    index_path = gen_dir / "index.json"
    if not index_path.is_file():
        return None
    try:
        return parse_index(json.loads(index_path.read_text("utf-8")))
    except (OSError, ValueError):
        return None


def list_artworks_local(operator_name: str, gen_dir: Path | None) -> ListOutcome | str:
    """LOCAL_IMAGE=true list: filter the index by the operator's char_id."""
    try:
        char_id = resolve_artwork_char_id(operator_name)
    except (OSError, AssertionError):
        # gamedata not synced yet (effective_excel_path None or table missing).
        return data_not_ready_message()
    if char_id is None:
        return f"找不到干员「{operator_name}」。建议先用 search_prts 确认准确的中文名称。"
    if gen_dir is None:
        return data_not_ready_message()
    index = load_index(gen_dir)
    if index is None:
        return data_not_ready_message()

    matched = sorted(
        (
            (sid, entry)
            for sid, entry in index.artworks.items()
            if char_id_of(sid) == char_id
        ),
        key=lambda item: item[0],
    )
    if not matched:
        return f"未找到「{operator_name}」的立绘数据。"

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
    markdown = render_list(operator_name, artworks)
    return ListOutcome(
        data=data,
        markdown=markdown,
        summary=f"「{operator_name}」共 {len(artworks)} 张立绘，详见 structuredContent",
    )


def get_artwork_local(
    operator_name: str,
    artwork_id: str,
    variant: str | None,
    gen_dir: Path | None,
) -> GetOutcome | str:
    """LOCAL_IMAGE=true get: read one contained PNG and base64-encode it."""
    chosen = variant or DEFAULT_VARIANT
    if gen_dir is None:
        return data_not_ready_message()
    index = load_index(gen_dir)
    if index is None:
        return data_not_ready_message()

    entry = index.artworks.get(artwork_id)
    if entry is None:
        return f"找不到 artwork_id「{artwork_id}」。该 ID 不透明，请用 action=list 重新获取。"
    try:
        char_id = resolve_artwork_char_id(operator_name)
    except (OSError, AssertionError):
        return data_not_ready_message()
    if char_id is None:
        return f"找不到干员「{operator_name}」。建议先用 search_prts 确认准确的中文名称。"
    if char_id_of(artwork_id) != char_id:
        return (
            f"该 artwork_id 不属于干员「{operator_name}」。"
            "artwork_id 为不透明 token，请用 action=list 重新获取。"
        )
    variant_meta = entry.variant(chosen)
    if variant_meta is None:
        available = "、".join(entry.available_variants()) or "无"
        return f"artwork_id「{artwork_id}」不提供「{chosen}」变体（可用：{available}）。"
    # The file field comes from the network-downloaded index; contain it to
    # the generation dir so a malformed/compromised upstream cannot read an
    # arbitrary host file and exfiltrate it base64-encoded. Both paths are
    # resolve()d so symlink escapes are caught, and the read operates on the
    # resolved path — the same one the containment check verified.
    gen_resolved = gen_dir.resolve()
    png_path = (gen_dir / variant_meta.file).resolve()
    if not png_path.is_relative_to(gen_resolved) or not png_path.is_file():
        return f"图片文件缺失：{variant_meta.file}。同步可能不完整，请稍后重试。"
    try:
        image_bytes = png_path.read_bytes()
    except OSError as exc:
        return f"读取图片文件失败：{exc}"

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
    return GetOutcome(
        markdown=markdown,
        image_b64=image_b64,
        mime="image/png",
        data=data,
        summary=f"{operator_name} 的「{label}」（{chosen}）",
    )
