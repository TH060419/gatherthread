"""Build an ad-hoc signed macOS .app with private Node and connector bundles."""

from __future__ import annotations

import hashlib
import json
import os
import platform
import plistlib
import re
import shutil
import stat
import subprocess
import struct
import tempfile
from pathlib import Path, PurePosixPath
from urllib.request import urlopen


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
LAUNCHER = HERE.parent
BUILD = LAUNCHER / ".build-macos"
DIST = LAUNCHER / "dist"
APP = BUILD / "GatherThread Launcher.app"
RESOURCES = APP / "Contents" / "Resources"
MINIMUM_MACOS_VERSION = "13.5"
APP_NAME = "GatherThread Launcher.app"
LAUNCHER_VERSION = "0.1.3"
DMG_METADATA = ".gatherthread"
DMG_ENTRIES = {APP_NAME, "Applications", DMG_METADATA}
DMG_METADATA_ENTRIES = {"READ ME FIRST.html", "BUILD_PROVENANCE.json", "background.png", "layout.json"}
# macOS may create these volume directories after attaching a fresh image.
# They are never accepted from the unmounted source staging directory.
DMG_SYSTEM_VOLUME_DIRECTORIES = {".fseventsd", ".Spotlight-V100", ".Trashes"}
DMG_MOUNT_PHASES = {"writable-pre-layout", "writable-post-layout", "readonly-final"}
# Finder can retain the user's path/status bars even when bwsp requests them off.
# Reserve their height so both bilingual guidance blocks remain visible.
DMG_WINDOW_SIZE = (720, 648)
DMG_ICON_LOCATIONS = {"Applications": (180, 210), APP_NAME: (540, 210)}
REQUIRED_BUNDLE_FILES = (
    "Contents/Info.plist", "Contents/MacOS/GatherThreadLauncher",
    "Contents/Resources/GatherThread.icns", "Contents/Resources/runtime/node",
    "Contents/Resources/runtime/Node-LICENSE.txt",
    "Contents/Resources/connector/codex-connect.js", "Contents/Resources/connector/codex-hook.js",
    "Contents/Resources/connector/index.js", "Contents/Resources/connector/mcp.js",
    "Contents/Resources/connector/package.json", "Contents/Resources/connector/LICENSE",
    "Contents/Resources/connector/NOTICE", "Contents/Resources/marketplace.json",
    "Contents/Resources/plugins/gatherthread/.codex-plugin/plugin.json",
    "Contents/Resources/plugins/gatherthread/.mcp.json",
    "Contents/Resources/plugins/gatherthread/hooks/hooks.json",
    "Contents/Resources/plugins/gatherthread/scripts/hook-forwarder.mjs",
    "Contents/Resources/plugins/gatherthread/scripts/mcp-launcher.mjs",
    "Contents/Resources/plugins/gatherthread/skills/gatherthread/SKILL.md",
)


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


