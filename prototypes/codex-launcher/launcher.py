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


PACKAGE = "@gatherthread/codex-connect@0.1.0-beta.6"
CLAUDE_PACKAGE = "@gatherthread/claude-connect@0.1.0-beta.6"
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
CONNECTOR_STOP_TIMEOUT_SECONDS = 30
CONNECTOR_LOG_LINE_LIMIT = 16_384
CONNECTOR_LOG_QUEUE_LIMIT = 512


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


def launcher_work_area(window: tk.Tk) -> tuple[int, int, int, int]:
    """Nearest monitor's usable bounds, excluding its taskbar/docked toolbars."""
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes

        class MonitorInfo(ctypes.Structure):
            _fields_ = [("size", wintypes.DWORD), ("monitor", wintypes.RECT),
                        ("work", wintypes.RECT), ("flags", wintypes.DWORD)]

        user = ctypes.windll.user32
        user.MonitorFromWindow.argtypes = [wintypes.HWND, wintypes.DWORD]
        user.MonitorFromWindow.restype = wintypes.HANDLE
        user.GetMonitorInfoW.argtypes = [wintypes.HANDLE, ctypes.POINTER(MonitorInfo)]
        info = MonitorInfo()
        info.size = ctypes.sizeof(info)
        monitor = user.MonitorFromWindow(int(window.frame(), 0), 2)
        if monitor and user.GetMonitorInfoW(monitor, ctypes.byref(info)):
            return info.work.left, info.work.top, info.work.right, info.work.bottom
        work = wintypes.RECT()
        if user.SystemParametersInfoW(0x0030, 0, ctypes.byref(work), 0):
            return work.left, work.top, work.right, work.bottom
    return 0, 0, window.winfo_screenwidth(), max(1, window.winfo_screenheight() - 48)


