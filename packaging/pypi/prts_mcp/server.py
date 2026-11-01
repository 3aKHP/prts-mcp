"""Preserve Python command/module entry points; all server behavior is Rust."""

import importlib.metadata
import json
import os
from pathlib import Path
import subprocess
import sys


def resolve_executable():
    root = Path(__file__).resolve().parent
    receipt = json.loads((root / "NATIVE.json").read_text(encoding="utf-8"))
    build = json.loads((root / "BUILD.json").read_text(encoding="utf-8"))
    if (receipt["version"] != importlib.metadata.version("prts-mcp")
            or receipt["productVersion"] != build["version"]
            or receipt["commit"] != build["commit"]
            or receipt["platform"] != build["platform"]):
        raise ValueError("installed native program and package versions differ")
    name = "prts-mcp-ghcr.exe" if os.name == "nt" else "prts-mcp-ghcr"
    executable = root / "_native" / name
    if not executable.is_file():
        raise FileNotFoundError("installed native program is missing")
    return executable


def main():
    try:
        executable = resolve_executable()
        args = [str(executable)]
        if os.name == "nt":
            args += ["--launcher-parent-pid", str(os.getpid())]
        args += sys.argv[1:]
        if os.name != "nt":
            os.execv(str(executable), args)
        child = subprocess.Popen(args, shell=False)
        # The child receives console events itself. Keep the parent alive until
        # it exits; an unhandled KeyboardInterrupt would trip the parent watcher.
        while True:
            try:
                return child.wait()
            except KeyboardInterrupt:
                continue
    except (OSError, ValueError, KeyError, importlib.metadata.PackageNotFoundError) as error:
        print(f"PRTS-MCP: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