def validate_bundle(app: Path) -> None:
    """Do not copy a partial bundle, private build state or linked external content."""
    try:
        if app.is_symlink() or not app.is_dir() or app.name != APP_NAME:
            raise ValueError("The expected standalone application is missing")
        paths = list(app.rglob("*"))
        if len(paths) > 1_000 or any(path.is_symlink() for path in paths):
            raise ValueError("Unexpected or linked bundle entries")
        for path in paths:
            if any(part in {".git", ".env", "node_modules", "__pycache__", ".codegraph", ".serena"}
                   for part in path.relative_to(app).parts):
                raise ValueError("Private build state cannot be packaged")
            if not path.is_file() and not path.is_dir():
                raise ValueError("Non-regular bundle entry")
            if path.is_file() and path.stat().st_nlink != 1:
                raise ValueError("Hard-linked bundle entry")
        for relative in REQUIRED_BUNDLE_FILES:
            path = app / relative
            if not path.is_file() or path.stat().st_size == 0:
                raise ValueError("A required bundled resource is missing")
        for relative in ("Contents/MacOS/GatherThreadLauncher", "Contents/Resources/runtime/node"):
            if not os.access(app / relative, os.X_OK):
                raise ValueError("A bundled executable is not executable")
        with (app / "Contents/Info.plist").open("rb") as handle:
            info = plistlib.load(handle)
        if (info.get("CFBundleExecutable") != "GatherThreadLauncher"
                or info.get("CFBundleIdentifier") != "cn.gatherthread.codex-launcher"
                or info.get("LSMinimumSystemVersion") != MINIMUM_MACOS_VERSION
                or info.get("CFBundleShortVersionString") != LAUNCHER_VERSION
                or info.get("CFBundleVersion") != "13"):
            raise ValueError("Application identity or system minimum is invalid")
        version = info.get("GatherThreadReleaseVersion")
        if not isinstance(version, str) or not re.fullmatch(r"\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?", version):
            raise ValueError("Application release version is missing")
        for relative in ("Contents/Resources/connector/package.json",
                         "Contents/Resources/plugins/gatherthread/.codex-plugin/plugin.json"):
            if json.loads((app / relative).read_text(encoding="utf-8")).get("version") != version:
                raise ValueError("Application, connector and plugin versions differ")
        license_path = app / "Contents/Resources/runtime/Node-LICENSE.txt"
        if not (10_000 < license_path.stat().st_size <= 2_000_000) or not license_path.read_bytes().startswith(
                b"Node.js is licensed for use as follows:"):
            raise ValueError("Matching Node notices are missing")
        validate_bundle_icon(app)
    except (OSError, ValueError, plistlib.InvalidFileException) as error:
        raise SystemExit("macOS bundle validation failed: " + str(error)) from error


def app_file_hashes(app: Path) -> dict[str, str]:
    return {path.relative_to(app).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(app.rglob("*")) if path.is_file()}


def copy_reviewed_plugin(destination: Path) -> None:
    """Use Git's reviewed inventory, not arbitrary untracked/ignored worktree files."""
    try:
        raw = subprocess.check_output(["git", "ls-files", "-z", "--", "plugins/gatherthread"], cwd=ROOT)
        selected = [PurePosixPath(name) for name in raw.decode("utf-8").split("\0") if name]
        if not selected or len(selected) > 256 or len(set(selected)) != len(selected):
            raise ValueError("Missing or ambiguous reviewed plugin inventory")
        source_root = ROOT / "plugins/gatherthread"
        for relative in selected:
            if relative.parts[:2] != ("plugins", "gatherthread") or any(part in {".", ".."} for part in relative.parts):
                raise ValueError("Reviewed plugin path escaped its source directory")
            source = ROOT / relative
            if (source.is_symlink() or not source.is_file() or source.stat().st_nlink != 1
                    or not source.resolve().is_relative_to(source_root.resolve())
                    or any(parent.is_symlink() for parent in source.parents if parent != ROOT and ROOT in parent.parents)):
                raise ValueError("Reviewed plugin contains linked or non-regular source")
        for relative in selected:
            copy(ROOT / relative, destination / relative.relative_to("plugins/gatherthread"))
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        raise SystemExit("macOS reviewed plugin packaging failed") from error


def validate_provenance(provenance: dict, app: Path) -> None:
    keys = {"schema_version", "source_commit", "version", "architecture", "node_version",
            "minimum_macos", "signing", "app_files"}
    with (app / "Contents/Info.plist").open("rb") as handle:
        version = plistlib.load(handle)["GatherThreadReleaseVersion"]
    if (not isinstance(provenance, dict) or set(provenance) != keys
            or type(provenance["schema_version"]) is not int or provenance["schema_version"] != 1
            or not isinstance(provenance["source_commit"], str)
            or not re.fullmatch(r"[0-9a-f]{40}", provenance["source_commit"])
            or provenance["version"] != version or provenance["architecture"] not in {"arm64", "x86_64"}
            or not isinstance(provenance["node_version"], str)
            or not re.fullmatch(r"v24\.\d+\.\d+", provenance["node_version"])
            or provenance["minimum_macos"] != MINIMUM_MACOS_VERSION
            or provenance["signing"] != "ad-hoc; not Developer ID signed or notarized"
            or provenance["app_files"] != app_file_hashes(app)):
        raise SystemExit("macOS distribution provenance does not match the application")


