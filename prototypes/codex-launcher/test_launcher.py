import importlib.util
import io
import json
import struct
import types
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch
from urllib.parse import urlencode
from urllib.error import HTTPError, URLError


SPEC = importlib.util.spec_from_file_location("launcher", Path(__file__).with_name("launcher.py"))
launcher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(launcher)
VERIFY_SPEC = importlib.util.spec_from_file_location("verify_dist", Path(__file__).with_name("verify_dist.py"))
verify_dist = importlib.util.module_from_spec(VERIFY_SPEC)
VERIFY_SPEC.loader.exec_module(verify_dist)

AUTHORIZATION_ID = "11111111-2222-4333-8444-555555555555"
REAL_THREAD = threading.Thread


class FixtureValue:
    def __init__(self, value=""):
        self.value = value

    def get(self):
        return self.value

    def set(self, value):
        self.value = value


def email_launcher_fixture():
    fake = types.SimpleNamespace(busy=False, connector=None, origin=FixtureValue("https://test.gatherthread.cn"),
                                 project=FixtureValue("project-example"), email=FixtureValue("tester@example.com"),
                                 password=FixtureValue("private-fixture-password"), token=FixtureValue(), model=FixtureValue("gpt-6-sol"),
                                 context_tokens=FixtureValue("128000"), history_sync=FixtureValue("first-connect"), workspace=FixtureValue(),
                                 status=FixtureValue(), link_version="2", authorization_id=AUTHORIZATION_ID,
                                 handoff_project="project-example", authorization_used=False, events=launcher.queue.Queue(),
                                 _paths=lambda: (Path("node.exe"), "codex.exe"), _flags=lambda: 0, _read_connector=MagicMock(),
                                 connector_lock=threading.Lock())
    fake._clear_secrets = lambda: (fake.password.set(""), fake.token.set(""))
    fake._env = lambda token: {"GATHERTHREAD_TOKEN": token}
    fake._set_busy = lambda value: setattr(fake, "busy", value)
    return fake


def email_link(origin="https://test.gatherthread.cn", **changes):
    values = {"v": "2", "origin": origin, "project": "project-example",
              "model": "gpt-6-sol", "context_window_tokens": "128000",
              "visible_history_sync": "first-connect", "email": "Tester+desktop@example.com",
              "authorization_id": AUTHORIZATION_ID}
    values.update(changes)
    return "gatherthread-connect://connect?" + urlencode(values)


def claim_response(**changes):
    data = {"actor": {"user_id": "fixture-user", "device_id": "fixture-device", "display_name": "Fixture"},
            "device": {"id": "fixture-device", "user_id": "fixture-user", "name": "Windows Codex",
                       "created_at": "2026-10-12T01:00:00.000Z", "token_created_at": "2026-10-12T01:00:00.000Z",
                       "last_used_at": None, "expires_at": None, "revoked_at": None,
                       "rotated_at": None, "token_version": 1},
            "token": "gta_" + "x" * 43,
            "authorization": {"id": AUTHORIZATION_ID, "user_id": "fixture-user",
                              "claimed_by_device_id": "fixture-device", "authorizer_device_id": "fixture-browser",
                              "created_at": "2026-10-12T01:00:00.000Z", "expires_at": "2026-10-12T01:10:00.000Z",
                              "claimed_at": "2026-10-12T01:01:00.000Z", "revoked_at": None, "expired_at": None}}
    data.update(changes)
    return json.dumps({"data": data}).encode()


class ClaimResponse(io.BytesIO):
    status = 201

    def __init__(self, payload):
        super().__init__(payload)
        self.headers = {"Content-Type": "application/json"}


