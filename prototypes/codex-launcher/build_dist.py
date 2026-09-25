"""Build a Windows trial ZIP with private Python and Node runtimes."""

from __future__ import annotations

import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
from urllib.request import urlopen
from pathlib import Path


HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
DIST = HERE / "dist"
BUILD = HERE / ".build-tools"
APP = BUILD / "GatherThreadLauncher"


def copy(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)


def matching_node_license(version: str) -> bytes:
    if not re.fullmatch(r"v24\.\d+\.\d+", version):
        raise SystemExit("A released Node 24 build is required")
    url = f"https://raw.githubusercontent.com/nodejs/node/{version}/LICENSE"
    try:
        with urlopen(url, timeout=20) as response:
            content = response.read(2_000_001)
    except OSError as error:
        raise SystemExit(f"Could not retrieve the matching official Node license: {error}") from error
    if not (10_000 < len(content) <= 2_000_000) or not content.startswith(b"Node.js is licensed for use as follows:"):
        raise SystemExit("The matching official Node license is missing or invalid")
    return content


def main() -> None:
    if os.name != "nt":
        raise SystemExit("This package builder currently supports Windows only")
    if platform.architecture()[0] != "64bit":
        raise SystemExit("The Windows x64 bundle requires a 64-bit Python build")
    version = json.loads((ROOT / "packages" / "codex-connect" / "package.json").read_text(encoding="utf-8"))["version"]
    plugin_version = json.loads((ROOT / "plugins" / "gatherthread" / ".codex-plugin" / "plugin.json").read_text(encoding="utf-8"))["version"]
    if plugin_version != version or f"@gatherthread/codex-connect@{version}" not in (HERE / "launcher.py").read_text(encoding="utf-8"):
        raise SystemExit("Launcher, connector, and plugin versions must match")
    python_home = Path(sys.executable).resolve().parent
    node_path = Path(shutil.which("node.exe") or "")
    if not node_path.is_file() or not node_path.resolve().name.lower() == "node.exe":
        raise SystemExit("Node 24 executable was not found")
    node_version = subprocess.check_output([str(node_path), "--version"], text=True).strip()
    node_license = matching_node_license(node_version)
    npm = shutil.which("npm.cmd")
    if not npm:
        raise SystemExit("npm.cmd is required for building the connector")
    subprocess.run([npm, "run", "build:ts"], cwd=ROOT, check=True)
    subprocess.run([npm, "run", "build:connector"], cwd=ROOT, check=True)
    if BUILD.exists():
        resolved = BUILD.resolve()
        if resolved.parent != HERE.resolve():
            raise SystemExit("Refusing to remove a directory outside the launcher project")
        shutil.rmtree(resolved)
    APP.mkdir(parents=True)
    DIST.mkdir(exist_ok=True)

    for name in ("python.exe", "pythonw.exe", "python3.dll", "python313.dll",
                 "vcruntime140.dll", "vcruntime140_1.dll", "LICENSE.txt"):
        copy(python_home / name, APP / "runtime" / name)
    shutil.copytree(python_home / "DLLs", APP / "runtime" / "DLLs")
    shutil.copytree(python_home / "tcl", APP / "runtime" / "tcl")
    shutil.copytree(python_home / "Lib", APP / "runtime" / "Lib",
                    ignore=shutil.ignore_patterns("site-packages", "__pycache__", "test", "tests",
                                                  "ensurepip", "idlelib", "lib2to3", "tkinter.test"))
    (APP / "runtime" / "python313._pth").write_text(".\nLib\nDLLs\n", encoding="utf-8")
    copy(node_path, APP / "runtime" / "node.exe")
    (APP / "runtime" / "Node-LICENSE.txt").write_bytes(node_license)

    connector_dist = ROOT / "packages" / "codex-connect" / "dist"
    shutil.copytree(connector_dist, APP / "connector")
    copy(HERE / "connector" / "package.json", APP / "connector" / "package.json")
    copy(ROOT / "packages" / "codex-connect" / "LICENSE", APP / "connector" / "LICENSE")
    copy(ROOT / "packages" / "codex-connect" / "NOTICE", APP / "connector" / "NOTICE")
    shutil.copytree(ROOT / "plugins" / "gatherthread", APP / "plugins" / "gatherthread")
    copy(ROOT / ".agents" / "plugins" / "marketplace.json", APP / ".agents" / "plugins" / "marketplace.json")
    marketplace_path = APP / ".agents" / "plugins" / "marketplace.json"
    marketplace = json.loads(marketplace_path.read_text(encoding="utf-8"))
    marketplace["name"] = "gatherthread-launcher"
    marketplace_path.write_text(json.dumps(marketplace, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    copy(HERE / "launcher.py", APP / "launcher.py")
    copy(HERE / "Uninstall.ps1", APP / "Uninstall.ps1")
    copy(HERE / "README.md", APP / "README.md")
    (APP / "Install.cmd").write_text(
        '@echo off\r\nsetlocal\r\n"%~dp0runtime\\python.exe" "%~dp0launcher.py" --install\r\n'
        'if errorlevel 1 (pause & exit /b 1)\r\n'
        'start "" "%LOCALAPPDATA%\\Programs\\GatherThread Launcher\\runtime\\pythonw.exe" '
        '"%LOCALAPPDATA%\\Programs\\GatherThread Launcher\\launcher.py"\r\n',
        encoding="ascii",
    )
    (APP / "Run-portable.cmd").write_text(
        '@echo off\r\nstart "" "%~dp0runtime\\pythonw.exe" "%~dp0launcher.py"\r\n', encoding="ascii",
    )
    (APP / "Uninstall.cmd").write_text(
        '@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Uninstall.ps1"\r\n'
        'if errorlevel 1 pause\r\n', encoding="ascii",
    )
    manifest = {}
    for path in sorted(APP.rglob("*")):
        if path.is_file():
            manifest[str(path.relative_to(APP)).replace("\\", "/")] = hashlib.sha256(path.read_bytes()).hexdigest()
    (APP / "SHA256SUMS.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    archive = shutil.make_archive(str(DIST / "GatherThreadLauncher-Windows-x64"), "zip", root_dir=BUILD, base_dir=APP.name)
    print(archive)


if __name__ == "__main__":
    main()
