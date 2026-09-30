import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("launcher", Path(__file__).with_name("launcher.py"))
launcher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(launcher)


class NativeCodexCommandTests(unittest.TestCase):
    def test_workspace_selection_uses_existing_absolute_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertIsNone(launcher.selected_workspace(""))
            self.assertEqual(launcher.selected_workspace(directory), str(Path(directory).resolve()))
            for invalid in ("relative-directory", str(Path(directory) / "missing"), __file__):
                with self.subTest(path=invalid), self.assertRaises(ValueError):
                    launcher.selected_workspace(invalid)

    def test_connector_args_select_exactly_one_workspace_mode(self):
        inputs = (Path("node"), Path("connector"), launcher.SERVER_ORIGIN,
                  "project-example", "gpt-5.6-sol", 65536, "first-connect", "codex")
        default = launcher.connector_args(*inputs)
        custom = launcher.connector_args(*inputs, workspace="C:\\Codex Projects\\Example")
        self.assertIn("--create-workspace", default)
        self.assertNotIn("--workspace", default)
        self.assertNotIn("--create-workspace", custom)
        self.assertEqual(custom[custom.index("--workspace") + 1], "C:\\Codex Projects\\Example")

    def test_hook_command_rejects_windows_shell_expansion_in_install_path(self):
        self.assertIn('"${PLUGIN_ROOT}/scripts/hook-forwarder.mjs"', launcher.hook_node_command(Path('C:/Users/Test/node.exe')))
        for path in ('C:/Users/%USERNAME%/node.exe', 'C:/Users/!NAME!/node.exe', 'C:/Users/$(whoami)/node.exe', 'C:/Users/Bad"Name/node.exe'):
            with self.subTest(path=path), self.assertRaisesRegex(ValueError, "Hook"):
                launcher.hook_node_command(Path(path))

    def test_deep_link_accepts_only_fixed_server(self):
        accepted = "gatherthread-connect://connect?v=1&origin=https%3A%2F%2Fgatherthread.cn&project=project-example&model=gpt-5.6-sol&context_window_tokens=65536&visible_history_sync=first-connect"
        rejected = "gatherthread-connect://connect?v=1&origin=https%3A%2F%2Fexample.com&project=project-example&model=gpt-5.6-sol&context_window_tokens=65536&visible_history_sync=first-connect"
        self.assertEqual(launcher.parse_link(accepted)[:2], (launcher.SERVER_ORIGIN, "project-example"))
        with self.assertRaisesRegex(ValueError, "gatherthread.cn"):
            launcher.parse_link(rejected)

    def test_shared_browser_launcher_contract_vectors(self):
        vectors = json.loads(Path(__file__).with_name("contract-vectors.json").read_text(encoding="utf-8"))
        self.assertEqual(vectors["version"], int(launcher.LINK_VERSION))
        for case in vectors["accepted"]:
            with self.subTest(case=case["name"]):
                self.assertEqual(list(launcher.parse_link(case["uri"])), case["parsed"])
        for uri in vectors["rejected_uris"]:
            with self.subTest(uri=uri):
                with self.assertRaises(ValueError):
                    launcher.parse_link(uri)

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
    def test_unknown_cmd_wrapper_does_not_use_sibling_executable(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            wrapper = Path(directory) / "codex.cmd"
            native = Path(directory) / "codex.exe"
            wrapper.write_text("@echo off\r\necho unknown wrapper\r\n", encoding="utf-8")
            native.touch()
            with self.assertRaisesRegex(ValueError, "codex.exe"):
                launcher.native_codex_command(str(wrapper))

    @unittest.skipUnless(launcher.os.name == "nt", "Windows npm package")
    def test_official_npm_wrapper_resolves_to_its_own_binary(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            wrapper = Path(directory) / "codex.cmd"
            native = Path(directory) / "node_modules" / "@openai" / "codex" / "node_modules" / "@openai" / "codex-win32-x64" / "vendor" / "x86_64-pc-windows-msvc" / "bin" / "codex.exe"
            native.parent.mkdir(parents=True)
            wrapper.write_text('@echo off\r\n"%~dp0\\node.exe" "%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n', encoding="utf-8")
            package = Path(directory) / "node_modules" / "@openai" / "codex" / "package.json"
            package.parent.mkdir(parents=True, exist_ok=True)
            package.write_text('{"name":"@openai/codex","bin":{"codex":"bin/codex.js"}}', encoding="utf-8")
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

    @unittest.skipUnless(launcher.os.name == "nt", "Windows command wrappers")
    def test_unknown_wrapper_rejects_another_codex_on_path(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            wrapper = Path(directory) / "codex.cmd"
            other_native = Path(directory) / "other" / "codex.exe"
            other_native.parent.mkdir()
            wrapper.write_text("@echo off\r\necho unknown wrapper\r\n", encoding="utf-8")
            other_native.touch()
            with patch.object(launcher, "find_codex", return_value=str(other_native)):
                with self.assertRaisesRegex(ValueError, "codex.exe"):
                    launcher.native_codex_command(str(wrapper))


if __name__ == "__main__":
    unittest.main()
