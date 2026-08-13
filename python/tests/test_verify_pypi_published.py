"""Tests for python/scripts/verify_pypi_published.py.

Stands up a mock PyPI JSON endpoint on localhost and exercises the verify
script as a subprocess across its contract: a digest match, a retrievable
mismatch (fail-fast), and a propagation-delay-then-success retry. Plus a unit
check of the PEP 440 pre-release normalization used to build the JSON URL.
"""
import hashlib
import http.server
import json
import os
import subprocess
import sys
import threading
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "verify_pypi_published.py"
NAME = "prts-mcp"
VERSION = "9.9.9"
WHL = "prts_mcp-9.9.9-py3-none-any.whl"
SDIST = "prts_mcp-9.9.9.tar.gz"
GOOD_WHL = b"wheel content original"
GOOD_SDIST = b"sdist content original"

# scenario is mutated per test; the server reads it.
scenario: dict = {"first_404": 0, "digests": {}}
_state: dict = {"calls": 0}


class _Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path.startswith(f"/pypi/{NAME}/") and path.endswith("/json"):
            _state["calls"] += 1
            if _state["calls"] <= scenario["first_404"]:
                self.send_response(404)
                self.end_headers()
                return
            body = json.dumps(
                {"urls": [{"filename": fn, "digests": {"sha256": d}} for fn, d in scenario["digests"].items()]}
            ).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, *args):  # silence the test server
        pass


class _Server(threading.Thread):
    def __init__(self):
        super().__init__(daemon=True)
        self.httpd = http.server.HTTPServer(("127.0.0.1", 0), _Handler)
        self.port = self.httpd.server_address[1]

    def run(self):
        self.httpd.serve_forever()

    def stop(self):
        self.httpd.shutdown()


@pytest.fixture
def pypi():
    _state["calls"] = 0
    scenario["first_404"] = 0
    scenario["digests"] = {}
    s = _Server()
    s.start()
    yield f"http://127.0.0.1:{s.port}"
    s.stop()


def _write_dist(tmp_path: Path, contents: dict) -> Path:
    d = tmp_path / "dist"
    d.mkdir()
    for fn, data in contents.items():
        (d / fn).write_bytes(data)
    return d


def _run(dist: Path, base: str):
    env = {
        **os.environ,
        "PYPI_BASE": base,
        "VERSION": VERSION,
        "VERIFY_ATTEMPTS": "3",
        "VERIFY_SLEEP": "0",
    }
    return subprocess.run([sys.executable, str(SCRIPT), str(dist)], env=env, capture_output=True, text=True)


def test_match(pypi, tmp_path):
    dist = _write_dist(tmp_path, {WHL: GOOD_WHL, SDIST: GOOD_SDIST})
    scenario["digests"] = {
        WHL: hashlib.sha256(GOOD_WHL).hexdigest(),
        SDIST: hashlib.sha256(GOOD_SDIST).hexdigest(),
    }
    r = _run(dist, pypi)
    assert r.returncode == 0, r.stdout
    assert "PyPI digests verified" in r.stdout


def test_mismatch(pypi, tmp_path):
    dist = _write_dist(tmp_path, {WHL: GOOD_WHL, SDIST: GOOD_SDIST})
    scenario["digests"] = {
        WHL: hashlib.sha256(GOOD_WHL).hexdigest(),
        SDIST: hashlib.sha256(b"a different sdist").hexdigest(),
    }
    r = _run(dist, pypi)
    assert r.returncode == 1
    assert "sha256 mismatch" in r.stdout
    assert SDIST in r.stdout
    # fail-fast: must not be classified as a propagation delay
    assert "propagation delay" not in r.stdout


def test_propagation_then_ok(pypi, tmp_path):
    dist = _write_dist(tmp_path, {WHL: GOOD_WHL, SDIST: GOOD_SDIST})
    scenario["first_404"] = 1  # first request 404 (not yet indexed), then OK
    scenario["digests"] = {
        WHL: hashlib.sha256(GOOD_WHL).hexdigest(),
        SDIST: hashlib.sha256(GOOD_SDIST).hexdigest(),
    }
    r = _run(dist, pypi)
    assert r.returncode == 0, r.stdout
    assert "PyPI digests verified" in r.stdout


def test_normalize_version():
    sys.path.insert(0, str(SCRIPT.parent))
    from verify_pypi_published import normalize_version

    assert normalize_version("2.7.0-alpha.1") == "2.7.0a1"
    assert normalize_version("2.6.0-beta.2") == "2.6.0b2"
    assert normalize_version("2.7.0-rc.1") == "2.7.0rc1"
    assert normalize_version("2.7.0") == "2.7.0"
