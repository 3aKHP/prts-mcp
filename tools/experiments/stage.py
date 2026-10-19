"""Streaming bootstrap, sent verbatim to a selected SSH/container interpreter."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import tarfile


def main():
    os.umask(0o077)
    root, key, expected, maximum = sys.argv[1:]
    root = Path(root).expanduser()
    if not root.is_absolute() or root == Path("/"):
        raise ValueError("Dedicated absolute work root required")
    if not key or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for c in key):
        raise ValueError("Invalid ownership key")
    root.mkdir(parents=True, exist_ok=True)
    if root.is_symlink():
        raise ValueError("Work root cannot be a symlink")
    if shutil.disk_usage(str(root)).free < int(maximum):
        raise ValueError("Insufficient free disk for staging")
    run = root / key
    run.mkdir()  # Exclusive ownership: never adopt an existing directory.
    lock = (run / ".lock").open("a+b")
    if os.name == "nt":
        import msvcrt
        lock.write(b"0"); lock.flush(); lock.seek(0)
        msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
    else:
        import fcntl
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    (run / "owner.json").write_text(json.dumps({"key": key, "job_sha256": expected}))
    bundle = run / "bundle"
    bundle.mkdir()
    total, names = 0, set()
    with tarfile.open(fileobj=sys.stdin.buffer, mode="r|*") as archive:
        for entry in archive:
            parts = entry.name.split("/")
            if (not entry.isfile() or entry.name in names or
                    any(part in ("", ".", "..") or ":" in part or "\\" in part for part in parts)):
                raise ValueError("Unsafe archive entry")
            total += entry.size
            if entry.size < 0 or total > int(maximum):
                raise ValueError("Bundle budget exceeded")
            names.add(entry.name)
            target = bundle.joinpath(*parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("xb") as output:
                shutil.copyfileobj(archive.extractfile(entry), output, 1024 * 1024)
            os.chmod(str(target), 0o555 if entry.mode & 0o111 else 0o444)
    job = bundle / "control" / "job.json"
    if hashlib.sha256(job.read_bytes()).hexdigest() != expected:
        raise ValueError("Staged job does not match the experiment")
    print(json.dumps({"staged": True, "key": key}))


if __name__ == "__main__":
    main()
