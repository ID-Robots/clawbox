"""Tiny state file at $CLAWKEEP_DATA_DIR/state.json.

Used so the idle-heartbeat timer knows whether it should send an idle
heartbeat (no other heartbeat in the last N hours) without re-reading
the portal. Also surfaced to the clawbox UI as the source of truth
for "Last backup: …" / "Cloud bytes: …" displays.
"""

from __future__ import annotations

import json
import os
import secrets
from dataclasses import asdict, dataclass, field
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
    # Sub-phase of an in-flight backup so the UI can show "Building archive…"
    # vs "Uploading…" when reopened mid-run. Empty when nothing is running.
    last_step: str = ""           # "starting" | "archiving" | "uploading" | "checking-stats" | ""
    last_step_at_ms: int = 0
    last_backup_at_ms: int = 0
    last_cloud_bytes: int = 0
    last_snapshot_count: int = 0
    # Live upload progress (only meaningful while last_step == "uploading"):
    # the UI uses these to render "<done>/<total> · <MB/s>" instead of a bare
    # indeterminate spinner. Cleared on terminal status (ok / error) by
    # _stamp_heartbeat() so the next reopen doesn't show stale numbers.
    upload_bytes_total: int = 0
    upload_bytes_done: int = 0
    upload_started_at_ms: int = 0
    # What the last archive build left out — the box's own backup archives,
    # `own_backups` — and the snapshot-sized archive files it still carried,
    # as [{"path": "~/…", "bytes": n}], largest first. Written once the archive
    # is built and BEFORE the upload, so the app and `backup_status` can say it
    # while the upload runs; kept until the next build replaces it.
    last_left_out_count: int = 0
    last_left_out_bytes: int = 0
    last_large_archives: list[dict[str, object]] = field(default_factory=list)
    last_large_archive_count: int = 0
    last_large_archive_bytes: int = 0
    # The symbolic links the last archive build SKIPPED — the archiver refuses
    # them (a target outside the backup, or none), so the snapshot does not
    # carry them; `backup_guard` — as [{"path": "~/…", "target": "<link text>"}]
    # sorted by path, the first `backup_guard.LISTED_SKIPPED_LINKS` of
    # `last_skipped_link_count`. Written with the fields above.
    last_skipped_links: list[dict[str, str]] = field(default_factory=list)
    last_skipped_link_count: int = 0
    # When the portal first refused to mint credentials because the account is
    # over quota (402 quota_full), in the current run of refusals; 0 once it
    # mints them again. The TS bridge reads it to tell "auto-backup was
    # switched off while the account was full" — a pause it re-arms by itself
    # once credentials work again — from an owner switching it off for good.
    quota_full_since_ms: int = 0
    # Why the last backup run REFUSED to upload, and the sizes it refused on —
    # the pre-upload admission check in `runner`. "" when the last run was not
    # refused there: every run clears the record as it starts, so a refusal
    # never outlives the run after it. `quota_full` carries all three sizes;
    # `usage_unverified` (the prefix could not be listed) carries what the
    # archive needed and the quota, and 0 for the usage nobody could count.
    # The app reads these to say "needs 1.2 GB, 300 MB free" in the owner's
    # language — the sentence the daemon logs is English and is never shown.
    # Deliberately NOT `quota_full_since_ms`: that one says the PORTAL refuses
    # credentials, and the bridge ends a quota pause the moment credentials
    # mint again — which they do the whole time a refusal like this stands.
    last_refusal: str = ""  # "" | "quota_full" | "usage_unverified"
    last_refusal_at_ms: int = 0
    last_refusal_needed_bytes: int = 0
    last_refusal_used_bytes: int = 0
    last_refusal_quota_bytes: int = 0
    # The failure incident the portal was last told about — from the first
    # failed run to the next one that succeeds — so that one incident costs the
    # owner a "backup needs attention" email at most at the backoff points of
    # `runner.ALERT_BACKOFF_MS`, not one a night. 0 when the last run was fine.
    alert_incident_since_ms: int = 0
    # How many "error" heartbeats of this incident the portal has received …
    alert_reports: int = 0
    # … and when the next one may go: a failure before then is logged and
    # recorded here, and the portal keeps showing the one it was told.
    alert_next_report_at_ms: int = 0


#: The values `last_refusal` may hold; anything else in the file reads as "".
REFUSAL_QUOTA_FULL = "quota_full"
REFUSAL_USAGE_UNVERIFIED = "usage_unverified"
_REFUSALS = frozenset({REFUSAL_QUOTA_FULL, REFUSAL_USAGE_UNVERIFIED})


