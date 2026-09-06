"""Restore-flow tests.

The interesting bits to cover:
  - manifest parsing & rejection of obviously broken archives
  - safe-member traversal guard (no `..`, no link that leaves the root, no
    file written through a link, no device nodes)
  - the destination pre-pass: the manifest may only name places THIS box's
    agent declares, and a refusal moves nothing
  - end-to-end orchestrator with mocked S3 + openclaw verify
  - rollback on swap failure
"""

from __future__ import annotations

import io
import json
import os
import subprocess
import tarfile
from pathlib import Path
from unittest.mock import patch

import pytest

from clawkeep import agent as agent_mod
from clawkeep import openclaw as openclaw_mod
from clawkeep import restore
from clawkeep.api import Credentials
from clawkeep.config import Config, HeartbeatConfig, OpenclawConfig


@pytest.fixture(autouse=True)
def _pin_device_edition(tmp_path_factory, monkeypatch):
    """Pin the device edition for every test in this module.

    `restore_snapshot` now asks `clawkeep.agent` which agent this device runs,
    and that reads the ROOT-OWNED /etc/clawbox/edition.env. Left alone, these
    tests would pass on a laptop (no such file, so the default "openclaw"
    matches the OpenClaw-shaped fixtures) and FAIL on a Hermes device running
    its own suite — the worst kind of test, one whose result depends on the
    machine rather than the code.
    """
    empty = tmp_path_factory.mktemp("edition") / "edition.env"
    empty.write_text("CLAWBOX_EDITION=openclaw\n", encoding="utf-8")
    monkeypatch.setattr(agent_mod, "EDITION_FILE", str(empty))
    monkeypatch.delenv("CLAWBOX_EDITION", raising=False)


#: The real thing, captured before the fixture below patches it out, for the
#: tests that run it against a fake CLI.
_REAL_PLAN_ROOTS = openclaw_mod.plan_roots


