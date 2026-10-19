"""Incremental evidence transfer, verification and explicitly shareable export."""
import os
import shutil
import tarfile
from pathlib import Path

from .bundle import archive_directory, extract
from .common import LabError, file_hash, inventory, read_json, write_json


def collect(run, driver):
    run = Path(run)
    destination = run / "evidence"
    destination.mkdir(exist_ok=True)
    known = inventory(destination / "raw") if (destination / "raw").exists() else {}
    collections = run / "collections"
    collections.mkdir(exist_ok=True)
    number = len(list(collections.glob("*.tar"))) + 1
    archive = collections / "{:04d}.tar".format(number)
    with archive.open("xb") as output:
        driver.invoke("collect", {"known": known}, output_file=output)
        output.flush()
        os.fsync(output.fileno())
    temporary = collections / "{:04d}".format(number)
    temporary.mkdir()
    # Transfer size is bounded by the preregistered number of attempts/logs.
    snapshot = read_json(run / "snapshot.json")
    config = snapshot["config"]
    limits = config["profile"]["limits"]
    job_bytes = snapshot["bundle"]["files"]["control/job.json"]["size"]
    per_attempt = ((limits["max_bundle_mib"] + limits["max_output_mib"] * 4) * 1048576
                   + job_bytes * 2 + 32768)
    ceiling = (per_attempt * config["plan"]["design"]["rounds"] * len(config["plan"]["variants"]) *
               config["plan"]["design"]["max_attempts"] + 10485760)
    with archive.open("rb") as stream:
        extract(stream, temporary, ceiling)
    for name in inventory(temporary):
        source, target = temporary / name, destination / name
        if name not in ("owner.json", "postflight.json") and not name.startswith("raw/"):
            raise LabError("Unexpected collected evidence path")
        if target.exists() and name != "postflight.json":
            if file_hash(target) != file_hash(source):
                raise LabError("Previously collected evidence changed: " + name)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            if name == "postflight.json":
                write_json(target, read_json(source))
            else:
                with target.open("xb") as output, source.open("rb") as incoming:
                    shutil.copyfileobj(incoming, output)
    postflight = read_json(destination / "postflight.json")
    if inventory(destination / "raw") != postflight["raw_files"]:
        raise LabError("Collected evidence failed its complete hash inventory")
    state = read_json(run / "state.json")
    if read_json(destination / "owner.json") != {"key": state["driver"]["key"],
                                                "job_sha256": state["driver"]["job_sha256"]}:
        raise LabError("Collected evidence belongs to another experiment")
    write_json(collections / "{:04d}.json".format(number),
               {"archive_sha256": file_hash(archive), "raw_files": postflight["raw_files"]}, exclusive=True)
    return postflight


def verify_archive(path, expected):
    found = {}
    import hashlib
    with tarfile.open(str(path), "r:gz") as archive:
        for member in archive:
            if not member.isfile() or member.name in found:
                raise LabError("Evidence archive contains duplicate/special entries")
            checksum = hashlib.sha256()
            source = archive.extractfile(member)
            for block in iter(lambda: source.read(1024 * 1024), b""):
                checksum.update(block)
            found[member.name] = {"size": member.size, "sha256": checksum.hexdigest()}
    if found != expected:
        raise LabError("Evidence archive does not match its source inventory")


def archive(run, destination):
    receipt = archive_directory(run, destination)
    verify_archive(destination, receipt["files"])
    receipt["path"] = str(Path(destination).resolve())
    write_json(Path(run) / "archive-receipt.json", receipt)
    return {"archive_sha256": receipt["sha256"], "files_verified": len(receipt["files"])}


def export(run, summary):
    snapshot = read_json(Path(run) / "snapshot.json")
    state = read_json(Path(run) / "state.json")
    plan = snapshot["config"]["plan"]
    # Construct a new document. Never copy arbitrary configuration, adapter
    # details, prompts, logs, env values, operation text or topology into it.
    report = dict(summary)
    report["variant_identities"] = [{"id": variant["id"],
        "revision": variant.get("revision"),
        "artifacts": [{"sha256": item["sha256"], "size": item["size"]}
                      for item in snapshot["config"]["files"]
                      if item["target"] in [entry["target"] for entry in variant["files"]]]}
        for variant in plan["variants"]]
    observed = state["driver"].get("observed", {})
    report["environment"] = {"driver": snapshot["config"]["profile"]["driver"],
        "system": observed.get("system"), "architecture": observed.get("architecture"),
        "python": observed.get("python"), "memory_bytes": observed.get("memory_bytes"),
        "capabilities": observed.get("capabilities", [])}
    profile = snapshot["config"]["profile"]
    if profile["driver"] == "container":
        report["environment"]["container"] = {key: profile["container"][key]
            for key in ("memory_mib", "cpus", "pids", "network")}
        report["environment"]["image_id"] = state["driver"]["image_id"]
    report["orders"] = snapshot["config"]["orders"]
    report["evidence_identity"] = {"job_sha256": state["driver"]["job_sha256"],
                                   "bundle_sha256": snapshot["bundle"]["archive_sha256"]}
    return report
