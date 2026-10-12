"""No-network checks for the packaged macOS launcher icon."""

import plistlib
import hashlib
import importlib.util
import json
import os
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


class DmgPackagingTests(unittest.TestCase):
    def bundle(self, root):
        app = root / "GatherThread Launcher.app"
        contents = app / "Contents"
        contents.mkdir(parents=True)
        shutil.copy2(HERE / "Info.plist", contents / "Info.plist")
        resources = contents / "Resources"
        resources.mkdir()
        shutil.copy2(HERE.parent / "assets/GatherThread.icns", resources / "GatherThread.icns")
        for relative in (
            "MacOS/GatherThreadLauncher", "Resources/runtime/node",
            "Resources/connector/codex-connect.js", "Resources/connector/codex-hook.js",
            "Resources/connector/mcp.js", "Resources/connector/index.js",
            "Resources/connector/LICENSE", "Resources/connector/NOTICE",
            "Resources/plugins/gatherthread/.mcp.json", "Resources/marketplace.json",
            "Resources/plugins/gatherthread/hooks/hooks.json",
            "Resources/plugins/gatherthread/scripts/hook-forwarder.mjs",
            "Resources/plugins/gatherthread/scripts/mcp-launcher.mjs",
            "Resources/plugins/gatherthread/skills/gatherthread/SKILL.md",
        ):
            path = contents / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("synthetic bundle fixture\n", encoding="utf-8")
        for relative in ("MacOS/GatherThreadLauncher", "Resources/runtime/node"):
            (contents / relative).chmod(0o755)
        (resources / "runtime/Node-LICENSE.txt").write_text(
            "Node.js is licensed for use as follows:\n" + "Fixture license notice.\n" * 700, encoding="utf-8")
        for relative in ("connector/package.json", "plugins/gatherthread/.codex-plugin/plugin.json"):
            path = resources / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps({"version": "0.1.0-beta.1"}), encoding="utf-8")
        return app

    def provenance(self, app):
        return {"schema_version": 1, "source_commit": "a" * 40, "version": "0.1.0-beta.1",
                "architecture": "arm64", "node_version": "v24.16.0", "minimum_macos": "13.5",
                "signing": "ad-hoc; not Developer ID signed or notarized",
                "app_files": {str(path.relative_to(app)): hashlib.sha256(path.read_bytes()).hexdigest()
                              for path in app.rglob("*") if path.is_file()}}

    def stage(self, root):
        app = self.bundle(root / "source")
        stage = root / "stage"
        provenance = self.provenance(app)
        BUILD.prepare_dmg_stage(app, stage, provenance)
        return stage, provenance

    def test_dmg_stage_has_drag_target_bilingual_steps_and_exact_provenance(self):
        with tempfile.TemporaryDirectory() as directory:
            stage, provenance = self.stage(Path(directory))
            self.assertEqual(os.readlink(stage / "Applications"), "/Applications")
            self.assertEqual({p.name for p in stage.iterdir()},
                             {"GatherThread Launcher.app", "Applications", "READ ME FIRST.html", "BUILD_PROVENANCE.json"})
            guide = (stage / "READ ME FIRST.html").read_text(encoding="utf-8")
            self.assertIn("<strong>系统设置 → 隐私与安全性 → 仍要打开</strong>", guide)
            self.assertIn("<strong>System Settings → Privacy &amp; Security → Open Anyway</strong>", guide)
            self.assertIn("<strong>审查、信任并允许共序 Hooks</strong>", guide)
            self.assertIn("Applications", guide)
            self.assertNotIn("xattr", guide)
            self.assertEqual(json.loads((stage / "BUILD_PROVENANCE.json").read_text()), provenance)
            BUILD.validate_dmg_root(stage, provenance)

    def test_stage_refuses_overwriting_a_preexisting_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app = self.bundle(root / "source")
            stage = root / "stage"
            stage.mkdir()
            (stage / "keep.txt").write_text("keep", encoding="utf-8")
            with self.assertRaises(SystemExit):
                BUILD.prepare_dmg_stage(app, stage, self.provenance(app))
            self.assertEqual((stage / "keep.txt").read_text(), "keep")

    def test_packaging_refuses_missing_runtime_or_version_mismatch(self):
        with tempfile.TemporaryDirectory() as directory:
            app = self.bundle(Path(directory))
            path = app / "Contents/Resources/runtime/node"
            path.unlink()
            with self.assertRaises(SystemExit):
                BUILD.validate_bundle(app)
        with tempfile.TemporaryDirectory() as directory:
            app = self.bundle(Path(directory))
            (app / "Contents/Resources/connector/package.json").write_text('{"version":"0.0.0"}')
            with self.assertRaises(SystemExit):
                BUILD.validate_bundle(app)

    def test_packaging_refuses_a_symlink_inside_the_app(self):
        with tempfile.TemporaryDirectory() as directory:
            app = self.bundle(Path(directory))
            (app / "Contents/Resources/private-link").symlink_to("/etc")
            with self.assertRaises(SystemExit):
                BUILD.validate_bundle(app)

    def test_mounted_image_refuses_extra_entries_wrong_drag_target_and_changed_app(self):
        for mutation in ("extra", "drag-target", "app-content", "provenance"):
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as directory:
                stage, provenance = self.stage(Path(directory))
                if mutation == "extra":
                    (stage / "unreviewed.sh").write_text("fixture")
                elif mutation == "drag-target":
                    (stage / "Applications").unlink()
                    (stage / "Applications").symlink_to("/tmp")
                elif mutation == "app-content":
                    (stage / "GatherThread Launcher.app/Contents/Resources/connector/index.js").write_text("changed")
                else:
                    (stage / "BUILD_PROVENANCE.json").write_text("{}")
                with self.assertRaises(SystemExit):
                    BUILD.validate_dmg_root(stage, provenance)

    def test_image_verification_detaches_even_when_contents_are_invalid(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "fixture.dmg"
            output.write_bytes(b"fixture")
            with patch.object(BUILD.subprocess, "run") as run, \
                    patch.object(BUILD, "validate_dmg_root", side_effect=SystemExit("invalid image")):
                with self.assertRaisesRegex(SystemExit, "invalid image"):
                    BUILD.verify_dmg(output, {"fixture": True})
            commands = [call.args[0] for call in run.call_args_list]
            self.assertIn("-readonly", commands[1])
            self.assertIn("-nobrowse", commands[1])
            self.assertEqual(commands[-1][:2], ["hdiutil", "detach"])

    def test_failed_verification_never_publishes_or_overwrites_an_existing_dmg(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app = self.bundle(root / "source")
            output = root / "release.dmg"
            output.write_bytes(b"previous reviewed release")
            def create_fixture(command, **_kwargs):
                if command[:2] == ["hdiutil", "create"]:
                    Path(command[-1]).write_bytes(b"candidate fixture")
            with patch.object(BUILD.subprocess, "run", side_effect=create_fixture), \
                    patch.object(BUILD, "verify_dmg", side_effect=SystemExit("invalid image")):
                with self.assertRaisesRegex(SystemExit, "invalid image"):
                    BUILD.create_dmg(app, output, self.provenance(app))
            self.assertEqual(output.read_bytes(), b"previous reviewed release")

    def test_valid_dmg_has_matching_hash_and_source_record(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app = self.bundle(root / "source")
            output = root / "release.dmg"
            provenance = self.provenance(app)
            def create_fixture(command, **_kwargs):
                if command[:2] == ["hdiutil", "create"]:
                    Path(command[-1]).write_bytes(b"candidate fixture")
            with patch.object(BUILD.subprocess, "run", side_effect=create_fixture), \
                    patch.object(BUILD, "verify_dmg") as verify:
                BUILD.create_dmg(app, output, provenance)
            verify.assert_called_once()
            self.assertEqual((root / "release.dmg.sha256").read_text().strip(),
                             hashlib.sha256(output.read_bytes()).hexdigest())
            self.assertEqual(json.loads((root / "release.dmg.provenance.json").read_text()), provenance)

    def create_fixture(self, command, **_kwargs):
        if command[:2] == ["hdiutil", "create"] or command[0] == "ditto":
            Path(command[-1]).write_bytes(b"candidate fixture")

    def test_existing_checksum_and_provenance_are_never_overwritten(self):
        for suffix in (".sha256", ".provenance.json"):
            for kind in ("file", "symlink", "dangling-symlink"):
                with self.subTest(suffix=suffix, kind=kind), tempfile.TemporaryDirectory() as directory:
                    root = Path(directory)
                    app = self.bundle(root / "source")
                    output = root / "release.dmg"
                    sidecar = root / (output.name + suffix)
                    unrelated = root / "unrelated.txt"
                    unrelated.write_text("keep unrelated content")
                    if kind == "file":
                        sidecar.write_text("keep existing sidecar")
                    else:
                        sidecar.symlink_to(unrelated if kind == "symlink" else root / "missing.txt")
                    with patch.object(BUILD.subprocess, "run", side_effect=self.create_fixture), \
                            patch.object(BUILD, "verify_dmg"):
                        with self.assertRaises((OSError, SystemExit)):
                            BUILD.create_dmg(app, output, self.provenance(app))
                    self.assertFalse(output.exists())
                    self.assertEqual(unrelated.read_text(), "keep unrelated content")
                    if kind == "file":
                        self.assertEqual(sidecar.read_text(), "keep existing sidecar")
                    else:
                        self.assertTrue(sidecar.is_symlink())
                        if kind == "symlink":
                            self.assertEqual(sidecar.read_text(), "keep unrelated content")
                    other = ".provenance.json" if suffix == ".sha256" else ".sha256"
                    self.assertFalse((root / (output.name + other)).exists())
                    self.assertFalse((root / "missing.txt").exists())

    def test_sidecar_created_during_validation_is_preserved(self):
        for suffix in (".sha256", ".provenance.json"):
            with self.subTest(suffix=suffix), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                app = self.bundle(root / "source")
                output = root / "release.dmg"
                sidecar = root / (output.name + suffix)
                unrelated = root / "unrelated.txt"
                unrelated.write_text("keep concurrent content")
                def install_link(*_args):
                    sidecar.symlink_to(unrelated)
                with patch.object(BUILD.subprocess, "run", side_effect=self.create_fixture), \
                        patch.object(BUILD, "verify_dmg", side_effect=install_link):
                    with self.assertRaises((OSError, SystemExit)):
                        BUILD.create_dmg(app, output, self.provenance(app))
                self.assertFalse(output.exists())
                self.assertTrue(sidecar.is_symlink())
                self.assertEqual(unrelated.read_text(), "keep concurrent content")
                other = ".provenance.json" if suffix == ".sha256" else ".sha256"
                self.assertFalse((root / (output.name + other)).exists())

    def test_sidecar_write_failure_never_leaves_a_partial_release(self):
        original = Path.write_text
        for suffix in (".sha256", ".provenance.json"):
            with self.subTest(suffix=suffix), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                app = self.bundle(root / "source")
                output = root / "release.dmg"
                def fail_sidecar(path, *args, **kwargs):
                    if path.name.endswith(suffix):
                        raise OSError("synthetic sidecar write failure")
                    return original(path, *args, **kwargs)
                with patch.object(BUILD.subprocess, "run", side_effect=self.create_fixture), \
                        patch.object(BUILD, "verify_dmg"), patch.object(Path, "write_text", fail_sidecar):
                    with self.assertRaises((OSError, SystemExit)):
                        BUILD.create_dmg(app, output, self.provenance(app))
                for suffix in ("", ".sha256", ".provenance.json"):
                    self.assertFalse((root / (output.name + suffix)).exists())

    def test_promotion_failure_rolls_back_only_owned_release_files(self):
        original_link = os.link
        for suffix in (".sha256", ".provenance.json", ""):
            with self.subTest(suffix=suffix), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                app = self.bundle(root / "source")
                output = root / "release.dmg"
                unrelated = root / "unrelated.txt"
                unrelated.write_text("keep unrelated file")
                def fail_link(source, destination, **kwargs):
                    if Path(destination).name == output.name + suffix:
                        raise OSError("synthetic promotion failure")
                    return original_link(source, destination, **kwargs)
                with patch.object(BUILD.subprocess, "run", side_effect=self.create_fixture), \
                        patch.object(BUILD, "verify_dmg"), patch.object(BUILD.os, "link", side_effect=fail_link):
                    with self.assertRaises((OSError, SystemExit)):
                        BUILD.create_dmg(app, output, self.provenance(app))
                for suffix in ("", ".sha256", ".provenance.json"):
                    self.assertFalse((root / (output.name + suffix)).exists())
                self.assertEqual(unrelated.read_text(), "keep unrelated file")

    def test_rollback_preserves_a_concurrently_replaced_checksum(self):
        original_link = os.link
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app = self.bundle(root / "source")
            output = root / "release.dmg"
            checksum = root / (output.name + ".sha256")
            def replace_before_failure(source, destination, **kwargs):
                if Path(destination).name == output.name + ".provenance.json":
                    checksum.unlink()
                    checksum.write_text("keep concurrent replacement")
                    raise OSError("synthetic promotion failure after replacement")
                return original_link(source, destination, **kwargs)
            with patch.object(BUILD.subprocess, "run", side_effect=self.create_fixture), \
                    patch.object(BUILD, "verify_dmg"), \
                    patch.object(BUILD.os, "link", side_effect=replace_before_failure):
                with self.assertRaises((OSError, SystemExit)):
                    BUILD.create_dmg(app, output, self.provenance(app))
            self.assertEqual(checksum.read_text(), "keep concurrent replacement")
            self.assertFalse(output.exists())
            self.assertFalse((root / (output.name + ".provenance.json")).exists())

    def test_zip_and_its_sidecars_never_overwrite_existing_files_or_links(self):
        for suffix in ("", ".sha256", ".provenance.json"):
            for kind in ("file", "symlink", "dangling-symlink"):
                with self.subTest(suffix=suffix, kind=kind), tempfile.TemporaryDirectory() as directory:
                    root = Path(directory)
                    app = self.bundle(root / "source")
                    output = root / "release.zip"
                    existing = root / (output.name + suffix)
                    unrelated = root / "unrelated.txt"
                    unrelated.write_text("keep unrelated content")
                    if kind == "file":
                        existing.write_text("keep existing file")
                    else:
                        existing.symlink_to(unrelated if kind == "symlink" else root / "missing.txt")
                    with patch.object(BUILD.subprocess, "run", side_effect=self.create_fixture):
                        with self.assertRaises((OSError, SystemExit)):
                            BUILD.create_zip(app, output, self.provenance(app))
                    self.assertEqual(unrelated.read_text(), "keep unrelated content")
                    if kind == "file":
                        self.assertEqual(existing.read_text(), "keep existing file")
                    else:
                        self.assertTrue(existing.is_symlink())
                    for other in ("", ".sha256", ".provenance.json"):
                        if other != suffix:
                            self.assertFalse((root / (output.name + other)).exists())
                    self.assertFalse((root / "missing.txt").exists())

    def test_zip_preserves_collisions_arriving_during_archive_creation(self):
        for suffix in ("", ".sha256", ".provenance.json"):
            with self.subTest(suffix=suffix), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                app = self.bundle(root / "source")
                output = root / "release.zip"
                unrelated = root / "unrelated.txt"
                unrelated.write_text("keep concurrent content")
                existing = root / (output.name + suffix)
                def concurrent_fixture(command, **kwargs):
                    self.create_fixture(command, **kwargs)
                    existing.symlink_to(unrelated)
                with patch.object(BUILD.subprocess, "run", side_effect=concurrent_fixture):
                    with self.assertRaises((OSError, SystemExit)):
                        BUILD.create_zip(app, output, self.provenance(app))
                self.assertTrue(existing.is_symlink())
                self.assertEqual(unrelated.read_text(), "keep concurrent content")
                for other in ("", ".sha256", ".provenance.json"):
                    if other != suffix:
                        self.assertFalse((root / (output.name + other)).exists())

    def test_zip_sidecar_write_and_promotion_failures_leave_no_partial_release(self):
        original_write = Path.write_text
        original_link = os.link
        cases = [("write", suffix) for suffix in (".sha256", ".provenance.json")]
        cases += [("promote", suffix) for suffix in (".sha256", ".provenance.json", "")]
        for action, suffix in cases:
            with self.subTest(action=action, suffix=suffix), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                app = self.bundle(root / "source")
                output = root / "release.zip"
                def fail_write(path, *args, **kwargs):
                    if action == "write" and path.name.endswith(suffix):
                        raise OSError("synthetic ZIP sidecar write failure")
                    return original_write(path, *args, **kwargs)
                def fail_link(source, destination, **kwargs):
                    if action == "promote" and Path(destination).name == output.name + suffix:
                        raise OSError("synthetic ZIP promotion failure")
                    return original_link(source, destination, **kwargs)
                with patch.object(BUILD.subprocess, "run", side_effect=self.create_fixture), \
                        patch.object(Path, "write_text", fail_write), \
                        patch.object(BUILD.os, "link", side_effect=fail_link):
                    with self.assertRaises((OSError, SystemExit)):
                        BUILD.create_zip(app, output, self.provenance(app))
                for other in ("", ".sha256", ".provenance.json"):
                    self.assertFalse((root / (output.name + other)).exists())

    def test_zip_rollback_preserves_a_replaced_checksum_and_success_matches_hashes(self):
        original_link = os.link
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app = self.bundle(root / "source")
            output = root / "release.zip"
            checksum = root / (output.name + ".sha256")
            def replace_before_failure(source, destination, **kwargs):
                if Path(destination).name == output.name + ".provenance.json":
                    checksum.unlink()
                    checksum.write_text("keep concurrent replacement")
                    raise OSError("synthetic ZIP failure after replacement")
                return original_link(source, destination, **kwargs)
            with patch.object(BUILD.subprocess, "run", side_effect=self.create_fixture), \
                    patch.object(BUILD.os, "link", side_effect=replace_before_failure):
                with self.assertRaises((OSError, SystemExit)):
                    BUILD.create_zip(app, output, self.provenance(app))
            self.assertEqual(checksum.read_text(), "keep concurrent replacement")
            self.assertFalse(output.exists())
            self.assertFalse((root / (output.name + ".provenance.json")).exists())
            fresh = root / "fresh.zip"
            provenance = self.provenance(app)
            with patch.object(BUILD.subprocess, "run", side_effect=self.create_fixture):
                BUILD.create_zip(app, fresh, provenance)
            self.assertEqual((root / "fresh.zip.sha256").read_text().strip(),
                             hashlib.sha256(fresh.read_bytes()).hexdigest())
            self.assertEqual(json.loads((root / "fresh.zip.provenance.json").read_text()), provenance)

    def test_native_guide_keeps_critical_security_and_hooks_copy_bold(self):
        source = (HERE / "Launcher.swift").read_text(encoding="utf-8")
        self.assertTrue("系统设置 → 隐私与安全性 → 仍要打开" in source, "Native Gatekeeper path is explicit")
        self.assertTrue("审查、信任并允许共序 Hooks" in source, "Native Hook consent is explicit")
        self.assertTrue("emphasized: true" in source, "Native security instructions are emphasized")


class ReviewedPluginTests(unittest.TestCase):
    def test_only_git_reviewed_plugin_files_enter_the_bundle(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            plugin = root / "plugins/gatherthread"
            plugin.mkdir(parents=True)
            (plugin / "reviewed.json").write_text("reviewed fixture")
            (plugin / "untracked-private.txt").write_text("not distribution content")
            output = root / "copied-plugin"
            with patch.object(BUILD, "ROOT", root), \
                    patch.object(BUILD.subprocess, "check_output", return_value=b"plugins/gatherthread/reviewed.json\0"):
                BUILD.copy_reviewed_plugin(output)
            self.assertEqual((output / "reviewed.json").read_text(), "reviewed fixture")
            self.assertFalse((output / "untracked-private.txt").exists())

    def test_reviewed_plugin_symlinks_and_path_escape_are_refused(self):
        for selected in (b"plugins/gatherthread/link.json\0", b"plugins/gatherthread/../../outside.txt\0"):
            with self.subTest(selected=selected), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                plugin = root / "plugins/gatherthread"
                plugin.mkdir(parents=True)
                (root / "outside.txt").write_text("synthetic excluded content")
                (plugin / "link.json").symlink_to(root / "outside.txt")
                output = root / "copied-plugin"
                with patch.object(BUILD, "ROOT", root), \
                        patch.object(BUILD.subprocess, "check_output", return_value=selected):
                    with self.assertRaises(SystemExit):
                        BUILD.copy_reviewed_plugin(output)
                self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
