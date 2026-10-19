"""A complete offline starting point for a clean fork."""
import os
from pathlib import Path

from .common import LabError, read_json, resolve, write_json
from .config import TOOLS


def initialize(directory, driver, example):
    os.umask(0o077)
    directory = Path(directory).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    destinations = [directory / name for name in ("environment.json", "operations.md", "plan.json")]
    if any(path.exists() for path in destinations):
        raise LabError("Initialization never overwrites existing private configuration")
    profile = read_json(TOOLS / "examples" / (driver + ".json"))
    profile["operations"] = "operations.md"
    if driver == "local":
        profile["work_root"] = "work"
        operations = (TOOLS / "templates" / "LOCAL-OPERATIONS.md").read_text(encoding="utf-8")
    else:
        operations = (TOOLS / "templates" / "OPERATIONS.example.md").read_text(encoding="utf-8")
    plan_source = TOOLS / "examples" / (example + ".json")
    plan = read_json(plan_source)
    plan["environment"] = "environment.json"
    plan["benchmark"] = str(resolve(plan_source.parent, plan["benchmark"]))
    for entry in plan.get("files", []) + [item for variant in plan["variants"] for item in variant["files"]]:
        entry["source"] = str(resolve(plan_source.parent, entry["source"]))
    write_json(destinations[0], profile, exclusive=True)
    with destinations[1].open("x", encoding="utf-8") as stream:
        stream.write(operations)
    write_json(destinations[2], plan, exclusive=True)
    return {"directory": str(directory), "plan": str(destinations[2]),
            "ready": profile["ready"], "driver": driver}
