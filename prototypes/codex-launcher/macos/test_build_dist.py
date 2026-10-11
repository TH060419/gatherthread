"""No-network checks for the packaged macOS launcher icon."""

import plistlib
import importlib.util
import tempfile
import shutil
import unittest
from unittest.mock import patch
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


class DeploymentTargetTests(unittest.TestCase):
    def test_compiler_targets_declared_minimum_not_the_build_machine(self):
        with (HERE / "Info.plist").open("rb") as handle:
            minimum = plistlib.load(handle)["LSMinimumSystemVersion"]
        self.assertEqual(minimum, "13.5")
        for architecture in ("arm64", "x86_64"):
            command = BUILD.swift_compile_command(Path("FixtureLauncher"), architecture)
            self.assertEqual(command[command.index("-target") + 1], f"{architecture}-apple-macosx{minimum}")

    def test_packaging_rejects_a_runtime_newer_than_the_declared_minimum(self):
        for output in ("  minos 26.0\n", "no deployment metadata\n", "  minos 13.5\n  minos 14.0\n"):
            with self.subTest(output=output), patch.object(BUILD.subprocess, "check_output", return_value=output):
                with self.assertRaises(SystemExit):
                    BUILD.validate_binary_minimum(Path("FixtureNode"))

    def test_packaging_accepts_compatible_thin_and_universal_binaries(self):
        for output in ("  minos 13.5\n", "  minos 13.0\n  minos 13.5\n"):
            with self.subTest(output=output), patch.object(BUILD.subprocess, "check_output", return_value=output):
                BUILD.validate_binary_minimum(Path("FixtureNode"))


if __name__ == "__main__":
    unittest.main()
