"""Run one immutable trial on the selected execution host, Python 3.6+."""
import json
import os
from pathlib import Path
import platform
import shutil
import sys
import tarfile
import time

from lab.common import (LabError, RunLock, digest, encoded, file_hash, identifier,
                        inventory, read_json, relative_name, write_json)
from lab.process import capture
from lab.response import check_response


def checked_job(root, key, expected):
    if read_json(root / "owner.json") != {"key": key, "job_sha256": expected}:
        raise LabError("Experiment ownership does not match")
    path = root / "bundle" / "control" / "job.json"
    if file_hash(path) != expected:
        raise LabError("Frozen job changed")
    job = read_json(path)
    if job["identity"]["key"] != key:
        raise LabError("Job identity does not match")
    return job


def changed_files(root, job):
    changed = []
    for name, metadata in job["files"].items():
        path = root / "bundle" / relative_name(name)
        if path.is_symlink() or not path.is_file() or file_hash(path) != metadata["sha256"]:
            changed.append(name)
    expected = set(job["files"]) | {"control/job.json"}
    for path in (root / "bundle").rglob("*"):
        if (path.is_file() or path.is_symlink()) and path.relative_to(root / "bundle").as_posix() not in expected:
            changed.append(path.relative_to(root / "bundle").as_posix())
    return changed


def execute(root, job, request):
    trial = identifier(request["trial"])
    attempt = request["attempt"]
    if isinstance(attempt, bool) or not isinstance(attempt, int) or not 1 <= attempt <= job["design"]["max_attempts"]:
        raise LabError("Invalid attempt number")
    variants = {variant["id"]: variant for variant in job["variants"]}
    variant = variants[request["variant"]]
    round_number = request["round"]
    if not isinstance(round_number, int) or not 0 <= round_number < job["design"]["rounds"]:
        raise LabError("Invalid round")
    if trial != "r{:04d}-{}".format(round_number, variant["id"]):
        raise LabError("Trial does not match its round and variant")
    timeout = request["timeout_seconds"]
    if not 0 < timeout <= min(job["design"]["trial_seconds"], job["limits"]["max_trial_seconds"]):
        raise LabError("Invalid trial timeout")
    raw = root / "raw" / trial / "{:04d}".format(attempt)
    if raw.exists():
        if (raw / "result.json").is_file() and read_json(raw / "invocation.json") == request:
            return read_json(raw / "result.json")
        raise LabError("Attempt already exists; preserve it and choose a new attempt")
    raw.mkdir(parents=True)
    write_json(raw / "invocation.json", request, exclusive=True)
    work = root / "work" / trial / "{:04d}".format(attempt)
    work.mkdir(parents=True)
    parameters = dict(job["benchmark"].get("parameters", {}))
    parameters.update(variant["parameters"])
    adapter_request = {"version": 1, "cases": job["benchmark"]["cases"],
                       "parameters": parameters,
                       "context": {"round": round_number, "variant": variant["id"],
                                   "seed": job["design"]["seed"] + round_number,
                                   "unit": job["benchmark"]["unit"]}}
    replacements = {"{bundle}": str(root / "bundle"), "{work}": str(work),
                    "{python}": sys.executable, "{variant}": variant["id"]}

    def expand(value):
        for key, replacement in replacements.items():
            value = value.replace(key, replacement)
        return value

    def expand_parameters(value):
        if isinstance(value, str):
            return expand(value)
        if isinstance(value, list):
            return [expand_parameters(item) for item in value]
        if isinstance(value, dict):
            return {key: expand_parameters(item) for key, item in value.items()}
        return value

    command = [expand(argument) for argument in variant["command"]]
    adapter_request["parameters"] = expand_parameters(parameters)
    # Store requests before launch and measurements before any assertion.
    write_json(raw / "request.json", adapter_request, exclusive=True)
    write_json(raw / "command.json", command, exclusive=True)
    result = {"version": 1, "trial": trial, "attempt": attempt, "variant": variant["id"],
              "round": round_number, "request_sha256": digest(adapter_request),
              "status": "execution_error", "elapsed_seconds": 0}
    started = time.monotonic()
    try:
        if shutil.disk_usage(str(root)).free < job["limits"]["min_free_mib"] * 1048576:
            raise LabError("Execution disk reserve reached")
        changed = changed_files(root, job)
        if changed:
            raise LabError("Frozen inputs changed before execution: " + ",".join(changed))
        environment = {key: os.environ[key] for key in
                       ("PATH", "LANG", "LC_ALL", "SYSTEMROOT", "WINDIR", "TEMP", "TMP")
                       if key in os.environ}
        environment["PYTHONDONTWRITEBYTECODE"] = "1"
        for name in job["env_from"]:
            if name not in os.environ:
                raise LabError("Missing environment credential reference: " + name)
            environment[name] = os.environ[name]
        result.update(capture(command, encoded(adapter_request) + b"\n", work,
                              environment, raw, timeout,
                              job["limits"]["max_output_mib"] * 1048576,
                              job["limits"].get("address_space_mib", 0)))
        if result["status"] == "complete":
            measured = read_json(raw / "stdout.json")
            write_json(raw / "measured.json", measured, exclusive=True)
            check_response(measured, job["benchmark"])
            result["measured_sha256"] = file_hash(raw / "measured.json")
    except Exception as error:
        result["status"] = "execution_error"
        result["error"] = str(error)
    result["elapsed_seconds"] = time.monotonic() - started
    result["changed_files"] = changed_files(root, job)
    if result["changed_files"]:
        result["status"] = "input_changed"
    write_json(raw / "result.json", result, exclusive=True)
    return result


def collect(root, job, known):
    write_json(root / "postflight.json", {"identity": job["identity"],
               "changed_files": changed_files(root, job),
               "raw_files": inventory(root / "raw") if (root / "raw").exists() else {}})
    with tarfile.open(fileobj=sys.stdout.buffer, mode="w|") as archive:
        paths = [root / "owner.json", root / "postflight.json"]
        if (root / "raw").exists():
            paths += [path for path in sorted((root / "raw").rglob("*")) if path.is_file()
                      and known.get(path.relative_to(root / "raw").as_posix()) != {
                          "sha256": file_hash(path), "size": path.stat().st_size}]
        for path in paths:
            if path.is_symlink():
                raise LabError("Evidence contains a symlink")
            if path.is_file():
                archive.add(str(path), arcname=path.relative_to(root).as_posix(), recursive=False)


def main():
    os.umask(0o077)
    action, key, expected = sys.argv[1:]
    root = Path(__file__).resolve().parents[2]
    job = checked_job(root, key, expected)
    with RunLock(root / ".lock"):
        if action == "execute":
            print(json.dumps(execute(root, job, json.load(sys.stdin))))
        elif action == "collect":
            collect(root, job, json.load(sys.stdin).get("known", {}))
        elif action == "status":
            print(json.dumps({"ready": True, "identity": job["identity"],
                              "changed_files": changed_files(root, job)}))
        elif action == "cleanup":
            supplied = json.load(sys.stdin)
            current = inventory(root / "raw") if (root / "raw").exists() else {}
            if supplied["raw_files"] != current or changed_files(root, job):
                raise LabError("Collect and verify current evidence before cleanup")
            work = root / "work"
            if work.is_symlink():
                raise LabError("Owned work directory is a symlink")
            if work.exists():
                shutil.rmtree(str(work))
            print(json.dumps({"work_removed": True, "identity": job["identity"]}))
        else:
            raise LabError("Unknown worker action")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
