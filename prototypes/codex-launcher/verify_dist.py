"""Verify the Windows Launcher ZIP before sharing it."""

from __future__ import annotations

import hashlib
import json
import struct
from pathlib import Path
from zipfile import ZipFile
from claude_bundle import CLAUDE_RESOURCE_FILES


ARCHIVE = Path(__file__).resolve().parent / "dist" / "GatherThreadLauncher-Windows-x64.zip"
ROOT = "GatherThreadLauncher/"


def verify_ico(payload: bytes) -> set[int]:
    """Refuse a missing, truncated or single-size placeholder application icon."""
    try:
        reserved, kind, count = struct.unpack_from("<HHH", payload)
        if reserved != 0 or kind != 1 or count != 7:
            raise ValueError()
        sizes, ranges = set(), []
        for index in range(count):
            width, height, colors, reserved, planes, bits, length, offset = struct.unpack_from("<BBBBHHII", payload, 6 + 16 * index)
            width, height = width or 256, height or 256
            if (width != height or width in sizes or colors != 0 or reserved != 0
                    or planes != 1 or bits != 32 or offset < 6 + count * 16
                    or length < 33 or offset + length > len(payload)):
                raise ValueError()
            image = payload[offset:offset + length]
            if (image[:8] != b"\x89PNG\r\n\x1a\n" or image[12:16] != b"IHDR"
                    or struct.unpack_from(">II", image, 16) != (width, height)):
                raise ValueError()
            if any(offset < stop and start < offset + length for start, stop in ranges):
                raise ValueError()
            ranges.append((offset, offset + length))
            sizes.add(width)
        if sizes != {16, 24, 32, 48, 64, 128, 256}:
            raise ValueError()
        return sizes
    except (ValueError, struct.error):
        raise ValueError("Launcher ICO must contain valid 16–256 px PNG images") from None


def main() -> None:
    with ZipFile(ARCHIVE) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)):
            raise SystemExit("ZIP contains duplicate entries")
        manifest = json.loads(archive.read(ROOT + "SHA256SUMS.json"))
        files = {name[len(ROOT):] for name in names if name.startswith(ROOT) and not name.endswith("/")}
        if files - {"SHA256SUMS.json"} != set(manifest):
            raise SystemExit("ZIP manifest does not cover every file")
        for name, digest in manifest.items():
            if hashlib.sha256(archive.read(ROOT + name)).hexdigest() != digest:
                raise SystemExit(f"ZIP hash mismatch: {name}")
        license_text = archive.read(ROOT + "runtime/Node-LICENSE.txt")
        if not license_text.startswith(b"Node.js is licensed for use as follows:"):
            raise SystemExit("ZIP lacks the official Node license")
        for required in ("assets/gatherthread.ico", "assets/gatherthread.png", "launcher.py", "Install.cmd", "Uninstall.ps1", *CLAUDE_RESOURCE_FILES):
            if required not in files:
                raise SystemExit(f"ZIP lacks Launcher application asset: {required}")
        try:
            verify_ico(archive.read(ROOT + "assets/gatherthread.ico"))
        except ValueError as error:
            raise SystemExit(str(error)) from None
        png = archive.read(ROOT + "assets/gatherthread.png")
        if len(png) < 33 or png[:8] != b"\x89PNG\r\n\x1a\n" or png[12:16] != b"IHDR" or struct.unpack_from(">II", png, 16) != (512, 512):
            raise SystemExit("ZIP lacks the 512 px Launcher window icon")
        print(f"Verified {len(manifest)} files, application icons and Node notices: {ARCHIVE}")


if __name__ == "__main__":
    main()
