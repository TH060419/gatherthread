"""No-network checks for the packaged macOS launcher icon."""

import plistlib
import importlib.util
import tempfile
import shutil
import unittest
from pathlib import Path


HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("launcher_macos_build", HERE / "build_dist.py")
BUILD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILD)


class BundleIconTests(unittest.TestCase):
    def test_bundle_declares_the_real_application_icon(self):
        with (HERE / "Info.plist").open("rb") as handle:
            info = plistlib.load(handle)
        self.assertEqual(info.get("CFBundleIconFile"), "GatherThread.icns")

    def test_packaging_refuses_missing_icon(self):
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory) / "Fixture.app"
            (app / "Contents").mkdir(parents=True)
            with (app / "Contents/Info.plist").open("wb") as handle:
                plistlib.dump({"CFBundleIconFile": "GatherThread.icns"}, handle)
            with self.assertRaises(SystemExit):
                BUILD.validate_bundle_icon(app)

    def test_packaging_refuses_corrupted_icon(self):
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory) / "Fixture.app"
            (app / "Contents/Resources").mkdir(parents=True)
            with (app / "Contents/Info.plist").open("wb") as handle:
                plistlib.dump({"CFBundleIconFile": "GatherThread.icns"}, handle)
            (app / "Contents/Resources/GatherThread.icns").write_bytes(b"not an icon")
            with self.assertRaises(SystemExit):
                BUILD.validate_bundle_icon(app)

    def test_packaging_accepts_the_shipped_high_resolution_icon(self):
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory) / "Fixture.app"
            (app / "Contents/Resources").mkdir(parents=True)
            shutil.copy2(HERE / "Info.plist", app / "Contents/Info.plist")
            shutil.copy2(HERE.parent / "assets/GatherThread.icns", app / "Contents/Resources/GatherThread.icns")
            BUILD.validate_bundle_icon(app)


if __name__ == "__main__":
    unittest.main()
