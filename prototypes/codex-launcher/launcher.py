"""Windows GatherThread connection launcher, bundled with Python and Node."""

from __future__ import annotations

import os
import datetime
import json
import math
import queue
import re
import shutil
import socket
import subprocess
import sys
import threading
import tkinter as tk
import time
import webbrowser
from pathlib import Path
from tkinter import filedialog, messagebox, ttk
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, HTTPRedirectHandler, build_opener
from urllib.error import HTTPError, URLError


PACKAGE = "@gatherthread/codex-connect@0.1.0-beta.3"
CLAUDE_PACKAGE = "@gatherthread/claude-connect@0.1.0-beta.3"
SERVER_ORIGIN = "https://gatherthread.cn"
TEST_SERVER_ORIGIN = "https://test.gatherthread.cn"
OFFICIAL_ORIGINS = {SERVER_ORIGIN, TEST_SERVER_ORIGIN}
PROJECT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
SCHEME = "gatherthread-connect"
LINK_VERSION = "3"
HARNESSES = {"codex": "Codex", "claude-code": "Claude Code"}
EMAIL_RE = re.compile(r"^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$")
UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
DEVICE_TOKEN_RE = re.compile(r"^gta_[A-Za-z0-9_-]{43}$")
AUTHORIZATION_RESPONSE_LIMIT = 16 * 1024
AUTHORIZATION_DEADLINE_SECONDS = 15
AUTHORIZATION_FAILURE = "账号授权未完成。请检查密码，并从网页重新打开启动器；不要自动重试。 / Authorization failed. Check the password and reopen the Launcher from the website."
AUTHORIZATION_CANCELLED = "已取消本次授权。需要连接时，请从网页重新打开启动器。 / Authorization cancelled. Reopen the Launcher from the website to connect."
WINDOWS_APP_ID = "GatherThread.CodexLauncher"


def safe_origin(value: str) -> str:
    parsed = urlparse(value)
    loopback = parsed.hostname in {"localhost", "127.0.0.1", "::1"}
    if (parsed.scheme != "https" and not (parsed.scheme == "http" and loopback)) or not parsed.hostname:
        raise ValueError("服务地址须为 HTTPS，或本机 loopback HTTP")
    if parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path.rstrip("/") not in {"", "/v1"}:
        raise ValueError("服务地址含有不支持的路径或参数")
    if any(ord(char) < 32 for char in value):
        raise ValueError("服务地址包含控制字符")
    return value.rstrip("/")


def parse_link(value: str) -> tuple:
    if any(ord(char) < 32 or 127 <= ord(char) <= 159 for char in value):
        raise ValueError("GatherThread 连接链接含有控制字符")
    if len(value.encode("utf-8")) > 2048:
        raise ValueError("GatherThread 连接链接过长")
    parsed = urlparse(value)
    if parsed.scheme != SCHEME or parsed.netloc != "connect" or parsed.path not in {"", "/"} or parsed.fragment:
        raise ValueError("无效的 GatherThread 连接链接")
    query = parse_qs(parsed.query, strict_parsing=True, keep_blank_values=True)
    version = query.get("v", [""])[0]
    fields = {"v", "origin", "project", "model", "context_window_tokens", "visible_history_sync"}
    if version in {"2", "3"}:
        fields |= {"email", "authorization_id"}
    if version == "3":
        fields.add("harness")
    if set(query) != fields or any(len(item) != 1 for item in query.values()):
        raise ValueError("连接链接包含不支持的参数")
    if version not in {"1", "2", LINK_VERSION}:
        raise ValueError("不支持的 GatherThread 连接链接版本")
    origin = safe_origin(query["origin"][0])
    allowed = {SERVER_ORIGIN} if version == "1" else OFFICIAL_ORIGINS
    if origin not in allowed or query["origin"][0] != origin:
        raise ValueError("连接链接的网页地址不是允许的 gatherthread.cn 正式或测试环境")
    project = query["project"][0]
    if not PROJECT_RE.fullmatch(project):
        raise ValueError("无效的项目 ID")
    model = valid_model(query["model"][0])
    tokens = valid_context_tokens(query["context_window_tokens"][0])
    mode = valid_history_sync(query["visible_history_sync"][0])
    parsed_settings = origin, project, model, tokens, mode
    if version == "1":
        return parsed_settings
    email = valid_email(query["email"][0])
    authorization_id = query["authorization_id"][0]
    if not UUID_RE.fullmatch(authorization_id):
        raise ValueError("网页授权已失效，请从网页重新打开启动器")
    if version == "3":
        harness = query["harness"][0]
        if harness not in HARNESSES:
            raise ValueError("不支持的 Agent 类型；请从网页重新打开启动器")
        if harness == "claude-code":
            valid_claude_model(model)
        return (*parsed_settings, email, authorization_id, harness)
    return (*parsed_settings, email, authorization_id)


def valid_email(value: str) -> str:
    if not isinstance(value, str) or len(value) > 254:
        raise ValueError("邮箱账号无效，请从网页重新打开启动器")
    email = value.strip().lower()
    if not email.isascii() or not EMAIL_RE.fullmatch(email):
        raise ValueError("邮箱账号无效，请从网页重新打开启动器")
    local, domain = email.split("@")
    if len(local) > 64 or any(len(label) > 63 for label in domain.split(".")):
        raise ValueError("邮箱账号无效，请从网页重新打开启动器")
    return email


def valid_password(value: str) -> str:
    try:
        utf16_length = len(value.encode("utf-16-le")) // 2
        utf8_length = len(value.encode("utf-8"))
    except (AttributeError, UnicodeError):
        raise ValueError("密码须为 8 至 128 个字符 / Use 8–128 characters") from None
    if not 8 <= utf16_length <= 128 or utf8_length > 512:
        raise ValueError("密码须为 8 至 128 个字符 / Use 8–128 characters")
    return value


class NoAuthorizationRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        return None


class AuthorizationCancelled(Exception):
    """Local cancellation is not a server error or a server-side rollback."""