def _safe_int(value: object) -> int:
    """Coerce JSON-decoded values that should be ints. A malformed
    state.json (e.g. last_cloud_bytes saved as a string) shouldn't crash
    the daemon — fall back to 0 and the next successful run rewrites it."""
    try:
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0


def _refusal(value: object) -> str:
    """`last_refusal` as written, or "" for anything that is not one of the
    kinds the runner writes — a refusal the app cannot name is not shown."""
    return value if isinstance(value, str) and value in _REFUSALS else ""


def _large_archives(value: object) -> list[dict[str, object]]:
    """`last_large_archives` as written, or the part of it that still reads
    as one; a hand-edited or garbled list costs the list, not the daemon."""
    if not isinstance(value, list):
        return []
    return [
        {"path": item["path"], "bytes": _safe_int(item.get("bytes", 0))}
        for item in value
        if isinstance(item, dict) and isinstance(item.get("path"), str)
    ]


def skipped_links(value: object) -> list[dict[str, str]]:
    """A list of skipped links as written — `last_skipped_links`, or a
    snapshot's record — or the part of it that still reads as one."""
    if not isinstance(value, list):
        return []
    return [
        {"path": item["path"], "target": item["target"]}
        for item in value
        if isinstance(item, dict)
        and isinstance(item.get("path"), str)
        and isinstance(item.get("target"), str)
    ]


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
        last_heartbeat_status=(
            raw["last_heartbeat_status"]
            if isinstance(raw.get("last_heartbeat_status"), str)
            else ""
        ),
        last_step=raw["last_step"] if isinstance(raw.get("last_step"), str) else "",
        last_step_at_ms=_safe_int(raw.get("last_step_at_ms", 0)),
        last_backup_at_ms=_safe_int(raw.get("last_backup_at_ms", 0)),
        last_cloud_bytes=_safe_int(raw.get("last_cloud_bytes", 0)),
        last_snapshot_count=_safe_int(raw.get("last_snapshot_count", 0)),
        upload_bytes_total=_safe_int(raw.get("upload_bytes_total", 0)),
        upload_bytes_done=_safe_int(raw.get("upload_bytes_done", 0)),
        upload_started_at_ms=_safe_int(raw.get("upload_started_at_ms", 0)),
        last_left_out_count=_safe_int(raw.get("last_left_out_count", 0)),
        last_left_out_bytes=_safe_int(raw.get("last_left_out_bytes", 0)),
        last_large_archives=_large_archives(raw.get("last_large_archives")),
        last_large_archive_count=_safe_int(raw.get("last_large_archive_count", 0)),
        last_large_archive_bytes=_safe_int(raw.get("last_large_archive_bytes", 0)),
        last_skipped_links=skipped_links(raw.get("last_skipped_links")),
        last_skipped_link_count=_safe_int(raw.get("last_skipped_link_count", 0)),
        quota_full_since_ms=_safe_int(raw.get("quota_full_since_ms", 0)),
        last_refusal=_refusal(raw.get("last_refusal")),
        last_refusal_at_ms=_safe_int(raw.get("last_refusal_at_ms", 0)),
        last_refusal_needed_bytes=_safe_int(raw.get("last_refusal_needed_bytes", 0)),
        last_refusal_used_bytes=_safe_int(raw.get("last_refusal_used_bytes", 0)),
        last_refusal_quota_bytes=_safe_int(raw.get("last_refusal_quota_bytes", 0)),
        alert_incident_since_ms=_safe_int(raw.get("alert_incident_since_ms", 0)),
        alert_reports=_safe_int(raw.get("alert_reports", 0)),
        alert_next_report_at_ms=_safe_int(raw.get("alert_next_report_at_ms", 0)),
    )


def save(state: State, path: Path | str | None = None) -> None:
    p = Path(path if path is not None else default_state_path())
    p.parent.mkdir(parents=True, exist_ok=True)
    # Per-process unique tmp suffix so concurrent writers (e.g. an idle-
    # heartbeat tick + a backup run finishing at the same moment) don't
    # truncate each other's tmp file before the rename. The fixed
    # ".json.tmp" form was a race waiting to happen.
    suffix = f".{os.getpid()}.{secrets.token_hex(4)}.json.tmp"
    tmp = p.with_name(p.name + suffix)
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, json.dumps(asdict(state)).encode("utf-8"))
    finally:
        os.close(fd)
    try:
        os.replace(tmp, p)
    except OSError:
        # Best-effort cleanup of the tmp; re-raise so the caller knows.
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
