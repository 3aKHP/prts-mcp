"""Exercise candidate fallback and explicit major constraints without PyPI."""
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import zipfile


class ResolutionTests(unittest.TestCase):
    def test_unsupported_platform_cannot_silently_select_legacy_with_major_constraint(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for version, tag in [("2.8.2", "py3-none-any"), ("3.2.2", "py3-none-manylinux_2_28_x86_64")]:
                info = f"prts_mcp-{version}.dist-info"
                with zipfile.ZipFile(root / f"prts_mcp-{version}-{tag}.whl", "w") as wheel:
                    wheel.writestr(info + "/METADATA", f"Metadata-Version: 2.1\nName: prts-mcp\nVersion: {version}\nRequires-Python: >=3.11\n")
                    wheel.writestr(info + "/WHEEL", f"Wheel-Version: 1.0\nRoot-Is-Purelib: false\nTag: {tag}\n")
                    wheel.writestr(info + "/RECORD", "")
            for requirement, expected in [("prts-mcp", "prts-mcp==2.8.2"), ("prts-mcp>=3,<4", None)]:
                req = root / "requirements.in"
                req.write_text(requirement)
                result = subprocess.run([shutil.which("uv"), "pip", "compile", str(req), "--no-index", "--find-links", str(root), "--python-version", "3.11", "--python-platform", "aarch64-apple-darwin", "--no-header", "--no-annotate", "--no-cache", "--no-python-downloads"], capture_output=True, text=True)
                if expected:
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(result.stdout.strip(), expected)
                else:
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("no wheels", result.stderr)
