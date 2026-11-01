import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("bridge", ROOT / "packaging/pypi/prts_mcp/server.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class BridgeTests(unittest.TestCase):
    def test_posix_exec_preserves_arguments_and_streams(self):
        if os.name == "nt":
            self.skipTest("POSIX exec")
        with patch.object(bridge, "resolve_executable", return_value=Path("/tmp/中文 path/native")), patch.object(bridge.os, "execv", side_effect=RuntimeError("exec")) as execute, patch.object(sys, "argv", ["prts-mcp", "--version", "$(literal)"]):
            with self.assertRaisesRegex(RuntimeError, "exec"):
                bridge.main()
            execute.assert_called_once_with("/tmp/中文 path/native", ["/tmp/中文 path/native", "--version", "$(literal)"])

    def test_missing_program_is_stderr_only(self):
        import contextlib
        import io
        out, err = io.StringIO(), io.StringIO()
        with patch.object(bridge, "resolve_executable", side_effect=FileNotFoundError("missing")), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            self.assertEqual(bridge.main(), 1)
        self.assertEqual(out.getvalue(), "")
        self.assertIn("missing", err.getvalue())

    def test_metadata_mismatch_rejected_before_launch(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "BUILD.json").write_text(json.dumps(dict(version="3.2.2", commit="abc", platform="linux-x64")))
            (root / "NATIVE.json").write_text(json.dumps(dict(version="3.2.1", productVersion="3.2.2", commit="abc", platform="linux-x64")))
            with patch.object(bridge, "__file__", str(root / "server.py")), patch.object(bridge.importlib.metadata, "version", return_value="3.2.2"):
                with self.assertRaisesRegex(ValueError, "versions differ"):
                    bridge.resolve_executable()
