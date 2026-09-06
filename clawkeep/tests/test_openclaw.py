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


# ── the dry-run plan restore vets destinations against ───────────────────────

def _dry_run_payload() -> str:
    """What `openclaw backup create --dry-run --json` printed on the box on
    2026-09-06, trimmed: one included asset, one agent root, and the skipped
    list with every reason the CLI uses."""
    return json.dumps({
        "createdAt": "2026-09-06T11:08:59.787Z",
        "archiveRoot": "2026-09-06T11-08-59.787+00-00-openclaw-backup",
        "archivePath": "/home/clawbox/clawbox/2026-09-06T11-08-59.787+00-00-openclaw-backup.tar.gz",
        "dryRun": True,
        "assets": [{"kind": "state", "sourcePath": "/home/clawbox/.openclaw"}],
        "agentRoots": [{"agentId": "main", "sourcePath": "/home/clawbox/.openclaw/agents/main/agent"}],
        "skipped": [
            {"kind": "workspace", "sourcePath": "/home/clawbox/.openclaw/workspace", "reason": "covered"},
            {"kind": "agent", "sourcePath": "/home/clawbox/.openclaw/agents/main/agent", "reason": "covered"},
            {"kind": "workspace", "sourcePath": "/home/clawbox/projects", "reason": "missing"},
            {"kind": "managed state", "sourcePath": "/home/clawbox/.openclaw/npm", "reason": "regenerable"},
            {"kind": "plugin skills", "sourcePath": "/home/clawbox/.openclaw/plugin-skills", "reason": "regenerable"},
        ],
    })


def test_plan_roots_asks_for_the_full_dry_run_and_keeps_every_declared_root() -> None:
    captured: dict[str, list[str]] = {}

    def fake_run(args: list[str], **kw: object) -> subprocess.CompletedProcess:
        captured["args"] = list(args)
        return _cp(0, stdout=_dry_run_payload())

    with patch("clawkeep.openclaw.subprocess.run", side_effect=fake_run):
        roots = openclaw.plan_roots("/usr/bin/openclaw")

    # `--dry-run` writes nothing; the FULL plan, never `--no-include-workspace`
    # or `--only-config`, whatever the box's backup options say — a snapshot
    # taken with the workspace must stay restorable after the option changed.
    assert captured["args"][:5] == ["/usr/bin/openclaw", "backup", "create", "--dry-run", "--json"]
    assert "--no-include-workspace" not in captured["args"]
    assert "--only-config" not in captured["args"]
    assert "--output" not in captured["args"]

    assert {(r.kind, r.path) for r in roots} == {
        ("state", "/home/clawbox/.openclaw"),
        ("agent", "/home/clawbox/.openclaw/agents/main/agent"),
        ("workspace", "/home/clawbox/.openclaw/workspace"),
        # `missing` is kept: a root the box lacks today is exactly what a
        # restore is about to put back.
        ("workspace", "/home/clawbox/projects"),
    }
    # `regenerable` is not: no manifest of the CLI's writing names a cache.
    assert not any("npm" in r.path or "plugin-skills" in r.path for r in roots)


def _cli_failure(message: str) -> subprocess.CompletedProcess:
    """How the CLI fails under `--json`: the JSON envelope on stdout AND the
    "[openclaw] Reason:" lines on stderr, rc=1 (recorded on the box)."""
    return _cp(
        1,
        stdout=json.dumps({"ok": False, "error": {"type": "cli_error", "message": message}}),
        stderr=f"[openclaw] Could not start the CLI.\n[openclaw] Reason: {message}\n",
    )


CONFIG_INVALID = (
    "Config invalid at /home/clawbox/.openclaw/openclaw.json. OpenClaw cannot reliably "
    "discover custom workspaces for backup. Fix the config or rerun with "
    "--no-include-workspace for a partial backup."
)
NO_LOCAL_STATE = "No local OpenClaw state was found to back up."


def _partial_dry_run_payload() -> str:
    """`--dry-run --json --no-include-workspace` on the box on 2026-09-06 with
    a `{ not json` openclaw.json in a scratch state dir: the state root, no
    agent roots, and the config file named twice as `unresolved`."""
    return json.dumps({
        "createdAt": "2026-09-06T11:47:51.240Z",
        "archiveRoot": "2026-09-06T11-47-51.240+00-00-openclaw-backup",
        "archivePath": "/home/clawbox/clawbox/2026-09-06T11-47-51.240+00-00-openclaw-backup.tar.gz",
        "dryRun": True,
        "includeWorkspace": False,
        "onlyConfig": False,
        "verified": False,
        "assets": [{"kind": "state", "sourcePath": "/home/clawbox/.openclaw"}],
        "agentRoots": [],
        "skipped": [
            {"kind": "agent", "sourcePath": "/home/clawbox/.openclaw/openclaw.json", "reason": "unresolved"},
            {"kind": "plugin resources", "sourcePath": "/home/clawbox/.openclaw/openclaw.json", "reason": "unresolved"},
        ],
        "skippedVolatileCount": 0,
    })


