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
                                 _paths=lambda: (Path("node.exe"), "codex.exe"), _flags=lambda: 0, _read_connector=MagicMock(), _wait_connector=MagicMock(),
                                 connector_lock=threading.Lock())
    fake._clear_secrets = lambda: (fake.password.set(""), fake.token.set(""))
    fake._env = lambda token: {"GATHERTHREAD_TOKEN": token}
    fake._set_busy = lambda value: setattr(fake, "busy", value)
    fake._display_activity = MagicMock()
    fake._show_page = MagicMock()
    fake.sync_feedback = FixtureValue()
    fake.session_state, fake.actual_workspace, fake.plugin_state = FixtureValue(), FixtureValue(), FixtureValue()
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


class ConnectorStatusTests(unittest.TestCase):
    def ui(self):
        fake = email_launcher_fixture()
        fake.log, fake.after, fake._poll = MagicMock(), MagicMock(), MagicMock()
        fake.connection_cancelled = threading.Event()
        fake._stop = lambda: launcher.Launcher._stop(fake)
        fake._request_connector_stop = lambda process: launcher.Launcher._request_connector_stop(fake, process)
        return fake

    def test_stop_uses_graceful_pipe_and_late_ready_cannot_restore_connected(self):
        fake = self.ui()
        process = MagicMock(stdin=io.StringIO())
        process.poll.return_value = None
        fake.connector = process
        def synchronous(target, args=(), **_kwargs):
            return types.SimpleNamespace(start=lambda: target(*args))
        with patch.object(launcher.threading, "Thread", side_effect=synchronous):
            launcher.Launcher._stop(fake)
            launcher.Launcher._stop(fake)
        self.assertEqual(process.stdin.getvalue(), "gatherthread:stop\n")
        process.terminate.assert_not_called()
        fake.events.put(("connector_log", (process, "GatherThread connector ready.")))
        launcher.Launcher._poll(fake)
        self.assertIn("正在断开", fake.status.get())
        fake.stop_deadline = 0
        launcher.Launcher._poll(fake)
        self.assertIn("仍在退出", fake.status.get())
        self.assertIs(fake.connector, process, "unconfirmed cleanup must retain ownership")

    def test_stop_during_os_launch_does_not_block_ui_and_stops_the_late_child(self):
        fake = self.ui()
        spawn_entered, release_spawn = threading.Event(), threading.Event()
        process = MagicMock(stdin=io.StringIO())
        process.poll.return_value = None
        def spawn(*_args, **_kwargs):
            spawn_entered.set()
            release_spawn.wait(2)
            return process
        with patch.object(launcher, "bundled_connector", return_value=Path(__file__)), \
                patch.object(launcher, "claim_email_authorization", return_value="gta_" + "x" * 43), \
                patch.object(launcher.subprocess, "Popen", side_effect=spawn):
            launcher.Launcher._connect(fake)
            self.assertTrue(spawn_entered.wait(1))
            stopped = threading.Event()
            thread = REAL_THREAD(target=lambda: (launcher.Launcher._stop(fake), stopped.set()), daemon=True)
            thread.start()
            try:
                self.assertTrue(stopped.wait(0.3), "Stop cannot wait for Popen's lock")
            finally:
                release_spawn.set()
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline and (fake.connector is None or fake.busy):
                launcher.Launcher._poll(fake)
                time.sleep(0.01)
            launcher.Launcher._poll(fake)
            deadline = time.monotonic() + 1
            while not process.stdin.getvalue() and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertEqual(process.stdin.getvalue(), "gatherthread:stop\n")
            self.assertIs(fake.stopping_connector, process)

    def test_exit_receipt_does_not_wait_for_a_descendant_to_close_stdout(self):
        fake = self.ui()
        blocked, release = threading.Event(), threading.Event()
        class HeldPipe:
            def readline(self, _limit):
                blocked.set()
                release.wait(2)
                return ""
            def close(self):
                pass
        process = MagicMock(stdout=HeldPipe(), stdin=io.StringIO())
        process.wait.return_value = 0
        fake.connector = process
        reader = REAL_THREAD(target=launcher.Launcher._read_connector, args=(fake, process, "fixture"), daemon=True)
        reader.start()
        try:
            self.assertTrue(blocked.wait(1))
            launcher.Launcher._wait_connector(fake, process)
            launcher.Launcher._poll(fake)
            self.assertIsNone(fake.connector)
            self.assertTrue(reader.is_alive(), "the test must retain the inherited pipe during receipt handling")
        finally:
            release.set()
            reader.join(1)

    def test_output_is_bounded_and_never_exposes_a_partial_long_secret_line(self):
        fake = self.ui()
        process = MagicMock(stdout=io.StringIO("x" * 17000 + "gta_fixture-secret\n" + "safe\n" * 2000))
        launcher.Launcher._read_connector(fake, process, "fixture-secret")
        values = []
        while not fake.events.empty():
            values.append(fake.events.get_nowait()[1][1])
        self.assertEqual(len(values), launcher.CONNECTOR_LOG_QUEUE_LIMIT)
        self.assertEqual(values[0], "[过长输出已省略]")
        self.assertNotIn("secret", "".join(values))

    def test_connected_receipt_updates_status_before_child_exit(self):
        for line in ('Connected session: Demo [multi] as "Demo"', 'GatherThread connector ready.',
                     'Connected "claude-code" session: "Demo" [multi]'):
            with self.subTest(line=line):
                fake = email_launcher_fixture()
                fake.log = MagicMock()
                fake.after = MagicMock()
                fake._poll = MagicMock()
                process = MagicMock()
                process.poll.return_value = None
                fake.connector = process
                fake.status.set("连接器正在启动")
                process.stdout = io.StringIO(line + "\n")
                process.wait.return_value = 0
                launcher.Launcher._read_connector(fake, process, "fixture-credential")
                # Deliver the live output before the queued exit notification.
                first = fake.events.get_nowait()
                fake.events = launcher.queue.Queue()
                fake.events.put(first)
                launcher.Launcher._poll(fake)
                self.assertIn("已连接", fake.status.get())

    def test_native_startup_and_exited_process_do_not_report_connected(self):
        for line, exit_code in (("Codex App Server ready: fixture", None), ("GatherThread connector ready.", 1)):
            fake = email_launcher_fixture()
            fake.log = MagicMock()
            fake.after = MagicMock()
            fake._poll = MagicMock()
            fake.connector = MagicMock()
            fake.connector.poll.return_value = exit_code
            fake.status.set("starting")
            fake.events.put(("connector_log", (fake.connector, line)))
            launcher.Launcher._poll(fake)
            self.assertEqual(fake.status.get(), "starting")

    def test_old_connector_cannot_overwrite_new_connection_status(self):
        fake = email_launcher_fixture()
        fake.log = MagicMock()
        fake.after = MagicMock()
        fake._poll = MagicMock()
        fake.connector = MagicMock()
        fake.status.set("new connection")
        old = MagicMock(stdout=io.StringIO('Connected session: Old [solo] as "Old"\n'))
        old.wait.return_value = 1
        launcher.Launcher._read_connector(fake, old, "fixture-credential")
        launcher.Launcher._poll(fake)
        self.assertEqual(fake.status.get(), "new connection")


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
                                     _paths=lambda: (Path("node.exe"), "codex.exe"), _flags=lambda: 0, _read_connector=MagicMock(), _wait_connector=MagicMock())
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
            self.assertEqual(kwargs["env"], {"GATHERTHREAD_TOKEN": "gta_" + "x" * 43, "GATHERTHREAD_LAUNCHER_CONTROL": "stdin-v1"})
            self.assertEqual(kwargs["stdin"], launcher.subprocess.PIPE)
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
    def test_header_uses_the_unmodified_approved_brand_assets(self):
        root = Path(__file__).resolve().parents[2]
        for target, variant in (("gatherthread-lockup.png", "light"), ("gatherthread-lockup-dark.png", "dark")):
            self.assertEqual((Path(__file__).parent / "assets" / target).read_bytes(),
                             (root / "logo/png" / ("lockup-color-transparent-" + variant + "-1200px.png")).read_bytes())

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
    def test_windows_install_binds_mcp_to_its_current_bundled_node_and_connector(self):
        with tempfile.TemporaryDirectory() as directory:
            source, target = Path(directory) / "source", Path(directory) / "installed"
            for name in ("runtime/node.exe", "connector/codex-connect.js", "assets/gatherthread.ico", "assets/gatherthread.png"):
                file = source / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text("fixture", encoding="utf-8")
            plugin = source / "plugins/gatherthread"
            (plugin / "hooks").mkdir(parents=True)
            (plugin / ".mcp.json").write_text(json.dumps({"mcpServers": {"gatherthread": {"command": "npx", "args": ["old-package"]}}}), encoding="utf-8")
            (plugin / "hooks/hooks.json").write_text(json.dumps({"hooks": {
                event: [{"hooks": [{"command": "old-hook"}]}] for event in ("UserPromptSubmit", "Stop")}}), encoding="utf-8")
            with patch.object(launcher, "runtime_dir", return_value=source), patch.object(launcher, "installed_dir", return_value=target), \
                    patch.object(launcher, "register_windows_scheme") as register, patch.object(launcher, "create_start_menu_shortcut") as shortcut:
                self.assertEqual(launcher.install_bundle(), target)
            installed = json.loads((target / "plugins/gatherthread/.mcp.json").read_text(encoding="utf-8"))
            self.assertEqual(installed, {"mcpServers": {"gatherthread": {
                "command": str(target / "runtime/node.exe"), "args": [str(target / "connector/codex-connect.js"), "mcp"]}}})
            self.assertNotIn("old-package", json.dumps(installed))
            register.assert_called_once_with(target)
            shortcut.assert_called_once_with(target)
            self.assertIn("old-package", (plugin / ".mcp.json").read_text(encoding="utf-8"))

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