def validated_claim_token(payload: bytes, authorization_id: str) -> str:
    """Only a coherent native-device result may reach the connector environment."""
    try:
        data = json.loads(payload)["data"]
        actor, device, authorization = data["actor"], data["device"], data["authorization"]
        token = data["token"]
        identifiers = (actor["user_id"], actor["device_id"], device["id"], device["user_id"],
                       authorization["user_id"], authorization["claimed_by_device_id"], authorization["authorizer_device_id"])
        token_version = device["token_version"]
        if (not isinstance(token, str) or not DEVICE_TOKEN_RE.fullmatch(token)
                or any(not isinstance(value, str) or not PROJECT_RE.fullmatch(value) for value in identifiers)
                or actor["device_id"] != device["id"] or device["id"] != authorization["claimed_by_device_id"]
                or actor["user_id"] != device["user_id"] or device["user_id"] != authorization["user_id"]
                or authorization["id"] != authorization_id
                or not valid_response_label(actor["display_name"]) or not valid_response_label(device["name"])
                or not valid_timestamp(device["created_at"]) or not valid_timestamp(device["token_created_at"])
                or any(device[field] is not None and not valid_timestamp(device[field])
                       for field in ("last_used_at", "expires_at", "revoked_at", "rotated_at"))
                or device["revoked_at"] is not None
                or type(token_version) not in (int, float) or not math.isfinite(token_version)
                or token_version <= 0 or math.floor(token_version) != token_version
                or any(not valid_timestamp(authorization[field])
                       for field in ("created_at", "expires_at", "claimed_at"))
                or authorization["revoked_at"] is not None or authorization["expired_at"] is not None):
            raise ValueError()
        return token
    except (ValueError, KeyError, TypeError, AttributeError, UnicodeError, RecursionError, OverflowError):
        raise ValueError(AUTHORIZATION_FAILURE) from None


def valid_response_label(value) -> bool:
    return isinstance(value, str) and bool(value.strip()) and len(value.encode("utf-16-le")) // 2 <= 120


