from __future__ import annotations

import json
import subprocess
from unittest.mock import patch

import pytest

from clawkeep import restic
from clawkeep.api import Credentials


CREDS = Credentials(
    accessKeyId="AKIA",
    secretAccessKey="secret",
    sessionToken="session",
    endpoint="https://acct.r2.cloudflarestorage.com",
    bucket="clawkeep",
    prefix="users/u_x/repo/",
    expiresAt=0,
    quotaBytes=5_368_709_120,
    cloudBytes=0,
)


def _cp(rc: int, stdout: str = "", stderr: str = "") -> subprocess.CompletedProcess:
    return subprocess.CompletedProcess(args=[], returncode=rc, stdout=stdout, stderr=stderr)


def test_restic_env_includes_session_token() -> None:
    env = restic.restic_env(CREDS, "repo-pw")
    # Section 8 footgun guard.
    assert env["AWS_SESSION_TOKEN"] == "session"
    assert env["AWS_ACCESS_KEY_ID"] == "AKIA"
    assert env["AWS_SECRET_ACCESS_KEY"] == "secret"
    assert env["RESTIC_PASSWORD"] == "repo-pw"


def test_repo_url_shape() -> None:
    assert restic.repo_url(CREDS) == (
        "s3:https://acct.r2.cloudflarestorage.com/clawkeep/users/u_x/repo/"
    )


def test_init_idempotent_on_already_exists() -> None:
    with patch("clawkeep.restic.subprocess.run", return_value=_cp(1, stderr="repository already exists at ...")):
        restic.init("/usr/bin/restic", "s3:foo", {})  # must not raise


def test_init_raises_on_real_failure() -> None:
    with patch("clawkeep.restic.subprocess.run", return_value=_cp(2, stderr="permission denied")):
        with pytest.raises(restic.ResticError):
            restic.init("/usr/bin/restic", "s3:foo", {})


def test_backup_parses_summary_line() -> None:
    summary = json.dumps({
        "message_type": "summary",
        "files_new": 3,
        "files_changed": 1,
        "data_added": 1024,
    })
    stdout = "\n".join(
        [
            json.dumps({"message_type": "status", "files_done": 0}),
            json.dumps({"message_type": "status", "files_done": 1}),
            summary,
        ]
    )
    with patch("clawkeep.restic.subprocess.run", return_value=_cp(0, stdout=stdout)):
        result = restic.backup("/usr/bin/restic", "s3:foo", {}, paths=["/home"])
    assert result.ok is True
    assert result.files_new == 3
    assert result.files_changed == 1
    assert result.bytes_added == 1024


def test_backup_failure_returns_last_line() -> None:
    with patch(
        "clawkeep.restic.subprocess.run",
        return_value=_cp(1, stdout="", stderr="line1\nFatal: cannot upload to s3"),
    ):
        result = restic.backup("/usr/bin/restic", "s3:foo", {}, paths=["/home"])
    assert result.ok is False
    assert "Fatal" in result.last_line


def test_backup_passes_excludes_and_compression() -> None:
    captured: dict[str, list[str]] = {}

    def fake_run(args: list[str], **kw: object) -> subprocess.CompletedProcess:
        captured["args"] = list(args)
        return _cp(0, stdout=json.dumps({"message_type": "summary"}))

    with patch("clawkeep.restic.subprocess.run", side_effect=fake_run):
        restic.backup(
            "/usr/bin/restic",
            "s3:foo",
            {},
            paths=["/a", "/b"],
            excludes=["**/x"],
            compression="max",
            read_concurrency=4,
        )
    args = captured["args"]
    assert args[0] == "/usr/bin/restic"
    # Required positional flags appear in order
    assert "-r" in args and "s3:foo" in args
    assert "backup" in args
    assert "--compression" in args and "max" in args
    assert "--read-concurrency" in args and "4" in args
    assert "--exclude" in args and "**/x" in args
    assert "/a" in args and "/b" in args


def test_stats_parses_total_size_and_snapshot_count() -> None:
    stats_payload = json.dumps({"total_size": 1234567, "total_file_count": 42})
    snaps_payload = json.dumps([{"id": "a"}, {"id": "b"}, {"id": "c"}])

    cps = [_cp(0, stdout=stats_payload), _cp(0, stdout=snaps_payload)]

    with patch("clawkeep.restic.subprocess.run", side_effect=cps):
        s = restic.stats("/usr/bin/restic", "s3:foo", {})
    assert s.total_size == 1234567
    assert s.snapshot_count == 3


def test_stats_failure_raises() -> None:
    with patch("clawkeep.restic.subprocess.run", return_value=_cp(1, stderr="bad")):
        with pytest.raises(restic.ResticError):
            restic.stats("/usr/bin/restic", "s3:foo", {})
