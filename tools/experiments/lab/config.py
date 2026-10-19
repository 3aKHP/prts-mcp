"""Resolve one selected private profile and the two public experiment contracts."""
import itertools
import os
from pathlib import Path

from .integrity import LabError, digest, file_hash, read_json, relative_name, resolve
from .schema import validate

TOOLS = Path(__file__).resolve().parent.parent
ROOT = TOOLS.parent.parent


def contract(value, name):
    validate(value, read_json(TOOLS / "schemas" / (name + ".schema.json")))


def orders(plan):
    ids = [variant["id"] for variant in plan["variants"]]
    design = plan["design"]
    if "orders" in design:
        result = design["orders"]
        if len(result) != design["rounds"] or any(sorted(row) != sorted(ids) for row in result):
            raise LabError("Each scheduled round must contain every variant exactly once")
        return result
    if len(ids) <= 3:
        block = list(itertools.permutations(ids))
    else:
        block = [ids[index:] + ids[:index] for index in range(len(ids))]
        block += [list(reversed(row)) for row in block]
    return [list(block[index % len(block)]) for index in range(design["rounds"])]


def load(plan_path, profile_path=None):
    plan_path = Path(plan_path).resolve()
    plan = read_json(plan_path)
    contract(plan, "plan")
    benchmark_path = resolve(plan_path.parent, plan["benchmark"])
    benchmark = read_json(benchmark_path)
    contract(benchmark, "benchmark")
    chosen = profile_path or os.environ.get("EXPERIMENT_PROFILE") or plan.get("environment")
    if not chosen:
        raise LabError("Select --profile, EXPERIMENT_PROFILE, or a plan environment; use init for examples")
    # Explicit command-line/environment paths are relative to the caller; plan
    # references are relative to the plan, independently of the current cwd.
    profile_base = Path.cwd() if profile_path or os.environ.get("EXPERIMENT_PROFILE") else plan_path.parent
    profile_path = resolve(profile_base, chosen)
    profile = read_json(profile_path)
    contract(profile, "environment")
    if not profile["ready"]:
        raise LabError("Complete the selected environment and operations template, then set ready=true")
    if profile["driver"] == "ssh" and "ssh" not in profile:
        raise LabError("SSH requires an explicitly selected alias")
    if profile["driver"] == "local" and ("ssh" in profile or "container" in profile):
        raise LabError("A local profile cannot select remote transports")
    if profile["driver"] == "container" and "container" not in profile:
        raise LabError("Container execution requires image and resource settings")
    if profile["driver"] != "container" and "container" in profile:
        raise LabError("Container settings require the container driver")
    if profile["driver"] != "container" and "ssh" not in profile:
        work_root = str(resolve(profile_path.parent, profile["work_root"]))
        if Path(work_root).parent == Path(work_root) or work_root in ("/", "/tmp", "/home", "/var"):
            raise LabError("A dedicated experiment work_root is required")
    else:
        work_root = profile["work_root"]
        if not work_root.startswith("/") or work_root in ("/", "/tmp", "/home", "/var"):
            raise LabError("Remote work_root must be an absolute, dedicated experiment directory")
    operations = resolve(profile_path.parent, profile["operations"])
    if not operations.is_file() or not operations.read_text(encoding="utf-8").strip():
        raise LabError("The selected operations document is missing or empty")
    ids = [item["id"] for item in plan["variants"]]
    cases = [item["id"] for item in benchmark["cases"]]
    if len(set(ids)) != len(ids) or len(set(cases)) != len(cases) or "aggregate" in cases:
        raise LabError("Variant/case identifiers must be unique; aggregate is reserved")
    if plan["design"]["trial_seconds"] > profile["limits"]["max_trial_seconds"]:
        raise LabError("Trial duration exceeds the selected environment limit")
    for metric in benchmark["metrics"].values():
        if metric.get("minimum", -float("inf")) > metric.get("maximum", float("inf")):
            raise LabError("Metric bounds are reversed")
    for check in plan["checks"]:
        if check["variant"] not in ids or check.get("baseline", ids[0]) not in ids:
            raise LabError("Acceptance check references an unknown variant")
        if check["case"] not in cases + ["aggregate"] or check["metric"] not in benchmark["metrics"]:
            raise LabError("Acceptance check references an unknown case or metric")
        if check["operator"].startswith(("delta_", "ratio_")) and "baseline" not in check:
            raise LabError("Comparative checks require an explicit baseline")
    source_files = []
    declarations = [(benchmark_path.parent, item) for item in benchmark["files"]]
    declarations += [(plan_path.parent, item) for item in plan.get("files", [])]
    declarations += [(plan_path.parent, item) for variant in plan["variants"] for item in variant["files"]]
    names = set()
    for base, declaration in declarations:
        target = relative_name(declaration["target"])
        if target.startswith("control/") or target in names:
            raise LabError("Duplicate or reserved bundle target: " + target)
        names.add(target)
        source = resolve(base, declaration["source"])
        if not source.is_file():
            raise LabError("Missing declared artifact: " + str(source))
        sha = file_hash(source)
        if declaration.get("sha256", sha) != sha:
            raise LabError("Declared artifact hash does not match: " + target)
        source_files.append({"source": str(source), "target": target, "sha256": sha,
                             "size": source.stat().st_size,
                             "executable": declaration.get("executable", False)})
    if sum(item["size"] for item in source_files) > profile["limits"]["max_bundle_mib"] * 1048576:
        raise LabError("Declared artifacts exceed the environment bundle budget")
    return {"plan": plan, "benchmark": benchmark, "profile": profile, "orders": orders(plan),
            "plan_path": str(plan_path), "profile_path": str(profile_path),
            "benchmark_path": str(benchmark_path), "operations_path": str(operations),
            "work_root": work_root, "files": source_files,
            "source_hashes": {str(path): file_hash(path) for path in
                              [plan_path, benchmark_path, profile_path, operations]}}


def source_identity(config):
    return digest({"sources": config["source_hashes"], "files": config["files"]})
