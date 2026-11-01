"""Package one audited native payload without invoking Cargo."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys

from common import ROOT, TAGS, git, inspect_wheel, inventory, product_version, python_version, read, sha, write


def pack(platform, native_dir, output):
    if git("status", "--porcelain", "--untracked-files=normal"):
        raise ValueError("Wheel packaging requires clean source")
    version = product_version()
    build = read(native_dir / "BUILD.json")
    targets = read(ROOT / "packaging/native/targets.json")
    if (build["version"] != version or build["platform"] != platform
            or build["target"] != targets[platform]["target"] or build["dirty"]
            or build["commit"] != git("rev-parse", "HEAD")):
        raise ValueError("Wheel requires a clean, same-commit audited native build")
    inventory(native_dir)
    abi = read(native_dir / "ABI.json")
    if abi["platform"] != targets[platform]["target"]:
        raise ValueError("ABI target differs")
    output.mkdir(parents=True, exist_ok=True)
    stage = output / "stage"
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir()
    template = ROOT / "packaging/pypi"
    shutil.copytree(template / "prts_mcp", stage / "prts_mcp", ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    for name in ("hatch_build.py",):
        shutil.copy2(template / name, stage / name)
    pyversion = python_version(version)
    (stage / "pyproject.toml").write_text((template / "pyproject.toml.in").read_text().replace("@VERSION@", pyversion))
    (stage / "README.md").write_text(
        "# PRTS-MCP\n\nNative Rust MCP server. This wheel provides `prts-mcp` and "
        "`python -m prts_mcp.server`, defaulting to stdio. Set `PRTS_TRANSPORT=http` for HTTP.\n\n"
        "Requires Python >=3.11. No compiler is needed. Game data is not included: "
        "startup synchronizes data, or use GAMEDATA_PATH / STORYJSON_PATH for existing data.\n\n"
        "https://github.com/3aKHP/prts-mcp\n", encoding="utf-8")
    for name in ("LICENSE", "NOTICE", "THIRD-PARTY.json", "licenses"):
        src = native_dir / name
        if src.is_dir():
            shutil.copytree(src, stage / name)
        else:
            shutil.copy2(src, stage / name)
    for name in ("BUILD.json", "ABI.json", "THIRD-PARTY.json"):
        shutil.copy2(native_dir / name, stage / "prts_mcp" / name)
    executable = "prts-mcp-ghcr" + (".exe" if platform == "windows-x64" else "")
    dest = stage / "prts_mcp/_native" / executable
    dest.parent.mkdir()
    shutil.copy2(native_dir / "bin" / executable, dest)
    if platform != "windows-x64":
        dest.chmod(0o755)
    receipt = {"schema": "prts-mcp-pypi/v1", "productVersion": version, "version": pyversion,
               "platform": platform, "commit": build["commit"], "nativeSha256": sha(dest)}
    write(stage / "prts_mcp/NATIVE.json", receipt)
    wheels = output / "wheels"
    wheels.mkdir(exist_ok=True)
    for old in wheels.glob("*.whl"):
        old.unlink()
    subprocess.run([sys.executable, "-m", "hatchling", "build", "-t", "wheel", "-d", str(wheels.resolve())],
                   cwd=stage, env={**os.environ, "PRTS_PYPI_PLATFORM_TAG": TAGS[platform]}, check=True)
    wheel, = wheels.glob("*.whl")
    receipt.update(filename=wheel.name, sha256=sha(wheel))
    inspect_wheel(wheel, receipt)
    write(output / "package.json", receipt)
    return receipt


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("platform", choices=TAGS)
    parser.add_argument("--native-dir", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    print(pack(args.platform, (args.native_dir or ROOT / "artifacts/native" / args.platform / "payload").resolve(),
               (args.output or ROOT / "artifacts/pypi" / args.platform).resolve()))
