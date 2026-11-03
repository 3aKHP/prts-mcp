"""Shared validation for native wheels and their acceptance receipts."""
import base64
import csv
from email.parser import BytesParser
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[2]
TAGS = {
    "linux-x64": "manylinux_2_28_x86_64",
    "linux-arm64": "manylinux_2_28_aarch64",
    "windows-x64": "win_amd64",
    "darwin-arm64": "macosx_14_0_arm64",
    "darwin-x64": "macosx_14_0_x86_64",
}


def product_version():
    return re.search(r'^version = "([^"]+)"', (ROOT / "Cargo.toml").read_text(), re.M)[1]


def python_version(product):
    match = re.fullmatch(r'(3\.\d+\.\d+)(?:-(alpha|beta|rc|dev)\.(\d+))?', product)
    if not match:
        raise ValueError("Invalid product version")
    base, kind, number = match.groups()
    return base + ({"alpha": "a", "beta": "b", "rc": "rc", "dev": ".dev"}[kind] + number if kind else "")


def sha(path):
    with open(path, "rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write(path, value):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True).strip()


def inventory(directory):
    directory = Path(directory)
    rows = {}
    for line in (directory / "SHA256SUMS").read_text().splitlines():
        digest, name = line.split("  ", 1)
        if name in rows or Path(name).is_absolute() or ".." in Path(name).parts or "\\" in name:
            raise ValueError("Unsafe or duplicate inventory path")
        rows[name] = digest
    actual = set()
    for path in directory.rglob("*"):
        if path.is_symlink():
            raise ValueError("Symbolic links are not allowed")
        if path.is_file() and path.name != "SHA256SUMS":
            actual.add(path.relative_to(directory).as_posix())
    if actual != set(rows):
        raise ValueError("Native inventory differs")
    for name, digest in rows.items():
        if sha(directory / name) != digest:
            raise ValueError("Native inventory checksum differs")
    return rows


def inspect_wheel(path, receipt):
    """Verify the actual ZIP, metadata, native bytes, and every RECORD member."""
    path = Path(path)
    version = python_version(receipt["productVersion"])
    tag = "py3-none-" + TAGS[receipt["platform"]]
    expected_name = f"prts_mcp-{version}-{tag}.whl"
    if path.name != expected_name or receipt["version"] != version or sha(path) != receipt["sha256"]:
        raise ValueError("Wheel identity/checksum differs")
    with zipfile.ZipFile(path) as wheel:
        names = wheel.namelist()
        if len(names) != len(set(names)) or any(n.startswith("/") or ".." in n.split("/") or "\\" in n for n in names):
            raise ValueError("Unsafe wheel paths")
        dist = f"prts_mcp-{version}.dist-info"
        allowed = ("prts_mcp/", dist + "/")
        if any(not n.startswith(allowed) for n in names):
            raise ValueError("Unexpected wheel payload")
        native = "prts_mcp/_native/prts-mcp-ghcr" + (".exe" if receipt["platform"] == "windows-x64" else "")
        management = "prts_mcp/_native/prtsctl" + (".exe" if receipt["platform"] == "windows-x64" else "")
        if sorted(n for n in names if n.startswith("prts_mcp/_native/")) != sorted([native, management]):
            raise ValueError("Wheel must contain the server and management executables")
        expected_payload = {"prts_mcp/" + n for n in ("__init__.py", "server.py", "BUILD.json", "ABI.json", "THIRD-PARTY.json", "NATIVE.json")} | {native, management}
        if {n for n in names if n.startswith("prts_mcp/")} != expected_payload:
            raise ValueError("Unexpected package payload, including bundled data")
        for executable, key in ((native,"nativeSha256"),(management,"managementSha256")):
            digest = hashlib.sha256(wheel.read(executable)).hexdigest()
            if digest != receipt[key]:
                raise ValueError("Native executable changed")
            if receipt["platform"] != "windows-x64" and not (wheel.getinfo(executable).external_attr >> 16) & 0o111:
                raise ValueError("Native executable lost its executable bit")
        entrypoints = wheel.read(dist + "/entry_points.txt").decode()
        if "prtsctl = prts_mcp.server:management_main" not in entrypoints or "prts-mcp = prts_mcp.server:main" not in entrypoints:
            raise ValueError("Wheel entry points differ")
        meta = BytesParser().parsebytes(wheel.read(dist + "/METADATA"))
        if (meta["Name"] != "prts-mcp" or meta["Version"] != version
                or meta["Requires-Python"] != ">=3.11" or meta.get_all("Requires-Dist")):
            raise ValueError("Wheel dependency/version metadata differs")
        if f"Tag: {tag}" not in wheel.read(dist + "/WHEEL").decode() or b"Root-Is-Purelib: false" not in wheel.read(dist + "/WHEEL"):
            raise ValueError("Wheel platform metadata differs")
        build = json.loads(wheel.read("prts_mcp/BUILD.json"))
        native_receipt = json.loads(wheel.read("prts_mcp/NATIVE.json"))
        for key in ("nativeSha256", "managementSha256"):
            if native_receipt.get(key) != receipt[key]:
                raise ValueError("Wheel native receipt differs")
        for key in ("commit", "platform"):
            if build[key] != receipt[key] or native_receipt[key] != receipt[key]:
                raise ValueError("Wheel provenance differs")
        if build["dirty"] or build["version"] != receipt["productVersion"] or native_receipt["version"] != version:
            raise ValueError("Wheel build version differs")
        if not any("/licenses/" in n for n in names) or not any(n.endswith("/NOTICE") for n in names):
            raise ValueError("Wheel is missing license notices")
        record = dist + "/RECORD"
        seen = set()
        for name, digest, size in csv.reader(io.StringIO(wheel.read(record).decode())):
            if name in seen:
                raise ValueError("Duplicate wheel RECORD entry")
            seen.add(name)
            if name == record:
                if digest or size:
                    raise ValueError("Invalid self RECORD")
                continue
            data = wheel.read(name)
            expected = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
            if digest != "sha256=" + expected or size != str(len(data)):
                raise ValueError("Wheel RECORD differs")
        if seen != set(names):
            raise ValueError("Wheel RECORD file set differs")
    return receipt
