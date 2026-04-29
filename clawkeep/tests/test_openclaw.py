from __future__ import annotations

import json
import subprocess
from pathlib import Path
from unittest.mock import patch

import pytest

from clawkeep import openclaw


def _cp(rc: int, stdout: str = "", stderr: str = "") -> subprocess.CompletedProcess:
    return subprocess.CompletedProcess(args=[], returncode=rc, stdout=stdout, stderr=stderr)


def _success_payload(archive_path: str) -> str:
    return json.dumps(
        {
            "createdAt": "2026-04-29T08:00:00.000Z",
            "archiveRoot": "2026-04-29T08-00-00.000Z-openclaw-backup",
            "archivePath": archive_path,
            "dryRun": False,
            "includeWorkspace": True,
            "onlyConfig": False,
            "verified": True,
            "assets": [
                {"kind": "state", "sourcePath": "/home/x/.openclaw"},
            ],
            "skipped": [],
        }
    )


def test_create_archive_parses_metadata(tmp_path: Path) -> None:
    archive = tmp_path / "snap.tar.gz"
    archive.write_bytes(b"x" * 17)
    captured: dict[str, list[str]] = {}

    def fake_run(args: list[str], **kw: object) -> subprocess.CompletedProcess:
        captured["args"] = list(args)
        return _cp(0, stdout=_success_payload(str(archive)))

    with patch("clawkeep.openclaw.subprocess.run", side_effect=fake_run):
        result = openclaw.create_archive(
            "/usr/bin/openclaw",
            output_dir=tmp_path,
            include_workspace=True,
            verify=True,
        )

    args = captured["args"]
    assert args[0] == "/usr/bin/openclaw"
    assert "backup" in args and "create" in args
    assert "--json" in args
    assert "--output" in args and str(tmp_path) in args
    assert "--verify" in args
    # Default include_workspace=True must NOT pass --no-include-workspace —
    # the openclaw default already includes the workspace, and adding the
    # flag would silently flip the behaviour the next time someone reads
    # the config.
    assert "--no-include-workspace" not in args
    assert result.path == archive
    assert result.size_bytes == 17
    assert result.asset_count == 1
    assert result.archive_root.startswith("2026-04-29")


def test_create_archive_passes_skip_workspace_flag(tmp_path: Path) -> None:
    archive = tmp_path / "snap.tar.gz"
    archive.write_bytes(b"x")
    captured: dict[str, list[str]] = {}

    def fake_run(args: list[str], **kw: object) -> subprocess.CompletedProcess:
        captured["args"] = list(args)
        return _cp(0, stdout=_success_payload(str(archive)))

    with patch("clawkeep.openclaw.subprocess.run", side_effect=fake_run):
        openclaw.create_archive(
            "/usr/bin/openclaw",
            output_dir=tmp_path,
            include_workspace=False,
            only_config=True,
            verify=False,
        )
    args = captured["args"]
    assert "--no-include-workspace" in args
    assert "--only-config" in args
    assert "--verify" not in args


def test_create_archive_raises_when_subprocess_fails(tmp_path: Path) -> None:
    with patch(
        "clawkeep.openclaw.subprocess.run",
        return_value=_cp(1, stderr="permission denied"),
    ):
        with pytest.raises(openclaw.OpenclawError, match="permission denied"):
            openclaw.create_archive("/usr/bin/openclaw", output_dir=tmp_path)


def test_create_archive_raises_when_archive_missing(tmp_path: Path) -> None:
    """openclaw must report a real file on disk; if its archivePath points
    nowhere the runner has nothing to upload."""
    fake_path = tmp_path / "ghost.tar.gz"  # never created
    with patch(
        "clawkeep.openclaw.subprocess.run",
        return_value=_cp(0, stdout=_success_payload(str(fake_path))),
    ):
        with pytest.raises(openclaw.OpenclawError, match="no file exists"):
            openclaw.create_archive("/usr/bin/openclaw", output_dir=tmp_path)


def test_create_archive_raises_on_malformed_json(tmp_path: Path) -> None:
    with patch(
        "clawkeep.openclaw.subprocess.run",
        return_value=_cp(0, stdout="not json"),
    ):
        with pytest.raises(openclaw.OpenclawError, match="malformed JSON"):
            openclaw.create_archive("/usr/bin/openclaw", output_dir=tmp_path)


def test_create_archive_translates_oserror() -> None:
    """A missing binary must surface as OpenclawError, not crash the daemon."""
    with patch(
        "clawkeep.openclaw.subprocess.run",
        side_effect=OSError(2, "No such file or directory"),
    ):
        with pytest.raises(openclaw.OpenclawError, match="could not exec"):
            openclaw.create_archive("/no/such/openclaw", output_dir=Path("/tmp/nope"))


def test_verify_archive_passes_on_ok(tmp_path: Path) -> None:
    archive = tmp_path / "snap.tar.gz"
    archive.write_bytes(b"x")
    with patch(
        "clawkeep.openclaw.subprocess.run",
        return_value=_cp(0, stdout=json.dumps({"ok": True, "assetCount": 1})),
    ):
        openclaw.verify_archive("/usr/bin/openclaw", archive)


def test_verify_archive_raises_when_not_ok(tmp_path: Path) -> None:
    archive = tmp_path / "snap.tar.gz"
    archive.write_bytes(b"x")
    with patch(
        "clawkeep.openclaw.subprocess.run",
        return_value=_cp(0, stdout=json.dumps({"ok": False, "error": "manifest mismatch"})),
    ):
        with pytest.raises(openclaw.OpenclawError, match="not ok"):
            openclaw.verify_archive("/usr/bin/openclaw", archive)
