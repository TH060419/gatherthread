import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("launcher", Path(__file__).with_name("launcher.py"))
launcher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(launcher)


class NativeCodexCommandTests(unittest.TestCase):
    def test_deep_link_accepts_only_fixed_server(self):
        accepted = "gatherthread-connect://connect?origin=https%3A%2F%2Fgatherthread.cn&project=project-example"
        rejected = "gatherthread-connect://connect?origin=https%3A%2F%2Fexample.com&project=project-example"
        self.assertEqual(launcher.parse_link(accepted)[:2], (launcher.SERVER_ORIGIN, "project-example"))
        with self.assertRaisesRegex(ValueError, "gatherthread.cn"):
            launcher.parse_link(rejected)

    @unittest.skipUnless(launcher.os.name == "nt", "Windows Codex discovery")
    def test_path_executable_is_preferred_over_user_installation(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            native = Path(directory) / "codex.exe"
            native.touch()
            with patch("shutil.which", side_effect=lambda name: str(native) if name == "codex.exe" else None):
                self.assertEqual(launcher.find_codex(), str(native))

    @unittest.skipUnless(launcher.os.name == "nt", "Windows Codex discovery")
    def test_desktop_executable_is_found_without_path_or_node(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            native = Path(directory) / "OpenAI" / "Codex" / "bin" / "version-1" / "codex.exe"
            native.parent.mkdir(parents=True)
            native.touch()
            with patch.dict(launcher.os.environ, {"LOCALAPPDATA": directory}), patch("shutil.which", return_value=None):
                self.assertEqual(launcher.find_codex(), str(native))

    @unittest.skipUnless(launcher.os.name == "nt", "Windows command wrappers")
    def test_cmd_wrapper_resolves_to_native_executable(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            wrapper = Path(directory) / "codex.cmd"
            native = Path(directory) / "codex.exe"
            wrapper.touch()
            native.touch()
            self.assertEqual(launcher.native_codex_command(str(wrapper)), str(native))

    @unittest.skipUnless(launcher.os.name == "nt", "Windows npm package")
    def test_official_npm_wrapper_resolves_to_its_own_binary(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            wrapper = Path(directory) / "codex.cmd"
            native = Path(directory) / "node_modules" / "@openai" / "codex" / "node_modules" / "@openai" / "codex-win32-x64" / "vendor" / "x86_64-pc-windows-msvc" / "bin" / "codex.exe"
            native.parent.mkdir(parents=True)
            wrapper.touch()
            native.touch()
            with patch.object(launcher, "find_codex", return_value=""):
                self.assertEqual(launcher.native_codex_command(str(wrapper)), str(native))

    @unittest.skipUnless(launcher.os.name == "nt", "Windows command wrappers")
    def test_cmd_wrapper_without_native_executable_fails_closed(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            wrapper = Path(directory) / "codex.cmd"
            wrapper.touch()
            original = launcher.find_codex
            launcher.find_codex = lambda: str(wrapper)
            try:
                with self.assertRaisesRegex(ValueError, "codex.exe"):
                    launcher.native_codex_command(str(wrapper))
            finally:
                launcher.find_codex = original


if __name__ == "__main__":
    unittest.main()
