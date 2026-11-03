"""Preserve Python command/module entry points; all server behavior is Rust."""

import importlib.metadata
import json
import os
from pathlib import Path
import subprocess
import sys


def resolve_executable(profile="prts-mcp-ghcr"):
    if profile not in ("prts-mcp-ghcr", "prtsctl"):
        raise ValueError("unsupported native entry")
    root = Path(__file__).resolve().parent
    receipt = json.loads((root / "NATIVE.json").read_text(encoding="utf-8"))
    build = json.loads((root / "BUILD.json").read_text(encoding="utf-8"))
    if (receipt["version"] != importlib.metadata.version("prts-mcp")
            or receipt["productVersion"] != build["version"]
            or receipt["commit"] != build["commit"]
            or receipt["platform"] != build["platform"]):
        raise ValueError("installed native program and package versions differ")
    name = profile + (".exe" if os.name == "nt" else "")
    executable = root / "_native" / name
    if not executable.is_file():
        raise FileNotFoundError("installed native program is missing")
    return executable


def run(profile):
    try:
        executable = resolve_executable(profile)
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


def main():
    return run("prts-mcp-ghcr")


def management_main():
    return run("prtsctl")


if __name__ == "__main__":
    sys.exit(main())