def windows_high_contrast() -> bool:
    if os.name != "nt":
        return False
    import ctypes
    from ctypes import wintypes

    class HighContrast(ctypes.Structure):
        _fields_ = [("size", wintypes.UINT), ("flags", wintypes.DWORD), ("scheme", wintypes.LPWSTR)]

    value = HighContrast()
    value.size = ctypes.sizeof(value)
    return bool(ctypes.windll.user32.SystemParametersInfoW(0x0042, value.size, ctypes.byref(value), 0) and value.flags & 1)


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
        self.minsize(640, 400)
        self.events: queue.Queue[tuple[str, str | tuple[int, str, str, bool]]] = queue.Queue()
        self.connector: subprocess.Popen[str] | None = None
        self.connector_lock = threading.Lock()
        self.stopping_connector: subprocess.Popen[str] | None = None
        self.stop_deadline: float | None = None
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
        self._fit_window_to_work_area()
        self.after(100, self._poll)
        self.protocol("WM_DELETE_WINDOW", self._background)

    def _build(self) -> None:
        self.high_contrast = windows_high_contrast()
        self.configure(bg="#f6f7f9")
        style = ttk.Style(self)
        style.theme_use("clam")
        style.configure("TFrame", background="#ffffff")
        style.configure("TLabel", background="#ffffff", foreground="#253047", font=("Microsoft YaHei UI", 10))
        style.configure("Muted.TLabel", foreground="#667085")
        style.configure("Title.TLabel", font=("Microsoft YaHei UI", 22, "bold"))
        style.configure("Heading.TLabel", font=("Microsoft YaHei UI", 12, "bold"))
        style.configure("Card.TFrame", bordercolor="#e0e5ef", lightcolor="#e0e5ef", darkcolor="#e0e5ef")
        style.configure("Vertical.TScrollbar", arrowsize=0, width=8, background="#cbd4e3", troughcolor="#f6f7f9", borderwidth=0)
        style.layout("Vertical.TScrollbar", [("Vertical.Scrollbar.trough", {"sticky": "ns", "children": [("Vertical.Scrollbar.thumb", {"expand": "1", "sticky": "nswe"})]})])
        style.configure("TEntry", padding=9, fieldbackground="#ffffff", bordercolor="#d7dde5", lightcolor="#d7dde5", darkcolor="#d7dde5")
        style.configure("TCombobox", padding=7)
        style.configure("TButton", font=("Microsoft YaHei UI", 10), padding=(14, 9), background="#f4f6f8", bordercolor="#d7dde5")
        style.map("TButton", background=[("active", "#e8edf2")], bordercolor=[("focus", "#5376cf")])
        style.configure("Primary.TButton", background="#315bd6", foreground="#ffffff", bordercolor="#315bd6")
        style.map("Primary.TButton", background=[("disabled", "#dce2ef"), ("active", "#264bb9")], foreground=[("disabled", "#6b7280")])
        self.page = 0
        self.default_root = str(Path.home() / "GatherThread Projects")
        self.workspace_display = tk.StringVar(value=self.workspace.get() or self.default_root)
        self.workspace_hint = tk.StringVar()
        self.workspace.trace_add("write", self._refresh_workspace_display)
        self._refresh_workspace_display()
        self.actual_workspace = tk.StringVar(value="连接后显示实际目录 / Available after connection")
        self.connection_state = tk.StringVar(value="尚未连接 / Not connected")
        self.plugin_state = tk.StringVar(value="等待安装或使用已有插件 / Install or use your existing plugin")
        self.session_state = tk.StringVar(value="等待连接会话 / Waiting for sessions")
        self.latest_event = tk.StringVar(value="尚无同步反馈 / No activity yet")
        self.sync_feedback = tk.StringVar(value="尚无同步反馈 / No sync feedback yet")
        self.step_labels = []
        shell = tk.Frame(self, bg="#f6f7f9")
        shell.pack(fill="both", expand=True, padx=24, pady=20)
        top = tk.Frame(shell, bg="#f6f7f9")
        top.pack(fill="x", pady=(0, 18))
        tk.Label(top, textvariable=self.target_label, bg="#f6f7f9", fg="#253047", font=("Microsoft YaHei UI", 18, "bold")).pack(side="left")
        try:
            self.brand_image = tk.PhotoImage(file=str(runtime_dir() / "assets/gatherthread-lockup.png")).subsample(6)
            tk.Label(top, image=self.brand_image, bg="#f6f7f9").pack(side="right")
        except tk.TclError:
            tk.Label(top, text="LOCAL CONNECTOR / 本地连接器", bg="#f6f7f9", fg="#667085").pack(side="right")
        body = tk.Frame(shell, bg="#f6f7f9")
        body.pack(fill="both", expand=True)
        self.body = body
        self.compact_navigation = ttk.Combobox(shell, state="readonly", values=("01 插件准备 / Plugin", "02 账号与模型 / Account", "03 本地目录 / Workspace", "04 连接与同步状态 / Status"))
        self.compact_navigation.current(0)
        self.compact_navigation.bind("<<ComboboxSelected>>", lambda _e: self._navigate_page(self.compact_navigation.current()))
        sidebar = self.sidebar = tk.Frame(body, bg="#eef1f7", width=215)
        sidebar.pack(side="left", fill="y", padx=(0, 16))
        sidebar.pack_propagate(False)
        tk.Label(sidebar, text="开始连接 / GET STARTED", bg="#eef1f7", fg="#667085", font=("Microsoft YaHei UI", 9)).pack(anchor="w", padx=18, pady=(22, 18))
        for index, (number, title, subtitle) in enumerate((("01", "插件准备", "Bundled plugin"), ("02", "账号与模型", "Account & model"), ("03", "本地目录", "Local workspace"), ("04", "连接与同步状态", "Connection & sync"))):
            label = tk.Label(sidebar, text=f"{number}   {title}\n        {subtitle}", justify="left", anchor="w", padx=8, pady=15, bg="#eef1f7", fg="#667085", font=("Microsoft YaHei UI", 11), cursor="hand2", takefocus=True, highlightthickness=2, highlightbackground="#eef1f7", highlightcolor="#315bd6")
            label.pack(fill="x", padx=8, pady=3)
            for event in ("<Button-1>", "<Return>", "<space>"):
                label.bind(event, lambda _e, target=index: self._navigate_page(target))
            self.step_labels.append(label)
        tk.Label(sidebar, text="设置完成后\n在状态页查看连接与同步进度。\n\n网页负责项目和会话；\n此窗口保持本机连接。", justify="left", wraplength=175, bg="#eef1f7", fg="#667085", font=("Microsoft YaHei UI", 9)).pack(side="bottom", anchor="w", padx=18, pady=24)
        panel = self.panel = ttk.Frame(body, padding=(28, 22))
        panel.pack(side="left", fill="both", expand=True)
        context = ttk.Frame(panel)
        context.pack(fill="x", pady=(0, 12))
        self.environment_label = ttk.Label(context, text="正式环境 / Production", style="Muted.TLabel")
        self.environment_label.pack(anchor="w")
        ttk.Label(context, textvariable=self.origin, style="Muted.TLabel").pack(anchor="w", pady=(2, 0))
        ttk.Separator(panel).pack(fill="x")
        viewport = ttk.Frame(panel)
        viewport.pack(fill="both", expand=True, pady=(18, 8))
        self.page_canvas = tk.Canvas(viewport, bg="#ffffff", highlightthickness=0, width=580, height=1)
        self.page_canvas.pack(side="left", fill="both", expand=True)
        page_scroll = ttk.Scrollbar(viewport, command=self.page_canvas.yview)
        page_scroll.pack(side="right", fill="y")
        self.page_canvas.configure(yscrollcommand=page_scroll.set)
        self.page_host = ttk.Frame(self.page_canvas)
        page_window = self.page_canvas.create_window((0, 0), window=self.page_host, anchor="nw")
        self.page_host.bind("<Configure>", lambda _e: self.page_canvas.configure(scrollregion=self.page_canvas.bbox("all")))
        self.page_canvas.bind("<Configure>", lambda e: self.page_canvas.itemconfigure(page_window, width=e.width))
        self.pages = [ttk.Frame(self.page_host) for _ in range(4)]

        def heading(parent, eyebrow, title, detail):
            ttk.Label(parent, text=eyebrow, style="Muted.TLabel").pack(anchor="w")
            ttk.Label(parent, text=title, style="Title.TLabel").pack(anchor="w", pady=(4, 8))
            ttk.Label(parent, text=detail, style="Muted.TLabel", wraplength=600).pack(anchor="w", pady=(0, 18))

        def field(parent, title, variable, **kwargs):
            ttk.Label(parent, text=title).pack(anchor="w", pady=(8, 4))
            entry = ttk.Entry(parent, textvariable=variable, **kwargs)
            entry.pack(fill="x")
            return entry

        first, account, directory, progress = self.pages
        heading(first, "PAGE 01 / 04", "先准备好插件", "随包提供本地连接所需组件。已有 GatherThread 插件可跳过安装。\nPrepare your plugin, or continue with an existing installation.")
        for title, detail in (("GatherThread Agent 插件", "MCP 协作工具 · 连接网页项目与本地 Agent"), ("Hooks · 本地会话同步", "仅在审查并允许后，按会话设置同步所选 Agent 中的直接输入"), ("本地连接器 + 私有 Node 24", "随包固定版本连接器，无需额外安装 Python、Node 或 npm")):
            row = ttk.Frame(first, padding=(14, 10), relief="solid", borderwidth=1, style="Card.TFrame")
            row.pack(fill="x", pady=(0, 8))
            ttk.Label(row, text=title, style="Heading.TLabel").pack(anchor="w")
            ttk.Label(row, text=detail, style="Muted.TLabel", wraplength=550).pack(anchor="w", pady=(3, 0))
        ttk.Label(first, text="安装前请确认信任 MCP / Hook 代码；安装后重启所选 Agent，\n在 /hooks 中审查并允许。只连接所选 Agent。\nReview and trust Hooks explicitly before syncing local turns.", style="Muted.TLabel", wraplength=590).pack(anchor="w", pady=(6, 12))
        self.install_button = ttk.Button(first, text="安装随包插件 / Install plugin", command=self._install)
        self.install_button.pack(anchor="w")
        ttk.Label(first, textvariable=self.plugin_state, style="Muted.TLabel", wraplength=590).pack(anchor="w", pady=(8, 0))

        heading(account, "PAGE 02 / 04", "确认账号与模型", "邮箱和模型由网页带入。输入账号密码，授权本机独立连接。\nConfirm your account and model, then enter your password.")
        self.authorization_area = ttk.Frame(account)
        self.authorization_area.pack(fill="x")
        self.email_form = ttk.Frame(self.authorization_area)
        field(self.email_form, "邮箱账号 / Email · 由网页填入", self.email, state="readonly")
        self.password_entry = field(self.email_form, "账号密码 / Password", self.password, show="•")
        ttk.Label(self.email_form, text="仅用于本次授权，不保存密码；其他设备保持登录。\nUsed once, never saved. Other devices stay signed in.", style="Muted.TLabel", wraplength=590).pack(anchor="w", pady=(8, 10))
        self.legacy_form = ttk.Frame(self.authorization_area)
        field(self.legacy_form, "旧版一次性设备授权 / Legacy authorization", self.token, show="•")
        ttk.Label(self.legacy_form, text="建议返回网页重新打开，使用邮箱密码授权。", style="Muted.TLabel").pack(anchor="w", pady=8)
        self.web_form = ttk.Frame(self.authorization_area)
        ttk.Label(self.web_form, text="请在网页登录，再从项目的「连接 Codex」打开启动器。", wraplength=590).pack(anchor="w", pady=8)
        ttk.Button(self.web_form, text="打开网页 / Open website", command=lambda: webbrowser.open(self.origin.get() + "/app/")).pack(anchor="w", pady=8)
        field(account, "模型 / Model", self.model)
        self.codex_only_settings = []
        settings = ttk.Frame(account)
        self.model_settings = settings
        self.code_sync_row = ttk.Frame(account)
        self.code_sync_checkbox = ttk.Checkbutton(self.code_sync_row, variable=self.code_sync, text="允许此设备同步项目文件 / Allow project file sync")
        self.code_sync_checkbox.pack(anchor="w")
        settings.pack(fill="x", pady=(12, 0))
        for title, variable in (("上下文 Token 上限 / Context limit", self.context_tokens), ("首次历史导入 / Initial history", self.history_sync)):
            column = ttk.Frame(settings)
            column.pack(side="left", fill="x", expand=True, padx=(0, 12))
            self.codex_only_settings.append(column)
            ttk.Label(column, text=title, style="Muted.TLabel").pack(anchor="w", pady=(0, 4))
            if variable is self.history_sync:
                ttk.Combobox(column, textvariable=variable, values=("first-connect", "never"), state="readonly", width=20).pack(fill="x")
            else:
                ttk.Entry(column, textvariable=variable, width=20).pack(fill="x")
        field(account, "项目 ID / Project · 由网页填入", self.project)

        heading(directory, "PAGE 03 / 04", "本地目录", "下方已显示默认路径。点击「更改路径」可选择你要使用的文件夹。\nThe default path is shown below. Change it to your preferred folder.")
        location = ttk.Frame(directory, padding=16, relief="solid", borderwidth=1, style="Card.TFrame")
        location.pack(fill="x", pady=(0, 16))
        ttk.Label(location, text="本地目录 / Local workspace", style="Heading.TLabel").pack(anchor="w")
        path_row = ttk.Frame(location)
        path_row.pack(fill="x", pady=(12, 0))
        self.workspace_entry = ttk.Entry(path_row, textvariable=self.workspace_display, state="readonly")
        self.workspace_entry.pack(side="left", fill="x", expand=True)
        self.change_workspace_button = ttk.Button(path_row, text="更改路径 / Change", command=self._choose_workspace)
        self.change_workspace_button.pack(side="right", padx=(8, 0))
        ttk.Label(location, textvariable=self.workspace_hint, style="Muted.TLabel", wraplength=550).pack(anchor="w", pady=(12, 0))
        actions = ttk.Frame(directory)
        actions.pack(fill="x", pady=(8, 18))
        ttk.Button(actions, text="打开此位置 / Open folder", command=self._browse_workspace).pack(side="left")
        ttk.Button(actions, text="使用默认目录 / Use default", command=lambda: self.workspace.set("")).pack(side="left", padx=8)
        advanced = ttk.Frame(directory)
        def toggle_advanced():
            if advanced.winfo_manager():
                advanced.pack_forget()
            else:
                advanced.pack(fill="x", after=advanced_button)
        advanced_button = ttk.Button(directory, text="高级：Codex 路径 / Advanced", command=toggle_advanced)
        advanced_button.pack(anchor="w")
        ttk.Label(advanced, textvariable=self.cli_label).pack(anchor="w", pady=(8, 4))
        ttk.Entry(advanced, textvariable=self.codex).pack(fill="x")
        ttk.Label(directory, text="确认后点击「启动连接」。此窗口需保持运行，关闭运行中的窗口会最小化。\nKeep this Launcher running while connected.", style="Muted.TLabel", wraplength=590).pack(anchor="w", pady=(16, 0))

        heading(progress, "PAGE 04 / 04", "连接与同步状态", "连接过程和同步反馈集中显示在这里。\nConnection progress and live activity in one place.")
        for title, variable in (("本机连接 / Connection", self.connection_state), ("会话状态 / Sessions", self.session_state), ("最近同步反馈 / Last sync feedback", self.sync_feedback), ("实际工作目录 / Workspace", self.actual_workspace), ("最近反馈 / Latest activity", self.latest_event)):
            ttk.Label(progress, text=title, style="Muted.TLabel").pack(anchor="w", pady=(5, 2))
            ttk.Label(progress, textvariable=variable, wraplength=590).pack(anchor="w", pady=(0, 5))
        ttk.Label(progress, text="运行日志 / Activity log", style="Muted.TLabel").pack(anchor="w", pady=(8, 5))
        log_box = ttk.Frame(progress)
        log_box.pack(fill="both", expand=True)
        self.log = tk.Text(log_box, height=5, state="disabled", wrap="word", bg="#f6f7f9", fg="#475467", font=("Consolas", 9), relief="flat", padx=12, pady=10)
        self.log.pack(side="left", fill="both", expand=True)
        scroll = ttk.Scrollbar(log_box, command=self.log.yview)
        scroll.pack(side="right", fill="y")
        self.log.configure(yscrollcommand=scroll.set)
        controls = ttk.Frame(progress)
        controls.pack(fill="x", pady=(12, 0))
        self.stop_button = ttk.Button(controls, text="停止连接 / Stop", command=self._stop)
        self.stop_button.pack(side="left")
        ttk.Button(controls, text="退居后台 / Minimize", command=self._background).pack(side="right")
        footer_separator = ttk.Separator(panel)
        footer_separator.pack(fill="x", pady=(4, 10))
        self.notice = ttk.Label(panel, textvariable=self.status, style="Muted.TLabel", wraplength=600)
        self.notice.pack(anchor="w", pady=(0, 8))
        footer = ttk.Frame(panel)
        footer.pack(fill="x")
        self.back_button = ttk.Button(footer, text="上一步 / Back", command=lambda: self._show_page(self.page - 1))
        self.back_button.pack(side="left")
        self.next_button = ttk.Button(footer, text="已有插件，继续 / Continue", style="Primary.TButton", command=self._next_page)
        self.next_button.pack(side="right")
        self.connect_button = ttk.Button(footer, text="启动连接 / Connect", style="Primary.TButton", command=self._connect)
        # Reserve navigation first, so large fonts/small windows cannot hide it.
        for widget in (viewport, footer_separator, self.notice, footer):
            widget.pack_forget()
        footer.pack(side="bottom", fill="x")
        self.notice.pack(side="bottom", anchor="w", pady=(8, 8))
        footer_separator.pack(side="bottom", fill="x", pady=(4, 10))
        viewport.pack(fill="both", expand=True, pady=(18, 8))
        self.bind("<Configure>", self._resize_layout, add="+")
        self.bind("<MouseWheel>", self._scroll_page, add="+")
        self.bind("<FocusIn>", self._reveal_focus, add="+")
        if self.high_contrast:
            self._apply_high_contrast(style)
        self.status.trace_add("write", self._status_changed)
        self._show_page(0)

    def _fit_window_to_work_area(self) -> None:
        """Fit the whole decorated window, in the same coordinate space as Tk."""
        self.update_idletasks()
        left, top, right, bottom = launcher_work_area(self)
        border = max(0, self.winfo_rootx() - self.winfo_x())
        title = max(0, self.winfo_rooty() - self.winfo_y())
        available_width = max(1, right - left - 16 - 2 * border)
        available_height = max(1, bottom - top - 16 - title - border)
        width, height = min(1020, available_width), min(900, available_height)
        self.minsize(min(640, width), min(400, height))
        self.geometry(f"{width}x{height}")
        self.update_idletasks()
        x = left + (right - left - width - 2 * border) // 2
        y = top + (bottom - top - height - title - border) // 2
        if os.name == "nt":
            import ctypes
            from ctypes import wintypes
            position = ctypes.windll.user32.SetWindowPos
            position.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int,
                                 ctypes.c_int, ctypes.c_int, wintypes.UINT]
            # Native positioning handles monitors left/above the primary screen.
            position(int(self.frame(), 0), None, x, y, 0, 0, 0x0015)
        else:
            self.geometry(f"+{max(0, x)}+{max(0, y)}")
        self.update_idletasks()

    def _resize_layout(self, event) -> None:
        if event.widget is not self:
            return
        compact = event.width < 900
        if compact and self.sidebar.winfo_manager():
            self.sidebar.pack_forget()
            self.compact_navigation.pack(fill="x", pady=(0, 10), before=self.body)
        elif not compact and not self.sidebar.winfo_manager():
            self.compact_navigation.pack_forget()
            self.sidebar.pack(side="left", fill="y", padx=(0, 16), before=self.panel)
        # Size text to the real content column so it cannot cover navigation.
        column = max(120, event.width - (0 if compact else 231) - 104)
        self.notice.configure(wraplength=column)

    def _apply_high_contrast(self, style) -> None:
        for name in ("TFrame", "Card.TFrame", "TLabel", "Muted.TLabel", "Title.TLabel", "Heading.TLabel"):
            style.configure(name, background="SystemWindow", foreground="SystemWindowText")
        for name in ("TEntry", "TCombobox"):
            style.configure(name, fieldbackground="SystemWindow", foreground="SystemWindowText")
            style.map(name, fieldbackground=[("readonly", "SystemWindow")], foreground=[("readonly", "SystemWindowText")])
        for name in ("TButton", "Primary.TButton"):
            style.configure(name, background="SystemButtonFace", foreground="SystemButtonText")
            style.map(name, background=[("active", "SystemHighlight"), ("disabled", "SystemButtonFace")], foreground=[("disabled", "SystemGrayText"), ("active", "SystemHighlightText")])

        def recolor(widget):
            if isinstance(widget, (tk.Frame, tk.Label, tk.Canvas, tk.Text)):
                widget.configure(background="SystemWindow")
                if isinstance(widget, (tk.Label, tk.Text)):
                    widget.configure(foreground="SystemWindowText")
            for child in widget.winfo_children():
                recolor(child)

        self.configure(background="SystemWindow")
        recolor(self)

    def _show_page(self, page: int) -> None:
        self.page = max(0, min(3, page))
        self.compact_navigation.current(self.page)
        for frame in self.pages:
            frame.pack_forget()
        self.pages[self.page].pack(fill="both", expand=True)
        for index, label in enumerate(self.step_labels):
            if self.high_contrast:
                label.configure(bg="SystemHighlight" if index == self.page else "SystemWindow", fg="SystemHighlightText" if index == self.page else "SystemWindowText")
            else:
                label.configure(bg="#dfe7ff" if index == self.page else "#eef1f7", fg="#264bb9" if index == self.page else "#667085")
        self.back_button.configure(state="disabled" if self.page == 0 or self.busy else "normal")
        self.back_button.configure(text="返回设置 / Settings" if self.page == 3 else "上一步 / Back")
        self.next_button.pack_forget()
        self.connect_button.pack_forget()
        if self.page < 2:
            self.next_button.configure(text="已有插件，继续 / Continue" if self.page == 0 else "下一步 / Next")
            self.next_button.pack(side="right")
        elif self.page == 2:
            self.connect_button.pack(side="right")
        if self.page == 1 and self.link_version in {"2", "3"}:
            self.password_entry.focus_set()
        self.page_canvas.yview_moveto(0)

    def _navigate_page(self, page: int) -> None:
        if not self.busy or page == 3:
            self._show_page(page)
        else:
            self.compact_navigation.current(self.page)

    def _refresh_workspace_display(self, *_args) -> None:
        custom = self.workspace.get()
        self.workspace_display.set(custom or self.default_root)
        self.workspace_hint.set(
            "已选择自定义目录，连接器将使用此文件夹。\nSelected folder will be used as the workspace."
            if custom else
            "当前使用默认位置，连接后在此创建项目名称子目录。\nDefault location; a project-named subfolder is resolved after connection."
        )

    def _scroll_page(self, event) -> None:
        if isinstance(event.widget, (tk.Text, ttk.Combobox)):
            return
        self.page_canvas.yview_scroll(-int(event.delta / 120), "units")

    def _reveal_focus(self, event) -> None:
        widget = event.widget
        if str(widget).startswith(str(self.pages[self.page])):
            self.update_idletasks()
            top = widget.winfo_rooty() - self.page_host.winfo_rooty()
            bottom = top + widget.winfo_height()
            visible_top = self.page_canvas.canvasy(0)
            visible_bottom = visible_top + self.page_canvas.winfo_height()
            total = max(1, self.page_host.winfo_height())
            if top < visible_top:
                self.page_canvas.yview_moveto(top / total)
            elif bottom > visible_bottom:
                self.page_canvas.yview_moveto((bottom - self.page_canvas.winfo_height() + 12) / total)

    def _next_page(self) -> None:
        if self.busy:
            return
        if self.page == 1:
            try:
                if self.link_version in {"2", "3"}:
                    valid_password(self.password.get())
                elif self.link_version == "1":
                    if not re.fullmatch(r"gtd_[A-Za-z0-9_-]{43}", self.token.get().strip()):
                        raise ValueError("请输入有效的一次性设备授权 / Enter a valid authorization")
                else:
                    raise ValueError("请从网页的「连接 Codex」打开启动器 / Open from the website")
                (valid_claude_model if self.harness == "claude-code" else valid_model)(self.model.get())
                valid_context_tokens(self.context_tokens.get())
                valid_history_sync(self.history_sync.get())
            except ValueError as error:
                self.status.set(str(error))
                self.password_entry.focus_set()
                return
        self._show_page(self.page + 1)

    def _browse_workspace(self) -> None:
        directory = Path(self.workspace.get() or self.default_root)
        while not directory.is_dir() and directory != directory.parent:
            directory = directory.parent
        try:
            os.startfile(str(directory))
        except OSError:
            self.status.set("无法打开默认位置，可复制上方路径手动浏览。 / Copy the path to browse manually.")

    def _status_changed(self, *_args) -> None:
        value = self.status.get()
        if (self.busy or self.connector is not None
                or value.startswith(("操作失败", "已断开", "连接器已退出"))
                or value == AUTHORIZATION_CANCELLED):
            self._display_activity("status", value)

    def _display_activity(self, kind: str, value: str) -> None:
        # Interpret only connector-owned line prefixes, never arbitrary success words.
        if kind == "error":
            self.connection_state.set("操作失败 / Failed")
            self.session_state.set("连接未完成，请查看日志 / Check activity for details")
            self.latest_event.set(value[:240])
        elif kind == "status":
            self.connection_state.set(value)
            if "已退出" in value or "已断开" in value or value == AUTHORIZATION_CANCELLED:
                self.session_state.set("连接已结束 / Connection ended")
        elif kind == "log_only":
            self.latest_event.set(value[:240])
        elif kind == "log":
            self.latest_event.set(value[:240])
            if value.startswith("Workspace: "):
                self.actual_workspace.set(value[len("Workspace: "):])
            elif value.startswith("Claude Code ready: "):
                self.connection_state.set("Claude Code 已就绪 / Claude Code ready")
            elif value.startswith("Codex App Server ready: "):
                self.connection_state.set("Codex 已就绪 / Codex ready")
            elif value.startswith("Connected session: ") or value.startswith('Connected "claude-code" session: '):
                self.connection_state.set("已连接 / Connected")
                self.session_state.set("会话连接成功 / Session connected")
            elif value == "GatherThread connector ready." or value.startswith("GatherThread project: "):
                self.connection_state.set("已连接项目 / Project connected")
            retry = re.fullmatch(r"gatherthread-codex \(([^)\r\n]+)\): .*; retrying", value)
            recovered = re.fullmatch(r"gatherthread-codex \(([^)\r\n]+)\): recovered", value)
            # These are historical records, not a current health/active-retry contract.
            # Heartbeat/sharing failures need not produce a matching recovery log.
            if retry:
                self.sync_feedback.set("曾记录同步重试；可在日志中查看详情 / A sync retry was recorded; see the log")
            elif recovered:
                self.sync_feedback.set("曾收到同步恢复反馈 / A sync recovery was reported")

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
        initial = Path(self.workspace.get() or self.default_root)
        while not initial.is_dir() and initial != initial.parent:
            initial = initial.parent
        directory = filedialog.askdirectory(parent=self, initialdir=str(initial), mustexist=True, title="选择 Agent 本地工作目录 / Choose workspace")
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
        running = self.connector is not None and self.connector.poll() is None
        self.install_button.configure(state="disabled" if value or pending or running else "normal")
        self.connect_button.configure(state="disabled" if value or pending or running or not self.link_version or self.authorization_used else "normal")
        self.password_entry.configure(state="disabled" if value or running else "normal")
        self.code_sync_checkbox.configure(state="disabled" if value or self.connector and self.connector.poll() is None else "normal")
        self.next_button.configure(state="disabled" if value or pending else "normal")
        self.back_button.configure(state="disabled" if value or self.page == 0 else "normal")

    def _install(self) -> None:
        if self.busy or getattr(self, "claude_discovery_pending", False) or (self.connector and self.connector.poll() is None):
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
        self.plugin_state.set("正在安装插件… / Installing plugin…")

        def work() -> None:
            commands = plugin_install_commands(codex, installed_dir(), self.harness)
            try:
                for args in commands:
                    self.events.put(("log", "运行：" + " ".join(args)))
                    result = subprocess.run(args, env=self._env(), capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=180, shell=False, creationflags=self._flags())
                    if result.returncode:
                        raise RuntimeError((result.stderr or result.stdout or "插件安装失败")[-1200:])
                self.events.put(("plugin", "插件安装完成。请在所选 Agent 中重启会话，并通过 /hooks 审查 Hooks。 / Installed; review Hooks."))
            except (OSError, subprocess.TimeoutExpired, RuntimeError) as error:
                self.events.put(("plugin", "插件安装失败，请查看第四页 / Installation failed; check page 4"))
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
        self.events.put(("page", "3"))

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
                    environment = self._env(credential)
                    environment["GATHERTHREAD_LAUNCHER_CONTROL"] = "stdin-v1"
                    self.connector = subprocess.Popen(args, env=environment, stdin=subprocess.PIPE,
                                                      stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                                      text=True, encoding="utf-8", errors="replace", shell=False, creationflags=self._flags())
                self.events.put(("connector_started", (self.connector, cancelled)))
                threading.Thread(target=self._read_connector, args=(self.connector, credential), daemon=True).start()
                threading.Thread(target=self._wait_connector, args=(self.connector,), daemon=True).start()
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
        discarding = False
        try:
            while True:
                line = process.stdout.readline(CONNECTOR_LOG_LINE_LIMIT + 1)
                if not line:
                    break
                oversized = discarding or len(line) > CONNECTOR_LOG_LINE_LIMIT
                discarding = oversized and not line.endswith("\n")
                if discarding:
                    continue
                output = "[过长输出已省略]" if oversized else line
                output = output.replace(token, "[REDACTED]") if token else output
                output = re.sub(r"\b(?:gta_|gtd_)[A-Za-z0-9_-]+", "[REDACTED]", output)
                # Child output cannot starve the UI or grow memory indefinitely.
                if self.events.qsize() < CONNECTOR_LOG_QUEUE_LIMIT:
                    self.events.put(("connector_log", (process, output.rstrip())))
        finally:
            process.stdout.close()

    def _wait_connector(self, process: subprocess.Popen[str]) -> None:
        # Do not wait for stdout EOF: an inherited pipe may outlive its parent.
        code = process.wait()
        if process.stdin:
            try:
                process.stdin.close()
            except OSError:
                pass
        self.events.put(("connector_exit", (process, code)))

    def _request_connector_stop(self, process: subprocess.Popen[str]) -> None:
        try:
            if process.stdin is None:
                raise OSError("Missing private Launcher control pipe")
            process.stdin.write("gatherthread:stop\n")
            process.stdin.flush()
        except (OSError, ValueError):
            self.events.put(("connector_stop_pending", (process, "停止通道尚未确认。连接器仍在退出前保持占用，请查看日志。")))

    def _stop(self) -> None:
        self.connection_cancelled.set()
        self._clear_secrets()
        # Never take the launch lock on the UI thread: Popen may be waiting for
        # the OS. A late child sees the cancellation in connector_started.
        process = self.connector
        if process and process.poll() is None:
            if getattr(self, "stopping_connector", None) is process:
                return
            self.stopping_connector = process
            self.stop_deadline = time.monotonic() + CONNECTOR_STOP_TIMEOUT_SECONDS
            self.status.set("正在断开，并确认本地 Agent 任务已停止…")
            threading.Thread(target=self._request_connector_stop, args=(process,), daemon=True).start()
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
            for _ in range(100):
                kind, value = self.events.get_nowait()
                activity_kind = "log"
                if kind == "page":
                    self.sync_feedback.set("尚无同步反馈 / No sync feedback yet")
                    self.session_state.set("等待连接会话 / Waiting for sessions")
                    self.actual_workspace.set("等待连接器确认 / Waiting for connector")
                    self._show_page(int(value))
                    continue
                if kind == "plugin":
                    self.plugin_state.set(value)
                    self.status.set(value)
                    continue
                if kind in ("connector_started", "connector_log", "connector_exit", "connector_stop_pending"):
                    process, value = value
                    if self.connector is not process:
                        continue
                    if kind == "connector_exit":
                        self.connector = None
                        stopped = getattr(self, "stopping_connector", None) is process
                        self.stopping_connector = None
                        self.stop_deadline = None
                        self.status.set("已断开。需要再次连接时，请从网页重新打开启动器。" if stopped and value == 0
                                        else f"连接器已退出，代码 {value}。请从网页重新连接；日志保留在下方。")
                        self._set_busy(False)
                        continue
                    if kind == "connector_started":
                        if value.is_set():
                            self._stop()
                        elif process.poll() is None:
                            self.status.set("连接器正在启动。安装或更新插件后请重启所选 Agent 会话，并审查 Hooks。")
                        continue
                    if kind == "connector_stop_pending":
                        if getattr(self, "stopping_connector", None) is process:
                            self.status.set(value)
                        continue
                    if process.poll() is None and getattr(self, "stopping_connector", None) is not process and (value == "GatherThread connector ready." or value.startswith("Connected session: ")
                            or value.startswith('Connected "claude-code" session: ')):
                        self.status.set("已连接；保持启动器运行，即可在网页使用此 Agent。")
                    if process.poll() is not None or getattr(self, "stopping_connector", None) is process:
                        activity_kind = "log_only"
                    kind = "log"
                if kind == "log":
                    self.log.configure(state="normal")
                    self.log.insert("end", value + "\n")
                    self.log.delete("1.0", "end-100000c")
                    self.log.see("end")
                    self.log.configure(state="disabled")
                    self._display_activity(activity_kind, value)
                elif kind == "status":
                    self.status.set(value)
                elif kind == "error":
                    self.status.set("操作失败：" + value)
                    self._display_activity("error", value)
                elif kind == "idle":
                    self._set_busy(False)
                elif kind == "claude_discovery":
                    self._apply_claude_discovery(*value)
        except queue.Empty:
            pass
        if getattr(self, "stop_deadline", None) is not None and time.monotonic() >= self.stop_deadline:
            self.stop_deadline = None
            self.status.set("停止请求已发送，本地任务仍在退出。请保持启动器打开；确认退出后才可重新连接。")
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
