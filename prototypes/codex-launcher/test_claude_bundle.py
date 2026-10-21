"""No-network Launcher packaging contract for the Claude Code plugin."""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("claude_bundle", Path(__file__).with_name("claude_bundle.py"))
bundle = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bundle)


class ClaudeBundleTests(unittest.TestCase):
    def prepared(self, output):
        plugin = output / "plugins/gatherthread"
        for name in bundle.CLAUDE_PLUGIN_FILES:
            file = plugin / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text("fixture")
        (output / ".claude-plugin").mkdir(parents=True)
        (output / ".claude-plugin/marketplace.json").write_text(json.dumps({
            "name": "gatherthread-claude", "plugins": [{"name": "gatherthread", "source": "./plugins/gatherthread",
                                                         "version": "0.1.0-beta.3", "description": "fixture"}]}))
        return plugin

    def test_build_uses_fixed_preparer_and_preserves_codex_connector(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, output = Path(tmp) / "repo", Path(tmp) / "resources"
            (output / "connector").mkdir(parents=True)
            (output / "connector/index.js").write_text("Codex preserved")
            expected = output / "claude-marketplace"
            with patch.object(bundle.subprocess, "run", side_effect=lambda *_a, **_kw: self.prepared(expected)) as run:
                bundle.copy_claude_resources(root, output, Path("/fixed/node"))
            self.assertEqual((output / "connector/index.js").read_text(), "Codex preserved")
            self.assertEqual((output / "connector/claude-connect.js").read_text(), "import './claude/claude-connect.js';\n")
            self.assertEqual((output / "connector/claude/index.js").read_text(), "fixture")
            manifest = json.loads((expected / ".claude-plugin/marketplace.json").read_text())
            self.assertEqual(manifest["name"], "gatherthread-launcher-claude")
            self.assertEqual(run.call_args.args[0][-2:], ["--output", str(expected)])
            self.assertFalse(run.call_args.kwargs.get("shell", False))

    def test_missing_or_symlinked_connector_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp)
            plugin = self.prepared(output / "claude-marketplace")
            selected = plugin / "connector/claude-connect.js"
            selected.unlink()
            with self.assertRaises(ValueError):
                bundle.validate_claude_marketplace(output / "claude-marketplace")
            selected.symlink_to(plugin / "connector/index.js")
            with self.assertRaises(ValueError):
                bundle.validate_claude_marketplace(output / "claude-marketplace")


if __name__ == "__main__":
    unittest.main()
