"""Backend selection, the cross-edition guard, and the round trip.

The round trip at the bottom is the test this whole change exists for: a
Hermes box makes a backup, the box is wiped, the backup is restored, and every
byte the customer cares about is back.
"""

from __future__ import annotations

import json
import sqlite3
import tarfile
from pathlib import Path
from unittest.mock import patch

import pytest

from clawkeep import agent, hermes, restore
from clawkeep.api import Credentials
from clawkeep.config import Config, HeartbeatConfig, OpenclawConfig

CREDS = Credentials(
    accessKeyId="AK", secretAccessKey="SK", sessionToken="ST",
    endpoint="https://acct.r2.cloudflarestorage.com", bucket="clawkeep",
    prefix="users/u_x/repo/", expiresAt=9_999_999_999_999,
    quotaBytes=5_368_709_120, cloudBytes=0,
)


def _cfg() -> Config:
    return Config(
        server="https://server",
        schedule="daily",
        openclaw=OpenclawConfig(binary="openclaw"),
        heartbeat=HeartbeatConfig(idle_interval_hours=24),
    )


@pytest.fixture()
def edition_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    p = tmp_path / "edition.env"
    monkeypatch.setattr(agent, "EDITION_FILE", str(p))
    monkeypatch.delenv("CLAWBOX_EDITION", raising=False)
    return p


# ── which agent is this box? ─────────────────────────────────────────────────

def test_root_owned_file_decides_the_edition(edition_file: Path) -> None:
    edition_file.write_text(
        "# written by setup-hermes-edition.sh\nCLAWBOX_EDITION=hermes\n",
        encoding="utf-8",
    )
    assert agent.device_agent() == "hermes"


def test_quoted_and_exported_forms_parse(edition_file: Path) -> None:
    edition_file.write_text('export CLAWBOX_EDITION="hermes"\n', encoding="utf-8")
    assert agent.read_edition() == "hermes"


def test_missing_file_falls_back_to_the_environment(
    edition_file: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Dev boxes and CI have no /etc/clawbox. Same fallback order as the TS
    reader, so the two never disagree about a box."""
    monkeypatch.setenv("CLAWBOX_EDITION", "hermes")
    assert agent.read_edition() == "hermes"


def test_default_is_openclaw_when_nothing_says_otherwise(edition_file: Path) -> None:
    assert agent.device_agent() == "openclaw"


def test_a_converted_box_backs_up_the_agent_it_actually_runs(
    edition_file: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A box converted OpenClaw → Hermes keeps a stale `~/.openclaw` next to
    the live `~/.hermes` (2.7 MB of it on the QA box). Picking the backend off
    "which directory exists" would have that box faithfully archiving an agent
    it stopped running."""
    edition_file.write_text("CLAWBOX_EDITION=hermes\n", encoding="utf-8")
    monkeypatch.setenv("HOME", str(tmp_path))
    (tmp_path / ".openclaw").mkdir()
    (tmp_path / ".hermes").mkdir()
    assert agent.device_agent() == "hermes"


def test_dual_prefers_openclaw_because_that_is_the_default_harness(
    edition_file: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    edition_file.write_text("CLAWBOX_EDITION=dual\n", encoding="utf-8")
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / ".hermes"))
    (tmp_path / ".openclaw").mkdir()
    (tmp_path / ".hermes").mkdir()
    assert agent.device_agent() == "openclaw"


# ── which agent wrote this snapshot? ─────────────────────────────────────────

def test_an_archive_with_no_agent_key_is_an_openclaw_one(edition_file: Path) -> None:
    """Every snapshot written before the key existed was OpenClaw's.
    Defaulting the other way would make every historical archive unrestorable
    on the device that made it."""
    assert agent.archive_agent({"archiveRoot": "x"}) == "openclaw"


def test_cross_edition_restore_is_refused_by_name(edition_file: Path) -> None:
    edition_file.write_text("CLAWBOX_EDITION=hermes\n", encoding="utf-8")
    with pytest.raises(agent.AgentMismatchError) as excinfo:
        agent.assert_archive_matches_device({"agent": "openclaw"})
    message = str(excinfo.value)
    # Names both sides and explains WHY the wrong snapshot was offered, because
    # the customer did nothing wrong — the portal listed it.
    assert "openclaw" in message and "hermes" in message
    assert "one list" in message