@pytest.fixture(autouse=True)
def planned_roots(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> list[openclaw_mod.PlannedRoot]:
    """What `openclaw backup create --dry-run` would declare on this "box".

    Restore now asks the CLI where OpenClaw keeps its state and refuses every
    other destination, so the fixtures here — which restore into
    `tmp_path/"state"` — must be the declared root or they would be refused
    as the attack they resemble. Patched at the CLI seam, the way
    `verify_archive` already is, so no test ever spawns the real binary: on
    the device that would answer `/home/clawbox/.openclaw` and refuse
    `tmp_path`, and on a laptop it would not exist at all.

    A test that wants different roots mutates the returned list.
    """
    roots = [openclaw_mod.PlannedRoot(kind="state", path=str(tmp_path / "state"))]
    monkeypatch.setattr(openclaw_mod, "plan_roots", lambda binary, **kw: tuple(roots))
    return roots


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


def _make_multi_archive(
    archive: Path,
    *,
    archive_root: str,
    assets: list[tuple[str, str, dict[str, bytes]]],
) -> dict:
    """Build an openclaw-shaped tarball with one asset per `(kind, sourcePath,
    payload)` triple, in that order. `sourcePath` goes into the manifest AS
    GIVEN — relative, `..`-laden or otherwise — because the manifest is the
    untrusted input under test. Returns the manifest dict it embedded."""
    manifest_assets = []
    with tarfile.open(archive, "w:gz") as tf:
        for kind, source_path, payload in assets:
            rel = source_path.lstrip("/")  # archive layout strips the leading "/"
            archive_subpath = f"{archive_root}/payload/posix/{rel}"
            manifest_assets.append({
                "kind": kind,
                "sourcePath": source_path,
                "archivePath": archive_subpath,
            })
            root = tarfile.TarInfo(archive_subpath)
            root.type = tarfile.DIRTYPE
            root.mode = 0o755
            tf.addfile(root)
            for name, content in payload.items():
                info = tarfile.TarInfo(f"{archive_subpath}/{name}")
                info.size = len(content)
                tf.addfile(info, io.BytesIO(content))
        manifest = {
            "schemaVersion": 1,
            "createdAt": "2026-04-29T08:00:00.000Z",
            "archiveRoot": archive_root,
            "runtimeVersion": "2026.4.26",
            "platform": "linux",
            "options": {"includeWorkspace": False},
            "paths": {"stateDir": assets[0][1]},
            "assets": manifest_assets,
            "skipped": [],
        }
        manifest_bytes = json.dumps(manifest).encode("utf-8")
        info = tarfile.TarInfo(f"{archive_root}/manifest.json")
        info.size = len(manifest_bytes)
        tf.addfile(info, io.BytesIO(manifest_bytes))
    return manifest


def _make_archive(
    archive: Path,
    *,
    archive_root: str,
    target_dir: Path,
    payload: dict[str, bytes],
    source_path: str | None = None,
) -> dict:
    """Build a minimal openclaw-shaped tarball whose single asset restores to
    `target_dir`. Returns the manifest dict it embedded. `source_path`
    overrides what the manifest SAYS (the payload still sits under
    `target_dir`'s archive path), for the tests about lying manifests."""
    return _make_multi_archive(
        archive,
        archive_root=archive_root,
        assets=[("state", source_path if source_path is not None else str(target_dir), payload)],
    )


def _fake_download_of(archive_path: Path):
    def fake_download(creds: Credentials, *, object_name: str, dest_path: Path) -> None:
        dest_path.write_bytes(archive_path.read_bytes())
    return fake_download


def _assert_nothing_moved(*targets: Path) -> None:
    """The refusal happened BEFORE anything on disk was touched: no live
    target renamed aside, no staging sibling built beside it."""
    for target in targets:
        parent = target.parent
        assert not list(parent.glob(f"{target.name}.bak-restore-*")), f"{target} was moved aside"
        assert not list(parent.glob(".clawkeep-restore-*")), f"staging was built beside {target}"


def _link_member(name: str, target: str, *, hard: bool = False) -> tarfile.TarInfo:
    info = tarfile.TarInfo(name)
    info.type = tarfile.LNKTYPE if hard else tarfile.SYMTYPE
    info.linkname = target
    return info


def _file_member(name: str, content: bytes = b"x") -> tuple[tarfile.TarInfo, io.BytesIO]:
    info = tarfile.TarInfo(name)
    info.size = len(content)
    return info, io.BytesIO(content)


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


# ── extraction: what a member may do to the tree being built ─────────────────

SUB = "root/payload/posix/home/clawbox/.openclaw"


def _extract(archive: Path, staged: Path, **kw: object) -> tuple[int, list[str]]:
    skipped: list[str] = []
    n, _ = restore._extract_asset(archive, archive_subpath=SUB, staging_root=staged, skipped=skipped, **kw)
    return n, skipped


def test_a_link_that_leaves_the_root_and_a_file_named_through_it_stay_inside(tmp_path: Path) -> None:
    """`evil -> ../../..` then `evil/x`. Without a filter, tarfile creates the
    link and then writes `x` THROUGH it — three directories above the staging
    root, which on the device is the owner's home. The link is refused and
    reported; `evil/x` lands as an ordinary file inside the tree."""
    archive = tmp_path / "snap.tar.gz"
    with tarfile.open(archive, "w:gz") as tf:
        tf.addfile(_link_member(f"{SUB}/evil", "../../.."))
        tf.addfile(*_file_member(f"{SUB}/evil/x", b"pwned"))

    # Deep enough that `../../..` from the staging root has somewhere to land.
    staged = tmp_path / "a" / "b" / "c" / "staged"
    _, skipped = _extract(archive, staged)

    assert any("evil" in m and "../../.." in m for m in skipped)
    assert not (staged / "evil").is_symlink()
    assert (staged / "evil" / "x").read_bytes() == b"pwned"
    # Nothing landed above the staging root: walk every ancestor up to tmp_path.
    for ancestor in (tmp_path / "a" / "b" / "c", tmp_path / "a" / "b", tmp_path / "a", tmp_path):
        assert sorted(p.name for p in ancestor.iterdir() if p.name != "snap.tar.gz") in (
            ["a"], ["b"], ["c"], ["staged"],
        ), f"something escaped into {ancestor}: {list(ancestor.iterdir())}"


def test_a_hardlink_that_leaves_the_root_is_refused(tmp_path: Path) -> None:
    archive = tmp_path / "snap.tar.gz"
    with tarfile.open(archive, "w:gz") as tf:
        tf.addfile(*_file_member(f"{SUB}/keep"))
        tf.addfile(_link_member(f"{SUB}/steal", "../../outside", hard=True))

    staged = tmp_path / "x" / "staged"
    _, skipped = _extract(archive, staged)
    assert any("steal" in m for m in skipped)
    assert not (staged / "steal").exists()


def test_an_absolute_link_outside_the_vetted_roots_is_refused(tmp_path: Path) -> None:
    archive = tmp_path / "snap.tar.gz"
    with tarfile.open(archive, "w:gz") as tf:
        tf.addfile(*_file_member(f"{SUB}/keep"))
        tf.addfile(_link_member(f"{SUB}/shadow", "/etc/shadow"))

    staged = tmp_path / "staged"
    _, skipped = _extract(archive, staged, allowed_roots=(str(tmp_path / "elsewhere"),))
    assert skipped == [f"{SUB}/shadow → /etc/shadow"]
    assert not (staged / "shadow").is_symlink()
    assert (staged / "keep").is_file()


def test_an_absolute_link_into_a_vetted_root_is_kept(tmp_path: Path) -> None:
    """The Hermes identity bridge: `memories/MEMORY.md -> ~/.clawbox/agent-identity/MEMORY.md`."""
    bridge = tmp_path / ".clawbox" / "agent-identity"
    archive = tmp_path / "snap.tar.gz"
    with tarfile.open(archive, "w:gz") as tf:
        tf.addfile(_link_member(f"{SUB}/MEMORY.md", str(bridge / "MEMORY.md")))

    staged = tmp_path / "staged"
    _, skipped = _extract(archive, staged, allowed_roots=(str(bridge),))
    assert skipped == []
    assert os.readlink(staged / "MEMORY.md") == str(bridge / "MEMORY.md")


def test_a_relative_link_that_resolves_inside_the_root_still_extracts(tmp_path: Path) -> None:
    """openclaw plugin-runtime-deps ship `dist/.buildstamp -> ../../shared/…`.
    A `..` is not an escape when it resolves inside the asset."""
    archive = tmp_path / "snap.tar.gz"
    with tarfile.open(archive, "w:gz") as tf:
        tf.addfile(*_file_member(f"{SUB}/shared/x/.buildstamp", b"stamp"))
        tf.addfile(_link_member(f"{SUB}/deps/x/dist/.buildstamp", "../../../shared/x/.buildstamp"))

    staged = tmp_path / "staged"
    _, skipped = _extract(archive, staged)
    assert skipped == []
    link = staged / "deps" / "x" / "dist" / ".buildstamp"
    assert link.is_symlink()
    assert link.read_bytes() == b"stamp"


def test_a_file_named_through_an_allowed_link_is_not_written_where_it_points(tmp_path: Path) -> None:
    """An absolute link INTO another vetted root is allowed (the identity
    bridge needs it). A file member named `<link>/x` would then be written
    into that other root — outside the tree being built, and outside the swap
    that follows. Refused by looking at where the parent really is."""
    other = tmp_path / "other-root"
    other.mkdir()
    archive = tmp_path / "snap.tar.gz"
    with tarfile.open(archive, "w:gz") as tf:
        tf.addfile(_link_member(f"{SUB}/bridge", str(other)))
        tf.addfile(*_file_member(f"{SUB}/bridge/pwn", b"through the link"))

    staged = tmp_path / "staged"
    _, skipped = _extract(archive, staged, allowed_roots=(str(other),))
    assert (staged / "bridge").is_symlink()
    assert any("bridge/pwn" in m for m in skipped)
    assert not (other / "pwn").exists()


def test_device_and_fifo_members_are_refused_outright(tmp_path: Path) -> None:
    for kind in (tarfile.CHRTYPE, tarfile.FIFOTYPE):
        archive = tmp_path / f"snap-{kind.decode()}.tar.gz"
        with tarfile.open(archive, "w:gz") as tf:
            info = tarfile.TarInfo(f"{SUB}/dev")
            info.type = kind
            tf.addfile(info)
        with pytest.raises(restore.RestoreError, match="device or fifo"):
            _extract(archive, tmp_path / f"staged-{kind.decode()}")


def test_the_same_policy_is_handed_to_tarfile_where_it_takes_a_filter() -> None:
    """tarfile's `filter=` exists on the device's 3.10.12 (a backport, not a
    3.12 feature) — `hasattr(tarfile, "data_filter")` is the feature test.
    Where it exists our own filter rides along; `fully_trusted` never does."""
    if hasattr(tarfile, "data_filter"):
        assert restore._EXTRACT_KWARGS == {"filter": restore._extraction_filter}
    else:  # pragma: no cover — an interpreter without the backport
        assert restore._EXTRACT_KWARGS == {}
    # And the filter refuses what the extractors refuse.
    with pytest.raises(restore.RestoreError):
        restore._extraction_filter(_link_member("evil", "../../.."), "/nonexistent")
    with pytest.raises(restore.RestoreError):
        restore._extraction_filter(tarfile.TarInfo("../x"), "/nonexistent")


# ── the destination pre-pass ─────────────────────────────────────────────────

def _run_restore(archive: Path, name: str = "snap-root.tar.gz") -> restore.RestoreResult:
    with (
        patch("clawkeep.restore.api.mint_credentials", return_value=CREDS),
        patch("clawkeep.restore.s3.download", side_effect=_fake_download_of(archive)),
        patch("clawkeep.restore.agent.verify_archive"),
    ):
        return restore.restore_snapshot(_cfg(), "claw_x", name)


def test_restore_refuses_an_asset_outside_the_agents_own_roots(
    tmp_path: Path, planned_roots: list[openclaw_mod.PlannedRoot],
) -> None:
    """THE finding: a manifest naming `~/.ssh` used to have `authorized_keys`
    swapped out by clicking Restore. Refused by name, before anything moves."""
    ssh = tmp_path / ".ssh"
    ssh.mkdir()
    (ssh / "authorized_keys").write_text("ssh-ed25519 owner\n")
    planned_roots[:] = [openclaw_mod.PlannedRoot("state", str(tmp_path / ".openclaw"))]

    archive = tmp_path / "snap.tar.gz"
    _make_archive(archive, archive_root="snap-root", target_dir=ssh,
                  payload={"authorized_keys": b"ssh-ed25519 attacker\n"})

    with pytest.raises(restore.RestoreError, match=r"\.ssh") as excinfo:
        _run_restore(archive)
    # Names the kind, the path, and the fact that the box decides.
    assert "'state'" in str(excinfo.value)
    assert "does not get to choose" in str(excinfo.value)
    assert (ssh / "authorized_keys").read_text() == "ssh-ed25519 owner\n"
    _assert_nothing_moved(ssh)


def test_restore_refuses_a_relative_source_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """`sourcePath: "install.sh"` resolved against the daemon's cwd — the
    ClawBox checkout, when the web server spawns it."""
    monkeypatch.chdir(tmp_path)
    (tmp_path / "install.sh").write_text("#!/bin/sh\necho real\n")
    archive = tmp_path / "snap.tar.gz"
    _make_archive(archive, archive_root="snap-root", target_dir=tmp_path / "install.sh",
                  payload={"x": b"y"}, source_path="install.sh")

    with pytest.raises(restore.RestoreError, match="absolute, normalised"):
        _run_restore(archive)
    assert (tmp_path / "install.sh").read_text() == "#!/bin/sh\necho real\n"
    _assert_nothing_moved(tmp_path / "install.sh")


@pytest.mark.parametrize("spelling", [
    "{root}/../.ssh",        # `..` — resolves to a sibling of the state dir
    "~/.openclaw",           # `~` is a shell convention, not a path
    "{root}/",               # trailing slash: the CLI never writes one
    "{root}/./workspace",    # a `.` segment
])
def test_restore_refuses_a_non_normalised_source_path(
    tmp_path: Path, planned_roots: list[openclaw_mod.PlannedRoot], spelling: str,
) -> None:
    state = tmp_path / ".openclaw"
    state.mkdir()
    (state / "openclaw.json").write_text("{}")
    planned_roots[:] = [openclaw_mod.PlannedRoot("state", str(state))]
    source = spelling.format(root=str(state))

    archive = tmp_path / "snap.tar.gz"
    _make_archive(archive, archive_root="snap-root", target_dir=state,
                  payload={"openclaw.json": b"{}"}, source_path=source)

    with pytest.raises(restore.RestoreError, match="absolute, normalised"):
        _run_restore(archive)
    assert (state / "openclaw.json").read_text() == "{}"
    _assert_nothing_moved(state, tmp_path / ".ssh")


def test_a_hostile_asset_after_two_good_ones_moves_nothing(
    tmp_path: Path, planned_roots: list[openclaw_mod.PlannedRoot],
) -> None:
    """The pre-pass. An in-loop check would refuse the third asset only after
    the first two had been moved aside and rolled back; "rolled back" is not
    "never touched", and this proves the stronger property.

    It also carries the claim about symlink roots: `allowed_roots` (what an
    absolute link may point into) is built from the vetted destinations, and
    a manifest root that is not local never reaches the extraction loop at
    all — so it can never become an allowed link target either."""
    state = tmp_path / ".openclaw"
    workspace = tmp_path / "workspace"
    for d in (state, workspace):
        d.mkdir()
        (d / "live.txt").write_text("live")
    ssh = tmp_path / ".ssh"
    ssh.mkdir()
    (ssh / "authorized_keys").write_text("owner")
    planned_roots[:] = [
        openclaw_mod.PlannedRoot("state", str(state)),
        openclaw_mod.PlannedRoot("workspace", str(workspace)),
    ]

    archive = tmp_path / "snap.tar.gz"
    _make_multi_archive(archive, archive_root="snap-root", assets=[
        ("state", str(state), {"live.txt": b"from-cloud"}),
        ("workspace", str(workspace), {"live.txt": b"from-cloud"}),
        ("state", str(ssh), {"authorized_keys": b"attacker"}),
    ])

    # Were the loop ever entered, this would prove it. It must not be.
    with patch("clawkeep.restore._extract_asset", side_effect=AssertionError("extraction started")):
        with pytest.raises(restore.RestoreError, match=r"\.ssh"):
            _run_restore(archive)

    assert (state / "live.txt").read_text() == "live"
    assert (workspace / "live.txt").read_text() == "live"
    assert (ssh / "authorized_keys").read_text() == "owner"
    _assert_nothing_moved(state, workspace, ssh)


def test_an_openclaw_asset_may_not_claim_to_be_sqlite_or_a_file(
    tmp_path: Path, planned_roots: list[openclaw_mod.PlannedRoot],
) -> None:
    """`sqlite: true` makes restore rename `<target>-wal` / `<target>-shm`
    aside — siblings OUTSIDE the target. OpenClaw declares no such asset."""
    state = tmp_path / "state"
    state.mkdir()
    archive = tmp_path / "snap.tar.gz"
    manifest = _make_archive(archive, archive_root="snap-root", target_dir=state, payload={"a": b"b"})
    manifest["assets"][0]["sqlite"] = True
    # Rewrite the manifest member with the lie in it.
    rewritten = tmp_path / "snap2.tar.gz"
    with tarfile.open(archive, "r:gz") as src, tarfile.open(rewritten, "w:gz") as dst:
        for m in src:
            if m.name.endswith("/manifest.json"):
                blob = json.dumps(manifest).encode()
                m.size = len(blob)
                dst.addfile(m, io.BytesIO(blob))
            else:
                dst.addfile(m, src.extractfile(m) if m.isfile() else None)

    with pytest.raises(restore.RestoreError, match="not a sqlite database"):
        _run_restore(rewritten)
    _assert_nothing_moved(state)


def test_restore_refuses_when_the_box_cannot_say_where_its_state_is(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A CLI that cannot answer the dry-run means the allowlist is unknown;
    restoring on a guess is the thing this whole check exists to stop."""
    state = tmp_path / "state"
    state.mkdir()
    (state / "live.txt").write_text("live")
    monkeypatch.setattr(
        openclaw_mod, "plan_roots",
        lambda binary, **kw: (_ for _ in ()).throw(openclaw_mod.OpenclawError("rc=1")),
    )
    archive = tmp_path / "snap.tar.gz"
    _make_archive(archive, archive_root="snap-root", target_dir=state, payload={"a": b"b"})

    with pytest.raises(restore.RestoreError, match="could not learn where this box keeps"):
        _run_restore(archive)
    assert (state / "live.txt").read_text() == "live"
    _assert_nothing_moved(state)


def _cli_failure(message: str) -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(
        args=[], returncode=1,
        stdout=json.dumps({"ok": False, "error": {"type": "cli_error", "message": message}}),
        stderr=f"[openclaw] Reason: {message}\n",
    )


def _dry_run_answer(state: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(
        args=[], returncode=0, stderr="",
        stdout=json.dumps({
            "dryRun": True, "includeWorkspace": False,
            "assets": [{"kind": "state", "sourcePath": str(state)}],
            "agentRoots": [],
            "skipped": [{"kind": "agent", "sourcePath": str(state / "openclaw.json"), "reason": "unresolved"}],
        }),
    )


def test_a_state_only_manifest_restores_under_a_plan_that_came_from_the_retry(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The box that needs a restore most: its openclaw.json is broken, so the
    full dry-run refuses ("Config invalid …") — and a restore that refused
    THERE would close the only way back. The real `plan_roots` runs against
    a fake CLI that answers the way the box did: the full plan fails, the
    `--no-include-workspace` retry answers the state root, and the snapshot
    of that root lands."""
    monkeypatch.setattr(openclaw_mod, "plan_roots", _REAL_PLAN_ROOTS)
    state = tmp_path / "state"
    state.mkdir()
    (state / "openclaw.json").write_text("{ not json")
    calls: list[list[str]] = []

    def fake_cli(args, **kw):
        calls.append(list(args))
        if "--no-include-workspace" in args:
            return _dry_run_answer(state)
        return _cli_failure(f"Config invalid at {state / 'openclaw.json'}. OpenClaw cannot reliably discover custom workspaces for backup.")

    archive = tmp_path / "snap.tar.gz"
    _make_archive(archive, archive_root="snap-root", target_dir=state,
                  payload={"openclaw.json": b'{"good": true}'})
    with patch("clawkeep.openclaw.subprocess.run", side_effect=fake_cli):
        result = _run_restore(archive)

    assert [c[-1] for c in calls] == ["--json", "--no-include-workspace"]
    assert (state / "openclaw.json").read_text() == '{"good": true}'
    assert (result.assets[0].backup_path / "openclaw.json").read_text() == "{ not json"


def test_a_workspace_outside_the_state_dir_is_refused_by_name_under_the_partial_plan(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """What the retry costs, said plainly: the partial plan knows nothing of
    a workspace the owner kept OUTSIDE the state directory, so a snapshot
    carrying one is refused with the declared roots named — the owner puts
    that one back by hand — and nothing moves, including the state root the
    plan did know."""
    monkeypatch.setattr(openclaw_mod, "plan_roots", _REAL_PLAN_ROOTS)
    state = tmp_path / "state"
    state.mkdir()
    (state / "live.txt").write_text("live")
    projects = tmp_path / "projects"
    projects.mkdir()

    def fake_cli(args, **kw):
        if "--no-include-workspace" in args:
            return _dry_run_answer(state)
        return _cli_failure("Config invalid at x")

    archive = tmp_path / "snap.tar.gz"
    _make_multi_archive(archive, archive_root="snap-root", assets=[
        ("state", str(state), {"live.txt": b"from-cloud"}),
        ("workspace", str(projects), {"notes.md": b"from-cloud"}),
    ])
    with patch("clawkeep.openclaw.subprocess.run", side_effect=fake_cli):
        with pytest.raises(restore.RestoreError, match="projects") as excinfo:
            _run_restore(archive)
    assert str(state) in str(excinfo.value)  # what IS allowed, for the owner
    assert (state / "live.txt").read_text() == "live"
    _assert_nothing_moved(state, projects)


def test_a_box_with_no_state_dir_restores_into_the_one_the_env_names(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`rm -rf ~/.openclaw`, then Restore. The CLI cannot plan a backup of
    nothing, so the plan is the state directory the environment names, and
    the swap creates it — which is what this code did before the allowlist,
    and what a restore is for."""
    monkeypatch.setattr(openclaw_mod, "plan_roots", _REAL_PLAN_ROOTS)
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.delenv("OPENCLAW_HOME", raising=False)
    monkeypatch.delenv("OPENCLAW_STATE_DIR", raising=False)
    state = tmp_path / ".openclaw"
    assert not state.exists()

    archive = tmp_path / "snap.tar.gz"
    _make_archive(archive, archive_root="snap-root", target_dir=state,
                  payload={"openclaw.json": b"{}"})
    with patch(
        "clawkeep.openclaw.subprocess.run",
        side_effect=lambda args, **kw: _cli_failure("No local OpenClaw state was found to back up."),
    ):
        result = _run_restore(archive)
    assert (state / "openclaw.json").read_text() == "{}"
    assert result.assets[0].target_path == state

    # And a snapshot of ANOTHER path is still refused on that box: "no state"
    # widens the plan to one directory, not to the disk.
    ssh = tmp_path / ".ssh"
    ssh.mkdir()
    (ssh / "authorized_keys").write_text("owner")
    hostile = tmp_path / "hostile.tar.gz"
    _make_archive(hostile, archive_root="snap-root", target_dir=ssh,
                  payload={"authorized_keys": b"attacker"})
    with patch(
        "clawkeep.openclaw.subprocess.run",
        side_effect=lambda args, **kw: _cli_failure("No local OpenClaw state was found to back up."),
    ):
        with pytest.raises(restore.RestoreError, match=r"\.ssh"):
            _run_restore(hostile)
    assert (ssh / "authorized_keys").read_text() == "owner"
    _assert_nothing_moved(ssh)


def test_a_file_asset_whose_archive_path_ends_in_dot_dot_is_refused_by_name(tmp_path: Path) -> None:
    """The single-file extractor writes ONE member under the basename of the
    manifest's `archivePath`. `..` there names the staging root's parent —
    refused by this module's own rule, before the archive is even walked,
    rather than left to tarfile's filter or to the OS."""
    archive = tmp_path / "snap.tar.gz"
    with tarfile.open(archive, "w:gz") as tf:
        tf.addfile(*_file_member(f"{SUB}/..", b"pwn"))
    for bad in (f"{SUB}/..", f"{SUB}/.", f"{SUB}/"):
        with pytest.raises(restore.RestoreError, match="not a name a file asset"):
            restore._extract_asset(archive, archive_subpath=bad, staging_root=tmp_path / "staged", entry="file")
    assert not (tmp_path / "staged").exists()
    assert sorted(p.name for p in tmp_path.iterdir()) == ["snap.tar.gz"]


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
        patch("clawkeep.restore.agent.verify_archive"),
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
            "clawkeep.restore.agent.verify_archive",
            side_effect=openclaw.OpenclawError("manifest mismatch"),
        ),
    ):
        with pytest.raises(restore.RestoreError, match="archive verify failed"):
            restore.restore_snapshot(cfg, "claw_x", "snap-root.tar.gz")

    # Live state untouched.
    assert (target / "live.txt").read_text() == "live"
    assert not any(target.parent.glob("state.bak-restore-*"))
