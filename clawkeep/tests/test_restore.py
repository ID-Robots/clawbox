"""Restore-flow tests.

The interesting bits to cover:
  - manifest parsing & rejection of obviously broken archives
  - safe-member traversal guard (no `..`, no absolute symlinks)
  - end-to-end orchestrator with mocked S3 + openclaw verify
  - rollback on swap failure
"""

from __future__ import annotations

import json
import tarfile
import time
from pathlib import Path
from unittest.mock import patch

import pytest

from clawkeep import restore
from clawkeep.api import Credentials
from clawkeep.config import Config, HeartbeatConfig, OpenclawConfig


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


def _cfg() -> Config:
    return Config(
        server="https://server",
        schedule="daily",
        openclaw=OpenclawConfig(binary="openclaw"),
        heartbeat=HeartbeatConfig(idle_interval_hours=24),
    )


def _make_archive(
    archive: Path,
    *,
    archive_root: str,
    target_dir: Path,
    payload: dict[str, bytes],
) -> dict:
    """Build a minimal openclaw-shaped tarball whose single asset restores to
    `target_dir`. Returns the manifest dict it embedded.
    """
    rel = str(target_dir).lstrip("/")  # archive layout strips the leading "/"
    archive_subpath = f"{archive_root}/payload/posix/{rel}"
    manifest = {
        "schemaVersion": 1,
        "createdAt": "2026-04-29T08:00:00.000Z",
        "archiveRoot": archive_root,
        "runtimeVersion": "2026.4.26",
        "platform": "linux",
        "options": {"includeWorkspace": False},
        "paths": {"stateDir": str(target_dir)},
        "assets": [{
            "kind": "state",
            "sourcePath": str(target_dir),
            "archivePath": archive_subpath,
        }],
        "skipped": [],
    }
    with tarfile.open(archive, "w:gz") as tf:
        # manifest.json
        manifest_bytes = json.dumps(manifest).encode("utf-8")
        info = tarfile.TarInfo(f"{archive_root}/manifest.json")
        info.size = len(manifest_bytes)
        from io import BytesIO
        tf.addfile(info, BytesIO(manifest_bytes))
        # asset files
        for name, content in payload.items():
            info = tarfile.TarInfo(f"{archive_subpath}/{name}")
            info.size = len(content)
            tf.addfile(info, BytesIO(content))
    return manifest


def test_read_manifest_extracts_only_manifest(tmp_path: Path) -> None:
    target = tmp_path / "state"
    archive = tmp_path / "snap.tar.gz"
    _make_archive(
        archive,
        archive_root="snap-root",
        target_dir=target,
        payload={"a.txt": b"hello"},
    )
    meta = restore._read_manifest(archive, "snap-root")
    assert meta["archiveRoot"] == "snap-root"
    assert meta["assets"][0]["kind"] == "state"


def test_read_manifest_rejects_missing_manifest(tmp_path: Path) -> None:
    archive = tmp_path / "broken.tar.gz"
    with tarfile.open(archive, "w:gz") as tf:
        info = tarfile.TarInfo("not-the-root/something.txt")
        info.size = 0
        from io import BytesIO
        tf.addfile(info, BytesIO(b""))
    with pytest.raises(restore.RestoreError, match="missing manifest"):
        restore._read_manifest(archive, "expected-root")


def test_member_name_unsafe_blocks_traversal() -> None:
    info = tarfile.TarInfo("root/payload/posix/../etc/passwd")
    assert restore._member_name_unsafe(info, "root/payload/posix/etc")


def test_member_link_unsafe_blocks_absolute_symlink() -> None:
    info = tarfile.TarInfo("root/payload/posix/home/.openclaw/cfg")
    info.type = tarfile.SYMTYPE
    info.linkname = "/etc/shadow"
    assert restore._member_link_unsafe(info)


def test_member_link_safe_allows_relative_dotdot_symlink() -> None:
    # openclaw plugin-runtime-deps ship symlinks like
    #   dist/.buildstamp -> ../../shared/<...>/.buildstamp
    # These are part of the trusted, signed archive and must not break
    # restore — we just refuse to treat them as path-traversal attempts.
    info = tarfile.TarInfo(
        "root/payload/posix/home/.openclaw/plugin-runtime-deps/openclaw-x/dist/.buildstamp"
    )
    info.type = tarfile.SYMTYPE
    info.linkname = "../../shared/openclaw-x/.buildstamp"
    assert not restore._member_link_unsafe(info)


