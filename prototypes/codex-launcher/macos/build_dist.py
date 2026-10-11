"""Build an ad-hoc signed macOS .app with private Node and connector bundles."""

from __future__ import annotations

import hashlib
import json
import os
import platform
import plistlib
import re
import shutil
import subprocess
import struct
from pathlib import Path
from urllib.request import urlopen


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
LAUNCHER = HERE.parent
BUILD = LAUNCHER / ".build-macos"
DIST = LAUNCHER / "dist"
APP = BUILD / "GatherThread Launcher.app"
RESOURCES = APP / "Contents" / "Resources"
MINIMUM_MACOS_VERSION = "13.5"


def swift_compile_command(binary: Path, architecture: str) -> list[str]:
    return ["swiftc", "-O", "-target", f"{architecture}-apple-macosx{MINIMUM_MACOS_VERSION}",
            "-framework", "AppKit", "-o", str(binary), str(HERE / "Launcher.swift")]


def validate_binary_minimum(binary: Path) -> None:
    """Do not claim compatibility below either bundled executable's real floor."""
    try:
        output = subprocess.check_output(["vtool", "-show-build", str(binary)], text=True)
        minimums = re.findall(r"^\s*minos\s+(\d+(?:\.\d+){1,2})\s*$", output, re.MULTILINE)
        declared = tuple(map(int, MINIMUM_MACOS_VERSION.split("."))) + (0,)
        for minimum in minimums:
            parts = tuple(map(int, minimum.split(".")))
            if parts + (0,) * (3 - len(parts)) > declared:
                raise ValueError()
        if not minimums:
            raise ValueError()
    except (OSError, subprocess.CalledProcessError, ValueError):
        raise SystemExit("Bundled macOS executable exceeds the declared system minimum") from None


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


def validate_bundle_icon(app: Path) -> None:
    """Fail packaging instead of silently shipping the generic macOS app icon."""
    try:
        with (app / "Contents/Info.plist").open("rb") as handle:
            info = plistlib.load(handle)
        if info.get("CFBundleIconFile") != "GatherThread.icns":
            raise ValueError("The app must declare GatherThread.icns")
        path = app / "Contents/Resources/GatherThread.icns"
        if path.is_symlink() or not path.is_file() or not (8 < path.stat().st_size <= 5_000_000):
            raise ValueError("The packaged application icon is missing")
        data = path.read_bytes()
        if data[:4] != b"icns" or struct.unpack(">I", data[4:8])[0] != len(data):
            raise ValueError("The packaged application icon is invalid")
        offset = 8
        sizes = set()
        while offset < len(data):
            if offset + 8 > len(data):
                raise ValueError("The application icon has a truncated element")
            kind, length = struct.unpack(">4sI", data[offset:offset + 8])
            if length < 8 or offset + length > len(data):
                raise ValueError("The application icon has an invalid element")
            sizes.add(kind)
            offset += length
        if not sizes.intersection({b"ic09", b"ic10"}):
            raise ValueError("The application icon must include a high-resolution image")
    except (OSError, ValueError, plistlib.InvalidFileException) as error:
        raise SystemExit("macOS bundle icon validation failed: " + str(error)) from error


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
    with (APP / "Contents/Info.plist").open("rb") as handle:
        if plistlib.load(handle).get("LSMinimumSystemVersion") != MINIMUM_MACOS_VERSION:
            raise SystemExit("macOS system minimum must match the compilation target")
    copy(LAUNCHER / "assets/GatherThread.icns", RESOURCES / "GatherThread.icns")
    validate_bundle_icon(APP)
    environment = os.environ.copy()
    environment["SWIFT_MODULE_CACHE_PATH"] = str(BUILD / "swift-cache")
    environment["CLANG_MODULE_CACHE_PATH"] = str(BUILD / "clang-cache")
    subprocess.run(swift_compile_command(APP / "Contents/MacOS/GatherThreadLauncher", platform.machine()),
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
    validate_binary_minimum(binary)
    validate_binary_minimum(RESOURCES / "runtime/node")
    subprocess.run([str(binary), "--self-test", str(LAUNCHER / "contract-vectors.json")], check=True)
    subprocess.run([str(binary), "--self-test", str(HERE / "account-contract-vectors.json")], check=True)
    subprocess.run([str(binary), "--icon-self-test", str(RESOURCES / "GatherThread.icns")], check=True)
    subprocess.run(["plutil", "-lint", str(APP / "Contents/Info.plist")], check=True)
    subprocess.run(["codesign", "--force", "--deep", "--sign", "-", str(APP)], check=True)
    DIST.mkdir(exist_ok=True)
    archive = DIST / f"GatherThreadLauncher-macOS-{platform.machine()}.zip"
    subprocess.run(["ditto", "-c", "-k", "--keepParent", str(APP), str(archive)], check=True)
    (DIST / f"{archive.name}.sha256").write_text(hashlib.sha256(archive.read_bytes()).hexdigest() + "\n", encoding="ascii")
    print(archive)


if __name__ == "__main__":
    main()