def test_matching_edition_passes_silently(edition_file: Path) -> None:
    edition_file.write_text("CLAWBOX_EDITION=hermes\n", encoding="utf-8")
    agent.assert_archive_matches_device({"agent": "hermes"})


def test_create_archive_routes_to_the_hermes_backend(
    edition_file: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    edition_file.write_text("CLAWBOX_EDITION=hermes\n", encoding="utf-8")
    home = tmp_path / "home"
    monkeypatch.setenv("HERMES_HOME", str(home / ".hermes"))
    monkeypatch.setenv("CLAWBOX_HOME", str(home / ".clawbox"))
    (home / ".hermes").mkdir(parents=True)
    (home / ".hermes" / "config.yaml").write_text("a: b\n", encoding="utf-8")

    out = agent.create_archive(_cfg(), output_dir=tmp_path / "out")
    assert out.archive_root.endswith("-hermes-backup")
    assert hermes.read_manifest(out.path)["agent"] == "hermes"


# ── the round trip ───────────────────────────────────────────────────────────

def _seed(home: Path) -> None:
    hermes_home = home / ".hermes"
    hermes_home.mkdir(parents=True)
    (hermes_home / "config.yaml").write_text("model: hermes-4\nvoice: on\n", encoding="utf-8")
    (hermes_home / ".env").write_text("ANTHROPIC_API_KEY=sk-live\n", encoding="utf-8")
    (hermes_home / "memories").mkdir()
    (hermes_home / "memories" / "MEMORY.md").write_text("owner likes tea\n", encoding="utf-8")
    (hermes_home / "skills" / "email").mkdir(parents=True)
    (hermes_home / "skills" / "email" / "SKILL.md").write_text("send mail\n", encoding="utf-8")
    conn = sqlite3.connect(hermes_home / "state.db")
    conn.execute("CREATE TABLE turns (id INTEGER PRIMARY KEY, body TEXT)")
    conn.execute("INSERT INTO turns (body) VALUES ('remember this')")
    conn.commit()
    conn.close()
    (home / ".clawbox" / "agent-identity").mkdir(parents=True)
    (home / ".clawbox" / "agent-identity" / "SOUL.md").write_text("I am Claw.\n", encoding="utf-8")
    # Bulk that must survive the restore untouched because it never travelled.
    (hermes_home / "hermes-agent").mkdir()
    (hermes_home / "hermes-agent" / "huge.bin").write_bytes(b"\1" * 4096)


def test_backup_then_restore_brings_the_box_back(
    edition_file: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Backup → wipe → restore, on the manifest-driven path the device uses.

    Only the network is faked: `mint_credentials` and `s3.download` stand in
    for the portal and R2. Everything else — the archiver, the manifest, the
    verify, the per-asset extraction, the atomic swap — is the real code.
    """
    edition_file.write_text("CLAWBOX_EDITION=hermes\n", encoding="utf-8")
    home = tmp_path / "home"
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("HERMES_HOME", str(home / ".hermes"))
    monkeypatch.setenv("CLAWBOX_HOME", str(home / ".clawbox"))
    _seed(home)

    made = agent.create_archive(_cfg(), output_dir=tmp_path / "out")
    snapshot_name = made.path.name

    # Wipe the state the customer would lose, and leave behind the junk a
    # half-broken box has, so we can prove it is replaced rather than merged.
    hermes_home = home / ".hermes"
    (hermes_home / "config.yaml").write_text("CORRUPT\n", encoding="utf-8")
    (hermes_home / ".env").write_text("", encoding="utf-8")
    (hermes_home / "memories" / "MEMORY.md").write_text("nothing\n", encoding="utf-8")
    (hermes_home / "skills" / "email" / "SKILL.md").write_text("broken\n", encoding="utf-8")
    (hermes_home / "skills" / "stray").mkdir()
    (home / ".clawbox" / "agent-identity" / "SOUL.md").write_text("who?\n", encoding="utf-8")
    conn = sqlite3.connect(hermes_home / "state.db")
    conn.execute("DELETE FROM turns")
    conn.commit()
    conn.close()

    def fake_download(creds: Credentials, *, object_name: str, dest_path: Path) -> None:
        dest_path.write_bytes(made.path.read_bytes())

    with (
        patch("clawkeep.restore.api.mint_credentials", return_value=CREDS),
        patch("clawkeep.restore.s3.download", side_effect=fake_download),
    ):
        result = restore.restore_snapshot(_cfg(), "claw_x", snapshot_name)

    assert {a.kind for a in result.assets} >= {
        "config", "credentials", "sessions", "memories", "skills", "identity",
    }

    # File assets — the three restore could not handle before this change.
    assert (hermes_home / "config.yaml").read_text() == "model: hermes-4\nvoice: on\n"
    assert (hermes_home / ".env").read_text() == "ANTHROPIC_API_KEY=sk-live\n"
    conn = sqlite3.connect(hermes_home / "state.db")
    try:
        assert conn.execute("SELECT body FROM turns").fetchall() == [("remember this",)]
    finally:
        conn.close()

    # Directory assets — replaced wholesale, so post-backup junk is gone.
    assert (hermes_home / "memories" / "MEMORY.md").read_text() == "owner likes tea\n"
    assert (hermes_home / "skills" / "email" / "SKILL.md").read_text() == "send mail\n"
    assert not (hermes_home / "skills" / "stray").exists()
    assert (home / ".clawbox" / "agent-identity" / "SOUL.md").read_text() == "I am Claw.\n"

    # What never travelled is still there: restore must not delete the 1.5 GB
    # checkout just because the archive has no opinion about it.
    assert (hermes_home / "hermes-agent" / "huge.bin").read_bytes() == b"\1" * 4096

    # No staging litter left in the customer's state directory.
    assert not list(hermes_home.glob(".clawkeep-restore-*"))
    assert not list(home.glob(".clawbox/.clawkeep-restore-*"))


def test_restore_refuses_an_openclaw_snapshot_on_a_hermes_box(
    edition_file: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The reachable data-loss case: one portal account, one R2 prefix, both
    devices' snapshots in one list. Refusing must happen BEFORE anything on
    disk moves."""
    edition_file.write_text("CLAWBOX_EDITION=hermes\n", encoding="utf-8")
    home = tmp_path / "home"
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("HERMES_HOME", str(home / ".hermes"))
    monkeypatch.setenv("CLAWBOX_HOME", str(home / ".clawbox"))
    _seed(home)
    live = (home / ".hermes" / "config.yaml").read_text()

    target = home / ".openclaw"
    target.mkdir()
    (target / "openclaw.json").write_text("{}", encoding="utf-8")

    def fake_download(creds: Credentials, *, object_name: str, dest_path: Path) -> None:
        root = "snap-root"
        sub = f"{root}/payload/posix/{hermes._tar_name(target)}"
        manifest = {
            "schemaVersion": 1,
            "archiveRoot": root,
            # No `agent` key at all: exactly what a real pre-Hermes OpenClaw
            # archive looks like.
            "assets": [{"kind": "state", "sourcePath": str(target), "archivePath": sub}],
        }
        with tarfile.open(dest_path, "w:gz") as tf:
            blob = json.dumps(manifest).encode("utf-8")
            info = tarfile.TarInfo(f"{root}/manifest.json")
            info.size = len(blob)
            import io
            tf.addfile(info, io.BytesIO(blob))
            tf.add(target, arcname=sub, recursive=True)

    with (
        patch("clawkeep.restore.api.mint_credentials", return_value=CREDS),
        patch("clawkeep.restore.s3.download", side_effect=fake_download),
    ):
        with pytest.raises(restore.RestoreError, match="cannot be restored onto this hermes"):
            restore.restore_snapshot(_cfg(), "claw_x", "snap-root.tar.gz")

    # Nothing moved: not the Hermes state, not the stale OpenClaw directory.
    assert (home / ".hermes" / "config.yaml").read_text() == live
    assert (target / "openclaw.json").read_text() == "{}"
    assert not list(home.glob(".openclaw.bak-restore-*"))
