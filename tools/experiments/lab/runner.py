"""Immutable experiment snapshots and resumable, append-only attempts."""
import json
import os
from pathlib import Path
import time
import uuid

from . import analysis, bundle, evidence
from .common import LabError, RunLock, digest, file_hash, inventory, read_json, write_json
from .config import TOOLS, ROOT, load, source_identity
from .drivers import Driver


def harness_identity():
    return {path.relative_to(TOOLS).as_posix(): file_hash(path)
            for path in sorted(TOOLS.rglob("*")) if path.is_file()
            and path.suffix in (".py", ".json") and "__pycache__" not in path.parts}


def create(plan_path, profile_path, output):
    os.umask(0o077)
    config = load(plan_path, profile_path)
    driver = Driver(config)
    driver.doctor()
    key = config["plan"]["id"][:32] + "-" + uuid.uuid4().hex[:16]
    run = Path(output).resolve() / key
    run.mkdir(parents=True)
    identity = {"key": key, "plan_sha256": digest(config["plan"]),
                "benchmark_sha256": digest(config["benchmark"])}
    state = {"version": 1, "phase": "freezing", "driver": driver.state,
             "created_at": time.time(), "run_seconds_used": 0}
    write_json(run / "state.json", state)
    try:
        frozen = bundle.make(run, config, identity)
        snapshot = {"version": 1, "identity": identity, "config": config,
                    "source_identity": source_identity(config), "harness": harness_identity(),
                    "bundle": frozen,
                    "operations": Path(config["operations_path"]).read_text(encoding="utf-8")}
        write_json(run / "snapshot.json", snapshot, exclusive=True)
        state["phase"] = "staging"
        driver.state.update({"key": key, "job_sha256": frozen["job_sha256"]})
        if config["profile"]["driver"] == "container":
            driver.state["container_name"] = "prts-lab-" + key
        state["driver"] = driver.state
        write_json(run / "state.json", state)
        driver.stage(run, identity, frozen)
        state["driver"] = driver.state
        state["phase"] = "ready"
        write_json(run / "state.json", state)
    except BaseException as error:
        state["phase"] = "stage_failed"
        state["driver"] = driver.state
        state["error"] = str(error)
        write_json(run / "state.json", state)
        print("Private experiment retained at " + str(run), file=__import__("sys").stderr)
        raise
    return run


def verified(run, execution=True):
    run = Path(run).resolve()
    snapshot = read_json(run / "snapshot.json")
    config = snapshot["config"]
    # A resume must not silently pick up changed code, credentials policy,
    # workloads, topology or inputs. Method amendments use a new linked plan.
    if execution:
        for path, sha in config["source_hashes"].items():
            if file_hash(path) != sha:
                raise LabError("A selected source/configuration changed; start a new experiment with parent provenance")
        if harness_identity() != snapshot["harness"]:
            raise LabError("Experiment tooling changed; preserve this run and create a new versioned experiment")
    if inventory(run / "bundle") != snapshot["bundle"]["files"]:
        raise LabError("Frozen local bundle changed")
    if file_hash(run / "bundle.tar") != snapshot["bundle"]["archive_sha256"]:
        raise LabError("Frozen transfer archive changed")
    if execution:
        for item in config["files"]:
            if file_hash(item["source"]) != item["sha256"]:
                raise LabError("A declared input or variant changed")
    return snapshot, Driver(config, read_json(run / "state.json")["driver"])


def execute(run, retry_errors=False):
    run = Path(run).resolve()
    with RunLock(run / ".lock"):
        snapshot, driver = verified(run)
        config = snapshot["config"]
        state = read_json(run / "state.json")
        if state["phase"] == "cleaned":
            raise LabError("This run was cleaned; analysis is available but execution cannot resume")
        if state["phase"] in ("staging", "stage_failed"):
            raise LabError("Staging did not finish; archive and clean this owned stage, then start a new run")
        evidence.collect(run, driver)
        groups = analysis.attempts(run)
        used = sum(item.get("elapsed_seconds", 0) for group in groups.values() for item in group)
        budget = config["profile"]["limits"]["max_run_seconds"]
        for index, row in enumerate(config["orders"]):
            for variant in row:
                trial = "r{:04d}-{}".format(index, variant)
                group = groups.get(trial, [])
                complete = [item for item in group if analysis.completed(item, config["benchmark"]) is not None]
                if len(complete) > 1:
                    raise LabError("Ambiguous successful attempts")
                if complete:
                    continue
                if group and not retry_errors:
                    raise LabError("Retained unsuccessful attempt; use resume --retry-errors within max_attempts")
                attempt = max([item["attempt"] for item in group] or [0]) + 1
                if attempt > config["plan"]["design"]["max_attempts"]:
                    raise LabError("Preregistered attempt limit reached")
                timeout = min(config["plan"]["design"]["trial_seconds"], budget - used)
                if timeout <= 0:
                    raise LabError("Preregistered execution budget exhausted")
                request = {"trial": trial, "attempt": attempt, "round": index,
                           "variant": variant, "timeout_seconds": timeout}
                state.update({"phase": "running", "pending": request})
                write_json(run / "state.json", state)
                write_json(run / "dispatches" / trial / ("{:04d}.json".format(attempt)),
                           request, exclusive=True)
                try:
                    driver.invoke("execute", request)
                finally:
                    # Even a nonzero transport/worker result must retain bytes
                    # before the coordinator makes a pass/fail decision.
                    evidence.collect(run, driver)
                groups = analysis.attempts(run)
                used = sum(item.get("elapsed_seconds", 0) for items in groups.values() for item in items)
                cooldown = config["plan"]["design"]["cooldown_seconds"]
                state["run_seconds_used"] = used
                state["phase"] = "ready"
                state.pop("pending", None)
                write_json(run / "state.json", state)
                current = groups[trial][-1]
                print(json.dumps({"trial": trial, "attempt": attempt, "status": current["status"]}), flush=True)
                if analysis.completed(current, config["benchmark"]) is None:
                    raise LabError("Trial failed; raw evidence retained. Resume does not replace completed measurements")
                if cooldown:
                    time.sleep(cooldown)
        summary = analysis.summarize(run)
        write_json(run / "summary.json", summary)
        state.update({"phase": "complete", "passed": summary["passed"], "completed_at": time.time()})
        write_json(run / "state.json", state)
        return summary


def cleanup(run):
    run = Path(run).resolve()
    with RunLock(run / ".lock"):
        snapshot, driver = verified(run, execution=False)
        receipt = read_json(run / "archive-receipt.json")
        if file_hash(receipt["path"]) != receipt["sha256"]:
            raise LabError("Verified evidence backup is missing or changed")
        evidence.verify_archive(receipt["path"], receipt["files"])
        state = read_json(run / "state.json")
        if state["phase"] == "cleaned":
            return state["cleanup"]
        if state["phase"] in ("staging", "stage_failed"):
            result = driver.cleanup_stage()
            state.update({"phase": "cleaned", "cleanup": result})
            write_json(run / "state.json", state)
            return result
        postflight = evidence.collect(run, driver)
        for name, metadata in inventory(run / "evidence").items():
            if receipt["files"].get("evidence/" + name) != metadata:
                raise LabError("Current evidence is newer than its backup; archive it before cleanup")
        result = driver.cleanup(postflight)
        state = read_json(run / "state.json")
        state.update({"phase": "cleaned", "cleanup": result})
        write_json(run / "state.json", state)
        return result
