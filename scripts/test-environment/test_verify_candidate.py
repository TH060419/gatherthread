"""Synthetic archive tests only: no network, extraction, providers, or host installation."""
import gzip
import hashlib
import importlib.util
import io
import json
import stat
import subprocess
import sys
import tarfile
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

SCRIPT = Path(__file__).with_name("verify-candidate.py")
SPEC = importlib.util.spec_from_file_location("candidate_validator", SCRIPT)
validator = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(validator)
COMMIT = "a" * 40
METADATA = {"commit": COMMIT, "node": "v24.16.0", "platform": "linux", "arch": "x64"}
DIRECTORIES = [".", "apps", "apps/server", "apps/server/dist", "apps/server/dist/src",
               "apps/web", "apps/web/dist"]


def entry(name, data=b"", kind=tarfile.REGTYPE, link="", mode=0o644):
    info = tarfile.TarInfo(name)
    info.type, info.linkname, info.mode = kind, link, mode
    info.size = len(data) if kind == tarfile.REGTYPE else 0
    return info, data


def baseline():
    return [*(entry(name, kind=tarfile.DIRTYPE, mode=0o755) for name in DIRECTORIES),
            entry("candidate.json", json.dumps(METADATA).encode()),
            entry("package.json", b'{"version":"0.1.0-beta.1"}'),
            entry("apps/server/dist/src/cli.js", b"// synthetic fixture\n"),
            entry("apps/web/dist/index.html", b"<p>fixture</p>")]


class CandidateTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="gt-candidate-test-")
        self.directory = Path(self.temporary.name)
        self.archive = self.directory / "candidate.tar.gz"
        self.checksum = self.directory / "candidate.tar.gz.sha256"

    def tearDown(self):
        self.temporary.cleanup()

    def write(self, entries=None, raw=None, archive_format=tarfile.GNU_FORMAT):
        if raw is None:
            stream = io.BytesIO()
            with tarfile.open(fileobj=stream, mode="w", format=archive_format) as archive:
                for info, data in entries if entries is not None else baseline():
                    archive.addfile(info, io.BytesIO(data) if info.isreg() else None)
            raw = gzip.compress(stream.getvalue(), mtime=0)
        self.archive.write_bytes(raw)
        self.checksum.write_bytes((hashlib.sha256(raw).hexdigest() + "  candidate.tar.gz\n").encode("ascii"))
        return raw

    def check(self, entries=None):
        self.write(entries)
        return validator.validate_archive(self.archive, COMMIT)

    def reject(self, entries):
        with self.assertRaises((ValueError, tarfile.TarError, EOFError, OSError)):
            self.check(entries)

    def test_valid_identity_and_public_stats(self):
        result = self.check()
        self.assertEqual(result["source_commit"], COMMIT)
        self.assertEqual(result["archive_bytes"], self.archive.stat().st_size)
        self.assertEqual(result["member_count"], len(baseline()))
        self.assertNotIn(str(self.directory), json.dumps(result))

    def test_checksum_fixture_is_exact_lf_bytes_and_crlf_is_refused(self):
        raw = self.write()
        expected = (hashlib.sha256(raw).hexdigest() + "  candidate.tar.gz\n").encode("ascii")
        self.assertEqual(self.checksum.read_bytes(), expected)
        self.checksum.write_bytes(expected.replace(b"\n", b"\r\n"))
        with self.assertRaisesRegex(ValueError, "Invalid candidate checksum file"):
            validator.validate_archive(self.archive, COMMIT)

    def test_windows_cross_api_creation_time_does_not_discard_fd_change_time(self):
        common = dict(st_dev=1, st_ino=2, st_size=3, st_mtime_ns=4, st_mode=stat.S_IFREG | 0o666,
                      st_nlink=1, st_birthtime_ns=5)
        path_metadata = SimpleNamespace(**common, st_ctime_ns=5)
        opened = SimpleNamespace(**common, st_ctime_ns=6)
        with patch.object(validator, "WINDOWS", True):
            self.assertEqual(validator.identity(path_metadata, cross_api=True),
                             validator.identity(opened, cross_api=True))
            self.assertTrue(validator.unchanged_file(opened, opened, path_metadata))
            # A real FD metadata change must still fail, even with unchanged
            # mtime, size, birthtime and path metadata.
            changed = SimpleNamespace(**common, st_ctime_ns=7)
            self.assertFalse(validator.unchanged_file(opened, changed, path_metadata))
            for field in common:
                changed_values = {**common, field: common[field] + 1}
                changed_path = SimpleNamespace(**changed_values, st_ctime_ns=5)
                self.assertFalse(validator.unchanged_file(opened, opened, changed_path))

    def test_posix_cross_api_comparison_keeps_precise_ctime(self):
        common = dict(st_dev=1, st_ino=2, st_size=3, st_mtime_ns=4, st_mode=stat.S_IFREG | 0o644,
                      st_nlink=1, st_birthtime_ns=5)
        first = SimpleNamespace(**common, st_ctime_ns=6)
        changed = SimpleNamespace(**common, st_ctime_ns=7)
        with patch.object(validator, "WINDOWS", False):
            self.assertNotEqual(validator.identity(first, cross_api=True),
                                validator.identity(changed, cross_api=True))
            self.assertFalse(validator.unchanged_file(first, first, changed))

    def test_metadata_requires_exact_four_fields(self):
        for field, value in [("commit", "b" * 40), ("node", "v24.15.0"), ("platform", "darwin"),
                             ("arch", "arm64"), ("provenance", {})]:
            with self.subTest(field=field):
                rows = baseline()
                rows[7] = entry("candidate.json", json.dumps({**METADATA, field: value}).encode())
                self.reject(rows)
        rows = baseline()
        rows[7] = entry("candidate.json", b'{}')
        self.reject(rows)

    def test_duplicate_json_keys_are_rejected(self):
        rows = baseline()
        rows[7] = entry("candidate.json", ('{"commit":"' + COMMIT + '",' + json.dumps(METADATA)[1:]).encode())
        self.reject(rows)

    def test_version_is_pinned_and_package_must_be_object(self):
        for value in [b'{"version":"0.1.0-alpha.8"}', b'[]', b'null']:
            rows = baseline()
            rows[8] = entry("package.json", value)
            self.reject(rows)

    def test_required_files_must_be_present_and_regular(self):
        for name in ["candidate.json", "package.json", "apps/server/dist/src/cli.js", "apps/web/dist/index.html"]:
            with self.subTest(name=name):
                rows = [row for row in baseline() if row[0].name != name]
                self.reject(rows)
                self.reject(rows + [entry(name, kind=tarfile.SYMTYPE, link="package.json")])

    def test_private_paths_and_databases_are_rejected(self):
        for name in [".git/config", ".ssh/id_rsa", ".aws/config", ".workbench/state", ".local/state",
                     ".env", ".env.local", ".env.production", ".git-credentials", ".netrc", ".npmrc",
                     "authorized_keys", "known_hosts", "id_rsa", "id_ed25519", "secret.pem", "secret.key",
                     "data.db", "data.sqlite", "data.sqlite3"]:
            with self.subTest(name=name):
                self.reject(baseline() + [entry(name)])

    def test_public_environment_templates_are_allowed(self):
        self.check(baseline() + [entry(name, b"# no secrets\n") for name in
                                [".env.example", ".env.sample", ".env.template"]])

    def test_absolute_backslash_parent_and_overlong_paths_are_rejected(self):
        for name in ["/outside", "../outside", "apps/../outside", "apps\\outside", "x" * 4097]:
            self.reject(baseline() + [entry(name)])

    def test_duplicate_normalized_members_are_rejected(self):
        self.reject(baseline() + [entry("./package.json", b"duplicate")])

    def test_all_parents_must_be_explicit_directories(self):
        self.reject([row for row in baseline() if row[0].name != "apps/server/dist"])
        self.reject(baseline() + [entry("missing/file", b"fixture")])

    def test_archive_root_if_present_must_be_a_directory(self):
        for root in [entry(".", kind=tarfile.SYMTYPE, link=".."), entry(".", b"fixture")]:
            with self.subTest(kind=root[0].type):
                self.reject([root, *baseline()[1:]])

    def test_special_files_and_privileged_modes_are_rejected(self):
        for kind in [tarfile.FIFOTYPE, tarfile.CHRTYPE, tarfile.BLKTYPE]:
            self.reject(baseline() + [entry("special", kind=kind)])
        for mode in [0o4644, 0o2644, 0o1644]:
            self.reject(baseline() + [entry("privileged", mode=mode)])

    def test_sparse_payload_is_rejected(self):
        self.write()
        with patch.object(tarfile.TarInfo, "issparse", return_value=True), self.assertRaises(ValueError):
            validator.validate_archive(self.archive, COMMIT)

    def test_internal_workspace_and_bin_symlinks_are_allowed(self):
        self.check(baseline() + [entry("node_modules", kind=tarfile.DIRTYPE),
                               entry("node_modules/.bin", kind=tarfile.DIRTYPE),
                               entry("node_modules/package", kind=tarfile.SYMTYPE, link="../apps/server"),
                               entry("node_modules/.bin/tool", kind=tarfile.SYMTYPE,
                                     link="../package/dist/src/cli.js")])

    def test_valid_internal_hardlink_is_allowed_and_not_double_charged(self):
        result = self.check(baseline() + [entry("copy", kind=tarfile.LNKTYPE, link="./package.json")])
        self.assertEqual(result["expanded_bytes"], sum(info.size for info, _ in baseline()))

    def test_regular_hardlink_chains_and_symlink_to_regular_chain_are_allowed(self):
        self.check(baseline() + [entry("copy", kind=tarfile.LNKTYPE, link="package.json"),
                                entry("copy2", kind=tarfile.LNKTYPE, link="copy"),
                                entry("apps/copy", kind=tarfile.SYMTYPE, link="../copy2")])

    def test_hardlinks_must_not_relocate_symlink_inodes(self):
        for target, additional in [("apps/alias", []),
                                   ("apps/copy", [entry("apps/copy", kind=tarfile.LNKTYPE, link="apps/alias")])]:
            with self.subTest(target=target):
                self.reject(baseline() + [entry("apps/alias", kind=tarfile.SYMTYPE, link="../package.json"),
                                         *additional, entry("relocated", kind=tarfile.LNKTYPE, link=target)])

    def test_links_cannot_escape_be_empty_or_use_backslashes(self):
        for kind in [tarfile.SYMTYPE, tarfile.LNKTYPE]:
            for target in ["", "/outside", "../outside", "bad\\name", "x" * 4097]:
                self.reject(baseline() + [entry("link", kind=kind, link=target)])

    def test_link_target_must_exist_and_hardlink_target_must_be_regular(self):
        self.reject(baseline() + [entry("link", kind=tarfile.SYMTYPE, link="missing")])
        self.reject(baseline() + [entry("link", kind=tarfile.LNKTYPE, link="apps")])

    def test_link_cycles_and_deep_chains_are_rejected(self):
        self.reject(baseline() + [entry("a", kind=tarfile.SYMTYPE, link="b"),
                                 entry("b", kind=tarfile.SYMTYPE, link="a")])
        rows = [entry(f"link{index}", kind=tarfile.SYMTYPE,
                      link=f"link{index + 1}" if index < 64 else "package.json") for index in range(65)]
        self.reject(baseline() + rows)

    def test_no_member_can_traverse_a_link_parent(self):
        self.reject(baseline() + [entry("alias", kind=tarfile.SYMTYPE, link="apps"),
                                 entry("alias/file", b"fixture")])

    def test_symlink_prefix_then_parent_cannot_escape_release(self):
        self.reject(baseline() + [entry("apps/package.json", b"fixture"),
                                 entry("apps/alias", kind=tarfile.SYMTYPE, link=".."),
                                 entry("apps/escape", kind=tarfile.SYMTYPE, link="alias/../package.json")])

    def test_hardlink_target_symlink_prefix_then_parent_cannot_escape_release(self):
        self.reject(baseline() + [entry("apps/package.json", b"fixture"),
                                 entry("apps/alias", kind=tarfile.SYMTYPE, link=".."),
                                 entry("apps/escape", kind=tarfile.LNKTYPE, link="apps/alias/../package.json")])

    def test_symlink_prefix_then_parent_stays_inside_when_physically_valid(self):
        self.check(baseline() + [entry("apps/alias", kind=tarfile.SYMTYPE, link="server/dist"),
                                entry("apps/result", kind=tarfile.SYMTYPE, link="alias/../dist/src/cli.js")])

    def test_parent_and_dot_cannot_traverse_a_regular_file(self):
        for target in ["package.json/../package.json", "package.json/./", "missing/../package.json"]:
            self.reject(baseline() + [entry("link", kind=tarfile.SYMTYPE, link=target)])

    def test_symlink_to_internal_hardlink_keeps_hardlink_root_semantics(self):
        self.check(baseline() + [entry("apps/copy", kind=tarfile.LNKTYPE, link="package.json"),
                                entry("apps/alias", kind=tarfile.SYMTYPE, link="copy")])

    def test_checksum_format_filename_and_digest_are_exact(self):
        self.write()
        digest = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        for text in [digest + "  other.tar.gz\n", digest + "  candidate.tar.gz\nextra\n",
                     "0" * 64 + "  candidate.tar.gz\n", digest + " *candidate.tar.gz\n"]:
            self.checksum.write_bytes(text.encode("ascii"))
            with self.assertRaises(ValueError):
                validator.validate_archive(self.archive, COMMIT)

    def test_changed_archive_is_rejected_by_checksum(self):
        self.write()
        data = bytearray(self.archive.read_bytes())
        data[10] ^= 1
        self.archive.write_bytes(data)
        with self.assertRaises(ValueError):
            validator.validate_archive(self.archive, COMMIT)

    def test_checksum_read_is_bounded_before_decoding(self):
        self.write()
        original = validator.regular_stream

        class Witness:
            def __init__(self, stream):
                self.stream = stream

            def read(inner, size=-1):
                self.assertEqual(size, 201)
                return inner.stream.read(size)

            def __getattr__(self, name):
                return getattr(self.stream, name)

            def __enter__(self):
                return self

            def __exit__(self, *arguments):
                return self.stream.__exit__(*arguments)

        def checked(path, maximum):
            stream, metadata = original(path, maximum)
            return (Witness(stream) if path == self.checksum else stream), metadata

        with patch.object(validator, "regular_stream", checked):
            validator.validate_archive(self.archive, COMMIT)

    def test_archive_copy_cannot_follow_a_growing_source_past_initial_size(self):
        raw = self.write()
        original = validator.regular_stream
        consumed = 0

        class Growing:
            def __init__(self, stream):
                self.stream = stream

            def read(inner, size):
                nonlocal consumed
                self.assertLessEqual(size, len(raw) + 1 - consumed)
                data = (raw + bytes(4096))[consumed:consumed + size]
                consumed += len(data)
                return data

            def __getattr__(self, name):
                return getattr(self.stream, name)

            def __enter__(self):
                return self

            def __exit__(self, *arguments):
                return self.stream.__exit__(*arguments)

        def checked(path, maximum):
            stream, metadata = original(path, maximum)
            return (Growing(stream) if path == self.archive else stream), metadata

        with patch.object(validator, "regular_stream", checked), self.assertRaises(ValueError):
            validator.validate_archive(self.archive, COMMIT)
        self.assertLessEqual(consumed, len(raw) + 1)

    def test_hash_preflight_and_parser_use_one_private_snapshot_not_source_path(self):
        self.write()
        original_stream = validator.regular_stream
        original_preflight = validator.preflight_tar
        original_open = tarfile.open
        source = snapshot = None

        def checked(path, maximum):
            nonlocal source
            stream, metadata = original_stream(path, maximum)
            if path == self.archive:
                source = stream
            return stream, metadata

        def preflight(stream):
            nonlocal snapshot
            self.assertIsNot(stream, source)
            snapshot = stream
            return original_preflight(stream)

        def parser(*arguments, **keywords):
            self.assertIs(keywords["fileobj"], snapshot)
            return original_open(*arguments, **keywords)

        with patch.object(validator, "regular_stream", checked), patch.object(validator, "preflight_tar", preflight), \
                patch.object(tarfile, "open", parser):
            validator.validate_archive(self.archive, COMMIT)

    def test_compressed_size_boundary(self):
        size = len(self.write())
        with patch.object(validator, "MAX_ARCHIVE_BYTES", size):
            validator.validate_archive(self.archive, COMMIT)
        with patch.object(validator, "MAX_ARCHIVE_BYTES", size - 1), self.assertRaises(ValueError):
            validator.validate_archive(self.archive, COMMIT)

    def test_expanded_file_and_member_boundaries(self):
        self.write()
        expanded = sum(info.size for info, _ in baseline())
        for constant, limit in [("MAX_EXPANDED_BYTES", expanded),
                                ("MAX_FILE_BYTES", max(info.size for info, _ in baseline())),
                                ("MAX_MEMBERS", len(baseline()))]:
            with patch.object(validator, constant, limit):
                validator.validate_archive(self.archive, COMMIT)
            with patch.object(validator, constant, limit - 1), self.assertRaises(ValueError):
                validator.validate_archive(self.archive, COMMIT)

    def test_whole_decompressed_stream_is_bounded_including_padding(self):
        raw = self.write()
        size = len(gzip.decompress(raw))
        with patch.object(validator, "MAX_TAR_BYTES", size):
            validator.validate_archive(self.archive, COMMIT)
        with patch.object(validator, "MAX_TAR_BYTES", size - 1), self.assertRaises(ValueError):
            validator.validate_archive(self.archive, COMMIT)

    def test_extended_metadata_is_bounded_before_parsing(self):
        rows = baseline() + [entry("x" * 200, b"fixture")]
        self.write(rows, archive_format=tarfile.PAX_FORMAT)
        with patch.object(validator, "MAX_EXTENDED_BYTES", 16), self.assertRaises(ValueError):
            validator.validate_archive(self.archive, COMMIT)
        with patch.object(validator, "MAX_METADATA_BYTES", 16), self.assertRaises(ValueError):
            validator.validate_archive(self.archive, COMMIT)

    def test_solaris_pax_metadata_uses_the_same_small_extended_cap(self):
        metadata = b"9 path=a\n"
        header = tarfile.TarInfo("metadata")
        header.type, header.size = tarfile.SOLARIS_XHDTYPE, len(metadata)
        raw = header.tobuf(format=tarfile.GNU_FORMAT) + metadata.ljust(512, b"\0") + bytes(1024)
        with patch.object(validator, "MAX_EXTENDED_BYTES", len(metadata) - 1), self.assertRaises(ValueError):
            validator.preflight_tar(io.BytesIO(gzip.compress(raw, mtime=0)))

    def test_truncated_and_appended_archives_are_rejected(self):
        raw = gzip.decompress(self.write())
        for altered in [raw[:300], raw + b"hidden"]:
            self.write(raw=gzip.compress(altered, mtime=0))
            with self.assertRaises((ValueError, tarfile.TarError, EOFError)):
                validator.validate_archive(self.archive, COMMIT)

    def test_truncated_gzip_footer_is_rejected(self):
        raw = self.write()
        self.write(raw=raw[:-6])
        with self.assertRaises((ValueError, tarfile.TarError, EOFError, OSError)):
            validator.validate_archive(self.archive, COMMIT)

    def test_archive_and_checksum_symlinks_are_refused(self):
        # Windows CI may require privilege for symlink creation. Use lstat metadata
        # rather than skip, so every platform exercises this refusal contract.
        self.write()
        for target in [self.archive, self.checksum]:
            original = Path.lstat

            def linked(path, *args, **kwargs):
                result = original(path, *args, **kwargs)
                if path == target:
                    class Metadata:
                        st_mode = stat.S_IFLNK | 0o777
                        st_nlink, st_size = 1, result.st_size
                    return Metadata()
                return result

            with patch.object(Path, "lstat", linked), self.assertRaises(ValueError):
                validator.validate_archive(self.archive, COMMIT)

    def test_archive_and_checksum_identity_changes_are_refused(self):
        self.write()
        original = Path.lstat
        for target in [self.archive, self.checksum]:
            calls = 0

            def changed(path, *args, **kwargs):
                nonlocal calls
                result = original(path, *args, **kwargs)
                if path == target:
                    calls += 1
                    if calls == 2:
                        return SimpleNamespace(**{name: getattr(result, name) + (1 if name == "st_ino" else 0)
                                                  for name in ["st_dev", "st_ino", "st_size", "st_mtime_ns",
                                                               "st_ctime_ns", "st_mode", "st_nlink"]})
                return result

            with patch.object(Path, "lstat", changed), self.assertRaises(ValueError):
                validator.validate_archive(self.archive, COMMIT)

    def test_opened_file_identity_must_match_checked_file(self):
        self.write()
        original = validator.os.fstat

        def changed(descriptor):
            result = original(descriptor)
            return SimpleNamespace(**{name: getattr(result, name) + (1 if name == "st_ino" else 0)
                                      for name in ["st_dev", "st_ino", "st_size", "st_mtime_ns",
                                                   "st_ctime_ns", "st_mode", "st_nlink"]})

        with patch.object(validator.os, "fstat", changed), self.assertRaises(ValueError):
            validator.validate_archive(self.archive, COMMIT)

    def test_invalid_commit_is_refused_before_file_access(self):
        for commit in ["main", "-x", "A" * 40, "a" * 39, "a" * 41, "a" * 40 + ";echo bad"]:
            with self.assertRaises(ValueError):
                validator.validate_archive(self.archive, commit)

    def test_cli_failure_is_generic_and_writes_no_provenance(self):
        self.write()
        output = self.directory / "provenance.json"
        result = subprocess.run([sys.executable, str(SCRIPT), str(self.archive), "b" * 40,
                                 "--provenance", str(output)], capture_output=True, text=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertNotIn(str(self.directory), result.stderr)
        self.assertFalse(output.exists())

    def test_deep_pax_parse_failure_never_exposes_a_traceback(self):
        metadata = b"9 path=a\n"
        header = tarfile.TarInfo("metadata")
        header.type, header.size = tarfile.XHDTYPE, len(metadata)
        record = header.tobuf(format=tarfile.GNU_FORMAT) + metadata.ljust(512, b"\0")
        raw = gzip.decompress(self.write())
        self.write(raw=gzip.compress(record * 1200 + raw, mtime=0))
        result = subprocess.run([sys.executable, str(SCRIPT), str(self.archive), COMMIT],
                                capture_output=True, text=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertEqual(result.stderr, "STOP: candidate validation failed\n")

    def test_invalid_deflate_block_never_exposes_a_traceback(self):
        self.write(raw=b"\x1f\x8b\x08\x00\x00\x00\x00\x00\x00\xff\x07" + bytes(8))
        result = subprocess.run([sys.executable, str(SCRIPT), str(self.archive), COMMIT],
                                capture_output=True, text=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertEqual(result.stderr, "STOP: candidate validation failed\n")

    def test_provenance_is_separate_new_public_file(self):
        self.write()
        output = self.directory / "provenance.json"
        command = [sys.executable, str(SCRIPT), str(self.archive), COMMIT, "--provenance", str(output),
                   "--workflow-sha", "b" * 40, "--run-id", "123", "--run-attempt", "1",
                   "--event", "workflow_dispatch", "--ref", "refs/heads/main",
                   "--repository", validator.REPOSITORY, "--workflow-ref", validator.WORKFLOW + "refs/heads/main"]
        subprocess.run(command, check=True, capture_output=True, timeout=10)
        metadata = json.loads(output.read_text())
        self.assertTrue(metadata["reviewed_main"])
        self.assertEqual(metadata["workflow_sha"], "b" * 40)
        self.assertNotIn(str(self.directory), output.read_text())
        self.assertNotEqual(subprocess.run(command, capture_output=True, timeout=10).returncode, 0)

    def test_premerge_provenance_never_claims_reviewed_main(self):
        self.write()
        output = self.directory / "provenance.json"
        subprocess.run([sys.executable, str(SCRIPT), str(self.archive), COMMIT, "--provenance", str(output),
                        "--workflow-sha", COMMIT, "--run-id", "123", "--run-attempt", "1", "--event", "push",
                        "--ref", validator.FEATURE_REF, "--repository", validator.REPOSITORY,
                        "--workflow-ref", validator.WORKFLOW + validator.FEATURE_REF],
                       check=True, capture_output=True, timeout=10)
        self.assertFalse(json.loads(output.read_text())["reviewed_main"])

    def test_main_verifier_public_provenance_and_output_without_extraction(self):
        self.write()
        output = self.directory / "provenance.json"
        arguments = [str(SCRIPT), str(self.archive), COMMIT, "--provenance", str(output),
                     "--workflow-sha", "b" * 40, "--run-id", "123", "--run-attempt", "1",
                     "--event", "workflow_dispatch", "--ref", "refs/heads/main",
                     "--repository", validator.REPOSITORY, "--workflow-ref", validator.WORKFLOW + "refs/heads/main"]
        capture = io.StringIO()
        with patch.object(sys, "argv", arguments), redirect_stdout(capture):
            validator.main()
        result = json.loads(capture.getvalue())
        self.assertEqual(result["release_verify_exit_code"], 0)
        self.assertEqual(json.loads(output.read_text()), result)
        self.assertEqual(sorted(path.name for path in self.directory.iterdir()),
                         ["candidate.tar.gz", "candidate.tar.gz.sha256", "provenance.json"])

    def test_provenance_ref_repository_and_run_identity_are_allowlisted(self):
        self.write()
        for flag, bad in [("--workflow-ref", validator.WORKFLOW + "refs/heads/other"),
                          ("--repository", "other/repository"), ("--run-id", "123;echo bad"),
                          ("--run-attempt", "0"), ("--workflow-sha", "b" * 39),
                          ("--event", "pull_request_target"), ("--ref", "refs/heads/other")]:
            output = self.directory / "rejected-provenance.json"
            command = [sys.executable, str(SCRIPT), str(self.archive), COMMIT, "--provenance", str(output),
                       "--workflow-sha", "b" * 40, "--run-id", "123", "--run-attempt", "1",
                       "--event", "workflow_dispatch", "--ref", "refs/heads/main",
                       "--repository", validator.REPOSITORY, "--workflow-ref", validator.WORKFLOW + "refs/heads/main"]
            command[command.index(flag) + 1] = bad
            self.assertNotEqual(subprocess.run(command, capture_output=True, timeout=10).returncode, 0)
            self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
