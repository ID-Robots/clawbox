"""The Hermes backup backend.

Three things are being defended here, and they are the three ways this feature
could quietly hurt someone:

  1. the archive contains what we say it contains (and NOT the 1.5 GB agent
     checkout);
  2. a backup made on a Hermes box restores, byte for byte, onto one;
  3. an archive that is missing payload for an asset it declares FAILS the
     verify instead of restoring 4 of 5 assets and reporting success.
"""

from __future__ import annotations

import json
import os
import sqlite3
import tarfile
from datetime import datetime, timezone
from pathlib import Path

import pytest

from clawkeep import hermes


def _populate(home: Path, clawbox: Path) -> None:
    """Build a miniature but faithful `~/.hermes`, including the bulky things
    that must NOT end up in the archive."""
    home.mkdir(parents=True, exist_ok=True)
    (home / "config.yaml").write_text("model: hermes-4\n", encoding="utf-8")
    (home / ".env").write_text("ANTHROPIC_API_KEY=sk-secret\n", encoding="utf-8")

    conn = sqlite3.connect(home / "state.db")
    conn.execute("CREATE TABLE turns (id INTEGER PRIMARY KEY, body TEXT)")
    conn.execute("INSERT INTO turns (body) VALUES ('hello')")
    conn.commit()
    conn.close()

    (home / "memories").mkdir()
    (home / "memories" / "MEMORY.md").write_text("# memory\n", encoding="utf-8")
    (home / "skills" / "email").mkdir(parents=True)
    (home / "skills" / "email" / "SKILL.md").write_text("skill\n", encoding="utf-8")
    (home / "hooks").mkdir()
    (home / "cron").mkdir()
    (home / "sessions").mkdir()
    (home / "plugins" / "image_gen" / "clawai").mkdir(parents=True)
    (home / "plugins" / "image_gen" / "clawai" / "backend.py").write_text("x\n", encoding="utf-8")
    (home / "pairing").mkdir()
    (home / "pairing" / "device.json").write_text('{"token":"secret"}', encoding="utf-8")

    # The shared identity bridge lives outside HERMES_HOME.
    (clawbox / "agent-identity").mkdir(parents=True)
    (clawbox / "agent-identity" / "SOUL.md").write_text("I am.\n", encoding="utf-8")

    # ── everything below is what must NOT travel ──────────────────────────
    (home / "hermes-agent" / ".git").mkdir(parents=True)
    (home / "hermes-agent" / "huge.bin").write_bytes(b"\0" * 4096)
    (home / "bin").mkdir()
    (home / "bin" / "python3.11").write_bytes(b"\0" * 2048)
    (home / "cache").mkdir()
    (home / "cache" / "model_catalog.json").write_text("{}", encoding="utf-8")
    (home / "image_cache").mkdir()
    (home / "image_cache" / "a.png").write_bytes(b"\0" * 1024)
    (home / "audio_cache").mkdir()
    (home / "logs").mkdir()
    (home / "logs" / "mcp-stderr.log").write_text("noise\n", encoding="utf-8")
    (home / "models_dev_cache.json").write_text("{}", encoding="utf-8")
    (home / "config.yaml.bak").write_text("old\n", encoding="utf-8")
    (home / "config.yaml.lock").write_text("", encoding="utf-8")