def valid_timestamp(value) -> bool:
    if not isinstance(value, str) or not re.fullmatch(
            r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z", value):
        return False
    try:
        datetime.datetime.fromisoformat(value[:-1] + "+00:00")
        return True
    except ValueError:
        return False


def claim_email_authorization(origin: str, authorization_id: str, project: str,
                              email: str, password: str, device_name: str,
                              *, cancelled: threading.Event | None = None) -> str:
    """One explicit claim; no cookies, redirects, persistent password or implicit retry."""
    cancelled = cancelled if cancelled is not None else threading.Event()
    if cancelled.is_set():
        raise AuthorizationCancelled()
    if origin not in OFFICIAL_ORIGINS or not UUID_RE.fullmatch(authorization_id) or not PROJECT_RE.fullmatch(project):
        raise ValueError(AUTHORIZATION_FAILURE)
    email = valid_email(email)
    password = valid_password(password)
    if (not device_name.strip() or len(device_name) > 120
            or any(ord(char) < 32 or 127 <= ord(char) <= 159 for char in device_name)):
        raise ValueError(AUTHORIZATION_FAILURE)
    body = json.dumps({"authorization_id": authorization_id, "project_id": project,
                       "email": email, "password": password, "device_name": device_name},
                      ensure_ascii=False).encode("utf-8")
    del password
    if len(body) > 8192:
        raise ValueError(AUTHORIZATION_FAILURE)
    request = Request(origin + "/v1/codex-launcher-authorizations/claim", data=body,
                      headers={"Content-Type": "application/json", "Accept": "application/json"}, method="POST")
    del body
    result: queue.Queue[tuple[bool, str]] = queue.Queue(maxsize=1)
    abandoned = threading.Event()
    response_lock = threading.Lock()
    active_response = [None]
    deadline = time.monotonic() + AUTHORIZATION_DEADLINE_SECONDS

    def stopped() -> bool:
        return cancelled.is_set() or abandoned.is_set()

    def abandon_transport() -> None:
        abandoned.set()
        request.data = None
        with response_lock:
            response = active_response[0]
        if response is None:
            return

        def close_response() -> None:
            # shutdown wakes a CPython socket-backed read where available.
            # close is best effort and can block in a third-party handler, so
            # the foreground authorization worker never waits for it.
            stream = getattr(response, "fp", None)
            raw = getattr(stream, "raw", None)
            transport = getattr(raw, "_sock", None)
            try:
                if transport is not None:
                    transport.shutdown(socket.SHUT_RDWR)
            except (OSError, ValueError, AttributeError):
                pass
            try:
                response.close()
            except (OSError, ValueError, AttributeError):
                pass

        threading.Thread(target=close_response, daemon=True).start()

    def exchange() -> None:
        response = None
        try:
            if stopped():
                return
            opener = build_opener(NoAuthorizationRedirect())
            if stopped():
                return
            response = opener.open(request, timeout=AUTHORIZATION_DEADLINE_SECONDS)
            with response_lock:
                active_response[0] = response
            with response:
                if stopped():
                    return
                if response.status != 201 or response.headers.get("Content-Type", "").split(";", 1)[0].lower() != "application/json":
                    raise ValueError()
                chunks = bytearray()
                while len(chunks) <= AUTHORIZATION_RESPONSE_LIMIT:
                    if stopped() or time.monotonic() >= deadline:
                        raise ValueError()
                    chunk = response.read1(min(4096, AUTHORIZATION_RESPONSE_LIMIT + 1 - len(chunks)))
                    if not chunk:
                        break
                    chunks.extend(chunk)
                if len(chunks) > AUTHORIZATION_RESPONSE_LIMIT:
                    raise ValueError()
                token = validated_claim_token(bytes(chunks), authorization_id)
                if stopped() or time.monotonic() >= deadline:
                    return
                request.data = None
                result.put_nowait((True, token))
        except (OSError, HTTPError, URLError, ValueError, AttributeError):
            if not stopped():
                result.put_nowait((False, ""))
        finally:
            request.data = None
            with response_lock:
                if active_response[0] is response:
                    active_response[0] = None

    threading.Thread(target=exchange, daemon=True).start()
    while True:
        if cancelled.is_set():
            abandon_transport()
            raise AuthorizationCancelled()
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            abandon_transport()
            raise ValueError(AUTHORIZATION_FAILURE) from None
        try:
            success, token = result.get(timeout=min(0.05, remaining))
        except queue.Empty:
            continue
        if cancelled.is_set():
            abandon_transport()
            raise AuthorizationCancelled()
        if not success:
            raise ValueError(AUTHORIZATION_FAILURE)
        return token


def valid_model(value: str) -> str:
    if not value.strip() or len(value) > 120 or value.startswith("-") or any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise ValueError("Agent 模型名称无效")
    return value


def valid_claude_model(value: str) -> str:
    if not re.fullmatch(r"claude-[A-Za-z0-9][A-Za-z0-9._-]{0,112}", value):
        raise ValueError("请输入完整的 Claude 模型 ID，不能使用 sonnet/opus 等别名")
    return value


def valid_context_tokens(value: str) -> int:
    if not value.isascii() or not value.isdecimal():
        raise ValueError("上下文 Token 上限必须是整数")
    number = int(value)
    if not 4096 <= number <= 2_000_000:
        raise ValueError("上下文 Token 上限必须在 4096 到 2000000 之间")
    return number


def valid_history_sync(value: str) -> str:
    if value not in {"first-connect", "never"}:
        raise ValueError("历史导入选项无效")
    return value


def selected_workspace(value: str) -> str | None:
    if not value:
        return None
    path = Path(value)
    if not path.is_absolute() or not path.is_dir():
        raise ValueError("工作目录必须是已存在的本地绝对路径目录")
    return str(path.resolve())


def connector_args(node: Path, connector: Path, origin: str, project: str,
                   model: str, tokens: int, mode: str, codex: str,
                   workspace: str | None = None, *, harness: str = "codex", code_sync: bool = False) -> list[str]:
    if harness not in HARNESSES:
        raise ValueError("不支持的 Agent 类型")
    return [str(node), str(connector), "--url", origin, "--project", project,
            *(["--workspace", workspace] if workspace else ["--create-workspace"]),
            "--plugin-hooks", "--model", model,
            *(["--claude-command", codex, *(["--code-sync"] if code_sync else [])] if harness == "claude-code"
              else ["--visible-history-sync", mode, "--context-window-tokens", str(tokens), "--codex-command", codex])]


def runtime_dir() -> Path:
    return Path(__file__).resolve().parent


def installed_dir() -> Path:
    return Path(os.environ["LOCALAPPDATA"]) / "Programs" / "GatherThread Launcher"


def bundled_node() -> Path:
    return runtime_dir() / "runtime" / ("node.exe" if os.name == "nt" else "bin/node")


def bundled_connector(harness: str = "codex") -> Path:
    if harness not in HARNESSES:
        raise ValueError("不支持的 Agent 类型")
    return runtime_dir() / "connector" / ("claude-connect.js" if harness == "claude-code" else "codex-connect.js")


def plugin_install_commands(executable: str, directory: Path, harness: str = "codex") -> list[list[str]]:
    if harness == "claude-code":
        return [[executable, "plugin", "marketplace", "add", str(directory / "claude-marketplace")],
                [executable, "plugin", "install", "gatherthread@gatherthread-launcher-claude", "--scope", "user"]]
    if harness != "codex":
        raise ValueError("不支持的 Agent 类型")
    return [[executable, "plugin", "marketplace", "add", str(directory)],
            [executable, "plugin", "add", "gatherthread@gatherthread-launcher"]]


def find_claude() -> str:
    candidates = claude_command_candidates()
    return candidates[0] if candidates else ""


def claude_command_candidates(*, path=None, home=None, windows=None) -> list[str]:
    """Existing native executables only; discovery never installs or invokes a shell wrapper."""
    windows = os.name == "nt" if windows is None else windows
    home = Path.home() if home is None else Path(home)
    name = "claude.exe" if windows else "claude"
    directories = (os.environ.get("PATH", "") if path is None else path).split(";" if windows else os.pathsep)
    candidates = [Path(directory) / name for directory in directories if directory and Path(directory).is_absolute()]
    candidates += [home / ".local/bin" / name, home / ".npm-global/bin" / name]
    if not windows:
        candidates += [Path("/opt/homebrew/bin/claude"), Path("/usr/local/bin/claude")]
    existing, seen = [], set()
    for candidate in candidates:
        identity = os.path.normcase(os.path.realpath(candidate))
        if identity in seen or not candidate.is_file() or not windows and not os.access(candidate, os.X_OK):
            continue
        seen.add(identity)
        existing.append(str(candidate))
    return existing[:12]


def compatible_claude_version(value: str) -> bool:
    match = re.match(r"^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:\s|$)", value.strip())
    return bool(match and tuple(map(int, match.groups())) >= (2, 1, 259))


def probe_claude_version(executable: str) -> str:
    environment = os.environ.copy()
    for key in ("GATHERTHREAD_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY"):
        environment.pop(key, None)
    try:
        result = subprocess.run([executable, "--version"], stdin=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, text=True, encoding="utf-8", errors="replace", timeout=0.8,
                                shell=False, env=environment, creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        return result.stdout[:4096] if result.returncode == 0 else ""
    except (OSError, subprocess.TimeoutExpired):
        return ""


def preferred_claude_command(candidates=None, probe=None) -> tuple[str, bool]:
    candidates = claude_command_candidates() if candidates is None else candidates
    probe = probe_claude_version if probe is None else probe
    for candidate in candidates:
        if compatible_claude_version(probe(candidate) or ""):
            return candidate, True
    return (candidates[0] if candidates else ""), False


def can_apply_claude_discovery(*, harness, generation, current_generation, selected, original, manual, busy) -> bool:
    return harness == "claude-code" and generation == current_generation and selected == original and not manual and not busy


def native_claude_command(selected: str) -> str:
    path = Path(selected)
    if not path.is_absolute() or not path.is_file():
        raise ValueError("请选择已安装且已登录的 Claude Code CLI 完整路径")
    if os.name == "nt" and path.suffix.lower() != ".exe":
        raise ValueError("请使用 Claude Code 原生 claude.exe；不能启动 .cmd/.bat 包装脚本")
    return str(path)


def hook_node_command(node: Path) -> str:
    """Fail closed on cmd.exe expansions in the installed Node path."""
    value = str(node)
    if not value or any(char in value for char in ('"', '%', '!', '$', '\0', '\r', '\n')):
        raise ValueError("插件安装路径包含 Windows Hook 命令不支持的字符")
    return f'"{value}" "${{PLUGIN_ROOT}}/scripts/hook-forwarder.mjs"'


def configure_claude_plugin(directory: Path) -> None:
    """Bind only the separately bundled Claude plugin to the private Node."""
    plugin = directory / "claude-marketplace" / "plugins" / "gatherthread"
    node = directory / "runtime" / "node.exe"
    required = [plugin / ".claude-plugin" / "plugin.json", plugin / "scripts" / "hook-forwarder.mjs",
                plugin / "scripts" / "mcp-launcher.mjs", plugin / "hooks" / "hooks.json"]
    if not all(path.is_file() for path in required):
        raise ValueError("安装包缺少 Claude Code 插件文件")
    command = hook_node_command(node).replace("${PLUGIN_ROOT}", "${CLAUDE_PLUGIN_ROOT}")
    (plugin / ".mcp.json").write_text(json.dumps({"mcpServers": {"gatherthread": {
        "command": str(node), "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/mcp-launcher.mjs"]}}},
        ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    hooks_path = plugin / "hooks" / "hooks.json"
    hooks = json.loads(hooks_path.read_text(encoding="utf-8"))
    for entries in hooks["hooks"].values():
        for entry in entries:
            for hook in entry["hooks"]:
                if hook.get("type") != "command":
                    raise ValueError("Claude Code 插件包含不支持的 Hook")
                hook["command"] = command
    hooks_path.write_text(json.dumps(hooks, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def find_codex() -> str:
    from shutil import which
    found = which("codex.exe")
    if found:
        return found
    local = Path(os.environ.get("LOCALAPPDATA", "")) / "OpenAI" / "Codex" / "bin"
    candidates = list(local.glob("*/codex.exe")) if local.is_dir() else []
    if candidates:
        return str(max(candidates, key=lambda item: item.stat().st_mtime))
    return which("codex.cmd") or which("codex") or ""


def npm_codex_native(wrapper: Path) -> Path | None:
    """Find the native binary installed by the official Windows npm package."""
    if wrapper.name.lower() != "codex.cmd":
        return None
    try:
        shim = wrapper.read_text(encoding="utf-8", errors="replace")[:16_384].lower()
    except OSError:
        return None
    # Resolve only the npm shim's own package. An arbitrary .cmd may launch a
    # different Codex (or something else), even when codex.exe is on PATH.
    if not re.search(r"node_modules[\\/]@openai[\\/]codex[\\/]bin[\\/]codex\.js", shim):
        return None
    if "%~dp0" not in shim and "%dp0%" not in shim:
        return None
    prefix = wrapper.parent
    main_package = prefix / "node_modules" / "@openai" / "codex"
    try:
        metadata = json.loads((main_package / "package.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(metadata, dict):
        return None
    declared_bin = metadata.get("bin")
    if metadata.get("name") != "@openai/codex" or not (
        declared_bin == "bin/codex.js"
        or isinstance(declared_bin, dict) and declared_bin.get("codex") == "bin/codex.js"
    ):
        return None
    packages = (
        main_package / "node_modules" / "@openai" / "codex-win32-x64",
        prefix / "node_modules" / "@openai" / "codex-win32-x64",
    )
    for package in packages:
        for subdir in ("bin", "codex"):
            candidate = package / "vendor" / "x86_64-pc-windows-msvc" / subdir / "codex.exe"
            if candidate.is_file():
                return candidate
    return None


def native_codex_command(selected: str) -> str:
    path = Path(selected)
    if not path.is_file():
        raise ValueError("请选择已安装且已登录的 Codex CLI 完整路径")
    if os.name != "nt":
        return str(path)
    if path.suffix.lower() == ".exe":
        return str(path)
    if path.suffix.lower() in {".cmd", ".bat"}:
        npm_native = npm_codex_native(path)
        if npm_native:
            return str(npm_native)
    raise ValueError("Codex App Server 需要原生 codex.exe；请安装支持插件的 Codex Desktop/CLI，或直接选择其 codex.exe。不能直接启动 codex.cmd。")


def register_windows_scheme(directory: Path) -> None:
    if os.name != "nt":
        raise RuntimeError("URL Scheme 注册仅支持 Windows")
    import winreg

    exe = str((directory / "runtime" / "pythonw.exe").resolve())
    script = str((directory / "launcher.py").resolve())
    base = rf"Software\Classes\{SCHEME}"
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, base) as key:
        winreg.SetValueEx(key, "", 0, winreg.REG_SZ, "URL:GatherThread Agent connection")
        winreg.SetValueEx(key, "URL Protocol", 0, winreg.REG_SZ, "")
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, base + r"\DefaultIcon") as key:
        winreg.SetValueEx(key, "", 0, winreg.REG_SZ, f'"{directory / "assets" / "gatherthread.ico"}",0')
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, base + r"\shell\open\command") as key:
        winreg.SetValueEx(key, "", 0, winreg.REG_SZ, f'"{exe}" "{script}" "%1"')


def configure_window_icon(window: tk.Tk) -> None:
    """Separate process/window identity from the unmodified bundled Python runtime."""
    if os.name == "nt":
        import ctypes
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(WINDOWS_APP_ID)
    assets = runtime_dir() / "assets"
    try:
        window._application_icon = tk.PhotoImage(file=str(assets / "gatherthread.png"))
        window.iconphoto(True, window._application_icon)
        if os.name == "nt":
            window.iconbitmap(default=str(assets / "gatherthread.ico"))
    except tk.TclError:
        # A source checkout can be inspected without generated icon assets.
        # Distribution verification requires both assets before publication.
        pass


def create_start_menu_shortcut(directory: Path) -> None:
    """Create one current-user entry pointing only at this installation."""
    shortcut = Path(os.environ["APPDATA"]) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "GatherThread Launcher.lnk"
    shortcut.parent.mkdir(parents=True, exist_ok=True)

    def quoted(value: str | Path) -> str:
        return "'" + str(value).replace("'", "''") + "'"

    script = (
        "$ErrorActionPreference='Stop';$shell=New-Object -ComObject WScript.Shell;"
        f"$link=$shell.CreateShortcut({quoted(shortcut)});"
        f"if ((Test-Path -LiteralPath {quoted(shortcut)}) -and (($link.TargetPath -ne {quoted(directory / 'runtime' / 'pythonw.exe')}) -or ($link.Arguments -ne {quoted(chr(34) + str(directory / 'launcher.py') + chr(34))}))) {{throw 'Existing shortcut is not owned by GatherThread Launcher'}};"
        f"$link.TargetPath={quoted(directory / 'runtime' / 'pythonw.exe')};"
        f"$link.Arguments={quoted(chr(34) + str(directory / 'launcher.py') + chr(34))};"
        f"$link.WorkingDirectory={quoted(directory)};"
        f"$link.IconLocation={quoted(str(directory / 'assets' / 'gatherthread.ico') + ',0')};"
        "$link.Description='GatherThread Agent Launcher';$link.Save()"
    )
    subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
                   check=True, capture_output=True, timeout=30, shell=False)


def install_bundle() -> Path:
    """Copy the portable folder to a stable per-user location and wire the plugin."""
    source, target = runtime_dir(), installed_dir()
    hook_command = hook_node_command(target / "runtime" / "node.exe")
    if source != target:
        shutil.copytree(source, target, dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns("*.pyc", "__pycache__"))
    node = target / "runtime" / "node.exe"
    connector = target / "connector" / "codex-connect.js"
    plugin = target / "plugins" / "gatherthread"
    if not all(path.is_file() for path in (node, connector, plugin / ".mcp.json", plugin / "hooks" / "hooks.json",
                                         target / "assets" / "gatherthread.ico", target / "assets" / "gatherthread.png")):
        raise RuntimeError("安装包缺少 Node、连接器、图标或插件文件")
    mcp = {"mcpServers": {"gatherthread": {
        "command": str(node), "args": [str(connector), "mcp"]}}}
    (plugin / ".mcp.json").write_text(json.dumps(mcp, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    hooks_path = plugin / "hooks" / "hooks.json"
    hooks = json.loads(hooks_path.read_text(encoding="utf-8"))
    for event in ("UserPromptSubmit", "Stop"):
        hooks["hooks"][event][0]["hooks"][0]["command"] = hook_command
    hooks_path.write_text(json.dumps(hooks, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if (target / "claude-marketplace").is_dir():
        configure_claude_plugin(target)
    register_windows_scheme(target)
    create_start_menu_shortcut(target)
    return target


class Launcher(tk.Tk):
    def __init__(self, link: str | None):
        super().__init__()
        self.title("GatherThread · Connect Agent")
        configure_window_icon(self)
        self.geometry("760x760")
        self.minsize(680, 640)
        self.events: queue.Queue[tuple[str, str | tuple[int, str, str, bool]]] = queue.Queue()
        self.connector: subprocess.Popen[str] | None = None
        self.connector_lock = threading.Lock()
        self.busy = False
        self.project = tk.StringVar()
        self.workspace = tk.StringVar()
        self.code_sync = tk.BooleanVar(value=False)
        self.harness = "codex"
        self.target_label = tk.StringVar(value="连接本机 Codex")
        self.cli_label = tk.StringVar(value="Codex CLI 完整路径")
        self.codex = tk.StringVar(value=find_codex())
        self.claude_manual_path = None
        self.claude_discovery_generation = 0
        self.claude_discovery_pending = False
        self.setting_cli_path = False
        self.codex.trace_add("write", self._cli_path_changed)
        self.model = tk.StringVar(value="gpt-5.6-sol")
        self.context_tokens = tk.StringVar(value="128000")
        self.history_sync = tk.StringVar(value="first-connect")
        self.origin = tk.StringVar(value=SERVER_ORIGIN)
        self.email = tk.StringVar()
        self.password = tk.StringVar()
        self.token = tk.StringVar()
        self.link_version = ""
        self.authorization_id = ""
        self.handoff_project = ""
        self.authorization_used = False
        self.connection_cancelled = threading.Event()
        self.status = tk.StringVar(value="请先在网页登录邮箱账号，再从项目中的 Agent 连接入口打开启动器。")
        self.project.trace_add("write", self._clear_secrets)
        self.origin.trace_add("write", self._clear_secrets)
        self._build()
        if link:
            self._apply_link(link)
        else:
            self._refresh_authorization_form()
        self.after(100, self._poll)
        self.protocol("WM_DELETE_WINDOW", self._background)

    def _build(self) -> None:
        root = ttk.Frame(self, padding=18)
        root.pack(fill="both", expand=True)
        ttk.Label(root, textvariable=self.target_label, font=("Segoe UI", 18, "bold")).pack(anchor="w")
        ttk.Label(root, text="网页负责项目和会话；此窗口负责启动并保持本机连接器运行。", wraplength=690).pack(anchor="w", pady=(4, 14))
        ttk.Label(root, textvariable=self.origin).pack(anchor="w", pady=(0, 3))
        self.environment_label = ttk.Label(root, text="正式环境 / Production")
        self.environment_label.pack(anchor="w", pady=(0, 9))
        ttk.Label(root, text="项目 ID（网页打开时自动填入；格式：project-***）").pack(anchor="w")
        ttk.Entry(root, textvariable=self.project).pack(fill="x", pady=(2, 9))
        ttk.Label(root, textvariable=self.cli_label).pack(anchor="w")
        ttk.Entry(root, textvariable=self.codex).pack(fill="x", pady=(2, 9))
        ttk.Label(root, text="本地工作目录（可选；留空使用默认项目目录）").pack(anchor="w")
        workspace_row = ttk.Frame(root)
        workspace_row.pack(fill="x", pady=(2, 9))
        ttk.Entry(workspace_row, textvariable=self.workspace).pack(side="left", fill="x", expand=True)
        ttk.Button(workspace_row, text="浏览…", command=self._choose_workspace).pack(side="left", padx=(8, 0))
        ttk.Button(workspace_row, text="默认目录", command=lambda: self.workspace.set("")).pack(side="left", padx=(8, 0))
        self.code_sync_row = ttk.Frame(root)
        self.code_sync_checkbox = ttk.Checkbutton(self.code_sync_row, variable=self.code_sync,
            text="允许此设备同步项目文件（GT Cloud；上传仍需在项目中开启）")
        self.code_sync_checkbox.pack(anchor="w")
        settings = ttk.Frame(root)
        self.model_settings = settings
        settings.pack(fill="x", pady=(2, 9))
        self.codex_only_settings = []
        for label, var, width in (("模型", self.model, 24), ("上下文 Token 上限", self.context_tokens, 14)):
            column = ttk.Frame(settings)
            column.pack(side="left", padx=(0, 14))
            ttk.Label(column, text=label).pack(anchor="w")
            ttk.Entry(column, textvariable=var, width=width).pack(anchor="w")
            if var is self.context_tokens:
                self.codex_only_settings.append(column)
        history = ttk.Frame(settings)
        history.pack(side="left")
        ttk.Label(history, text="首次历史导入").pack(anchor="w")
        ttk.Combobox(history, textvariable=self.history_sync, values=("first-connect", "never"), state="readonly", width=16).pack(anchor="w")
        self.codex_only_settings.append(history)
        self.authorization_area = ttk.Frame(root)
        self.authorization_area.pack(fill="x", pady=(0, 12))
        self.email_form = ttk.Frame(self.authorization_area)
        ttk.Label(self.email_form, text="邮箱账号 / Email account（由网页填入）").pack(anchor="w")
        ttk.Entry(self.email_form, textvariable=self.email, state="readonly").pack(fill="x", pady=(2, 8))
        ttk.Label(self.email_form, text="账号密码 / Password").pack(anchor="w")
        self.password_entry = ttk.Entry(self.email_form, textvariable=self.password, show="•")
        self.password_entry.pack(fill="x", pady=(2, 4))
        ttk.Label(self.email_form, text="只用于本次授权，不保存密码；其他设备仍保持登录。", wraplength=690).pack(anchor="w")
        self.legacy_form = ttk.Frame(self.authorization_area)
        ttk.Label(self.legacy_form, text="旧版链接：一次性设备授权 / Legacy one-use authorization").pack(anchor="w")
        ttk.Entry(self.legacy_form, textvariable=self.token, show="•").pack(fill="x", pady=(2, 4))
        ttk.Label(self.legacy_form, text="建议返回网页重新打开启动器，使用邮箱账号密码授权。", wraplength=690).pack(anchor="w")
        self.web_form = ttk.Frame(self.authorization_area)
        ttk.Label(self.web_form, text="先在网页登录，再从项目的 Agent 连接入口打开此窗口。", wraplength=690).pack(anchor="w")
        ttk.Button(self.web_form, text="打开 GatherThread 网页 / Open website", command=lambda: webbrowser.open(self.origin.get() + "/app/")).pack(anchor="w", pady=(5, 0))
        ttk.Label(root, text="随包插件为选中的 Agent 提供共序 MCP 与 Hooks。安装前请审查并信任；只连接所选 Agent，不会改用其他 Agent。", wraplength=690).pack(anchor="w")
        buttons = ttk.Frame(root)
        buttons.pack(fill="x", pady=(12, 9))
        self.install_button = ttk.Button(buttons, text="可选：安装随包插件", command=self._install)
        self.install_button.pack(side="left")
        self.connect_button = ttk.Button(buttons, text="启动连接", command=self._connect)
        self.connect_button.pack(side="left", padx=8)
        ttk.Button(buttons, text="停止连接", command=self._stop).pack(side="left")
        ttk.Button(buttons, text="退居后台", command=self._background).pack(side="right")
        ttk.Label(root, textvariable=self.status, wraplength=690).pack(anchor="w", pady=(4, 8))
        self.log = tk.Text(root, height=7, state="disabled", wrap="word")
        self.log.pack(fill="both", expand=True)
        ttk.Label(root, text="关闭窗口会最小化到任务栏；恢复窗口后可停止连接。", wraplength=690).pack(anchor="w", pady=(7, 0))

    def _clear_secrets(self, *_args) -> None:
        self.password.set("")
        self.token.set("")

    def _refresh_authorization_form(self) -> None:
        for form in (self.email_form, self.legacy_form, self.web_form):
            form.pack_forget()
        form = self.email_form if self.link_version in {"2", "3"} else self.legacy_form if self.link_version == "1" else self.web_form
        form.pack(fill="x")
        self.environment_label.configure(text="测试环境 · 账号和数据独立 / Test environment" if self.origin.get() == TEST_SERVER_ORIGIN else "正式环境 / Production")
        self.connect_button.configure(state="normal" if self.link_version else "disabled")

    def _apply_link(self, link: str) -> None:
        self._clear_secrets()
        if self.busy or (self.connector and self.connector.poll() is None):
            self.status.set("连接进行中，请先停止连接再打开新的项目。 / Stop the current connection before opening another project.")
            return
        self.authorization_id = ""
        self.handoff_project = ""
        self.link_version = ""
        self.authorization_used = False
        self.claude_discovery_generation = getattr(self, "claude_discovery_generation", 0) + 1
        self.claude_discovery_pending = False
        self.harness = "codex"
        self.code_sync.set(False)
        self.email.set("")
        try:
            settings = parse_link(link)
            origin, project, model, tokens, mode = settings[:5]
            self.origin.set(origin)
            self.project.set(project)
            self.model.set(model)
            self.context_tokens.set(str(tokens))
            self.history_sync.set(mode)
            self.link_version = "3" if len(settings) == 8 else "2" if len(settings) == 7 else "1"
            self.harness = settings[7] if len(settings) == 8 else "codex"
            name = HARNESSES[self.harness]
            self.title("GatherThread · Connect " + name)
            self.target_label.set("连接本机 " + name)
            self.cli_label.set(name + " CLI 完整路径")
            self.setting_cli_path = True
            try:
                manual = getattr(self, "claude_manual_path", None)
                self.codex.set((manual if manual is not None else find_claude()) if self.harness == "claude-code" else find_codex())
            finally:
                self.setting_cli_path = False
            if self.harness == "claude-code":
                self.code_sync_row.pack(fill="x", pady=(2, 9), before=self.model_settings)
            else:
                self.code_sync_row.pack_forget()
            for widget in self.codex_only_settings:
                if self.harness == "claude-code":
                    widget.pack_forget()
                else:
                    widget.pack(side="left", padx=(0, 14))
            if self.link_version in {"2", "3"}:
                self.email.set(settings[5])
                self.authorization_id = settings[6]
                self.handoff_project = project
                self.status.set("邮箱已填入。输入密码后点击「启动连接」；无需复制 Token。 / Enter your password and start the connection.")
            else:
                self.status.set("这是旧版连接链接。建议在网页重新打开启动器，改用邮箱密码授权。")
        except ValueError:
            # Never echo the incoming URI: it may contain unapproved secrets.
            self.status.set("连接链接无效，请从 GatherThread 网页重新打开启动器。 / Invalid link. Reopen from the website.")
        self._refresh_authorization_form()
        if self.harness == "claude-code" and self.link_version == "3":
            self._discover_claude()

    def _cli_path_changed(self, *_args) -> None:
        if self.harness == "claude-code" and not self.setting_cli_path:
            self.claude_manual_path = self.codex.get()
            self.claude_discovery_generation += 1
            self.claude_discovery_pending = False
            self._set_busy(self.busy)

    def _discover_claude(self) -> None:
        if self.claude_manual_path is not None:
            return
        generation, original = self.claude_discovery_generation, self.codex.get()
        self.claude_discovery_pending = True
        self._set_busy(self.busy)

        def work() -> None:
            path, compatible = preferred_claude_command()
            self.events.put(("claude_discovery", (generation, original, path, compatible)))

        threading.Thread(target=work, daemon=True).start()

    def _apply_claude_discovery(self, generation, original, path, compatible) -> None:
        if not can_apply_claude_discovery(harness=self.harness, generation=generation,
                current_generation=self.claude_discovery_generation, selected=self.codex.get(), original=original,
                manual=self.claude_manual_path is not None, busy=self.busy or bool(self.connector and self.connector.poll() is None)):
            return
        self.claude_discovery_pending = False
        if compatible:
            self.setting_cli_path = True
            try:
                self.codex.set(path)
            finally:
                self.setting_cli_path = False
        else:
            self.status.set("未发现兼容的 Claude Code CLI（需要 2.1.259 或更新版本）。请在本机更新后重新打开；已保留当前路径。")
        self._set_busy(self.busy)

    def _paths(self) -> tuple[Path, str]:
        node = bundled_node()
        if not node.is_file():
            raise ValueError(f"缺少随安装包提供的 Node 24 运行时：{node}")
        validator = native_claude_command if self.harness == "claude-code" else native_codex_command
        codex = validator(self.codex.get().strip())
        if codex != self.codex.get().strip():
            self.codex.set(codex)
        return node, codex

    def _choose_workspace(self) -> None:
        directory = filedialog.askdirectory(parent=self, mustexist=True, title="选择 Agent 本地工作目录")
        if directory:
            self.workspace.set(directory)

    def _env(self, token: str = "") -> dict[str, str]:
        env = os.environ.copy()
        node = bundled_node()
        env["PATH"] = str(node.parent) + os.pathsep + env.get("PATH", "")
        env.pop("GATHERTHREAD_TOKEN", None)
        if token:
            env["GATHERTHREAD_TOKEN"] = token
        return env

    def _set_busy(self, value: bool) -> None:
        self.busy = value
        pending = getattr(self, "claude_discovery_pending", False)
        self.install_button.configure(state="disabled" if value or pending else "normal")
        self.connect_button.configure(state="disabled" if value or pending or not self.link_version or self.authorization_used else "normal")
        self.password_entry.configure(state="disabled" if value else "normal")
        self.code_sync_checkbox.configure(state="disabled" if value or self.connector and self.connector.poll() is None else "normal")

    def _install(self) -> None:
        if self.busy or getattr(self, "claude_discovery_pending", False):
            return
        try:
            _, codex = self._paths()
        except ValueError as error:
            messagebox.showerror("缺少运行环境", str(error))
            return
        if runtime_dir() != installed_dir():
            messagebox.showerror("请先安装 Launcher", "请运行安装包中的 Install.cmd，再从安装后的 Launcher 安装插件。")
            return
        if not messagebox.askokcancel("安装 " + HARNESSES[self.harness] + " 插件",
                                     "将通过所选 Agent 的官方命令，为当前系统用户安装随包 GatherThread 插件。\n\n请确认信任其中的 MCP/Hook 代码；此操作不会替你批准 Agent 的工具操作。"):
            return
        self._set_busy(True)

        def work() -> None:
            commands = plugin_install_commands(codex, installed_dir(), self.harness)
            try:
                for args in commands:
                    self.events.put(("log", "运行：" + " ".join(args)))
                    result = subprocess.run(args, env=self._env(), capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=180, shell=False, creationflags=self._flags())
                    if result.returncode:
                        raise RuntimeError((result.stderr or result.stdout or "插件安装失败")[-1200:])
                self.events.put(("status", "插件安装完成。请在所选 Agent 中重启会话，并通过 /hooks 审查 Hooks。"))
            except (OSError, subprocess.TimeoutExpired, RuntimeError) as error:
                self.events.put(("error", str(error)))
            finally:
                self.events.put(("idle", ""))

        threading.Thread(target=work, daemon=True).start()

    def _connect(self) -> None:
        if getattr(self, "claude_discovery_pending", False):
            self.status.set("正在检查本机 Claude Code 版本，请稍候。")
            return
        if self.busy or (self.connector and self.connector.poll() is None):
            self.status.set("连接器已在运行。")
            return
        try:
            node, codex = self._paths()
            harness = getattr(self, "harness", "codex")
            connector = bundled_connector(harness)
            if not connector.is_file():
                package = CLAUDE_PACKAGE if harness == "claude-code" else PACKAGE
                raise ValueError(f"缺少固定版本 {package} 的打包入口：{connector}")
            origin = self.origin.get()
            if origin not in OFFICIAL_ORIGINS or (self.link_version == "1" and origin != SERVER_ORIGIN):
                raise ValueError("请从正确环境的网页重新打开启动器")
            project = self.project.get().strip()
            if not PROJECT_RE.fullmatch(project):
                raise ValueError("项目 ID 格式不正确；请使用网页显示的项目 ID，格式如 project-***")
            token, password = "", ""
            if self.link_version in {"2", "3"}:
                if self.authorization_used or project != self.handoff_project or not UUID_RE.fullmatch(self.authorization_id):
                    raise ValueError("网页授权已失效，请从网页重新打开启动器")
                password = valid_password(self.password.get())
                email = valid_email(self.email.get())
            elif self.link_version == "1":
                token = self.token.get().strip()
                if not re.fullmatch(r"gtd_[A-Za-z0-9_-]{43}", token):
                    raise ValueError("请输入有效的一次性设备授权")
                email = ""
            else:
                raise ValueError("请先在网页登录，再从项目中的 Agent 连接入口打开启动器")
            model = valid_claude_model(self.model.get()) if harness == "claude-code" else valid_model(self.model.get())
            tokens = valid_context_tokens(self.context_tokens.get())
            mode = valid_history_sync(self.history_sync.get())
            workspace = selected_workspace(self.workspace.get())
        except ValueError as error:
            self._clear_secrets()
            messagebox.showerror("连接信息有误", str(error))
            return
        consent = getattr(self, "code_sync", None)
        args = connector_args(node, connector, origin, project, model, tokens, mode, codex, workspace,
                              harness=harness, code_sync=bool(consent and consent.get()))
        authorization_id = self.authorization_id
        password_buffer = bytearray(password.encode("utf-8"))
        password = ""
        self._clear_secrets()
        self.connection_cancelled = threading.Event()
        cancelled = self.connection_cancelled
        if self.link_version in {"2", "3"}:
            self.authorization_used = True
        self._set_busy(True)
        self.status.set("正在授权本机 " + HARNESSES[harness] + "… / Authorizing this Agent device…")

        def work() -> None:
            credential = token
            try:
                try:
                    if cancelled.is_set():
                        raise AuthorizationCancelled()
                    if password_buffer:
                        credential = claim_email_authorization(origin, authorization_id, project, email,
                                                               password_buffer.decode("utf-8"), "Windows " + HARNESSES[harness] + " Launcher",
                                                               cancelled=cancelled)
                finally:
                    password_buffer[:] = b"\0" * len(password_buffer)
                    password_buffer.clear()
                with self.connector_lock:
                    if cancelled.is_set():
                        raise AuthorizationCancelled()
                    self.connector = subprocess.Popen(args, env=self._env(credential), stdin=subprocess.DEVNULL,
                                                      stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                                      text=True, encoding="utf-8", errors="replace", shell=False, creationflags=self._flags())
                self.events.put(("status", "连接器正在启动。安装或更新插件后请重启所选 Agent 会话，并审查 Hooks。"))
                threading.Thread(target=self._read_connector, args=(self.connector, credential), daemon=True).start()
            except AuthorizationCancelled:
                self.events.put(("status", AUTHORIZATION_CANCELLED))
            except (OSError, ValueError):
                self.events.put(("status", AUTHORIZATION_CANCELLED) if cancelled.is_set()
                                else ("error", AUTHORIZATION_FAILURE))
            finally:
                self.events.put(("idle", ""))

        threading.Thread(target=work, daemon=True).start()

    def _read_connector(self, process: subprocess.Popen[str], token: str) -> None:
        assert process.stdout is not None
        for line in process.stdout:
            output = line.replace(token, "[REDACTED]") if token else line
            output = re.sub(r"\b(?:gta_|gtd_)[A-Za-z0-9_-]+", "[REDACTED]", output)
            self.events.put(("log", output.rstrip()))
        code = process.wait()
        self.events.put(("status", f"连接器已退出，代码 {code}。可检查日志后重试。"))

    def _stop(self) -> None:
        self.connection_cancelled.set()
        self._clear_secrets()
        with self.connector_lock:
            if self.connector and self.connector.poll() is None:
                self.connector.terminate()
                self.status.set("正在停止连接器…")
            elif self.busy:
                self.status.set(AUTHORIZATION_CANCELLED)

    def _background(self) -> None:
        self._clear_secrets()
        if self.busy or (self.connector and self.connector.poll() is None):
            self.iconify()
        else:
            self.destroy()

    def _poll(self) -> None:
        try:
            while True:
                kind, value = self.events.get_nowait()
                if kind == "log":
                    self.log.configure(state="normal")
                    self.log.insert("end", value + "\n")
                    self.log.see("end")
                    self.log.configure(state="disabled")
                elif kind == "status":
                    self.status.set(value)
                elif kind == "error":
                    self.status.set("操作失败：" + value)
                elif kind == "idle":
                    self._set_busy(False)
                elif kind == "claude_discovery":
                    self._apply_claude_discovery(*value)
        except queue.Empty:
            pass
        self.after(100, self._poll)

    @staticmethod
    def _flags() -> int:
        return subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0


def main() -> None:
    if "--install" in sys.argv:
        target = install_bundle()
        print(f"Installed GatherThread Launcher: {target}")
        return
    link = next((arg for arg in sys.argv[1:] if arg.startswith(SCHEME + ":")), None)
    Launcher(link).mainloop()


if __name__ == "__main__":
    main()