def test_plan_roots_retries_without_the_workspace_when_the_config_is_broken() -> None:
    """A corrupt openclaw.json is the canonical reason to restore a backup,
    and the full dry-run refuses exactly there (it needs the config to find
    the workspaces). The CLI's own advice is `--no-include-workspace`, which
    still answers the state root; the plan is that, and nothing the CLI
    marked `unresolved` (the config FILE, named as an `agent` root)."""
    calls: list[list[str]] = []

    def fake_run(args: list[str], **kw: object) -> subprocess.CompletedProcess:
        calls.append(list(args))
        if "--no-include-workspace" in args:
            return _cp(0, stdout=_partial_dry_run_payload())
        return _cli_failure(CONFIG_INVALID)

    with patch("clawkeep.openclaw.subprocess.run", side_effect=fake_run):
        roots = openclaw.plan_roots("/usr/bin/openclaw")

    assert calls == [
        ["/usr/bin/openclaw", "backup", "create", "--dry-run", "--json"],
        ["/usr/bin/openclaw", "backup", "create", "--dry-run", "--json", "--no-include-workspace"],
    ]
    assert {(r.kind, r.path) for r in roots} == {("state", "/home/clawbox/.openclaw")}


def test_plan_roots_falls_back_to_the_state_dir_the_env_names_when_there_is_none(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`rm -rf ~/.openclaw` then Restore: the CLI has nothing to plan from,
    with or without the workspace. The one root it cannot deny is the state
    directory the same environment names — and ONLY on that message; any
    other failure still fails closed."""
    calls: list[list[str]] = []

    def no_state(args: list[str], **kw: object) -> subprocess.CompletedProcess:
        calls.append(list(args))
        return _cli_failure(NO_LOCAL_STATE)

    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.delenv("OPENCLAW_HOME", raising=False)
    monkeypatch.delenv("OPENCLAW_STATE_DIR", raising=False)
    with patch("clawkeep.openclaw.subprocess.run", side_effect=no_state):
        roots = openclaw.plan_roots("/usr/bin/openclaw")
    assert len(calls) == 2 and "--no-include-workspace" in calls[1]
    assert roots == (openclaw.PlannedRoot("state", str(tmp_path / ".openclaw")),)

    # The override the gateway unit exports wins, `~` and all.
    monkeypatch.setenv("OPENCLAW_STATE_DIR", "~/elsewhere/.openclaw")
    with patch("clawkeep.openclaw.subprocess.run", side_effect=no_state):
        roots = openclaw.plan_roots("/usr/bin/openclaw")
    assert roots == (openclaw.PlannedRoot("state", str(tmp_path / "elsewhere" / ".openclaw")),)

    # A different failure on the retry is not "no state": fail closed, and
    # say what BOTH runs said.
    def broken(args: list[str], **kw: object) -> subprocess.CompletedProcess:
        return _cli_failure(CONFIG_INVALID if "--no-include-workspace" not in args else "disk on fire")

    with patch("clawkeep.openclaw.subprocess.run", side_effect=broken):
        with pytest.raises(openclaw.OpenclawError, match="dry-run failed") as excinfo:
            openclaw.plan_roots("/usr/bin/openclaw")
    assert "Config invalid" in str(excinfo.value) and "disk on fire" in str(excinfo.value)


def test_state_dir_mirrors_the_clis_resolution(tmp_path: Path) -> None:
    """The CLI's `resolveStateDir`, arm for arm: OPENCLAW_HOME is the ACCOUNT
    home (its state dir is `$OPENCLAW_HOME/.openclaw` — the very confusion
    that once put a second tree at `~/.openclaw/.openclaw/`), a legacy
    `.clawdbot` is kept only when `.openclaw` is absent, and a shell
    placeholder that leaked into the env counts as unset."""
    home = tmp_path / "home"
    home.mkdir()
    env = {"HOME": str(home)}
    assert openclaw.state_dir(env) == str(home / ".openclaw")

    (home / ".clawdbot").mkdir()
    assert openclaw.state_dir(env) == str(home / ".clawdbot")
    (home / ".openclaw").mkdir()
    assert openclaw.state_dir(env) == str(home / ".openclaw")

    acct = tmp_path / "acct"
    acct.mkdir()
    assert openclaw.state_dir({**env, "OPENCLAW_HOME": str(acct)}) == str(acct / ".openclaw")
    assert openclaw.state_dir({**env, "OPENCLAW_HOME": "~/acct"}) == str(home / "acct" / ".openclaw")
    assert openclaw.state_dir({**env, "OPENCLAW_HOME": "undefined"}) == str(home / ".openclaw")
    assert openclaw.state_dir({**env, "OPENCLAW_STATE_DIR": " /srv/oc "}) == "/srv/oc"


def test_plan_roots_fails_closed_when_the_cli_cannot_answer() -> None:
    with patch("clawkeep.openclaw.subprocess.run", return_value=_cp(1, stderr="boom")):
        with pytest.raises(openclaw.OpenclawError, match="dry-run failed"):
            openclaw.plan_roots("/usr/bin/openclaw")
    with patch("clawkeep.openclaw.subprocess.run", return_value=_cp(0, stdout="{}")):
        with pytest.raises(openclaw.OpenclawError, match="declared no source paths"):
            openclaw.plan_roots("/usr/bin/openclaw")
    with patch("clawkeep.openclaw.subprocess.run", return_value=_cp(0, stdout="not json")):
        with pytest.raises(openclaw.OpenclawError, match="malformed JSON"):
            openclaw.plan_roots("/usr/bin/openclaw")
