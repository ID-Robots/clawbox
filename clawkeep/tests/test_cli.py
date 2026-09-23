"""Tests for the snapshot-management CLI subcommands (label / lock / unlock /
delete / prune). These drive the manifest mutations the TS bridge spawns.

The S3 layer is stubbed: we only assert the command's control flow — locked
guard, exit codes, JSON envelopes, and manifest mutations — not the wire.
"""

from __future__ import annotations

import json

from dataclasses import replace
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


# ── The error envelope carries the daemon's own classification ──────────────
#
# Found by the device feature sweep on a box whose account is over quota:
# `clawkeep snapshots` said `Cloud backup quota reached. Upgrade your plan or
# remove old snapshots.` while the TS bridge answered HTTP 502 "Could not list
# cloud backups". `ApiError` classifies every portal failure precisely so
# callers "can branch … without parsing English error strings", and `_emit_err`
# dropped that classification: the bridge had nothing but the sentence, which it
# is right not to surface verbatim (it can be a traceback, and it carries device
# paths). Every credential-minting subcommand is affected, not just `snapshots`:
# `label`, `lock`, `unlock`, `delete` and `prune` all mint first.


def test_emit_err_carries_the_api_error_kind(capsys: pytest.CaptureFixture[str]) -> None:
    from clawkeep.api import ApiError

    rc = cli._emit_err(ApiError("quota_full", "Cloud backup quota reached.", 402), 1)
    assert rc == 1
    out = json.loads(capsys.readouterr().out)
    assert out == {
        "ok": False,
        "error": "Cloud backup quota reached.",
        "kind": "quota_full",
    }


def test_emit_err_omits_kind_for_an_exception_that_has_none(
    capsys: pytest.CaptureFixture[str],
) -> None:
    # `token.TokenError` and `config.ConfigError` have no kind, and the bridge's
    # `default:` branch is the honest answer for them.
    rc = cli._emit_err(RuntimeError("boto3 is not installed"), 1)
    assert rc == 1
    out = json.loads(capsys.readouterr().out)
    assert out == {"ok": False, "error": "boto3 is not installed"}
    assert "kind" not in out


def test_emit_err_ignores_a_kind_that_is_not_a_string(
    capsys: pytest.CaptureFixture[str],
) -> None:
    # The envelope's shape is a contract with the TS bridge; an attribute that
    # happens to be called `kind` must not be able to change it.
    class Weird(Exception):
        kind = {"not": "a string"}

    cli._emit_err(Weird("nope"), 1)
    out = json.loads(capsys.readouterr().out)
    assert out == {"ok": False, "error": "nope"}


def test_snapshots_reports_the_quota_kind_the_portal_answered(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """The whole path, as the box produced it: listing mints credentials first,
    the portal answers 402 while the account is over quota, and the envelope
    must name that rather than leaving the bridge to guess."""
    from clawkeep.api import ApiError

    with (
        patch(
            "clawkeep.cli._load_cfg_and_token",
            return_value=(_stub_cfg(), "claw_token"),
        ),
        patch(
            "clawkeep.api.mint_credentials",
            side_effect=ApiError(
                "quota_full",
                "Cloud backup quota reached. Upgrade your plan or remove old snapshots.",
                402,
            ),
        ),
        patch("clawkeep.cli.s3.list_snapshots") as list_snapshots,
    ):
        rc = cli._snapshots_main([])
    assert rc == 1
    out = json.loads(capsys.readouterr().out)
    assert out["ok"] is False
    assert out["kind"] == "quota_full"
    # Nothing was listed — the credential is withheld before the read.
    list_snapshots.assert_not_called()


def test_snapshots_reports_the_listing_not_the_portal_counter(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """TASK-1025: `cloudBytes` in this envelope is what the objects add up to.

    It used to be `creds.cloudBytes` — the portal's running counter — and the
    TS bridge writes that field into state.json, which is where the panel's
    "cloud usage" comes from. A counter that still carried freed snapshots
    therefore reappeared on the box as "9.8 GB used" no matter what the
    account actually held.
    """
    from clawkeep import s3

    counter_says = 9_800_000_000
    creds = replace(CREDS, cloudBytes=counter_says)
    snapshots = [
        s3.Snapshot(name="b.tar.gz.enc", size_bytes=200, last_modified_ms=2),
        s3.Snapshot(name="a.tar.gz.enc", size_bytes=100, last_modified_ms=1),
    ]
    with (
        patch("clawkeep.cli._load_cfg_and_token", return_value=(_stub_cfg(), "claw_token")),
        patch("clawkeep.api.mint_credentials", return_value=creds),
        patch("clawkeep.cli.s3.list_snapshots", return_value=snapshots),
    ):
        rc = cli._snapshots_main([])

    assert rc == 0
    out = json.loads(capsys.readouterr().out)
    assert out["cloudBytes"] == 300
    assert out["cloudBytes"] != counter_says
    # The quota is the portal's to declare — only usage is re-derived here.
    assert out["quotaBytes"] == creds.quotaBytes
    assert [s["name"] for s in out["snapshots"]] == ["b.tar.gz.enc", "a.tar.gz.enc"]


def test_snapshots_reports_zero_usage_for_an_empty_prefix(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """The case the customer was in: nothing left in the bucket, a counter
    that still said otherwise."""
    creds = replace(CREDS, cloudBytes=9_800_000_000)
    with (
        patch("clawkeep.cli._load_cfg_and_token", return_value=(_stub_cfg(), "claw_token")),
        patch("clawkeep.api.mint_credentials", return_value=creds),
        patch("clawkeep.cli.s3.list_snapshots", return_value=[]),
    ):
        rc = cli._snapshots_main([])

    assert rc == 0
    out = json.loads(capsys.readouterr().out)
    assert out["cloudBytes"] == 0
    assert out["snapshots"] == []


def _stub_cfg() -> object:
    class Cfg:
        server = "https://portal.example"

    return Cfg()
