#!/usr/bin/env python3
"""Read-only candidate validation. Never extracts, deploys, or loads private configuration."""
import argparse
import gzip
import hashlib
import json
import os
import posixpath
import re
import stat
import tarfile
import tempfile
import zlib
from pathlib import Path

VERSION = "0.1.0-beta.1"
NODE = "v24.16.0"
MAX_ARCHIVE_BYTES = 500 * 1024 * 1024
MAX_EXPANDED_BYTES = 512 * 1024 * 1024
MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_MEMBERS = 100_000
# Count all decompressed bytes, not only files. Bound metadata before tarfile parses it.
MAX_TAR_BYTES = 640 * 1024 * 1024
MAX_EXTENDED_BYTES = 64 * 1024
MAX_METADATA_BYTES = 8 * 1024 * 1024
MAX_NAME_BYTES = 4096
FEATURE_REF = "refs/heads/codex/hosted-cpuset-katex-20261010"
REPOSITORY = "TH060419/gatherthread"
WORKFLOW = f"{REPOSITORY}/.github/workflows/test-candidate.yml@"
WINDOWS = os.name == "nt"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def regular_stream(path, maximum):
    before = path.lstat()
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1
            and 0 < before.st_size <= maximum, "Invalid candidate file type or size")
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    stream = os.fdopen(descriptor, "rb")
    opened = os.fstat(stream.fileno())
    if identity(before, cross_api=True) != identity(opened, cross_api=True):
        stream.close()
        raise ValueError("Candidate file changed")
    return stream, opened


def identity(metadata, cross_api=False):
    # CPython 3.12 Windows path stat exposes creation time as legacy ctime,
    # whereas fstat exposes FILE_BASIC_INFO.ChangeTime. Compare birthtime
    # across APIs, but retain full FD ctime in the same-API mutation check.
    timestamp = (getattr(metadata, "st_birthtime_ns", metadata.st_ctime_ns)
                 if WINDOWS and cross_api else metadata.st_ctime_ns)
    return (metadata.st_dev, metadata.st_ino, metadata.st_size,
            metadata.st_mtime_ns, timestamp, metadata.st_mode, metadata.st_nlink)


def unchanged_file(before, current, path_metadata):
    return (identity(before) == identity(current)
            and identity(before, cross_api=True) == identity(path_metadata, cross_api=True))


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "Duplicate JSON key")
        result[key] = value
    return result


def member_name(raw):
    require(isinstance(raw, str) and raw and len(raw.encode("utf-8")) <= MAX_NAME_BYTES
            and "\x00" not in raw and "\\" not in raw, "Invalid archive path")
    require(not raw.startswith("/") and ".." not in raw.split("/"), "Archive path escapes release")
    return posixpath.normpath(raw)


def forbidden(name):
    parts = name.split("/")
    if any(part in {".git", ".ssh", ".aws", ".workbench", ".local"} for part in parts):
        return True
    if any(part.startswith(".env") and part not in {".env.example", ".env.sample", ".env.template"}
           for part in parts):
        return True
    leaf = parts[-1].lower()
    return leaf in {".git-credentials", ".netrc", ".npmrc", "authorized_keys", "known_hosts",
                    "id_rsa", "id_ed25519"} or leaf.endswith((".pem", ".key", ".db", ".sqlite", ".sqlite3"))


def preflight_tar(stream):
    """Limit gzip expansion and raw metadata, including hidden PAX/GNU records."""
    total = records = metadata_bytes = 0
    with gzip.GzipFile(fileobj=stream, mode="rb") as compressed:
        def read(size):
            nonlocal total
            data = compressed.read(min(size, MAX_TAR_BYTES - total + 1))
            total += len(data)
            require(total <= MAX_TAR_BYTES, "Decompressed archive exceeds limit")
            return data

        while True:
            block = read(512)
            require(len(block) == 512, "Truncated archive header")
            if block == bytes(512):
                # GNU tar pads the terminator with zero blocks. No hidden second archive.
                while True:
                    tail = read(min(1024 * 1024, MAX_TAR_BYTES - total + 1))
                    require(not any(tail), "Unexpected trailing archive data")
                    if not tail:
                        return
            record = tarfile.TarInfo.frombuf(block, "utf-8", "strict")
            records += 1
            require(records <= MAX_MEMBERS, "Archive member count exceeds limit")
            require(record.size >= 0, "Invalid archive entry size")
            if record.type in {tarfile.XHDTYPE, tarfile.XGLTYPE, tarfile.SOLARIS_XHDTYPE, tarfile.GNUTYPE_LONGNAME,
                               tarfile.GNUTYPE_LONGLINK}:
                require(record.size <= MAX_EXTENDED_BYTES, "Archive metadata exceeds limit")
                metadata_bytes += record.size
                require(metadata_bytes <= MAX_METADATA_BYTES, "Archive metadata exceeds limit")
            else:
                require(record.size <= MAX_FILE_BYTES, "Archive file size exceeds limit")
            remaining = (record.size + 511) // 512 * 512
            while remaining:
                chunk = read(min(remaining, 1024 * 1024))
                require(chunk, "Truncated archive data")
                remaining -= len(chunk)


