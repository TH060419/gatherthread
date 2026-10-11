"""Brand icon regressions; no native application or account is launched."""
import plistlib
import struct
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent


class IconTests(unittest.TestCase):
    def test_windows_icon_contains_real_multisize_images(self):
        data = (HERE / "assets/gatherthread.ico").read_bytes()
        reserved, kind, count = struct.unpack_from("<HHH", data)
        self.assertEqual((reserved, kind), (0, 1))
        sizes = set()
        for index in range(count):
            width, height, _, _, _, _, length, offset = struct.unpack_from("<BBBBHHII", data, 6 + index * 16)
            width, height = width or 256, height or 256
            self.assertEqual(width, height)
            png = data[offset:offset + length]
            self.assertTrue(png.startswith(b"\x89PNG\r\n\x1a\n"))
            self.assertEqual(struct.unpack_from(">II", png, 16), (width, height))
            sizes.add(width)
        self.assertTrue({16, 24, 32, 48, 64, 128, 256}.issubset(sizes))

    def test_macos_icon_resource_is_declared_and_valid(self):
        plist = plistlib.loads((HERE / "macos/Info.plist").read_bytes())
        self.assertEqual(plist.get("CFBundleIconFile"), "GatherThread.icns")
        data = (HERE / "assets/GatherThread.icns").read_bytes()
        self.assertEqual(data[:4], b"icns")
        self.assertEqual(struct.unpack_from(">I", data, 4)[0], len(data))
        self.assertGreater(len(data), 1024)


if __name__ == "__main__":
    unittest.main()
