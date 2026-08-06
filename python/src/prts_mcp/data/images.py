"""Image artwork index schema, data loading and label construction.

Consumes the AKDP ``akdp-images/v1`` index.json (frozen schema in
``arknights-data-pipeline/docs/image-index-schema.md``). Semantic labels
are joined from ``skin_table.json`` at the consumer side; the index itself
carries no display names, keeping the schema stable across game versions.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Mapping

from prts_mcp.config import (
    Config,
    activation_aware_cache,
    register_activation_listener,
)
from prts_mcp.data.stores import DirectoryStore

_logger = logging.getLogger(__name__)

SCHEMA_VERSION = "akdp-images/v1"
VARIANT_ORDER: tuple[str, ...] = ("original", "large", "preview")
DEFAULT_VARIANT = "large"


# ---------------------------------------------------------------------------
# Index schema types
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class VariantMeta:
    file: str
    width: int
    height: int
    bytes: int
    sha256: str


@dataclass(frozen=True)
class ArtworkEntry:
    skin_id: str
    kind: str            # "base" | "skin"
    shard: str           # "chararts" | "skinpack"
    since_version: str
    variants: Mapping[str, VariantMeta]

    def variant(self, name: str) -> VariantMeta | None:
        """Return the named variant or None when absent."""
        return self.variants.get(name)

    def available_variants(self) -> tuple[str, ...]:
        """Variants present for this artwork, in canonical order."""
        return tuple(v for v in VARIANT_ORDER if v in self.variants)


@dataclass(frozen=True)
class ImagesIndex:
    schema_version: str
    baseline_version: str
    current_version: str
    shards: Mapping[str, str]
    artworks: Mapping[str, ArtworkEntry]


def _parse_variant(raw: Any) -> VariantMeta | None:
    if not isinstance(raw, dict):
        return None
    try:
        return VariantMeta(
            file=str(raw["file"]),
            width=int(raw["w"]),
            height=int(raw["h"]),
            bytes=int(raw["bytes"]),
            sha256=str(raw["sha256"]),
        )
    except (KeyError, TypeError, ValueError):
        return None


def parse_index(data: Mapping[str, Any]) -> ImagesIndex | None:
    """Parse a raw index.json mapping. Returns None on schema mismatch.

    The schema is frozen at ``akdp-images/v1``; an unfamiliar schemaVersion
    is rejected so a future incompatible index does not silently misparse.
    """
    if data.get("schemaVersion") != SCHEMA_VERSION:
        _logger.warning(
            "images index schemaVersion mismatch: expected %r, got %r",
            SCHEMA_VERSION,
            data.get("schemaVersion"),
        )
        return None
    artworks: dict[str, ArtworkEntry] = {}
    raw_artworks = data.get("artworks")
    if isinstance(raw_artworks, dict):
        for skin_id, entry in raw_artworks.items():
            if not isinstance(entry, dict):
                continue
            variants: dict[str, VariantMeta] = {}
            for vname in VARIANT_ORDER:
                parsed = _parse_variant(entry.get(vname))
                if parsed is not None:
                    variants[vname] = parsed
            if not variants:
                continue
            artworks[str(skin_id)] = ArtworkEntry(
                skin_id=str(skin_id),
                kind=str(entry.get("kind", "base")),
                shard=str(entry.get("shard", "")),
                since_version=str(entry.get("sinceVersion", "")),
                variants=variants,
            )
    raw_shards = data.get("shards")
    shards = (
        {str(k): str(v) for k, v in raw_shards.items()}
        if isinstance(raw_shards, dict)
        else {}
    )
    return ImagesIndex(
        schema_version=SCHEMA_VERSION,
        baseline_version=str(data.get("baselineVersion", "")),
        current_version=str(data.get("currentVersion", "")),
        shards=shards,
        artworks=artworks,
    )


# ---------------------------------------------------------------------------
# skin_table.json loading (charSkins mapping)
# ---------------------------------------------------------------------------


@activation_aware_cache(maxsize=1)
def _load_char_skins() -> dict[str, Any]:
    """Load the ``charSkins`` mapping from ``skin_table.json``.

    Returns an empty mapping when excel data is unavailable or the file is
    absent (the bundled fallback does not ship skin_table); callers fall
    back to skinId-derived labels in that case.
    """
    cfg = Config.load()
    excel = cfg.effective_excel_path
    if excel is None:
        return {}
    store = DirectoryStore(excel)
    if not store.exists("skin_table.json"):
        return {}
    try:
        table = store.read_json("skin_table.json")
    except (OSError, ValueError):
        return {}
    char_skins = table.get("charSkins")
    return char_skins if isinstance(char_skins, dict) else {}


def clear_image_caches() -> None:
    """Clear image-related caches after synced game data changes on disk."""
    _load_char_skins.cache_clear()


register_activation_listener(clear_image_caches)


# ---------------------------------------------------------------------------
# Label construction
# ---------------------------------------------------------------------------

_BASE_ILLUST_LABELS: Mapping[str, str] = {"1": "精英零立绘", "2": "精英二立绘"}


def build_artwork_label(
    skin_id: str,
    char_skins: Mapping[str, Any] | None = None,
) -> str:
    """Construct a human-readable label for an artwork ``skin_id``.

    Priority:
    - ``@`` fashion skins → ``displaySkin.skinName`` (e.g. "报童"); falls back
      to a theme-derived placeholder when the skin name is unavailable.
    - ``#N`` base illusts → programmatic label from the number suffix
      (e.g. "精英二立绘"); a ``+`` suffix appends "（变体）".
    - Unknown shapes → a tolerant fallback using the raw skin_id.

    Labels intentionally omit the operator name: ``operator_artwork`` list
    is already scoped to one operator, so the label only needs to
    distinguish that operator's illusts/skins from each other.
    """
    skins = char_skins if char_skins is not None else _load_char_skins()
    entry = skins.get(skin_id)

    if "@" in skin_id:
        if isinstance(entry, dict):
            display = entry.get("displaySkin")
            if isinstance(display, dict):
                name = display.get("skinName")
                if name:
                    return str(name)
        theme = skin_id.split("@", 1)[1].split("#", 1)[0]
        return f"时装（{theme}）" if theme else "时装"

    suffix = skin_id.rsplit("#", 1)[-1] if "#" in skin_id else ""
    base_num = suffix.rstrip("+")
    plus = "+" in suffix
    label = _BASE_ILLUST_LABELS.get(base_num)
    if label is None:
        label = f"立绘 {base_num}" if base_num else "立绘"
    if plus:
        label += "（变体）"
    return label
