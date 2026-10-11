"""Compile native icon formats from the existing approved GatherThread PNG.

Run on macOS with its built-in sips/iconutil. The generated assets are checked
in so Windows builders do not need Pillow, ImageMagick or a macOS machine.
No logo is redrawn and no runtime executable is modified.
"""
from pathlib import Path
import platform
import shutil
import struct
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
SOURCE = HERE.parents[1] / "apps/web/android-chrome-512x512.png"
ASSETS = HERE / "assets"


def main():
    if platform.system() != "Darwin":
        raise SystemExit("Regenerate on macOS; use the checked-in assets on Windows.")
    source = SOURCE.read_bytes()
    if not source.startswith(b"\x89PNG\r\n\x1a\n") or struct.unpack_from(">II", source, 16) != (512, 512):
        raise SystemExit("Expected the approved 512px square brand PNG")
    ASSETS.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="gatherthread-icons-") as stage:
        stage = Path(stage)
        images = {}
        for size in (16, 24, 32, 48, 64, 128, 256, 512, 1024):
            target = stage / f"brand-{size}.png"
            subprocess.run(["sips", "--resampleHeightWidth", str(size), str(size), str(SOURCE),
                            "--out", str(target)], check=True, stdout=subprocess.DEVNULL)
            images[size] = target
        sizes = (16, 24, 32, 48, 64, 128, 256)
        entries, payloads = [], []
        offset = 6 + 16 * len(sizes)
        for size in sizes:
            png = images[size].read_bytes()
            entries.append(struct.pack("<BBBBHHII", size % 256, size % 256, 0, 0, 1, 32, len(png), offset))
            payloads.append(png)
            offset += len(png)
        (ASSETS / "gatherthread.ico").write_bytes(struct.pack("<HHH", 0, 1, len(sizes)) + b"".join(entries + payloads))
        iconset = stage / "GatherThread.iconset"
        iconset.mkdir()
        for size in (16, 32, 128, 256, 512):
            for scale in (1, 2):
                name = f"icon_{size}x{size}{'@2x' if scale == 2 else ''}.png"
                shutil.copy2(images[size * scale], iconset / name)
        subprocess.run(["iconutil", "--convert", "icns", str(iconset), "--output", str(ASSETS / "GatherThread.icns")], check=True)
    shutil.copy2(SOURCE, ASSETS / "gatherthread.png")
    print("Generated GatherThread.icns, gatherthread.ico and gatherthread.png from the existing brand asset.")


if __name__ == "__main__":
    main()
