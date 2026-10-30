"""Minimal LTS v2 consumer: rebuild the selected baseline/delta chain."""
from __future__ import annotations
import hashlib
import json
import shutil
from pathlib import Path
from uuid import uuid4
from typing import Callable
from zipfile import ZipFile

from prts_mcp.data.images_v2 import validate
from prts_mcp.sync.generation_store import active_generation, load_meta, save_meta, releases_dir, prune_generations
from prts_mcp.sync.release_activation import safe_extract_zip
from prts_mcp.sync.transport import stream_cascading


def _hash(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def sync_v2(root: Path, tag: str, keys: tuple[str, ...], base: str, read_small: Callable[[str], bytes | None]) -> tuple[str, bool]:
    """Rebuild and activate a verified chain; return its version and change flag."""
    def read(version_tag):
        blob = read_small(f"{base}/{version_tag}/index.json")
        if blob is None:
            raise ValueError("v2 index download failed")
        raw = json.loads(blob)
        if not validate(raw) or version_tag != "images2-" + raw["currentVersion"]:
            raise ValueError("invalid v2 index identity")
        return raw
    index = read(tag)
    meta = load_meta(root)
    if meta and meta.get("schemaVersion") == "akdp-images/v2":
        if meta.get("currentVersion", "") > index["currentVersion"]:
            raise ValueError("refusing image version downgrade")
        if (meta.get("currentVersion") == index["currentVersion"] and set(meta.get("shardsSynced", [])) == set(keys)
                and active_generation(root) is not None):
            return index["currentVersion"], False
    chain = []
    current = index
    while True:
        if current["baselineVersion"] != index["baselineVersion"] or current["baselineParts"] != index["baselineParts"]:
            raise ValueError("baseline lineage changed")
        chain.append(("images2-" + current["currentVersion"], current["deltaParts"]))
        if current["currentVersion"] == index["baselineVersion"]:
            break
        current = read("images2-" + current["previousVersion"])
    tree = releases_dir(root)
    tree.mkdir(parents=True, exist_ok=True)
    name = "v2-" + uuid4().hex
    stage = tree / ("." + name + ".tmp")
    stage.mkdir()
    try:
        jobs = [("images2-baseline-" + index["baselineVersion"], index["baselineParts"])] + list(reversed(chain))
        for version_tag, parts in jobs:
            for part in parts:
                if part["group"] not in keys:
                    continue
                archive = stage / ".part.zip"
                stream_cascading(f"{base}/{version_tag}/{part['file']}", archive)
                if archive.stat().st_size != part["bytes"] or _hash(archive) != part["sha256"]:
                    raise ValueError("v2 ZIP digest mismatch")
                with ZipFile(archive) as zipped:
                    if len(zipped.namelist()) != len(part["members"]) or set(zipped.namelist()) != set(part["members"]):
                        raise ValueError("v2 ZIP member mismatch")
                    for member, spec in part["members"].items():
                        h = hashlib.sha256()
                        count = 0
                        with zipped.open(member) as stream:
                            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                                h.update(chunk)
                                count += len(chunk)
                        if count != spec["bytes"] or h.hexdigest() != spec["sha256"]:
                            raise ValueError("v2 member digest mismatch")
                safe_extract_zip(archive, stage)
                archive.unlink()
        expected = {}
        for artwork in index["artworks"].values():
            for tier in ("original", "large", "preview"):
                if tier in artwork and artwork["shard"] + "-" + tier in keys:
                    v = artwork[tier]
                    expected[v["file"]] = v
        for path in stage.glob("*.png"):
            if path.name not in expected:
                path.unlink()
        for filename, spec in expected.items():
            path = stage / filename
            if path.stat().st_size != spec["bytes"] or _hash(path) != spec["sha256"]:
                raise ValueError("v2 target digest mismatch")
        (stage / "index.json").write_text(json.dumps(index))
        gen_meta = dict(schemaVersion="akdp-images/v2", baselineVersion=index["baselineVersion"], currentVersion=index["currentVersion"], shardsSynced=list(keys))
        save_meta(stage, gen_meta)
        activated = tree / name
        stage.replace(activated)
        save_meta(root, {**gen_meta, "generation_root": str(activated.relative_to(root))})
        prune_generations(tree, activated)
        return index["currentVersion"], True
    finally:
        if stage.exists():
            shutil.rmtree(stage)