def validate_archive(path, commit):
    require(re.fullmatch(r"[a-f0-9]{40}", commit) is not None, "Use a full lowercase commit SHA")
    require(path.name == "candidate.tar.gz", "Unexpected candidate filename")
    checksum_path = path.with_name("candidate.tar.gz.sha256")
    checksum, checksum_before = regular_stream(checksum_path, 200)
    with checksum:
        checksum_bytes = checksum.read(201)
        require(len(checksum_bytes) == checksum_before.st_size and len(checksum_bytes) <= 200,
                "Candidate checksum changed or exceeds limit")
        checksum_text = checksum_bytes.decode("ascii")
        require(unchanged_file(checksum_before, os.fstat(checksum.fileno()), checksum_path.lstat()),
                "Candidate checksum changed")
    match = re.fullmatch(r"([a-f0-9]{64})  candidate\.tar\.gz\n", checksum_text)
    require(match is not None, "Invalid candidate checksum file")
    source, before = regular_stream(path, MAX_ARCHIVE_BYTES)
    # One disk-backed private snapshot serves every pass. Never retain a whole
    # 500 MiB archive in memory or reparse a mutable source path after preflight.
    with source, tempfile.TemporaryFile(mode="w+b") as stream:
        copied = 0
        while True:
            chunk = source.read(min(1024 * 1024, before.st_size - copied + 1))
            copied += len(chunk)
            require(copied <= before.st_size and copied <= MAX_ARCHIVE_BYTES, "Candidate file grew during copy")
            if not chunk:
                break
            require(stream.write(chunk) == len(chunk), "Candidate snapshot write failed")
        require(copied == before.st_size, "Candidate file shrank during copy")
        require(unchanged_file(before, os.fstat(source.fileno()), path.lstat()),
                "Candidate file changed during copy")
        stream.seek(0)
        digest = hashlib.sha256()
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
        require(digest.hexdigest() == match.group(1), "Candidate SHA256 mismatch")
        stream.seek(0)
        preflight_tar(stream)
        stream.seek(0)
        entries, links = {}, {}
        expanded = 0
        with tarfile.open(fileobj=stream, mode="r:gz") as archive:
            for member in archive:
                name = member_name(member.name)
                require(name not in entries and len(entries) < MAX_MEMBERS, "Duplicate or excessive archive member")
                require(not forbidden(name), "Archive contains private configuration, credentials, or database files")
                require(member.isdir() or member.isreg() or member.issym() or member.islnk(), "Special archive member refused")
                require(not member.issparse(), "Sparse archive member refused")
                require(name != "." or member.isdir(), "Archive root must be a directory")
                require(member.mode & 0o7000 == 0, "Privileged file mode refused")
                entries[name] = member
                if member.isreg():
                    require(0 <= member.size <= MAX_FILE_BYTES, "Archive file size exceeds limit")
                    expanded += member.size
                    require(expanded <= MAX_EXPANDED_BYTES, "Archive expanded size exceeds limit")
                if member.issym() or member.islnk():
                    target = member.linkname
                    require(target and len(target.encode("utf-8")) <= MAX_NAME_BYTES and "\x00" not in target
                            and "\\" not in target and not target.startswith("/"), "Invalid archive link")
                    # Preserve component order: alias/.. is not equivalent to
                    # lexical normalization when alias itself is a symlink.
                    links[name] = target

            def resolve(name):
                hops = 0

                def walk(components, resolved, active=(), hardlink_target=False):
                    nonlocal hops
                    for index, component in enumerate(components):
                        if component in {"", "."}:
                            continue
                        if component == "..":
                            require(resolved, "Resolved archive link escapes release")
                            resolved.pop()
                            continue
                        prefix = "/".join([*resolved, component])
                        require(prefix in entries, "Archive link points to a missing target")
                        if prefix in links:
                            require(not hardlink_target or not entries[prefix].issym(),
                                    "Hardlink target must not contain a symbolic link")
                            require(prefix not in active and hops < 64, "Cyclic or excessive archive links")
                            hops += 1
                            # Hardlink names are relative to the archive root;
                            # symlink names are relative to their physical parent.
                            base = [] if entries[prefix].islnk() else resolved.copy()
                            resolved = walk(links[prefix].split("/"), base, (*active, prefix),
                                            hardlink_target or entries[prefix].islnk())
                        else:
                            resolved.append(component)
                        if index < len(components) - 1:
                            current = "/".join(resolved) or "."
                            require(current in entries and entries[current].isdir(),
                                    "Archive link traverses a non-directory")
                    return resolved

                return "/".join(walk([] if name == "." else name.split("/"), [])) or "."

            for name, member in entries.items():
                resolved = resolve(name)
                require(resolved in entries, "Archive link points to a missing target")
                if member.islnk():
                    require(entries[resolved].isreg(), "Hardlink target must be a regular file")
                parent = posixpath.dirname(name)
                while parent and parent != ".":
                    require(parent in entries and entries[parent].isdir(), "Archive member traverses a link or non-directory parent")
                    parent = posixpath.dirname(parent)
            required = ("candidate.json", "package.json", "apps/server/dist/src/cli.js", "apps/web/dist/index.html")
            require(all(name in entries and entries[name].isreg() for name in required), "Required release file missing")

            def read_json(name):
                require(entries[name].size <= 64 * 1024, "Release metadata exceeds limit")
                return json.loads(archive.extractfile(entries[name]).read().decode("utf-8"), object_pairs_hook=unique_object)

            require(read_json("candidate.json") == {"commit": commit, "node": NODE, "platform": "linux", "arch": "x64"},
                    "Candidate identity mismatch")
            manifest = read_json("package.json")
            require(isinstance(manifest, dict) and manifest.get("version") == VERSION, "Candidate version mismatch")
        require(unchanged_file(before, os.fstat(source.fileno()), path.lstat()), "Candidate file changed")
    return {"source_commit": commit, "version": VERSION, "node": NODE, "platform": "linux", "arch": "x64",
            "archive": "candidate.tar.gz", "archive_sha256": digest.hexdigest(), "archive_bytes": before.st_size,
            "expanded_bytes": expanded, "member_count": len(entries)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("commit")
    parser.add_argument("--provenance", type=Path)
    parser.add_argument("--workflow-sha")
    parser.add_argument("--workflow-ref")
    parser.add_argument("--repository")
    parser.add_argument("--run-id")
    parser.add_argument("--run-attempt")
    parser.add_argument("--event")
    parser.add_argument("--ref")
    arguments = parser.parse_args()
    result = validate_archive(arguments.archive, arguments.commit)
    if arguments.provenance:
        require(re.fullmatch(r"[a-f0-9]{40}", arguments.workflow_sha or "") is not None, "Invalid workflow SHA")
        require(all(re.fullmatch(r"[1-9][0-9]{0,19}", value or "") for value in
                    (arguments.run_id, arguments.run_attempt)), "Invalid workflow run identity")
        require((arguments.event, arguments.ref) in {("workflow_dispatch", "refs/heads/main"), ("push", FEATURE_REF)},
                "Unapproved candidate workflow source")
        require(arguments.repository == REPOSITORY and arguments.workflow_ref == WORKFLOW + arguments.ref,
                "Invalid repository or workflow identity")
        result.update(schema=1, workflow_sha=arguments.workflow_sha, run_id=arguments.run_id,
                      run_attempt=arguments.run_attempt, event=arguments.event, ref=arguments.ref,
                      workflow_ref=arguments.workflow_ref, repository=arguments.repository,
                      reviewed_main=arguments.event == "workflow_dispatch", release_verify_exit_code=0, build_exit_code=0)
        # Called only after prepare-candidate.sh exits successfully; never overwrite evidence.
        with os.fdopen(os.open(arguments.provenance, os.O_WRONLY | os.O_CREAT | os.O_EXCL
                               | getattr(os, "O_NOFOLLOW", 0), 0o600), "w") as output:
            json.dump(result, output, indent=2, sort_keys=True)
            output.write("\n")
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, UnicodeError, tarfile.TarError, EOFError, RecursionError, zlib.error):
        # Do not echo a malicious filename, file content, traceback, or private environment.
        raise SystemExit("STOP: candidate validation failed") from None
