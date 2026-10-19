"""Incremental evidence transfer, verification and explicitly shareable export."""
import os
import tarfile
from pathlib import Path

from .bundle import archive_directory, extract
from .integrity import (LabError, decode_json, file_hash, inventory, read_json,
                        remove_tree, sync_directory, write_json)


def collection_checkpoint(run, verify_all=False):
    collections = Path(run) / "collections"
    if collections.is_symlink():
        raise LabError("Collection directory contains a symlink")
    records = list(collections.glob("*.json"))
    if any(not path.stem.isdigit() or path.is_symlink() for path in records):
        raise LabError("Unexpected collection receipt path")
    records.sort(key=lambda path: int(path.stem))
    if not records:
        return None
    latest = None
    for path in records if verify_all else records[-1:]:
        receipt = read_json(path)
        archive = path.with_suffix(".tar")
        if (archive.is_symlink() or not isinstance(receipt, dict) or
                file_hash(archive) != receipt.get("archive_sha256") or
                not isinstance(receipt.get("raw_files"), dict)):
            raise LabError("Collection archive/receipt failed verification")
        # Bind the checkpoint to the manifest inside the verified transfer,
        # rather than trusting a separately editable receipt's raw_files map.
        postflight = None
        try:
            with tarfile.open(str(archive), "r:") as transfer:
                for member in transfer:
                    if member.name == "postflight.json":
                        if not member.isfile() or postflight is not None:
                            raise LabError("Invalid collection postflight entry")
                        postflight = decode_json(transfer.extractfile(member).read().decode("utf-8"))
        except (tarfile.TarError, UnicodeError, ValueError) as error:
            raise LabError("Invalid collection transfer: " + str(error))
        if not isinstance(postflight, dict) or postflight.get("raw_files") != receipt["raw_files"]:
            raise LabError("Collection receipt manifest does not match its transfer")
        latest = receipt["raw_files"]
    return latest


def discard_extractions(collections):
    if collections.is_symlink():
        raise LabError("Collection directory contains a symlink")
    for path in collections.iterdir():
        if path.is_dir() or path.is_symlink():
            if path.is_symlink() or not path.name.isdigit() or not path.with_suffix(".tar").is_file():
                raise LabError("Unexpected extraction directory")
            remove_tree(path)


def publish_file(source, target, replace=False):
    """Publish a complete extracted file, never a partially copied raw file."""
    if target.is_symlink():
        raise LabError("Evidence target contains a symlink")
    target.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(str(source), 0o600)
    with source.open("rb") as stream:
        os.fsync(stream.fileno())
    if replace:
        os.replace(str(source), str(target))
    else:
        os.link(str(source), str(target))
    sync_directory(target.parent)


def merge_collection(temporary, destination, run, committed):
    snapshot = read_json(run / "snapshot.json")
    state = read_json(run / "state.json")
    owner = {"key": state["driver"]["key"], "job_sha256": state["driver"]["job_sha256"]}
    postflight = read_json(temporary / "postflight.json")
    if (not isinstance(postflight, dict) or not isinstance(postflight.get("raw_files"), dict) or
            read_json(temporary / "owner.json") != owner or postflight.get("identity") != snapshot["identity"]):
        raise LabError("Collected evidence belongs to another experiment")
    for name, metadata in (committed or {}).items():
        if postflight["raw_files"].get(name) != metadata:
            raise LabError("Previously collected remote evidence changed: " + name)
    files = inventory(temporary)
    for name, metadata in files.items():
        if name.startswith("raw/"):
            if postflight["raw_files"].get(name[4:]) != metadata:
                raise LabError("Transferred evidence failed its declared hash: " + name)
        elif name not in ("owner.json", "postflight.json"):
            raise LabError("Unexpected collected evidence path")
    for name in files:
        if name == "postflight.json":
            continue
        source, target = temporary / name, destination / name
        if target.exists():
            if file_hash(target) == files[name]["sha256"]:
                continue
            if name == "owner.json" and committed is not None:
                raise LabError("Previously collected evidence changed: " + name)
            # A file absent from the last committed receipt may be a partial
            # copy from an interrupted older collector. The immutable tar and
            # remote manifest supply the full bytes; committed files never heal.
            publish_file(source, target, replace=True)
        else:
            publish_file(source, target)
    if inventory(destination / "raw") != postflight["raw_files"]:
        raise LabError("Collected evidence failed its complete hash inventory")
    write_json(destination / "postflight.json", postflight)
    return postflight


def collect(run, driver):
    run = Path(run)
    destination = run / "evidence"
    collections = run / "collections"
    if destination.is_symlink() or collections.is_symlink():
        raise LabError("Evidence/collection directory contains a symlink")
    destination.mkdir(exist_ok=True)
    known = inventory(destination / "raw")
    collections.mkdir(exist_ok=True)
    committed = collection_checkpoint(run)
    for name, metadata in (committed or {}).items():
        if known.get(name) != metadata:
            raise LabError("Previously collected evidence changed: " + name)
    discard_extractions(collections)
    number = max([int(path.stem) for path in collections.glob("*.tar")] or [0]) + 1
    archive = collections / "{:04d}.tar".format(number)
    with archive.open("xb") as output:
        driver.invoke("collect", {"known": known}, output_file=output)
        output.flush()
        os.fsync(output.fileno())
    # Transfer size is bounded by the preregistered number of attempts/logs.
    snapshot = read_json(run / "snapshot.json")
    config = snapshot["config"]
    limits = config["profile"]["limits"]
    job_bytes = snapshot["bundle"]["files"]["control/job.json"]["size"]
    per_attempt = ((limits["max_bundle_mib"] + limits["max_output_mib"] * 4) * 1048576
                   + job_bytes * 2 + 32768)
    ceiling = (per_attempt * config["plan"]["design"]["rounds"] * len(config["plan"]["variants"]) *
               config["plan"]["design"]["max_attempts"] + 10485760)
    temporary = collections / "{:04d}".format(number)
    temporary.mkdir()
    try:
        with archive.open("rb") as stream:
            extract(stream, temporary, ceiling)
        postflight = merge_collection(temporary, destination, run, committed)
        write_json(collections / "{:04d}.json".format(number),
                   {"archive_sha256": file_hash(archive), "raw_files": postflight["raw_files"]}, exclusive=True)
        return postflight
    finally:
        remove_tree(temporary)


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
    committed = collection_checkpoint(run, verify_all=True)
    known = inventory(Path(run) / "evidence/raw")
    for name, metadata in (committed or {}).items():
        if known.get(name) != metadata:
            raise LabError("Previously collected evidence changed: " + name)
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
