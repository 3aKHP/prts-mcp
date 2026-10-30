"""Pure v2 index validation shared by the legacy reader and synchronizer."""
from __future__ import annotations
import re

SCHEMA = "akdp-images/v2"


def flat(value):
    return isinstance(value, str) and value not in ("", ".", "..") and not any(c in value for c in "/\\\0:")


def digest(value):
    return isinstance(value, str) and re.fullmatch(r"[0-9a-fA-F]{64}", value) is not None


def positive(value):
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def validate(data):
    try:
        if data["schemaVersion"] != SCHEMA or not flat(data["currentVersion"]) or not flat(data["baselineVersion"]):
            return False
        current, baseline = data["currentVersion"], data["baselineVersion"]
        if baseline > current:
            return False
        if baseline == current:
            if data.get("previousVersion") is not None or data["deltaParts"]:
                return False
        elif not flat(data.get("previousVersion")) or not baseline <= data["previousVersion"] < current:
            return False
        for parts in (data["baselineParts"], data["deltaParts"]):
            if not isinstance(parts, list) or len(parts) > 997:
                return False
            files, members = set(), set()
            for part in parts:
                if (not isinstance(part.get("group"), str) or not flat(part["file"]) or part["file"] in files or not positive(part["bytes"])
                        or part["bytes"] >= 2 * 1024**3 or not digest(part["sha256"])
                        or not isinstance(part["members"], dict) or not part["members"]):
                    return False
                files.add(part["file"])
                for name, member in part["members"].items():
                    if (not flat(name) or name in members or not positive(member["bytes"])
                            or not digest(member["sha256"]) or member["group"] != part["group"]):
                        return False
                    members.add(name)
        names = set()
        if not isinstance(data["artworks"], dict):
            return False
        for artwork in data["artworks"].values():
            count = 0
            for tier in ("original", "large", "preview"):
                if tier not in artwork:
                    continue
                variant = artwork[tier]
                if (not flat(variant["file"]) or variant["file"] in names or not digest(variant["sha256"])
                        or not all(positive(variant[k]) for k in ("bytes", "w", "h"))
                        or artwork["shard"] not in ("chararts", "skinpack")):
                    return False
                names.add(variant["file"])
                count += 1
            if not count:
                return False
        return True
    except (KeyError, TypeError, AttributeError):
        return False
