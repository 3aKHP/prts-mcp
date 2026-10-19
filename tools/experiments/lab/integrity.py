"""Evidence integrity, durable publication and owned-path primitives (Python 3.6+)."""
import hashlib
import json
import math
import os
import shutil
import stat
import tempfile
from pathlib import Path


class LabError(Exception):
    pass


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), allow_nan=False).encode("utf-8")


def digest(value):
    return hashlib.sha256(encoded(value)).hexdigest()


def file_hash(path):
    result = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def decode_json(text):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise LabError("Duplicate JSON key: " + key)
            result[key] = value
        return result

    def invalid(value):
        raise LabError("Non-finite JSON number: " + value)

    def number(value):
        result = float(value)
        if not math.isfinite(result):
            invalid(value)
        return result

    return json.loads(text,
                      object_pairs_hook=pairs, parse_constant=invalid, parse_float=number)


def read_json(path):
    return decode_json(Path(path).read_text(encoding="utf-8"))


def sync_directory(path):
    if os.name != "nt":
        descriptor = os.open(str(path), os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def write_json(path, value, exclusive=False):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    data = encoded(value) + b"\n"
    descriptor, temporary = tempfile.mkstemp(prefix=".lab-", dir=str(path.parent))
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        if exclusive:
            # Publish the whole file atomically without replacing an existing
            # attempt. A crash can leave a temp file, never partial metadata.
            os.link(temporary, str(path))
        else:
            os.replace(temporary, str(path))
        sync_directory(path.parent)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def relative_name(value):
    if not isinstance(value, str) or not value or "\\" in value:
        raise LabError("Expected a portable relative file name")
    parts = value.split("/")
    if any(part in ("", ".", "..") for part in parts) or value.startswith("/"):
        raise LabError("File name escapes its bundle")
    if any(":" in part or "\x00" in part for part in parts):
        raise LabError("Unsupported file name")
    return value


def resolve(base, value):
    path = Path(value).expanduser()
    return (Path(base) / path).resolve() if not path.is_absolute() else path.resolve()


def inventory(root):
    root = Path(root)
    if root.is_symlink():
        raise LabError("Evidence contains a symlink: " + str(root))
    result = {}
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise LabError("Evidence contains a symlink: " + str(path))
        if path.is_file():
            result[path.relative_to(root).as_posix()] = {
                "sha256": file_hash(path), "size": path.stat().st_size}
    return result


def remove_tree(path):
    def readonly(function, name, error):
        if os.name != "nt" or not isinstance(error[1], PermissionError) or os.path.islink(name):
            raise error[1]
        os.chmod(name, stat.S_IREAD | stat.S_IWRITE)
        function(name)
    shutil.rmtree(str(path), onerror=readonly)


class RunLock:
    """An OS lock survives coordinator crashes without stale lock-file policy."""
    def __init__(self, path):
        self.path = Path(path)
        self.stream = None

    def __enter__(self):
        self.stream = self.path.open("a+b")
        try:
            if os.name == "nt":
                import msvcrt
                self.stream.seek(0)
                self.stream.write(b"0")
                self.stream.flush()
                self.stream.seek(0)
                msvcrt.locking(self.stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.stream.close()
            raise LabError("Another operation owns this experiment")
        return self

    def __exit__(self, *_):
        self.stream.close()
