"""Tiny state file at $CLAWKEEP_DATA_DIR/state.json.

Used so the idle-heartbeat timer knows whether it should send an idle
heartbeat (no other heartbeat in the last N hours) without re-reading
the portal. Also surfaced to the clawbox UI as the source of truth
for "Last backup: …" / "Cloud bytes: …" displays.
"""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass
from pathlib import Path

from .token import data_dir


def default_state_path() -> Path:
    return data_dir() / "state.json"


# Module-level constant kept for backward compat. Tests that need to flip
# CLAWKEEP_DATA_DIR mid-run should pass an explicit path or call
# default_state_path() at call time.
DEFAULT_STATE_PATH = default_state_path()


@dataclass
class State:
    last_heartbeat_at_ms: int = 0
    last_heartbeat_status: str = ""  # ok | error | running | idle
    last_backup_at_ms: int = 0
    last_cloud_bytes: int = 0
    last_snapshot_count: int = 0


def _safe_int(value: object) -> int:
    """Coerce JSON-decoded values that should be ints. A malformed
    state.json (e.g. last_cloud_bytes saved as a string) shouldn't crash
    the daemon — fall back to 0 and the next successful run rewrites it."""
    try:
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0


def load(path: Path | str | None = None) -> State:
    p = Path(path if path is not None else default_state_path())
    if not p.exists():
        return State()
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return State()
    if not isinstance(raw, dict):
        return State()
    return State(
        last_heartbeat_at_ms=_safe_int(raw.get("last_heartbeat_at_ms", 0)),
        last_heartbeat_status=str(raw.get("last_heartbeat_status", "")),
        last_backup_at_ms=_safe_int(raw.get("last_backup_at_ms", 0)),
        last_cloud_bytes=_safe_int(raw.get("last_cloud_bytes", 0)),
        last_snapshot_count=_safe_int(raw.get("last_snapshot_count", 0)),
    )


def save(state: State, path: Path | str | None = None) -> None:
    p = Path(path if path is not None else default_state_path())
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".json.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, json.dumps(asdict(state)).encode("utf-8"))
    finally:
        os.close(fd)
    os.replace(tmp, p)