@pytest.fixture()
def box(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    home = tmp_path / "home"
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("HERMES_HOME", str(home / ".hermes"))
    monkeypatch.setenv("CLAWBOX_HOME", str(home / ".clawbox"))
    _populate(home / ".hermes", home / ".clawbox")
    return home


def _names(archive: Path) -> list[str]:
    with tarfile.open(archive, "r:gz") as tf:
        return tf.getnames()


def _manifest(archive: Path) -> dict:
    return hermes.read_manifest(archive)


# ── what is in the archive ───────────────────────────────────────────────────

def test_archive_root_matches_the_filename_stem(box: Path, tmp_path: Path) -> None:
    """Restore locates the manifest from the snapshot NAME. If the stem and the
    tarball's top-level directory ever disagree, every Hermes archive becomes
    unreadable by the only code that has to read it."""
    out = hermes.create_archive(output_dir=tmp_path / "out")
    assert out.path.name == f"{out.archive_root}.tar.gz"
    assert f"{out.archive_root}/manifest.json" in _names(out.path)


def test_archive_carries_the_state_that_matters(box: Path, tmp_path: Path) -> None:
    out = hermes.create_archive(output_dir=tmp_path / "out")
    kinds = {a["kind"] for a in _manifest(out.path)["assets"]}
    assert kinds == {
        "config", "credentials", "sessions", "memories", "skills",
        "hooks", "cron", "session-log", "plugins", "pairing", "identity",
    }
    # `pets/` does not exist on this box: recorded as skipped, not silently
    # dropped and not an error.
    skipped = {s["kind"] for s in _manifest(out.path)["skipped"]}
    assert skipped == {"pets"}


@pytest.mark.parametrize(
    "forbidden",
    ["hermes-agent", "bin", "cache", "image_cache", "audio_cache", "logs",
     "models_dev_cache.json", "config.yaml.bak", "config.yaml.lock"],
)
def test_bulk_and_transient_paths_never_travel(
    box: Path, tmp_path: Path, forbidden: str,
) -> None:
    """The allowlist's whole job. `hermes-agent/` alone is ~1.5 GB on a real
    box; sweeping it in would turn every nightly backup into an upload the
    customer's quota cannot hold."""
    out = hermes.create_archive(output_dir=tmp_path / "out")
    assert not any(f"/.hermes/{forbidden}" in n for n in _names(out.path))


def test_credential_bearing_assets_are_declared_as_such(box: Path, tmp_path: Path) -> None:
    """The archive says out loud that it holds secrets, so nothing downstream
    has to infer it from a filename."""
    manifest = _manifest(hermes.create_archive(output_dir=tmp_path / "out").path)
    flagged = {a["kind"] for a in manifest["assets"] if a["credentialBearing"]}
    assert flagged == {"credentials", "pairing"}
    assert manifest["containsCredentials"] is True


def test_only_config_is_not_a_key_dump(box: Path, tmp_path: Path) -> None:
    """A config-only snapshot is the one a customer is most likely to hand to
    support, so `.env` must not be in it."""
    out = hermes.create_archive(output_dir=tmp_path / "out", only_config=True)
    manifest = _manifest(out.path)
    assert [a["kind"] for a in manifest["assets"]] == ["config"]
    assert manifest["containsCredentials"] is False
    assert not any(n.endswith("/.env") for n in _names(out.path))


def test_session_db_is_copied_through_sqlite_not_read_raw(
    box: Path, tmp_path: Path,
) -> None:
    """A live agent holds `state.db` open in WAL mode; a raw byte copy of one
    restores as a torn database. The archived copy must open and answer."""
    out = hermes.create_archive(output_dir=tmp_path / "out")
    manifest = _manifest(out.path)
    sub = next(a["archivePath"] for a in manifest["assets"] if a["kind"] == "sessions")
    extracted = tmp_path / "state.db"
    with tarfile.open(out.path, "r:gz") as tf:
        member = tf.extractfile(sub)
        assert member is not None
        extracted.write_bytes(member.read())
    conn = sqlite3.connect(extracted)
    try:
        assert conn.execute("SELECT body FROM turns").fetchall() == [("hello",)]
    finally:
        conn.close()


@pytest.mark.skipif(os.name != "posix", reason="POSIX file modes; the device is Linux")
def test_archive_is_owner_only_on_disk(box: Path, tmp_path: Path) -> None:
    """It holds provider keys before it is encrypted. 0600 for the window in
    which the plaintext exists."""
    out = hermes.create_archive(output_dir=tmp_path / "out")
    assert (out.path.stat().st_mode & 0o777) == 0o600


def test_empty_box_refuses_rather_than_shipping_an_empty_archive(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An archive with no assets would upload, list, and then fail every
    restore. Refuse at creation, where the message can still say why."""
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "nothing"))
    monkeypatch.setenv("CLAWBOX_HOME", str(tmp_path / "nothing-either"))
    (tmp_path / "nothing").mkdir()
    with pytest.raises(hermes.HermesError, match="nothing to back up"):
        hermes.create_archive(output_dir=tmp_path / "out")


def test_failed_create_leaves_no_half_written_tarball(
    box: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A truncated tarball that survived to be uploaded would fail a restore
    months later, when the customer needs it and has nothing else."""
    monkeypatch.setattr(
        hermes, "_sqlite_snapshot",
        lambda src, dest: (_ for _ in ()).throw(hermes.HermesError("boom")),
    )
    out_dir = tmp_path / "out"
    with pytest.raises(hermes.HermesError):
        hermes.create_archive(output_dir=out_dir)
    assert list(out_dir.glob("*.tar.gz")) == []


# ── verify ───────────────────────────────────────────────────────────────────

def test_verify_accepts_what_create_wrote(box: Path, tmp_path: Path) -> None:
    hermes.verify_archive(hermes.create_archive(output_dir=tmp_path / "out").path)


def test_verify_rejects_a_manifest_declaring_payload_that_is_absent(
    box: Path, tmp_path: Path,
) -> None:
    """THE false-success guard. An archive whose manifest lists an asset the
    payload does not contain restores everything else and calls it a success —
    the customer learns their sessions are gone weeks later."""
    good = hermes.create_archive(output_dir=tmp_path / "out", verify=False)
    manifest = _manifest(good.path)
    root = manifest["archiveRoot"]
    tampered = tmp_path / f"{root}.tar.gz"

    manifest["assets"].append({
        "kind": "invented",
        "sourcePath": "/home/clawbox/.hermes/invented",
        "archivePath": f"{root}/payload/posix/home/clawbox/.hermes/invented",
        "entry": "dir",
        "credentialBearing": False,
    })
    blob = json.dumps(manifest).encode("utf-8")
    with tarfile.open(good.path, "r:gz") as src, tarfile.open(tampered, "w:gz") as dst:
        for member in src:
            if member.name.endswith("manifest.json"):
                continue
            # Only regular files carry a payload stream. Asking a symlink or a
            # directory for one makes tarfile chase the link inside the
            # archive and raise KeyError.
            handle = src.extractfile(member) if member.isfile() else None
            dst.addfile(member, handle)
        info = tarfile.TarInfo(f"{root}/manifest.json")
        info.size = len(blob)
        import io
        dst.addfile(info, io.BytesIO(blob))

    with pytest.raises(hermes.HermesError, match="missing payload.*invented"):
        hermes.verify_archive(tampered)


def test_verify_refuses_an_openclaw_archive(tmp_path: Path) -> None:
    """The Hermes verifier must not pretend to have checked someone else's
    format."""
    archive = tmp_path / "snap.tar.gz"
    blob = json.dumps({"archiveRoot": "snap", "assets": [{"kind": "state"}]}).encode()
    with tarfile.open(archive, "w:gz") as tf:
        info = tarfile.TarInfo("snap/manifest.json")
        info.size = len(blob)
        import io
        tf.addfile(info, io.BytesIO(blob))
    with pytest.raises(hermes.HermesError, match="written by 'openclaw'"):
        hermes.verify_archive(archive)


def test_created_at_is_real_iso_and_the_stem_is_path_safe(
    box: Path, tmp_path: Path,
) -> None:
    moment = datetime(2026, 8, 26, 9, 30, 0, tzinfo=timezone.utc)
    out = hermes.create_archive(output_dir=tmp_path / "out", now=moment)
    # The stem carries the instant in a form that is legal as a path AND as an
    # S3 object key, and the UI parses the leading timestamp off it.
    assert out.path.name.startswith("2026-08-26T09-30-00.000Z-")
    assert out.path.name.endswith("-hermes-backup.tar.gz")
    assert ":" not in out.path.name
    # The invariant restore depends on: stem == tarball top-level directory.
    assert out.path.name == f"{out.archive_root}.tar.gz"
    # `createdAt` is real ISO-8601; only the filename has to avoid ":".
    assert _manifest(out.path)["createdAt"] == "2026-08-26T09:30:00.000Z"


def test_two_backups_in_the_same_second_do_not_collide(
    box: Path, tmp_path: Path,
) -> None:
    """The nightly timer firing while somebody presses "Back up now".

    `runner` uploads under the archive's own filename, so two runs that agreed
    on a name would have the second overwrite the first's object in R2 — the
    customer left with one recovery point where they should have had two.
    """
    moment = datetime(2026, 8, 26, 9, 30, 0, tzinfo=timezone.utc)
    first = hermes.create_archive(output_dir=tmp_path / "out", now=moment)
    second = hermes.create_archive(output_dir=tmp_path / "out", now=moment)
    assert first.path.name != second.path.name
    assert first.archive_root != second.archive_root
    assert first.path.exists() and second.path.exists()
    # Each still names its own manifest correctly.
    for made in (first, second):
        assert _manifest(made.path)["archiveRoot"] == made.archive_root
        hermes.verify_archive(made.path)


def test_an_empty_directory_asset_survives_the_round_trip(
    box: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`~/.hermes` ships `hooks/` and `pairing/` EMPTY on a real box.

    An empty directory has no members under its prefix, only the directory
    entry itself -- which the extractor used to skip. `extracted_any` stayed
    False, the asset failed "no members under ...", and because that happens
    part-way down the asset list the customer got a cross-asset rollback
    instead of their restore. Found by running the real thing against a real
    Hermes box, so it is pinned here.
    """
    from clawkeep import restore as restore_mod

    home = box / ".hermes"
    assert not any((home / "hooks").iterdir())  # the shape that broke it

    out = hermes.create_archive(output_dir=tmp_path / "out")
    sub = next(a["archivePath"] for a in _manifest(out.path)["assets"]
               if a["kind"] == "hooks")
    staging = tmp_path / "staged"
    extracted, swap_source = restore_mod._extract_asset(
        out.path, archive_subpath=sub, staging_root=staging,
    )
    assert extracted == 0
    # A directory asset swaps the staging directory itself...
    assert swap_source == staging
    # ...and it exists and is empty, which is the whole point.
    assert staging.is_dir() and not any(staging.iterdir())
