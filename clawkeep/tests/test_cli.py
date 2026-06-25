"""Tests for the snapshot-management CLI subcommands (label / lock / unlock /
delete / prune). These drive the manifest mutations the TS bridge spawns.

The S3 layer is stubbed: we only assert the command's control flow — locked
guard, exit codes, JSON envelopes, and manifest mutations — not the wire.
"""

from __future__ import annotations

import json

from unittest.mock import patch

import pytest

from clawkeep import cli
from clawkeep.api import Credentials


CREDS = Credentials(
    accessKeyId="AKIA",
    secretAccessKey="secret",
    sessionToken="session",
    endpoint="https://acct.r2.cloudflarestorage.com",
    bucket="clawkeep",
    prefix="users/u_x/repo/",
    expiresAt=9_999_999_999_999,
    quotaBytes=5_368_709_120,
    cloudBytes=0,
)


def test_delete_refuses_locked(capsys: pytest.CaptureFixture[str]) -> None:
    manifest = {"version": 1, "snapshots": {"a.tar.gz.enc": {"locked": True}}}
    with (
        patch("clawkeep.cli._mint_creds", return_value=CREDS),
        patch("clawkeep.cli.s3.read_manifest", return_value=manifest),
        patch("clawkeep.cli.s3.delete_snapshot") as delete_snapshot,
        patch("clawkeep.cli.s3.write_manifest") as write_manifest,
    ):
        rc = cli._delete_main(["a.tar.gz.enc"])
    assert rc == 2
    out = json.loads(capsys.readouterr().out)
    assert out["ok"] is False
    assert out["kind"] == "locked"
    # The object must be left untouched — no delete, no manifest rewrite.
    delete_snapshot.assert_not_called()
    write_manifest.assert_not_called()


def test_delete_allows_unlocked(capsys: pytest.CaptureFixture[str]) -> None:
    manifest = {
        "version": 1,
        "snapshots": {"a.tar.gz.enc": {"locked": False, "label": "x"}},
    }
    with (
        patch("clawkeep.cli._mint_creds", return_value=CREDS),
        patch("clawkeep.cli.s3.read_manifest", return_value=manifest),
        patch("clawkeep.cli.s3.delete_snapshot") as delete_snapshot,
        patch("clawkeep.cli.s3.write_manifest") as write_manifest,
    ):
        rc = cli._delete_main(["a.tar.gz.enc"])
    assert rc == 0
    out = json.loads(capsys.readouterr().out)
    assert out["ok"] is True
    delete_snapshot.assert_called_once_with(CREDS, "a.tar.gz.enc")
    # Manifest entry pruned after the object delete.
    written = write_manifest.call_args.args[1]
    assert "a.tar.gz.enc" not in written["snapshots"]


def test_lock_sets_locked_true(capsys: pytest.CaptureFixture[str]) -> None:
    manifest = {"version": 1, "snapshots": {}}
    with (
        patch("clawkeep.cli._mint_creds", return_value=CREDS),
        patch("clawkeep.cli.s3.read_manifest", return_value=manifest),
        patch("clawkeep.cli.s3.write_manifest") as write_manifest,
        patch("clawkeep.api.now_ms", return_value=111),
    ):
        rc = cli._lock_main(["a.tar.gz.enc"], locked=True)
    assert rc == 0
    out = json.loads(capsys.readouterr().out)
    assert out["locked"] is True
    written = write_manifest.call_args.args[1]
    # A brand-new entry is created (createdAt stamped) with locked=True.
    assert written["snapshots"]["a.tar.gz.enc"]["locked"] is True


def test_label_clears_on_empty_text(capsys: pytest.CaptureFixture[str]) -> None:
    manifest = {
        "version": 1,
        "snapshots": {"a.tar.gz.enc": {"label": "old", "locked": False}},
    }
    with (
        patch("clawkeep.cli._mint_creds", return_value=CREDS),
        patch("clawkeep.cli.s3.read_manifest", return_value=manifest),
        patch("clawkeep.cli.s3.write_manifest") as write_manifest,
    ):
        rc = cli._label_main(["a.tar.gz.enc", "--text", "   "])
    assert rc == 0
    out = json.loads(capsys.readouterr().out)
    assert out["label"] is None
    written = write_manifest.call_args.args[1]
    assert written["snapshots"]["a.tar.gz.enc"]["label"] is None


def test_label_sets_text(capsys: pytest.CaptureFixture[str]) -> None:
    manifest = {"version": 1, "snapshots": {}}
    with (
        patch("clawkeep.cli._mint_creds", return_value=CREDS),
        patch("clawkeep.cli.s3.read_manifest", return_value=manifest),
        patch("clawkeep.cli.s3.write_manifest") as write_manifest,
        patch("clawkeep.api.now_ms", return_value=222),
    ):
        rc = cli._label_main(["a.tar.gz.enc", "--text", "Before v3 upgrade"])
    assert rc == 0
    out = json.loads(capsys.readouterr().out)
    assert out["label"] == "Before v3 upgrade"
    written = write_manifest.call_args.args[1]
    assert written["snapshots"]["a.tar.gz.enc"]["label"] == "Before v3 upgrade"


def test_prune_delegates_to_apply_retention(capsys: pytest.CaptureFixture[str]) -> None:
    with (
        patch("clawkeep.cli._mint_creds", return_value=CREDS),
        patch("clawkeep.runner.apply_retention", return_value=["old1", "old2"]) as ret,
    ):
        rc = cli._prune_main(["--keep-last", "5"])
    assert rc == 0
    out = json.loads(capsys.readouterr().out)
    assert out["deleted"] == ["old1", "old2"]
    assert out["keepLast"] == 5
    ret.assert_called_once_with(CREDS, 5)
