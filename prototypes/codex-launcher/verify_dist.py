"""Verify the Windows Launcher ZIP before sharing it."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from zipfile import ZipFile


ARCHIVE = Path(__file__).resolve().parent / "dist" / "GatherThreadLauncher-Windows-x64.zip"
ROOT = "GatherThreadLauncher/"


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
        print(f"Verified {len(manifest)} files and Node notices: {ARCHIVE}")


if __name__ == "__main__":
    main()
