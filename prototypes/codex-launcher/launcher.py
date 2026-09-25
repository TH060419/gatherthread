"""Windows GatherThread connection launcher, bundled with Python and Node."""

from __future__ import annotations

import os
import json
import queue
import re
import shutil
import subprocess
import sys
import threading
import tkinter as tk
from pathlib import Path
from tkinter import messagebox, ttk
from urllib.parse import parse_qs, urlparse


PACKAGE = "@gatherthread/codex-connect@0.1.0-alpha.7"
SERVER_ORIGIN = "https://gatherthread.cn"
PROJECT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
SCHEME = "gatherthread-connect"


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


def parse_link(value: str) -> tuple[str, str, str, int, str]:
    parsed = urlparse(value)
    if parsed.scheme != SCHEME or parsed.netloc != "connect" or parsed.path not in {"", "/"} or parsed.fragment:
        raise ValueError("无效的 GatherThread 连接链接")
    query = parse_qs(parsed.query, strict_parsing=True)
    if not {"origin", "project"} <= set(query) or set(query) - {
        "origin", "project", "model", "context_window_tokens", "visible_history_sync"
    } or any(len(item) != 1 for item in query.values()):
        raise ValueError("连接链接包含不支持的参数")
    origin = safe_origin(query["origin"][0])
    if origin != SERVER_ORIGIN:
        raise ValueError("连接链接的网页地址不是 https://gatherthread.cn")
    project = query["project"][0]
    if not PROJECT_RE.fullmatch(project):
        raise ValueError("无效的项目 ID")
    model = valid_model(query.get("model", ["gpt-5.6-sol"])[0])
    tokens = valid_context_tokens(query.get("context_window_tokens", ["128000"])[0])
    mode = valid_history_sync(query.get("visible_history_sync", ["first-connect"])[0])
    return origin, project, model, tokens, mode


def valid_model(value: str) -> str:
    if not value.strip() or len(value) > 120 or value.startswith("-") or any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise ValueError("Codex 模型名称无效")
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


def connector_args(node: Path, connector: Path, origin: str, project: str,
                   model: str, tokens: int, mode: str, codex: str) -> list[str]:
    return [str(node), str(connector), "--url", origin, "--project", project,
            "--create-workspace", "--plugin-hooks", "--visible-history-sync", mode,
            "--model", model, "--context-window-tokens", str(tokens),
            "--codex-command", codex]


def runtime_dir() -> Path:
    return Path(__file__).resolve().parent


def installed_dir() -> Path:
    return Path(os.environ["LOCALAPPDATA"]) / "Programs" / "GatherThread Launcher"


def bundled_node() -> Path:
    return runtime_dir() / "runtime" / ("node.exe" if os.name == "nt" else "bin/node")


def bundled_connector() -> Path:
    return runtime_dir() / "connector" / "codex-connect.js"


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
    prefix = wrapper.parent
    packages = (
        prefix / "node_modules" / "@openai" / "codex" / "node_modules" / "@openai" / "codex-win32-x64",
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
        sibling = path.with_suffix(".exe")
        if sibling.is_file():
            return str(sibling)
        npm_native = npm_codex_native(path)
        if npm_native:
            return str(npm_native)
        native = find_codex()
        if native and Path(native).suffix.lower() == ".exe":
            return native
    raise ValueError("Codex App Server 需要原生 codex.exe；请安装支持插件的 Codex Desktop/CLI，或直接选择其 codex.exe。不能直接启动 codex.cmd。")


def register_windows_scheme(directory: Path) -> None:
    if os.name != "nt":
        raise RuntimeError("URL Scheme 注册仅支持 Windows")
    import winreg

    exe = str((directory / "runtime" / "pythonw.exe").resolve())
    script = str((directory / "launcher.py").resolve())
    base = rf"Software\Classes\{SCHEME}"
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, base) as key:
        winreg.SetValueEx(key, "", 0, winreg.REG_SZ, "URL:GatherThread Codex connection")
        winreg.SetValueEx(key, "URL Protocol", 0, winreg.REG_SZ, "")
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, base + r"\shell\open\command") as key:
        winreg.SetValueEx(key, "", 0, winreg.REG_SZ, f'"{exe}" "{script}" "%1"')


