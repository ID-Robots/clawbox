"""Helpers shared by the suites that drive the real `openclaw` CLI seam.

One recorded CLI contract for every suite that fakes `openclaw backup create`:
`test_openclaw.py` and `test_restore.py` each used to carry their own copy of
the failure shape, and two copies drift — one had the JSON envelope on stdout
AND the "[openclaw] Could not start the CLI." line, the other only the Reason
line — which is how the envelope-less form went untested.
"""

from __future__ import annotations

import json
import subprocess

import pytest

from clawkeep import backup_guard

#: The real pre-flight planner, for the suites that test it on purpose.
REAL_PLAN = backup_guard._plan


@pytest.fixture(autouse=True)
def no_live_backup_plan(
    monkeypatch: pytest.MonkeyPatch, tmp_path_factory: pytest.TempPathFactory,
) -> None:
    """No test may plan — let alone walk — the REAL box's OpenClaw state, or
    write into the real ClawKeep data dir.

    Every suite that reaches `agent.create_archive` on the OpenClaw edition
    goes through `backup_guard.create_archive`, whose pre-flight runs
    `openclaw backup create --dry-run` and walks what it answers. On a machine
    with the CLI installed that was the developer's own `~/.openclaw`. The
    guard's suites hand it a plan built from a fixture tree instead. The data
    dir (the guard's lock and link journal live there) defaults to a fresh
    temporary one; a suite that wants its own sets it after this runs.
    """
    monkeypatch.setattr(backup_guard, "_plan", lambda cfg: None)
    monkeypatch.setenv("CLAWKEEP_DATA_DIR", str(tmp_path_factory.mktemp("clawkeep-data")))


def cli_failure(message: str, *, envelope: bool = True) -> subprocess.CompletedProcess[str]:
    """How `openclaw backup create --dry-run --json` fails, recorded on the
    box on 2026-09-06: rc=1, the "[openclaw] Reason:" lines on stderr and —
    under `--json` — the `{ok: false, error: {message}}` envelope on stdout.

    `envelope=False` is the OTHER form the same sentence reaches clawkeep in:
    nothing parseable on stdout, so `_cli_error_message` hands back the raw
    stderr tail with the "Could not start" line in front of the reason. A
    fallback that recognises the sentence only at the START of the message
    misses this one.
    """
    return subprocess.CompletedProcess(
        args=[],
        returncode=1,
        stdout=(
            json.dumps({"ok": False, "error": {"type": "cli_error", "message": message}})
            if envelope
            else ""
        ),
        stderr=f"[openclaw] Could not start the CLI.\n[openclaw] Reason: {message}\n",
    )
