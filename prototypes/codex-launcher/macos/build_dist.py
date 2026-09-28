"""Build an ad-hoc signed macOS .app with private Node and connector bundles."""

from __future__ import annotations

import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
from pathlib import Path
from urllib.request import urlopen


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
LAUNCHER = HERE.parent
BUILD = LAUNCHER / ".build-macos"
DIST = LAUNCHER / "dist"
APP = BUILD / "GatherThread Launcher.app"
RESOURCES = APP / "Contents" / "Resources"


def matching_node_license(version: str) -> bytes:
    if not re.fullmatch(r"v24\.\d+\.\d+", version):
        raise SystemExit("A released Node 24 build is required")
    with urlopen(f"https://raw.githubusercontent.com/nodejs/node/{version}/LICENSE", timeout=20) as response:
        content = response.read(2_000_001)
    if not (10_000 < len(content) <= 2_000_000) or not content.startswith(b"Node.js is licensed for use as follows:"):
        raise SystemExit("The matching official Node license is missing or invalid")
    return content


def copy(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)


def main() -> None:
    if platform.system() != "Darwin" or platform.machine() not in {"arm64", "x86_64"}:
        raise SystemExit("Build on macOS arm64 or x86_64")
    version = json.loads((ROOT / "packages/codex-connect/package.json").read_text(encoding="utf-8"))["version"]
    plugin_version = json.loads((ROOT / "plugins/gatherthread/.codex-plugin/plugin.json").read_text(encoding="utf-8"))["version"]
    windows_source = (LAUNCHER / "launcher.py").read_text(encoding="utf-8")
    if plugin_version != version or f"@gatherthread/codex-connect@{version}" not in windows_source:
        raise SystemExit("Launcher, connector, and plugin versions must match")
    node_command = shutil.which("node")
    if not node_command:
        raise SystemExit("Node 24 is required on the build machine")
    node = Path(node_command).resolve()
    node_version = subprocess.check_output([str(node), "--version"], text=True).strip()
    node_arch = subprocess.check_output([str(node), "-p", "process.arch"], text=True).strip()
    if node_arch != {"arm64": "arm64", "x86_64": "x64"}[platform.machine()]:
        raise SystemExit("Node architecture must match the macOS build machine")
    license_text = matching_node_license(node_version)
    npm = shutil.which("npm")
    if not npm:
        raise SystemExit("npm is required on the build machine")
    subprocess.run([npm, "run", "build:ts"], cwd=ROOT, check=True)
    subprocess.run([npm, "run", "build:connector"], cwd=ROOT, check=True)
    if BUILD.exists():
        if BUILD.resolve().parent != LAUNCHER.resolve():
            raise SystemExit("Refusing to remove a directory outside the launcher project")
        shutil.rmtree(BUILD)
    (APP / "Contents/MacOS").mkdir(parents=True)
    RESOURCES.mkdir(parents=True)
    copy(HERE / "Info.plist", APP / "Contents/Info.plist")
    environment = os.environ.copy()
    environment["SWIFT_MODULE_CACHE_PATH"] = str(BUILD / "swift-cache")
    environment["CLANG_MODULE_CACHE_PATH"] = str(BUILD / "clang-cache")
    subprocess.run(["swiftc", "-O", "-framework", "AppKit", "-o",
                    str(APP / "Contents/MacOS/GatherThreadLauncher"), str(HERE / "Launcher.swift")],
                   check=True, env=environment)
    copy(node, RESOURCES / "runtime/node")
    (RESOURCES / "runtime/Node-LICENSE.txt").write_bytes(license_text)
    connector = ROOT / "packages/codex-connect/dist"
    shutil.copytree(connector, RESOURCES / "connector")
    for name in ("package.json", "LICENSE", "NOTICE"):
        copy(ROOT / "packages/codex-connect" / name, RESOURCES / "connector" / name)
    shutil.copytree(ROOT / "plugins/gatherthread", RESOURCES / "plugins/gatherthread")
    copy(ROOT / ".agents/plugins/marketplace.json", RESOURCES / "marketplace.json")
    binary = APP / "Contents/MacOS/GatherThreadLauncher"
    subprocess.run([str(binary), "--self-test", str(LAUNCHER / "contract-vectors.json")], check=True)
    subprocess.run(["plutil", "-lint", str(APP / "Contents/Info.plist")], check=True)
    subprocess.run(["codesign", "--force", "--deep", "--sign", "-", str(APP)], check=True)
    DIST.mkdir(exist_ok=True)
    archive = DIST / f"GatherThreadLauncher-macOS-{platform.machine()}.zip"
    subprocess.run(["ditto", "-c", "-k", "--keepParent", str(APP), str(archive)], check=True)
    (DIST / f"{archive.name}.sha256").write_text(hashlib.sha256(archive.read_bytes()).hexdigest() + "\n", encoding="ascii")
    print(archive)


if __name__ == "__main__":
    main()
