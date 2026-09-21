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
