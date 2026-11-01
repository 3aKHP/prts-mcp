"""Cache the small frozen legacy wheel for real package-upgrade probes."""
from pathlib import Path
import urllib.request
from common import ROOT, read, sha


def legacy_wheel():
    pin = read(ROOT / "packaging/pypi/legacy.json")
    path = ROOT / ".runtime/pypi-legacy" / pin["filename"]
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists() or sha(path) != pin["sha256"]:
        with urllib.request.urlopen(pin["url"], timeout=30) as response:
            data = response.read(2_000_000)
        path.write_bytes(data)
    if sha(path) != pin["sha256"]:
        raise ValueError("Legacy wheel checksum differs")
    return path


if __name__ == "__main__":
    print(legacy_wheel())
