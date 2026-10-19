"""Freeze runtime, evaluator and inputs without copying private operations."""
import io
import os
import shutil
import tarfile
from pathlib import Path

from .common import LabError, file_hash, inventory, relative_name, write_json
from .config import TOOLS


def make(run, config, identity):
    root = Path(run) / "bundle"
    root.mkdir()
    for item in config["files"]:
        target = root / item["target"]
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(item["source"], str(target))
        if file_hash(target) != item["sha256"]:
            raise LabError("Artifact changed while freezing: " + item["target"])
        os.chmod(str(target), 0o755 if item["executable"] else 0o644)
    for path in sorted(TOOLS.rglob("*.py")):
        if "tests" not in path.relative_to(TOOLS).parts:
            target = root / "control" / path.relative_to(TOOLS)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(str(path), str(target))
    for path in (TOOLS / "schemas").glob("*.json"):
        target = root / "control" / "schemas" / path.name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(str(path), str(target))
    files = inventory(root)
    job = {"version": 1, "identity": identity, "benchmark": config["benchmark"],
           "variants": config["plan"]["variants"], "design": config["plan"]["design"],
           "limits": config["profile"]["limits"], "env_from": config["profile"].get("env_from", []),
           "files": files}
    write_json(root / "control" / "job.json", job, exclusive=True)
    for path in root.rglob("*"):
        if path.is_file():
            os.chmod(str(path), 0o555 if path.stat().st_mode & 0o111 else 0o444)
    archive = Path(run) / "bundle.tar"
    with tarfile.open(str(archive), "w") as stream:
        for name in sorted(inventory(root)):
            stream.add(str(root / name), arcname=name, recursive=False)
    return {"job_sha256": file_hash(root / "control" / "job.json"),
            "archive_sha256": file_hash(archive), "files": inventory(root)}


def extract(stream, destination, byte_limit):
    """Extract regular files only; never use tarfile.extract(all)."""
    destination = Path(destination)
    total = 0
    names = set()
    with tarfile.open(fileobj=stream, mode="r|*") as archive:
        for member in archive:
            name = relative_name(member.name)
            if not member.isfile() or name in names:
                raise LabError("Archive contains a special or duplicate entry")
            names.add(name)
            total += member.size
            if total > byte_limit or member.size < 0:
                raise LabError("Archive exceeds its declared budget")
            target = destination / name
            target.parent.mkdir(parents=True, exist_ok=True)
            # All ancestors are created by this operation; refuse any symlink
            # if a previously interrupted extraction is presented as input.
            if any(parent.is_symlink() for parent in [target] + list(target.parents)
                   if parent != destination.parent):
                raise LabError("Archive target contains a symlink")
            with target.open("xb") as output:
                shutil.copyfileobj(archive.extractfile(member), output, 1024 * 1024)
            os.chmod(str(target), 0o555 if member.mode & 0o111 else 0o444)


def archive_directory(root, output):
    root, output = Path(root), Path(output)
    if output.resolve() == root.resolve() or root.resolve() in output.resolve().parents:
        raise LabError("An evidence archive must be outside its source directory")
    files = inventory(root)
    # The lock file is an implementation detail, not scientific evidence.
    files.pop(".lock", None)
    with output.open("xb") as raw:
        with tarfile.open(fileobj=raw, mode="w|gz") as archive:
            for name in sorted(files):
                archive.add(str(root / name), arcname=name, recursive=False)
    return {"sha256": file_hash(output), "files": files}