def prepare_dmg_stage(app: Path, stage: Path, provenance: dict) -> None:
    validate_bundle(app)
    validate_provenance(provenance, app)
    if stage.exists() or stage.is_symlink():
        raise SystemExit("Refusing to overwrite an existing DMG staging directory")
    stage.mkdir()
    shutil.copytree(app, stage / APP_NAME)
    (stage / "Applications").symlink_to("/Applications", target_is_directory=True)
    metadata = stage / DMG_METADATA
    metadata.mkdir()
    copy(HERE / "install-guide.html", metadata / "READ ME FIRST.html")
    copy(HERE / "dmg-background/background.png", metadata / "background.png")
    copy(HERE / "dmg-background/layout.json", metadata / "layout.json")
    (metadata / "BUILD_PROVENANCE.json").write_text(
        json.dumps(provenance, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    validate_dmg_root(stage, provenance)


def dmg_entry_diagnostic(names: set[str]) -> str:
    """Bound public root filenames and escape controls, without exposing paths/content."""
    shown = []
    for name in sorted(names)[:8]:
        rendered = json.dumps(name, ensure_ascii=True)
        shown.append(rendered if len(rendered) <= 96 else rendered[:92] + '..."')
    if len(names) > 8:
        shown.append(f"... ({len(names) - 8} more)")
    return "[" + ", ".join(shown) + "]"


def validate_dmg_root(root: Path, expected_provenance: dict, *, require_finder: bool = False,
                      phase: str = "stage") -> None:
    """Validate actual mounted bytes against the pre-build manifest, not just filenames."""
    if phase != "stage" and phase not in DMG_MOUNT_PHASES:
        raise SystemExit("Invalid installation image validation phase")
    try:
        expected_entries = DMG_ENTRIES | ({".DS_Store"} if require_finder else set())
        entries = {entry.name: entry for entry in root.iterdir()}
        system_entries = set()
        if phase in DMG_MOUNT_PHASES:
            for name in DMG_SYSTEM_VOLUME_DIRECTORIES & entries.keys():
                if not stat.S_ISDIR(entries[name].lstat().st_mode):
                    raise ValueError(f"System volume entry {name} must be an ordinary directory")
                system_entries.add(name)
        missing = expected_entries - entries.keys()
        unexpected = entries.keys() - expected_entries - system_entries
        if missing or unexpected:
            raise ValueError("Unexpected installation image entries; missing=" + dmg_entry_diagnostic(missing)
                             + "; unexpected=" + dmg_entry_diagnostic(unexpected))
        applications = root / "Applications"
        if not applications.is_symlink() or os.readlink(applications) != "/Applications":
            raise ValueError("The drag target must be /Applications")
        metadata = root / DMG_METADATA
        if metadata.is_symlink() or not metadata.is_dir() or {p.name for p in metadata.iterdir()} != DMG_METADATA_ENTRIES:
            raise ValueError("Unexpected installation metadata entries")
        for name in DMG_METADATA_ENTRIES:
            entry = metadata / name
            if entry.is_symlink() or not entry.is_file() or not (0 < entry.stat().st_size <= 512_000):
                raise ValueError("Missing or invalid image instructions/provenance")
        if (metadata / "READ ME FIRST.html").read_bytes() != (HERE / "install-guide.html").read_bytes():
            raise ValueError("Installation instructions changed")
        for name in ("background.png", "layout.json"):
            if (metadata / name).read_bytes() != (HERE / "dmg-background" / name).read_bytes():
                raise ValueError("Installation background changed")
        provenance = json.loads((metadata / "BUILD_PROVENANCE.json").read_text(encoding="utf-8"))
        if provenance != expected_provenance:
            raise ValueError("Installation image provenance changed")
        validate_bundle(root / APP_NAME)
        validate_provenance(provenance, root / APP_NAME)
        if require_finder:
            validate_dmg_finder_layout(root)
    except (OSError, ValueError) as error:
        raise SystemExit(f"macOS installation image validation failed [{phase}]: " + str(error)) from error


def finder_window_settings() -> dict:
    """Fixed icon view, without a toolbar or a sidebar stealing background space."""
    return {"WindowBounds": "{{120, 120}, {720, 648}}", "ShowToolbar": False,
            "ShowSidebar": False, "ContainerShowSidebar": False, "ShowStatusBar": False,
            "ShowTabView": False, "ShowPathbar": False, "PreviewPaneVisibility": False,
            "SidebarWidth": 0}


def finder_icon_settings(background_alias: bytes) -> dict:
    # Finder's metadata field names are documented by the MIT dmgbuild project.
    # See dmg-background/THIRD_PARTY_NOTICES.md for the pinned reference and license.
    return {"viewOptionsVersion": 1, "backgroundType": 2,
            "backgroundImageAlias": background_alias,
            "backgroundColorRed": 251 / 255, "backgroundColorGreen": 250 / 255,
            "backgroundColorBlue": 247 / 255, "iconSize": 128.0, "textSize": 13.0,
            "arrangeBy": "none", "labelOnBottom": True, "showIconPreview": False,
            "showItemInfo": False, "gridOffsetX": 0.0, "gridOffsetY": 0.0,
            "gridSpacing": 100.0, "scrollPositionX": 0.0, "scrollPositionY": 0.0}


def dmg_metadata_tools():
    """Build-only, pinned pure-Python helpers; neither one enters the application."""
    try:
        from importlib.metadata import version
        from ds_store import DSStore
        from mac_alias import Alias
        if version("ds_store") != "1.3.3" or version("mac_alias") != "2.2.3":
            raise ValueError("Unreviewed Finder metadata tool version")
    except (ImportError, ValueError) as error:
        raise SystemExit("Install the hash-pinned macOS requirements-dmg.txt in a build venv") from error
    return DSStore, Alias


def write_dmg_finder_layout(root: Path) -> None:
    """Only the fresh temporary writable image receives this installation layout."""
    DSStore, Alias = dmg_metadata_tools()
    store_path = root / ".DS_Store"
    if store_path.exists() or store_path.is_symlink():
        raise SystemExit("Refusing to overwrite existing Finder metadata")
    alias = Alias.for_file(str(root / DMG_METADATA / "background.png"))
    # Keep the volume's creation/CNID identity, never publish a private build path.
    alias.volume.posix_path = b"/Volumes/GatherThread Launcher"
    with DSStore.open(str(store_path), "w+") as store:
        store["."]["vSrn"] = ("long", 1)
        store["."]["bwsp"] = finder_window_settings()
        store["."]["icvp"] = finder_icon_settings(alias.to_bytes())
        store["."]["icvl"] = ("type", b"icnv")
        for name, location in DMG_ICON_LOCATIONS.items():
            store[name]["Iloc"] = location
    validate_dmg_finder_layout(root)


def validate_dmg_finder_layout(root: Path) -> None:
    """Read the real .DS_Store, including its image target, not a layout claim."""
    DSStore, Alias = dmg_metadata_tools()
    path = root / ".DS_Store"
    if path.is_symlink() or not path.is_file() or not (0 < path.stat().st_size <= 64_000):
        raise SystemExit("Missing or invalid Finder installation metadata")
    try:
        with DSStore.open(str(path), "r") as store:
            expected = {(".", code) for code in (b"vSrn", b"bwsp", b"icvp", b"icvl")}
            expected |= {(name, b"Iloc") for name in DMG_ICON_LOCATIONS}
            if {(entry.filename, entry.code) for entry in store} != expected:
                raise ValueError("Unexpected Finder metadata records")
            if store["."]["bwsp"] != finder_window_settings() or store["."]["icvl"] != (b"type", b"icnv"):
                raise ValueError("Finder view/window changed")
            if store["."]["vSrn"] != (b"long", 1):
                raise ValueError("Finder view version changed")
            for name, location in DMG_ICON_LOCATIONS.items():
                if store[name]["Iloc"] != location:
                    raise ValueError("Installer icon placement changed")
            settings = store["."]["icvp"]
            alias_bytes = settings.get("backgroundImageAlias")
            if not isinstance(alias_bytes, bytes) or settings != finder_icon_settings(alias_bytes):
                raise ValueError("Finder background settings changed")
            alias = Alias.from_bytes(alias_bytes)
            if (alias.target.filename != "background.png" or alias.target.folder_name != ".gatherthread"
                    or alias.target.posix_path != "/.gatherthread/background.png"
                    or alias.volume.name != "GatherThread Launcher"
                    or alias.volume.posix_path != "/Volumes/GatherThread Launcher"):
                raise ValueError("Finder background alias escaped the installation image")
    except (OSError, ValueError, KeyError, TypeError, struct.error) as error:
        raise SystemExit("macOS Finder installation layout validation failed") from error


def configure_dmg_image(image: Path, temporary: Path, provenance: dict) -> None:
    """Mount only a fresh private intermediate, write its layout, and detach."""
    mount = temporary / "layout-mount"
    mount.mkdir()
    attached = False
    try:
        subprocess.run(["hdiutil", "attach", "-readwrite", "-nobrowse", "-noautoopen",
                        "-mountpoint", str(mount), str(image)], check=True, timeout=60,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        attached = True
        validate_dmg_root(mount, provenance, phase="writable-pre-layout")
        write_dmg_finder_layout(mount)
        validate_dmg_root(mount, provenance, require_finder=True, phase="writable-post-layout")
    finally:
        if attached:
            subprocess.run(["hdiutil", "detach", str(mount)], check=True, timeout=60,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def verify_dmg(image: Path, provenance: dict) -> None:
    subprocess.run(["hdiutil", "verify", str(image)], check=True, timeout=120,
                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    with tempfile.TemporaryDirectory(prefix="gatherthread-dmg-readonly-") as directory:
        mount = Path(directory) / "mount"
        mount.mkdir()
        try:
            subprocess.run(["hdiutil", "attach", "-readonly", "-nobrowse", "-noautoopen",
                            "-mountpoint", str(mount), str(image)], check=True, timeout=60,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            validate_dmg_root(mount, provenance, require_finder=True, phase="readonly-final")
            subprocess.run(["codesign", "--verify", "--deep", "--strict", str(mount / APP_NAME)],
                           check=True, timeout=60, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        finally:
            # Even a failed mount/validation is detached before candidate publication.
            subprocess.run(["hdiutil", "detach", str(mount)], check=True, timeout=60,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def publish_archive(candidate: Path, output: Path, provenance: dict) -> None:
    """Promote a privately built archive with no-clobber checksum/source sidecars."""
    checksum = candidate.with_name(candidate.name + ".sha256")
    checksum.write_text(hashlib.sha256(candidate.read_bytes()).hexdigest() + "\n", encoding="ascii")
    manifest = candidate.with_name(candidate.name + ".provenance.json")
    manifest.write_text(json.dumps(provenance, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    # Prepare every byte privately. Metadata precedes the archive, so a complete
    # image/ZIP is the publication commit marker. No check-then-write race.
    files = ((checksum, output.parent / (output.name + ".sha256")),
             (manifest, output.parent / (output.name + ".provenance.json")),
             (candidate, output))
    published = []
    try:
        for source, destination in files:
            os.link(source, destination, follow_symlinks=False)
            published.append((destination, source.stat()))
    except BaseException as error:
        for destination, owned in reversed(published):
            try:
                current = destination.lstat()
                if (current.st_dev, current.st_ino) == (owned.st_dev, owned.st_ino):
                    destination.unlink()
            except FileNotFoundError:
                pass
        if isinstance(error, FileExistsError):
            raise SystemExit("Refusing to replace an existing archive or sidecar; choose a fresh output directory") from None
        raise


def create_zip(app: Path, output: Path, provenance: dict) -> None:
    validate_bundle(app)
    validate_provenance(provenance, app)
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="gatherthread-zip-build-", dir=output.parent) as directory:
        candidate = Path(directory) / "candidate.zip"
        subprocess.run(["ditto", "-c", "-k", "--keepParent", str(app), str(candidate)], check=True)
        publish_archive(candidate, output, provenance)


def create_dmg(app: Path, output: Path, provenance: dict) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="gatherthread-dmg-build-", dir=output.parent) as directory:
        temporary = Path(directory)
        stage = temporary / "stage"
        prepare_dmg_stage(app, stage, provenance)
        writable = temporary / "layout.dmg"
        candidate = temporary / "candidate.dmg"
        subprocess.run(["hdiutil", "create", "-volname", "GatherThread Launcher", "-fs", "HFS+",
                        "-format", "UDRW", "-srcfolder", str(stage), str(writable)],
                       check=True, timeout=120, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        configure_dmg_image(writable, temporary, provenance)
        subprocess.run(["hdiutil", "convert", str(writable), "-format", "UDZO", "-o", str(candidate)],
                       check=True, timeout=120, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        verify_dmg(candidate, provenance)
        publish_archive(candidate, output, provenance)


def source_commit() -> str:
    try:
        commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
        for args in (["git", "diff", "--quiet"], ["git", "diff", "--cached", "--quiet"]):
            subprocess.run(args, cwd=ROOT, check=True)
    except (OSError, subprocess.CalledProcessError):
        raise SystemExit("Build the macOS distribution from a clean committed source checkout") from None
    if not re.fullmatch(r"[0-9a-f]{40}", commit) or os.environ.get("GITHUB_SHA", commit) != commit:
        raise SystemExit("The build source commit does not match its provenance")
    return commit


def main() -> None:
    if platform.system() != "Darwin" or platform.machine() not in {"arm64", "x86_64"}:
        raise SystemExit("Build on macOS arm64 or x86_64")
    commit = source_commit()
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
    copy_reviewed_plugin(RESOURCES / "plugins/gatherthread")
    copy(ROOT / ".agents/plugins/marketplace.json", RESOURCES / "marketplace.json")
    binary = APP / "Contents/MacOS/GatherThreadLauncher"
    validate_binary_minimum(binary)
    validate_binary_minimum(RESOURCES / "runtime/node")
    subprocess.run([str(binary), "--self-test", str(LAUNCHER / "contract-vectors.json")], check=True)
    subprocess.run([str(binary), "--self-test", str(HERE / "account-contract-vectors.json")], check=True)
    subprocess.run([str(binary), "--icon-self-test", str(RESOURCES / "GatherThread.icns")], check=True)
    subprocess.run(["plutil", "-lint", str(APP / "Contents/Info.plist")], check=True)
    subprocess.run(["codesign", "--force", "--deep", "--sign", "-", str(APP)], check=True)
    validate_bundle(APP)
    subprocess.run(["codesign", "--verify", "--deep", "--strict", str(APP)], check=True)
    DIST.mkdir(exist_ok=True)
    provenance = {"schema_version": 1, "source_commit": commit, "version": version,
                  "architecture": platform.machine(), "node_version": node_version,
                  "minimum_macos": MINIMUM_MACOS_VERSION,
                  "signing": "ad-hoc; not Developer ID signed or notarized",
                  "app_files": app_file_hashes(APP)}
    archive = DIST / f"GatherThreadLauncher-macOS-{platform.machine()}.zip"
    create_zip(APP, archive, provenance)
    image = DIST / f"GatherThreadLauncher-macOS-{platform.machine()}.dmg"
    create_dmg(APP, image, provenance)
    print(image)
    print(archive)


if __name__ == "__main__":
    main()
