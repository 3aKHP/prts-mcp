import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import ROOT, TAGS, inspect_wheel, python_version, sha, write
import pack


class PackTests(unittest.TestCase):
    def test_versions(self):
        for product, expected in [("3.2.2", "3.2.2"), ("3.2.2-dev.0", "3.2.2.dev0"), ("3.2.2-alpha.1", "3.2.2a1"), ("3.2.2-beta.2", "3.2.2b2"), ("3.2.2-rc.1", "3.2.2rc1")]:
            self.assertEqual(python_version(product), expected)
        with self.assertRaises(ValueError):
            python_version("3.2.2-invalid.0")

    def test_all_platform_wheels_and_checksums(self):
        targets = json.loads((ROOT / "packaging/native/targets.json").read_text())
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            native = directory / "native"
            native.mkdir()
            (native / "bin").mkdir()
            (native / "licenses/test").mkdir(parents=True)
            (native / "licenses/test/LICENSE").write_text("upstream notice")
            for name in ("LICENSE", "NOTICE", "THIRD-PARTY.json"):
                (native / name).write_text("{}")
            for platform in TAGS:
                for path in (native / "bin").iterdir():
                    path.unlink()
                executable = native / "bin" / ("prts-mcp-ghcr.exe" if platform == "windows-x64" else "prts-mcp-ghcr")
                executable.write_bytes(b"synthetic native fixture")
                write(native / "BUILD.json", dict(version="3.2.2-dev.0", commit="abc", platform=platform, target=targets[platform]["target"], dirty=False))
                write(native / "ABI.json", dict(platform=targets[platform]["target"]))
                (native / "SHA256SUMS").write_text("".join(f"{sha(p)}  {p.relative_to(native).as_posix()}\n" for p in sorted(native.rglob("*")) if p.is_file() and p.name != "SHA256SUMS"))
                with patch.object(pack, "git", side_effect=lambda *args: "" if args[0] == "status" else "abc"):
                    receipt = pack.pack(platform, native, directory / platform)
                wheel = directory / platform / "wheels" / receipt["filename"]
                inspect_wheel(wheel, receipt)
                bad = dict(receipt, sha256="0" * 64)
                with self.assertRaisesRegex(ValueError, "identity/checksum"):
                    inspect_wheel(wheel, bad)
                with patch.object(pack, "git", side_effect=lambda *args: "" if args[0] == "status" else "other"):
                    with self.assertRaisesRegex(ValueError, "same-commit"):
                        pack.pack(platform, native, directory / "bad")