class ClaudeLauncherTests(unittest.TestCase):
    def test_claude_discovery_skips_older_path_before_a_compatible_existing_install(self):
        probes = {"/old/claude": "2.1.150 (Claude Code)", "/new/claude": "2.1.306 (Claude Code)"}
        self.assertEqual(launcher.preferred_claude_command(list(probes), probes.get), ("/new/claude", True))
        self.assertEqual(launcher.preferred_claude_command(["/old/claude"], probes.get), ("/old/claude", False))

    def test_claude_discovery_version_gate_rejects_invalid_or_unsupported_metadata(self):
        for version in ("", "unknown", "2.1.150 (Claude Code)", "2.1.258 (Claude Code)", "debug 2.1.306"):
            self.assertFalse(launcher.compatible_claude_version(version), version)
        for version in ("2.1.259 (Claude Code)", "2.1.306 (Claude Code)", "2.2.0", "3.0.0"):
            self.assertTrue(launcher.compatible_claude_version(version), version)

    def test_claude_version_probe_is_metadata_only_bounded_and_shell_free(self):
        result = types.SimpleNamespace(returncode=0, stdout="2.1.306 (Claude Code)")
        with patch.object(launcher.subprocess, "run", return_value=result) as run:
            self.assertEqual(launcher.probe_claude_version("/fixture/claude"), result.stdout)
        self.assertEqual(run.call_args.args[0], ["/fixture/claude", "--version"])
        self.assertLessEqual(run.call_args.kwargs["timeout"], 1)
        self.assertFalse(run.call_args.kwargs.get("shell", False))
        with patch.object(launcher.subprocess, "run", side_effect=launcher.subprocess.TimeoutExpired("claude", 1)):
            self.assertEqual(launcher.probe_claude_version("/fixture/claude"), "")

    def test_claude_candidate_list_deduplicates_and_ignores_windows_wrappers(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            old, new, shim = root / "old/claude.exe", root / "home/.local/bin/claude.exe", root / "old/claude.cmd"
            for candidate in (old, new, shim):
                candidate.parent.mkdir(parents=True, exist_ok=True)
                candidate.touch()
            candidates = launcher.claude_command_candidates(path=f"{old.parent};{old.parent}", home=root / "home", windows=True)
            self.assertEqual(candidates, [str(old), str(new)])

    def test_claude_discovery_never_overwrites_manual_or_stale_path(self):
        allowed = dict(harness="claude-code", generation=4, current_generation=4, selected="/old/claude",
                       original="/old/claude", manual=False, busy=False)
        self.assertTrue(launcher.can_apply_claude_discovery(**allowed))
        for changed in ({"manual": True}, {"selected": "/manual/claude"}, {"current_generation": 5},
                        {"harness": "codex"}, {"busy": True}):
            self.assertFalse(launcher.can_apply_claude_discovery(**{**allowed, **changed}))

    def test_manual_path_edit_cancels_an_already_running_default_discovery(self):
        fake = types.SimpleNamespace(harness="claude-code", setting_cli_path=False, codex=FixtureValue("/manual/claude"),
            claude_manual_path=None, claude_discovery_generation=4, claude_discovery_pending=True,
            busy=False, connector=None, status=FixtureValue(), _set_busy=MagicMock())
        launcher.Launcher._cli_path_changed(fake)
        self.assertEqual(fake.claude_manual_path, "/manual/claude")
        self.assertFalse(fake.claude_discovery_pending)
        launcher.Launcher._apply_claude_discovery(fake, 4, "/manual/claude", "/new/claude", True)
        self.assertEqual(fake.codex.get(), "/manual/claude")

    def test_discovery_updates_only_automatic_path_and_retains_an_unsupported_path(self):
        fake = types.SimpleNamespace(harness="claude-code", setting_cli_path=False, codex=FixtureValue("/old/claude"),
            claude_manual_path=None, claude_discovery_generation=4, claude_discovery_pending=True,
            busy=False, connector=None, status=FixtureValue(), _set_busy=MagicMock())
        launcher.Launcher._apply_claude_discovery(fake, 4, "/old/claude", "/new/claude", True)
        self.assertEqual(fake.codex.get(), "/new/claude")
        fake.claude_discovery_pending = True
        launcher.Launcher._apply_claude_discovery(fake, 4, "/new/claude", "/other/claude", False)
        self.assertEqual(fake.codex.get(), "/new/claude")
        self.assertIn("2.1.259", fake.status.get())

    def test_new_claude_handoff_resets_previous_local_file_consent(self):
        fake = email_launcher_fixture()
        fake.code_sync = FixtureValue(True)
        fake.target_label, fake.cli_label, fake.codex = FixtureValue(), FixtureValue(), FixtureValue()
        fake.title, fake._refresh_authorization_form = MagicMock(), MagicMock()
        fake._discover_claude = MagicMock()
        fake.code_sync_row, fake.model_settings = MagicMock(), MagicMock()
        fake.codex_only_settings = []
        with patch.object(launcher, "find_claude", return_value="/fixture/claude"):
            launcher.Launcher._apply_link(fake, email_link(v="3", harness="claude-code", model="claude-sonnet-4-6"))
        self.assertFalse(fake.code_sync.get())
        self.assertEqual(fake.harness, "claude-code")
        self.assertEqual(fake.codex.get(), "/fixture/claude")
        fake.code_sync_row.pack.assert_called_once()

    def test_claude_file_sync_requires_explicit_checkbox_consent(self):
        fake = email_launcher_fixture()
        fake.harness, fake.link_version = "claude-code", "3"
        fake.model.set("claude-sonnet-4-6")
        fake.code_sync = FixtureValue(True)
        fake._paths = lambda: (Path("node.exe"), "claude.exe")
        def thread(target, args=(), **_kwargs):
            return types.SimpleNamespace(start=lambda: target(*args))
        with patch.object(launcher, "bundled_connector", return_value=Path(__file__)), \
                patch.object(launcher, "claim_email_authorization", return_value="gta_" + "x" * 43), \
                patch.object(launcher.threading, "Thread", side_effect=thread), \
                patch.object(launcher.subprocess, "Popen", return_value=MagicMock()) as spawn:
            launcher.Launcher._connect(fake)
        self.assertIn("--code-sync", spawn.call_args.args[0])

    def test_v3_password_claim_launches_only_claude_connector(self):
        fake = email_launcher_fixture()
        fake.harness, fake.link_version = "claude-code", "3"
        fake.model.set("claude-sonnet-4-6")
        fake._paths = lambda: (Path("node.exe"), "claude.exe")

        def thread(target, args=(), **_kwargs):
            return types.SimpleNamespace(start=lambda: target(*args))

        with patch.object(launcher, "bundled_connector", return_value=Path(__file__)) as selected, \
                patch.object(launcher, "claim_email_authorization", return_value="gta_" + "x" * 43) as claim, \
                patch.object(launcher.threading, "Thread", side_effect=thread), \
                patch.object(launcher.subprocess, "Popen", return_value=MagicMock()) as spawn:
            launcher.Launcher._connect(fake)
        selected.assert_called_once_with("claude-code")
        args, kwargs = spawn.call_args.args[0], spawn.call_args.kwargs
        self.assertEqual(args[args.index("--claude-command") + 1], "claude.exe")
        self.assertEqual(args[args.index("--model") + 1], "claude-sonnet-4-6")
        self.assertNotIn("--code-sync", args)
        self.assertFalse(kwargs["shell"])
        self.assertEqual(fake.password.get(), "")
        self.assertNotIn("private-fixture-password", repr(args))
        self.assertEqual(claim.call_args.args[5], "Windows Claude Code Launcher")

    def test_claude_plugin_configuration_uses_private_node_and_claude_root(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            plugin = root / "claude-marketplace/plugins/gatherthread"
            for file in (".claude-plugin/plugin.json", "scripts/hook-forwarder.mjs", "scripts/mcp-launcher.mjs"):
                path = plugin / file
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("fixture")
            (plugin / "hooks").mkdir()
            (plugin / "hooks/hooks.json").write_text(json.dumps({"hooks": {
                "UserPromptSubmit": [{"hooks": [{"type": "command", "command": "old-node"}]}]}}))
            launcher.configure_claude_plugin(root)
            mcp = json.loads((plugin / ".mcp.json").read_text())
            self.assertEqual(mcp["mcpServers"]["gatherthread"]["command"], str(root / "runtime/node.exe"))
            self.assertIn("${CLAUDE_PLUGIN_ROOT}", (plugin / "hooks/hooks.json").read_text())
            self.assertNotIn("old-node", (plugin / "hooks/hooks.json").read_text())

    def test_v3_selects_exact_harness_and_keeps_account_handoff(self):
        for harness in ("claude-code", "codex"):
            parsed = launcher.parse_link(email_link(v="3", harness=harness,
                                                    model="claude-sonnet-4-6" if harness == "claude-code" else "gpt-6-sol"))
            self.assertEqual(parsed[5:], ("tester+desktop@example.com", AUTHORIZATION_ID, harness))
        self.assertEqual(len(launcher.parse_link(email_link())), 7)

    def test_harness_selection_is_strict_and_cannot_change_legacy_links(self):
        for changes in ({"v": "3"}, {"v": "3", "harness": "other"},
                        {"v": "3", "harness": "Claude-Code"}, {"harness": "claude-code"}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                launcher.parse_link(email_link(**changes))

    def test_claude_connector_args_do_not_launch_codex_or_bypass_permissions(self):
        args = launcher.connector_args(Path("node"), Path("claude-connect.js"), launcher.TEST_SERVER_ORIGIN,
                                       "project-example", "claude-sonnet-4-6", 65536, "never", "claude.exe",
                                       harness="claude-code")
        self.assertIn("--claude-command", args)
        self.assertNotIn("--codex-command", args)
        self.assertIn("--plugin-hooks", args)
        self.assertNotIn("--code-sync", args)
        approved = launcher.connector_args(Path("node"), Path("claude-connect.js"), launcher.TEST_SERVER_ORIGIN,
                                           "project-example", "claude-sonnet-4-6", 65536, "never", "claude.exe",
                                           harness="claude-code", code_sync=True)
        self.assertIn("--code-sync", approved)
        self.assertNotIn("--visible-history-sync", args)
        self.assertNotIn("--context-window-tokens", args)
        self.assertNotIn("--dangerously-skip-permissions", args)

    def test_bundled_connector_path_selects_exact_harness(self):
        self.assertEqual(launcher.bundled_connector("claude-code").name, "claude-connect.js")
        self.assertEqual(launcher.bundled_connector().name, "codex-connect.js")
        with self.assertRaises(ValueError):
            launcher.bundled_connector("unknown")

    def test_claude_model_alias_or_other_harness_model_cannot_cross_launcher_boundary(self):
        for model in ("sonnet", "opus", "haiku", "default", "gpt-6-sol", "claude-", "claude-model with spaces"):
            with self.subTest(model=model), self.assertRaises(ValueError):
                launcher.parse_link(email_link(v="3", harness="claude-code", model=model))

    def test_claude_plugin_install_uses_official_explicit_commands(self):
        commands = launcher.plugin_install_commands("claude.exe", Path("C:/Launcher"), "claude-code")
        self.assertEqual(commands[0][1:4], ["plugin", "marketplace", "add"])
        self.assertEqual(commands[1][1:], ["plugin", "install", "gatherthread@gatherthread-launcher-claude", "--scope", "user"])
        self.assertNotIn("--dangerously-skip-permissions", " ".join(sum(commands, [])))


if __name__ == "__main__":
    unittest.main()