def install_bundle() -> Path:
    """Copy the portable folder to a stable per-user location and wire the plugin."""
    source, target = runtime_dir(), installed_dir()
    if source != target:
        shutil.copytree(source, target, dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns("*.pyc", "__pycache__"))
    node = target / "runtime" / "node.exe"
    connector = target / "connector" / "codex-connect.js"
    plugin = target / "plugins" / "gatherthread"
    if not all(path.is_file() for path in (node, connector, plugin / ".mcp.json", plugin / "hooks" / "hooks.json")):
        raise RuntimeError("安装包缺少 Node、连接器或插件文件")
    mcp = {"mcpServers": {"gatherthread": {
        "command": str(node), "args": [str(connector), "mcp"]}}}
    (plugin / ".mcp.json").write_text(json.dumps(mcp, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    hooks_path = plugin / "hooks" / "hooks.json"
    hooks = json.loads(hooks_path.read_text(encoding="utf-8"))
    command = f'"{node}" "${{PLUGIN_ROOT}}/scripts/hook-forwarder.mjs"'
    for event in ("UserPromptSubmit", "Stop"):
        hooks["hooks"][event][0]["hooks"][0]["command"] = command
    hooks_path.write_text(json.dumps(hooks, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    register_windows_scheme(target)
    return target


class Launcher(tk.Tk):
    def __init__(self, link: str | None):
        super().__init__()
        self.title("GatherThread · Connect Codex")
        self.geometry("760x650")
        self.minsize(680, 600)
        self.events: queue.Queue[tuple[str, str]] = queue.Queue()
        self.connector: subprocess.Popen[str] | None = None
        self.busy = False
        self.project = tk.StringVar()
        self.codex = tk.StringVar(value=find_codex())
        self.model = tk.StringVar(value="gpt-5.6-sol")
        self.context_tokens = tk.StringVar(value="128000")
        self.history_sync = tk.StringVar(value="first-connect")
        self.token = tk.StringVar()
        self.status = tk.StringVar(value="填写连接信息后启动连接；已有 GatherThread 插件可直接沿用。")
        self._build()
        if link:
            try:
                _origin, project, model, tokens, mode = parse_link(link)
                self.project.set(project)
                self.model.set(model)
                self.context_tokens.set(str(tokens))
                self.history_sync.set(mode)
            except ValueError as error:
                self.after(0, lambda: messagebox.showerror("连接链接无效", str(error)))
        self.after(100, self._poll)
        self.protocol("WM_DELETE_WINDOW", self._background)

    def _build(self) -> None:
        root = ttk.Frame(self, padding=18)
        root.pack(fill="both", expand=True)
        ttk.Label(root, text="连接本机 Codex", font=("Segoe UI", 18, "bold")).pack(anchor="w")
        ttk.Label(root, text="网页负责项目和会话；此窗口负责启动并保持本机连接器运行。", wraplength=690).pack(anchor="w", pady=(4, 14))
        ttk.Label(root, text=f"网页服务地址：{SERVER_ORIGIN}").pack(anchor="w", pady=(0, 9))
        for label, var in (("项目 ID（格式：project-***）", self.project), ("Codex CLI 路径", self.codex)):
            ttk.Label(root, text=label).pack(anchor="w")
            ttk.Entry(root, textvariable=var).pack(fill="x", pady=(2, 9))
        settings = ttk.Frame(root)
        settings.pack(fill="x", pady=(2, 9))
        for label, var, width in (("模型", self.model, 24), ("上下文 Token 上限", self.context_tokens, 14)):
            column = ttk.Frame(settings)
            column.pack(side="left", padx=(0, 14))
            ttk.Label(column, text=label).pack(anchor="w")
            ttk.Entry(column, textvariable=var, width=width).pack(anchor="w")
        history = ttk.Frame(settings)
        history.pack(side="left")
        ttk.Label(history, text="首次历史导入").pack(anchor="w")
        ttk.Combobox(history, textvariable=self.history_sync, values=("first-connect", "never"), state="readonly", width=16).pack(anchor="w")
        ttk.Label(root, text="设备 Token（仅交给连接器进程，不写入链接或日志）").pack(anchor="w")
        ttk.Entry(root, textvariable=self.token, show="•").pack(fill="x", pady=(2, 12))
        ttk.Label(root, text="已有 GatherThread 插件可跳过安装。只有需要包内 Node 运行 MCP 与 Hooks 时才安装随包插件，并在 Codex 中审查 Hooks。", wraplength=690).pack(anchor="w")
        buttons = ttk.Frame(root)
        buttons.pack(fill="x", pady=(12, 9))
        self.install_button = ttk.Button(buttons, text="可选：安装随包插件", command=self._install)
        self.install_button.pack(side="left")
        self.connect_button = ttk.Button(buttons, text="启动连接", command=self._connect)
        self.connect_button.pack(side="left", padx=8)
        ttk.Button(buttons, text="停止连接", command=self._stop).pack(side="left")
        ttk.Button(buttons, text="退居后台", command=self._background).pack(side="right")
        ttk.Label(root, textvariable=self.status, wraplength=690).pack(anchor="w", pady=(4, 8))
        self.log = tk.Text(root, height=11, state="disabled", wrap="word")
        self.log.pack(fill="both", expand=True)
        ttk.Label(root, text="关闭窗口会最小化到任务栏；恢复窗口后可停止连接。", wraplength=690).pack(anchor="w", pady=(7, 0))

    def _paths(self) -> tuple[Path, str]:
        node = bundled_node()
        if not node.is_file():
            raise ValueError(f"缺少随安装包提供的 Node 24 运行时：{node}")
        codex = native_codex_command(self.codex.get().strip())
        if codex != self.codex.get().strip():
            self.codex.set(codex)
        return node, codex

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
        self.install_button.configure(state="disabled" if value else "normal")
        self.connect_button.configure(state="disabled" if value else "normal")

    def _install(self) -> None:
        if self.busy:
            return
        try:
            _, codex = self._paths()
        except ValueError as error:
            messagebox.showerror("缺少运行环境", str(error))
            return
        if runtime_dir() != installed_dir():
            messagebox.showerror("请先安装 Launcher", "请运行安装包中的 Install.cmd，再从安装后的 Launcher 安装插件。")
            return
        if not messagebox.askokcancel("安装插件", "将从本机安装包中的 GatherThread marketplace 安装固定版本插件。\n\n请确认信任其中的 MCP/Hook 代码。"):
            return
        self._set_busy(True)

        def work() -> None:
            commands = [
                [codex, "plugin", "marketplace", "add", str(installed_dir())],
                [codex, "plugin", "add", "gatherthread@gatherthread-launcher"],
            ]
            try:
                for args in commands:
                    self.events.put(("log", "运行：" + " ".join(args)))
                    result = subprocess.run(args, env=self._env(), capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=180, shell=False, creationflags=self._flags())
                    if result.returncode:
                        raise RuntimeError((result.stderr or result.stdout or "插件安装失败")[-1200:])
                self.events.put(("status", "插件安装完成。请重启 Codex Desktop，在 /hooks 审查并启用 Hooks。"))
            except (OSError, subprocess.TimeoutExpired, RuntimeError) as error:
                self.events.put(("error", str(error)))
            finally:
                self.events.put(("idle", ""))

        threading.Thread(target=work, daemon=True).start()

    def _connect(self) -> None:
        if self.busy or (self.connector and self.connector.poll() is None):
            self.status.set("连接器已在运行。")
            return
        try:
            node, codex = self._paths()
            connector = bundled_connector()
            if not connector.is_file():
                raise ValueError(f"缺少固定版本 {PACKAGE} 的打包入口：{connector}")
            origin = SERVER_ORIGIN
            project = self.project.get().strip()
            if not PROJECT_RE.fullmatch(project):
                raise ValueError("项目 ID 格式不正确；请使用网页显示的项目 ID，格式如 project-***")
            token = self.token.get().strip()
            if not token or "\n" in token or "\r" in token:
                raise ValueError("请输入有效的设备 Token")
            model = valid_model(self.model.get())
            tokens = valid_context_tokens(self.context_tokens.get())
            mode = valid_history_sync(self.history_sync.get())
        except ValueError as error:
            messagebox.showerror("连接信息有误", str(error))
            return
        args = connector_args(node, connector, origin, project, model, tokens, mode, codex)
        try:
            self.connector = subprocess.Popen(args, env=self._env(token), stdin=subprocess.DEVNULL,
                                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                              text=True, encoding="utf-8", errors="replace", shell=False, creationflags=self._flags())
            self.token.set("")
            self.status.set("连接器正在启动。安装或更新插件后请重启 Codex，并审查 Hooks。")
            threading.Thread(target=self._read_connector, args=(self.connector, token), daemon=True).start()
        except OSError as error:
            self.status.set(f"启动失败：{error}")

    def _read_connector(self, process: subprocess.Popen[str], token: str) -> None:
        assert process.stdout is not None
        for line in process.stdout:
            self.events.put(("log", line.replace(token, "[REDACTED]").rstrip()))
        code = process.wait()
        self.events.put(("status", f"连接器已退出，代码 {code}。可检查日志后重试。"))

    def _stop(self) -> None:
        if self.connector and self.connector.poll() is None:
            self.connector.terminate()
            self.status.set("正在停止连接器…")

    def _background(self) -> None:
        if self.connector and self.connector.poll() is None:
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
