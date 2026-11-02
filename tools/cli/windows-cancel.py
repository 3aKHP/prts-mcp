"""Exercise real console Ctrl+C without signaling the CI runner's console."""
import ctypes
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time


def check(node: str, entry: str, directory: str) -> None:
    import msvcrt

    root = Path(directory)
    root.mkdir()
    (root / "active").write_text("existing-active-sentinel", encoding="utf-8")
    (root / ".prts-data-source.json").write_text(
        '{"schemaVersion":1,"repo":"fixture/source"}', encoding="utf-8"
    )
    env = dict(os.environ, PRTS_DATA_DIR=str(root), PRTS_DATA_SOURCE_REPO="fixture/source")
    with (root / "sync.lock").open("w+b") as lock, (root / "stdout").open("wb") as output, (root / "stderr").open("wb") as errors:
        lock.write(b"0")
        lock.flush()
        lock.seek(0)
        msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        child = subprocess.Popen(
            [node, entry, "data", "sync", "--wait-timeout", "30", "-o", "json"],
            env=env, stdin=subprocess.DEVNULL, stdout=output, stderr=errors,
        )
        try:
            # A handler, rather than SIG_IGN, avoids disabling Ctrl+C in children.
            signal.signal(signal.SIGINT, lambda *_: None)
            deadline = time.monotonic() + 10
            while not (root / ".prts-data-source.lock").exists():
                if child.poll() is not None or time.monotonic() > deadline:
                    raise AssertionError("sync failed to reach its guarded lock wait")
                time.sleep(0.02)
            kernel = ctypes.WinDLL("kernel32", use_last_error=True)
            if not kernel.GenerateConsoleCtrlEvent(0, 0):
                raise ctypes.WinError(ctypes.get_last_error())
            code = child.wait(timeout=10)
            assert code == 130, f"expected cooperative exit 130, got {code}"
        finally:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=10)
    report = json.loads((root / "stdout").read_text(encoding="utf-8"))
    assert report["cancelled"] is True
    assert (root / "active").read_text(encoding="utf-8") == "existing-active-sentinel"
    (root / "passed.json").write_text(json.dumps({"exit": 130, "cancelled": True}), encoding="utf-8")


if __name__ == "__main__":
    assert sys.platform == "win32"
    if sys.argv[1] == "--console":
        check(*sys.argv[2:])
    else:
        # The isolated console contains only this driver, Node and its native child.
        result = subprocess.run(
            [sys.executable, __file__, "--console", *sys.argv[1:]],
            creationflags=subprocess.CREATE_NEW_CONSOLE, timeout=35,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, encoding="utf-8",
        )
        root = Path(sys.argv[3])
        if result.returncode:
            print(result.stdout, result.stderr, file=sys.stderr)
            for name in ("stdout", "stderr"):
                path = root / name
                if path.exists():
                    print(path.read_text(encoding="utf-8", errors="replace"), file=sys.stderr)
            raise SystemExit(result.returncode)
        assert json.loads((root / "passed.json").read_text(encoding="utf-8"))["cancelled"]
        print("WINDOWS_CLI_CANCEL_PASS")