def test_swap_into_place_moves_old_aside_and_promotes_new(tmp_path: Path) -> None:
    target = tmp_path / "state"
    target.mkdir()
    (target / "old.txt").write_text("old")

    staging = tmp_path / "staging"
    staging.mkdir()
    (staging / "new.txt").write_text("new")

    backup = restore._swap_into_place(staging, target, ts=42)
    assert (target / "new.txt").read_text() == "new"
    assert backup.exists()
    assert backup.name == "state.bak-restore-42"
    assert (backup / "old.txt").read_text() == "old"


def test_swap_into_place_rolls_back_when_promotion_fails(tmp_path: Path) -> None:
    """If `staging.rename(target)` fails after we've already moved `target`
    aside, we must put `target` back so the user isn't left without state."""
    target = tmp_path / "state"
    target.mkdir()
    (target / "live.txt").write_text("live")

    staging = tmp_path / "staging"
    staging.mkdir()
    (staging / "new.txt").write_text("new")

    real_rename = Path.rename
    calls = {"n": 0}

    def fake_rename(self: Path, dest: Path) -> None:
        calls["n"] += 1
        if calls["n"] == 2:
            raise OSError("disk full")
        real_rename(self, dest)

    with patch.object(Path, "rename", fake_rename):
        with pytest.raises(restore.RestoreError, match="could not move"):
            restore._swap_into_place(staging, target, ts=99)

    # Live state is back where it was.
    assert (target / "live.txt").read_text() == "live"


def test_restore_snapshot_end_to_end(tmp_path: Path) -> None:
    target = tmp_path / "state"
    target.mkdir()
    (target / "live.txt").write_text("live-data")

    archive_root = "snap-root"
    captured_dest: dict[str, Path] = {}

    def fake_download(creds: Credentials, *, object_name: str, dest_path: Path) -> None:
        # Simulate the S3 GET — write the archive at the daemon's chosen
        # staging path, mirroring real download_file behaviour. Capture
        # the path so the test can confirm cleanup happened against the
        # *real* staging file, not a guessed one.
        captured_dest["path"] = dest_path
        _make_archive(
            dest_path,
            archive_root=archive_root,
            target_dir=target,
            payload={"restored.txt": b"from-cloud"},
        )

    cfg = _cfg()
    with (
        patch("clawkeep.restore.api.mint_credentials", return_value=CREDS),
        patch("clawkeep.restore.s3.download", side_effect=fake_download),
        patch("clawkeep.restore.openclaw.verify_archive"),
    ):
        result = restore.restore_snapshot(cfg, "claw_x", "snap-root.tar.gz")

    assert result.archive_name == "snap-root.tar.gz"
    assert len(result.assets) == 1
    asset = result.assets[0]
    assert asset.kind == "state"
    # New content is in place; old content moved aside.
    assert (target / "restored.txt").read_text() == "from-cloud"
    assert (asset.backup_path / "live.txt").read_text() == "live-data"

    # The orchestrator must clean up its scratch dir — the actual download
    # path captured above and its parent (the staging dir) should be gone.
    download_dest = captured_dest["path"]
    assert not download_dest.exists()
    assert not download_dest.parent.exists()


def test_restore_snapshot_rejects_bad_name() -> None:
    with pytest.raises(restore.RestoreError, match="expected a .tar.gz"):
        restore.restore_snapshot(_cfg(), "claw_x", "not-an-archive")


def test_restore_snapshot_propagates_verify_failure(tmp_path: Path) -> None:
    """Verify must run *before* any swap. A corrupted archive must NOT result
    in the live state being moved aside — that would leave the user without
    a working install for no reason."""
    target = tmp_path / "state"
    target.mkdir()
    (target / "live.txt").write_text("live")

    from clawkeep import openclaw

    def fake_download(creds: Credentials, *, object_name: str, dest_path: Path) -> None:
        _make_archive(
            dest_path,
            archive_root="snap-root",
            target_dir=target,
            payload={"x.txt": b"y"},
        )

    cfg = _cfg()
    with (
        patch("clawkeep.restore.api.mint_credentials", return_value=CREDS),
        patch("clawkeep.restore.s3.download", side_effect=fake_download),
        patch(
            "clawkeep.restore.openclaw.verify_archive",
            side_effect=openclaw.OpenclawError("manifest mismatch"),
        ),
    ):
        with pytest.raises(restore.RestoreError, match="archive verify failed"):
            restore.restore_snapshot(cfg, "claw_x", "snap-root.tar.gz")

    # Live state untouched.
    assert (target / "live.txt").read_text() == "live"
    assert not any(target.parent.glob("state.bak-restore-*"))
