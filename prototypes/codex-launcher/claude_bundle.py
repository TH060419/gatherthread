"""Prepare the self-contained Claude plugin without overwriting Codex assets."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path


CLAUDE_PLUGIN_FILES = (
    ".claude-plugin/plugin.json", ".claude-plugin/icon.png", ".mcp.json", "hooks/hooks.json",
    "scripts/hook-forwarder.mjs", "scripts/mcp-launcher.mjs",
    "skills/gatherthread/SKILL.md", ".source-connector.json",
    "connector/claude-connect.js", "connector/index.js", "connector/mcp.js", "connector/package.json",
    "connector/LICENSE", "connector/NOTICE",
    *("commands/" + name + ".md" for name in ("connect", "projects", "history", "chat", "request", "status", "sync", "files")),
)
CLAUDE_RESOURCE_FILES = (
    "connector/claude-connect.js", "connector/claude/claude-connect.js",
    "connector/claude/index.js", "connector/claude/mcp.js", "connector/claude/package.json",
    "connector/claude/LICENSE", "connector/claude/NOTICE",
    "claude-marketplace/.claude-plugin/marketplace.json",
    *("claude-marketplace/plugins/gatherthread/" + name for name in CLAUDE_PLUGIN_FILES),
)


def validate_claude_marketplace(marketplace: Path) -> None:
    """The build helper supplies a bounded explicit source and bundle inventory."""
    paths = list(marketplace.rglob("*"))
    if not marketplace.is_dir() or marketplace.is_symlink() or len(paths) > 256:
        raise ValueError("Claude Code marketplace is missing or unexpectedly large")
    for path in paths:
        if path.is_symlink() or not (path.is_dir() or path.is_file()) or path.is_file() and path.stat().st_nlink != 1:
            raise ValueError("Claude Code marketplace contains a linked or non-regular file")
        if any(part in {".git", ".env", "node_modules", "__pycache__", ".codegraph", ".serena"}
               for part in path.relative_to(marketplace).parts):
            raise ValueError("Private state cannot enter the Claude Code bundle")
    plugin = marketplace / "plugins/gatherthread"
    if any(not (plugin / name).is_file() or (plugin / name).stat().st_size == 0 for name in CLAUDE_PLUGIN_FILES):
        raise ValueError("Claude Code bundle lacks a required plugin or connector resource")
    try:
        manifest = json.loads((marketplace / ".claude-plugin/marketplace.json").read_text(encoding="utf-8"))
        if manifest.get("name") not in {"gatherthread-claude", "gatherthread-launcher-claude"}:
            raise ValueError()
        plugins = manifest.get("plugins")
        if (not isinstance(plugins, list) or len(plugins) != 1 or not isinstance(plugins[0], dict)
                or plugins[0].get("name") != "gatherthread" or plugins[0].get("source") != "./plugins/gatherthread"
                or set(plugins[0]) - {"name", "source", "description", "version"}):
            raise ValueError()
    except (OSError, ValueError, AttributeError):
        raise ValueError("Claude Code marketplace does not point to the exact bundled plugin") from None


def copy_claude_resources(repository: Path, resources: Path, node: Path) -> None:
    marketplace = resources / "claude-marketplace"
    if marketplace.exists() or marketplace.is_symlink():
        raise ValueError("Refusing to overwrite an existing Claude Code build destination")
    environment = {key: value for key, value in os.environ.items() if not key.startswith("GATHERTHREAD_")}
    try:
        subprocess.run([str(node), str(repository / "plugins/gatherthread-claude/scripts/prepare-source-plugin.mjs"),
                        "--output", str(marketplace)], cwd=repository, check=True, timeout=90,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=environment, shell=False)
    except (OSError, subprocess.SubprocessError):
        raise ValueError("Could not prepare the reviewed Claude Code plugin bundle") from None
    validate_claude_marketplace(marketplace)
    manifest_file = marketplace / ".claude-plugin/marketplace.json"
    manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
    manifest["name"] = "gatherthread-launcher-claude"
    manifest_file.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    connector = resources / "connector"
    connector.mkdir(parents=True, exist_ok=True)
    shutil.copytree(marketplace / "plugins/gatherthread/connector", connector / "claude")
    (connector / "claude-connect.js").write_text("import './claude/claude-connect.js';\n", encoding="utf-8")