class EmailAuthorizationTests(unittest.TestCase):
    def test_v2_keeps_actual_environment_and_fills_email(self):
        for origin in ("https://gatherthread.cn", "https://test.gatherthread.cn"):
            parsed = launcher.parse_link(email_link(origin))
            self.assertEqual(parsed, (origin, "project-example", "gpt-6-sol", 128000,
                                      "first-connect", "tester+desktop@example.com", AUTHORIZATION_ID))

    def test_v2_rejects_unsafe_origins_mailboxes_and_extra_parameters(self):
        cases = [email_link("https://test.gatherthread.cn.evil.example"),
                 email_link("https://test.gatherthread.cn/"), email_link("http://test.gatherthread.cn"),
                 email_link(email="bad\n@example.com"), email_link(email="中文@example.com"),
                 email_link(email="." + "a" * 64 + "@example.com"),
                 email_link(authorization_id="not-a-uuid"), email_link(password="must-not-be-in-a-link"),
                 email_link() + "&email=other%40example.com"]
        for uri in cases:
            with self.subTest(uri=uri), self.assertRaises(ValueError):
                launcher.parse_link(uri)

    def test_raw_uri_controls_cannot_be_silently_removed_by_urlparse(self):
        for control in ("\n", "\r", "\t", "\x7f"):
            uri = email_link().replace("connect?", "connect" + control + "?")
            with self.subTest(control=repr(control)), self.assertRaises(ValueError):
                launcher.parse_link(uri)

    def test_password_is_body_only_and_authorizes_an_independent_device(self):
        opener = MagicMock()
        requests = []

        def respond(request, **_kwargs):
            requests.append(json.loads(request.data))
            return ClaimResponse(claim_response())

        opener.open.side_effect = respond
        with patch.object(launcher, "build_opener", return_value=opener):
            token = launcher.claim_email_authorization("https://test.gatherthread.cn", AUTHORIZATION_ID,
                                                      "project-example", "Tester+desktop@example.com",
                                                      "  eightchars  ", "Windows Codex")
        request = opener.open.call_args.args[0]
        self.assertEqual(request.full_url, "https://test.gatherthread.cn/v1/codex-launcher-authorizations/claim")
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(requests[0], {"authorization_id": AUTHORIZATION_ID, "project_id": "project-example",
                                                  "email": "tester+desktop@example.com", "password": "  eightchars  ",
                                                  "device_name": "Windows Codex"})
        self.assertIsNone(request.get_header("Cookie"))
        self.assertIsNone(request.get_header("Origin"))
        self.assertEqual(opener.open.call_args.kwargs["timeout"], 15)
        self.assertEqual(token, "gta_" + "x" * 43)

    def test_claim_fails_closed_on_bad_token_identity_scope_or_large_response(self):
        invalid = [claim_response(token="gtd_" + "x" * 43), claim_response(token="gta_" + "x" * 44),
                   claim_response(device={"id": "different", "user_id": "fixture-user", "name": "Windows"}),
                   claim_response(authorization={"id": "different", "user_id": "fixture-user", "claimed_by_device_id": "fixture-device"}),
                   b"x" * (16 * 1024 + 1), b"not JSON"]
        for payload in invalid:
            opener = MagicMock()
            opener.open.return_value = ClaimResponse(payload)
            with self.subTest(bytes=len(payload)), patch.object(launcher, "build_opener", return_value=opener):
                with self.assertRaises(ValueError):
                    launcher.claim_email_authorization("https://gatherthread.cn", AUTHORIZATION_ID,
                                                       "project-example", "tester@example.com", "eightchars", "Windows")

    def test_claim_requires_complete_live_device_and_claim_metadata(self):
        full = json.loads(claim_response())
        cases = []
        for record, field in (("device", "created_at"), ("device", "token_created_at"),
                              ("device", "last_used_at"), ("device", "expires_at"),
                              ("device", "revoked_at"), ("device", "rotated_at"),
                              ("device", "token_version"), ("authorization", "authorizer_device_id"),
                              ("authorization", "created_at"), ("authorization", "expires_at"),
                              ("authorization", "claimed_at"), ("authorization", "revoked_at"),
                              ("authorization", "expired_at")):
            case = json.loads(claim_response())
            del case["data"][record][field]
            cases.append(("missing " + record + "." + field, case))
        for record, field, value in (("device", "revoked_at", "2026-10-12T01:02:00.000Z"),
                                     ("authorization", "expired_at", "2026-10-12T01:02:00.000Z"),
                                     ("authorization", "revoked_at", "2026-10-12T01:02:00.000Z"),
                                     ("authorization", "claimed_at", None),
                                     ("authorization", "authorizer_device_id", ""),
                                     ("device", "created_at", "2026-02-30T01:02:00.000Z"),
                                     ("device", "last_used_at", False),
                                     ("device", "expires_at", "invalid date"),
                                     ("device", "token_version", 0),
                                     ("device", "token_version", True),
                                     ("device", "token_version", 1.5),
                                     ("device", "token_version", "1")):
            case = json.loads(claim_response())
            case["data"][record][field] = value
            cases.append((record + "." + field + " invalid", case))
        self.assertEqual(launcher.validated_claim_token(json.dumps(full).encode(), AUTHORIZATION_ID), "gta_" + "x" * 43)
        for label, case in cases:
            with self.subTest(case=label), self.assertRaises(ValueError):
                launcher.validated_claim_token(json.dumps(case).encode(), AUTHORIZATION_ID)

    def test_claim_never_retries_or_echoes_server_error_or_password(self):
        secret = "private-fixture-password"
        for error in (HTTPError("https://gatherthread.cn", 401, secret, {}, io.BytesIO(secret.encode())),
                      HTTPError("https://gatherthread.cn", 302, secret, {}, io.BytesIO(secret.encode())),
                      URLError(secret)):
            opener = MagicMock()
            opener.open.side_effect = error
            with patch.object(launcher, "build_opener", return_value=opener):
                with self.assertRaises(ValueError) as caught:
                    launcher.claim_email_authorization("https://gatherthread.cn", AUTHORIZATION_ID,
                                                       "project-example", "tester@example.com", secret, "Windows")
            self.assertNotIn(secret, str(caught.exception))
            self.assertEqual(opener.open.call_count, 1)

    def test_redirect_handler_refuses_to_forward_password(self):
        handler = launcher.NoAuthorizationRedirect()
        self.assertIsNone(handler.redirect_request(None, None, 302, "redirect", {}, "https://evil.example"))

    def test_deadline_returns_without_late_authorization(self):
        release = threading.Event()

        class SlowResponse(ClaimResponse):
            def read1(self, _size):
                release.wait(1)
                return b""

        opener = MagicMock()
        opener.open.return_value = SlowResponse(claim_response())
        started = time.monotonic()
        try:
            with patch.object(launcher, "build_opener", return_value=opener), patch.object(launcher, "AUTHORIZATION_DEADLINE_SECONDS", 0.03):
                with self.assertRaises(ValueError):
                    launcher.claim_email_authorization("https://gatherthread.cn", AUTHORIZATION_ID,
                                                       "project-example", "tester@example.com", "eightchars", "Windows")
            self.assertLess(time.monotonic() - started, 0.3)
        finally:
            release.set()

    def test_stop_before_dispatch_sends_no_authorization_and_clears_password(self):
        fake = email_launcher_fixture()
        pending = []

        def queued_thread(target, args=(), **_kwargs):
            pending.append((target, args))
            return types.SimpleNamespace(start=lambda: None)

        with patch.object(launcher, "bundled_connector", return_value=Path(__file__)), \
                patch.object(launcher, "claim_email_authorization", return_value="gta_" + "x" * 43) as claim, \
                patch.object(launcher.threading, "Thread", side_effect=queued_thread), \
                patch.object(launcher.subprocess, "Popen") as process:
            launcher.Launcher._connect(fake)
            launcher.Launcher._stop(fake)
            work, args = pending[0]
            work(*args)
        claim.assert_not_called()
        process.assert_not_called()
        self.assertEqual(fake.password.get(), "")
        retained = dict(zip(work.__code__.co_freevars, (cell.cell_contents for cell in work.__closure__)))
        self.assertEqual(retained["password_buffer"], bytearray())
        self.assertNotIn("error", [kind for kind, _value in list(fake.events.queue)])

    def test_claim_helper_checks_shared_cancellation_before_opening_transport(self):
        cancelled = threading.Event()
        cancelled.set()
        with patch.object(launcher, "build_opener") as opener:
            with self.assertRaises(launcher.AuthorizationCancelled):
                launcher.claim_email_authorization("https://test.gatherthread.cn", AUTHORIZATION_ID,
                                                   "project-example", "tester@example.com", "eightchars", "Windows",
                                                   cancelled=cancelled)
        opener.assert_not_called()

    def test_stop_cancels_blocked_read_closes_response_and_fences_late_result(self):
        fake = email_launcher_fixture()
        reading, released, closed = threading.Event(), threading.Event(), threading.Event()
        workers = []

        class BlockedResponse(ClaimResponse):
            def read1(self, size):
                reading.set()
                released.wait(2)
                return super().read1(size)

            def close(self):
                closed.set()
                released.set()
                super().close()

        def capture_thread(target, args=(), **kwargs):
            worker = REAL_THREAD(target=target, args=args, **kwargs)
            if getattr(target, "__name__", "") == "work":
                workers.append(worker)
            return worker

        opener = MagicMock()
        opener.open.return_value = BlockedResponse(claim_response())
        try:
            with patch.object(launcher, "bundled_connector", return_value=Path(__file__)), \
                    patch.object(launcher, "build_opener", return_value=opener), \
                    patch.object(launcher.threading, "Thread", side_effect=capture_thread), \
                    patch.object(launcher.subprocess, "Popen") as process:
                launcher.Launcher._connect(fake)
                self.assertTrue(reading.wait(1), "the authorization read must have started")
                launcher.Launcher._stop(fake)
                workers[0].join(0.4)
                self.assertFalse(workers[0].is_alive(), "Stop must promptly release the foreground authorization worker")
                self.assertTrue(closed.wait(0.4), "Stop must best-effort close the active response")
                released.set()
                workers[0].join(0.4)
                process.assert_not_called()
                opener.open.assert_called_once()
                self.assertNotIn("error", [kind for kind, _value in list(fake.events.queue)])
                self.assertEqual(fake.password.get(), "")
                self.assertTrue(any(value == launcher.AUTHORIZATION_CANCELLED
                                    for kind, value in list(fake.events.queue) if kind == "status"))
        finally:
            released.set()
            for worker in workers:
                worker.join(1)

    def test_stop_during_open_releases_worker_and_ignores_response_delivered_later(self):
        fake = email_launcher_fixture()
        opening, release, completed = threading.Event(), threading.Event(), threading.Event()
        workers = []

        def open_later(*_args, **_kwargs):
            opening.set()
            release.wait(2)
            completed.set()
            return ClaimResponse(claim_response())

        def capture_thread(target, args=(), **kwargs):
            worker = REAL_THREAD(target=target, args=args, **kwargs)
            if getattr(target, "__name__", "") == "work":
                workers.append(worker)
            return worker

        opener = MagicMock()
        opener.open.side_effect = open_later
        try:
            with patch.object(launcher, "bundled_connector", return_value=Path(__file__)), \
                    patch.object(launcher, "build_opener", return_value=opener), \
                    patch.object(launcher.threading, "Thread", side_effect=capture_thread), \
                    patch.object(launcher.subprocess, "Popen") as process:
                launcher.Launcher._connect(fake)
                self.assertTrue(opening.wait(1), "the authorization request must have started")
                launcher.Launcher._stop(fake)
                workers[0].join(0.4)
                self.assertFalse(workers[0].is_alive(), "Stop must release the worker even before a response handle exists")
                release.set()
                self.assertTrue(completed.wait(1))
                process.assert_not_called()
                opener.open.assert_called_once()
                self.assertNotIn("error", [kind for kind, _value in list(fake.events.queue)])
                self.assertEqual(fake.password.get(), "")
                self.assertTrue(any(value == launcher.AUTHORIZATION_CANCELLED
                                    for kind, value in list(fake.events.queue) if kind == "status"))
        finally:
            release.set()
            for worker in workers:
                worker.join(1)

    def test_password_validation_matches_utf16_length_without_trimming(self):
        for password in ("1234567", "😀" * 65, "x" * 129):
            with self.subTest(length=len(password)), self.assertRaises(ValueError):
                launcher.valid_password(password)
        self.assertEqual(launcher.valid_password("        "), "        ")
        self.assertEqual(launcher.valid_password("😀" * 64), "😀" * 64)

    def test_windows_registry_has_owned_application_icon(self):
        registry = types.SimpleNamespace(HKEY_CURRENT_USER="HKCU", REG_SZ=1,
                                         CreateKey=MagicMock(), SetValueEx=MagicMock())
        registry.CreateKey.return_value.__enter__.return_value = "key"
        directory = Path(__file__).parent
        with patch.object(launcher.os, "name", "nt"), patch.dict("sys.modules", {"winreg": registry}):
            launcher.register_windows_scheme(directory)
        self.assertIn(launcher.SCHEME + "\\DefaultIcon", registry.CreateKey.call_args_list[1].args[1])
        self.assertTrue(any("gatherthread.ico" in str(call.args[-1]) for call in registry.SetValueEx.call_args_list))

    def test_start_menu_shortcut_uses_app_icon_without_modifying_python(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.dict(launcher.os.environ, {"APPDATA": directory}), patch.object(launcher.subprocess, "run") as run:
                launcher.create_start_menu_shortcut(root)
            script = run.call_args.args[0][-1]
            self.assertIn("GatherThread Launcher.lnk", script)
            self.assertIn("IconLocation", script)
            self.assertIn("gatherthread.ico", script)
            self.assertIn("pythonw.exe", script)
            self.assertIn("launcher.py", script)
            self.assertTrue(run.call_args.kwargs["check"])

    def test_email_connect_clears_password_before_child_and_keeps_test_origin(self):
        class Value:
            def __init__(self, value=""):
                self.value = value

            def get(self):
                return self.value

            def set(self, value):
                self.value = value

        fake = types.SimpleNamespace(busy=False, connector=None, origin=Value("https://test.gatherthread.cn"),
                                     project=Value("project-example"), email=Value("tester@example.com"),
                                     password=Value("private-fixture-password"), token=Value(), model=Value("gpt-6-sol"),
                                     context_tokens=Value("128000"), history_sync=Value("first-connect"), workspace=Value(),
                                     status=Value(), link_version="2", authorization_id=AUTHORIZATION_ID,
                                     handoff_project="project-example", authorization_used=False, events=launcher.queue.Queue(),
                                     _paths=lambda: (Path("node.exe"), "codex.exe"), _flags=lambda: 0, _read_connector=MagicMock())
        fake.connector_lock = threading.Lock()
        fake._clear_secrets = lambda: (fake.password.set(""), fake.token.set(""))
        fake._env = lambda token: {"GATHERTHREAD_TOKEN": token}
        fake._set_busy = lambda value: setattr(fake, "busy", value)
        targets = []

        def thread(target, args=(), **_kwargs):
            targets.append(target)
            return types.SimpleNamespace(start=lambda: target(*args))

        def spawn(args, **kwargs):
            self.assertEqual(fake.password.get(), "")
            self.assertEqual(fake.token.get(), "")
            self.assertEqual(args[args.index("--url") + 1], "https://test.gatherthread.cn")
            self.assertEqual(kwargs["env"], {"GATHERTHREAD_TOKEN": "gta_" + "x" * 43})
            self.assertNotIn("private-fixture-password", repr(args))
            self.assertNotIn("gta_", repr(args))
            work = targets[0]
            retained = dict(zip(work.__code__.co_freevars, (cell.cell_contents for cell in work.__closure__)))
            self.assertNotIn("password", retained)
            self.assertEqual(retained["password_buffer"], bytearray())
            return MagicMock()

        with patch.object(launcher, "bundled_connector", return_value=Path(__file__)), \
                patch.object(launcher, "claim_email_authorization", return_value="gta_" + "x" * 43) as claim, \
                patch.object(launcher.threading, "Thread", side_effect=thread), \
                patch.object(launcher.subprocess, "Popen", side_effect=spawn) as process:
            launcher.Launcher._connect(fake)
        self.assertEqual(claim.call_args.args[0], "https://test.gatherthread.cn")
        self.assertTrue(fake.authorization_used)
        process.assert_called_once()


class IconDistributionTests(unittest.TestCase):
    def test_checked_in_application_icons_have_required_sizes(self):
        assets = Path(__file__).parent / "assets"
        self.assertEqual(verify_dist.verify_ico((assets / "gatherthread.ico").read_bytes()),
                         {16, 24, 32, 48, 64, 128, 256})
        png = (assets / "gatherthread.png").read_bytes()
        self.assertEqual(png[:8], b"\x89PNG\r\n\x1a\n")
        self.assertEqual(struct.unpack_from(">II", png, 16), (512, 512))

    def test_ico_verification_requires_multiresolution_png_images(self):
        sizes = (16, 24, 32, 48, 64, 128, 256)
        images = [b"\x89PNG\r\n\x1a\n" + struct.pack(">I", 13) + b"IHDR" + struct.pack(">II", size, size) + bytes(13) for size in sizes]
        offset = 6 + 16 * len(sizes)
        entries = []
        for size, image in zip(sizes, images):
            entries.append(struct.pack("<BBBBHHII", size % 256, size % 256, 0, 0, 1, 32, len(image), offset))
            offset += len(image)
        payload = struct.pack("<HHH", 0, 1, len(sizes)) + b"".join(entries) + b"".join(images)
        self.assertEqual(verify_dist.verify_ico(payload), set(sizes))
        for damaged in (payload[:20], b"not an icon", payload.replace(b"IHDR", b"BAD!", 1)):
            with self.subTest(bytes=len(damaged)), self.assertRaises(ValueError):
                verify_dist.verify_ico(damaged)


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
