"""Offline preview of the real Windows UI. Never installs or authorizes a device."""

import argparse
import ctypes
from ctypes import wintypes
from pathlib import Path
import struct
import sys
import zlib
from urllib.parse import urlencode

sys.path.insert(0, str(Path(__file__).resolve().parent))
from launcher import Launcher


def capture(window, destination):
    """Capture only this native window, without desktop or unrelated app content."""
    user, gdi = ctypes.windll.user32, ctypes.windll.gdi32
    user.GetDC.restype = wintypes.HDC
    gdi.CreateCompatibleDC.argtypes = [wintypes.HDC]
    gdi.CreateCompatibleDC.restype = wintypes.HDC
    gdi.CreateCompatibleBitmap.argtypes = [wintypes.HDC, ctypes.c_int, ctypes.c_int]
    gdi.CreateCompatibleBitmap.restype = wintypes.HBITMAP
    gdi.SelectObject.argtypes = [wintypes.HDC, wintypes.HGDIOBJ]
    gdi.SelectObject.restype = wintypes.HGDIOBJ
    user.PrintWindow.argtypes = [wintypes.HWND, wintypes.HDC, wintypes.UINT]
    gdi.BitBlt.argtypes = [wintypes.HDC, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                         wintypes.HDC, ctypes.c_int, ctypes.c_int, wintypes.DWORD]
    gdi.GetDIBits.argtypes = [wintypes.HDC, wintypes.HBITMAP, wintypes.UINT, wintypes.UINT,
                            ctypes.c_void_p, ctypes.c_void_p, wintypes.UINT]
    gdi.DeleteObject.argtypes = [wintypes.HGDIOBJ]
    gdi.DeleteDC.argtypes = [wintypes.HDC]
    user.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
    hwnd = window.winfo_id()
    width, height = window.winfo_width(), window.winfo_height()
    dc = user.GetDC(hwnd)
    memory = gdi.CreateCompatibleDC(dc)
    bitmap = gdi.CreateCompatibleBitmap(dc, width, height)
    previous = gdi.SelectObject(memory, bitmap)
    try:
        if not gdi.BitBlt(memory, 0, 0, width, height, dc, 0, 0, 0x00CC0020):
            raise OSError("Window capture failed")
        gdi.SelectObject(memory, previous)
        header = ctypes.create_string_buffer(struct.pack("<IiiHHIIiiII", 40, width, -height, 1, 32, 0, width * height * 4, 0, 0, 0, 0))
        pixels = ctypes.create_string_buffer(width * height * 4)
        if not gdi.GetDIBits(memory, bitmap, 0, height, pixels, header, 0):
            raise OSError("GetDIBits failed")
        raw = pixels.raw
        rows = bytearray()
        for row in range(height):
            rows.append(0)
            for index in range(row * width * 4, (row + 1) * width * 4, 4):
                rows.extend((raw[index + 2], raw[index + 1], raw[index]))

        def chunk(name, data):
            return struct.pack(">I", len(data)) + name + data + struct.pack(">I", zlib.crc32(name + data))

        destination.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))
    finally:
        gdi.DeleteObject(bitmap)
        gdi.DeleteDC(memory)
        user.ReleaseDC(hwnd, dc)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--screenshots", type=Path)
    options = parser.parse_args()
    link = "gatherthread-connect://connect?" + urlencode({
        "v": "2", "origin": "https://gatherthread.cn", "project": "project-preview",
        "model": "gpt-6-luna", "context_window_tokens": "65536",
        "visible_history_sync": "first-connect", "email": "demo@example.com",
        "authorization_id": "11111111-2222-4333-8444-555555555555",
    })
    app = Launcher(link)
    app.title("GatherThread · 离线界面预览 / Offline preview")
    app.status.set("离线预览 · 示例数据，不会安装插件或发起账号授权。 / Preview only; no authorization.")
    app.install_button.configure(command=lambda: app.plugin_state.set("预览：插件已安装，仍需在 Codex 审查 Hooks / Example: installed; review Hooks"))

    def show_status():
        app._clear_secrets()
        app._show_page(3)
        for line in ("Codex App Server ready: preview", "Workspace: F:\\GatherThread Projects\\Demo Project", "Connected session: Demo [multi]"):
            app.events.put(("log", line))

    app.connect_button.configure(command=show_status)
    if options.screenshots:
        options.screenshots.mkdir(parents=True, exist_ok=True)

        def snapshots():
            for page, name in enumerate(("01-plugin", "02-account", "03-workspace", "04-status")):
                if page == 3:
                    show_status()
                    app._poll()
                else:
                    app._show_page(page)
                app.update()
                capture(app, options.screenshots / (name + ".png"))
            app.destroy()

        app.after(600, snapshots)
    app.mainloop()


if __name__ == "__main__":
    main()
