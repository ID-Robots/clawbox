"""One backup run: mint creds → init/backup → stats → heartbeat.

Section 8 of clawkeep-plan.md drives this. The daemon module wires it up
to the systemd timer and exits with the appropriate code so systemd can
schedule the next run.
"""

from __future__ import annotations

import logging
import time

from . import api, restic, state
from .api import ApiError
from .config import Config

log = logging.getLogger(__name__)

# Exit codes — used by daemon.py and surfaceable to systemd.
EXIT_OK = 0
EXIT_BACKUP_FAILED = 1
EXIT_QUOTA_FULL = 2
EXIT_AUTH_REVOKED = 3
EXIT_TIER = 4
EXIT_SERVER = 5
EXIT_NETWORK = 6
EXIT_RESTIC = 7
EXIT_UNKNOWN = 99


def _heartbeat_safe(server: str, token: str, **kwargs: object) -> bool:
    """Section 9: don't retry heartbeat aggressively. Log + move on.

    Returns True on success, False if the call failed. Callers that persist
    last_heartbeat_* fields use the result to avoid stamping "ok" onto state
    when the portal never actually saw the heartbeat.
    """
    try:
        api.heartbeat(server, token, **kwargs)  # type: ignore[arg-type]
        return True
    except ApiError as e:
        log.warning("heartbeat failed (status=%s, kind=%s): %s", kwargs.get("status"), e.kind, e)
        return False


def _retry_credentials(server: str, token: str, attempts: int = 3) -> api.Credentials:
    """Mint creds with exponential backoff for transient (network/server) errors.

    Auth/quota/tier errors are NOT retried — they need user action.
    Backoff: 1s, 5s, 30s (matches section 10).
    """
    delays = [1.0, 5.0, 30.0]
    last: ApiError | None = None
    for i in range(attempts):
        try:
            return api.mint_credentials(server, token)
        except ApiError as e:
            last = e
            if e.kind in ("auth", "quota_full", "tier"):
                raise
            if i + 1 < attempts:
                time.sleep(delays[min(i, len(delays) - 1)])
            log.warning("credentials attempt %d/%d failed (%s): %s", i + 1, attempts, e.kind, e)
    assert last is not None
    raise last


def _stamp_heartbeat(
    st: state.State, ok: bool, status: str, *, now_override: int | None = None,
) -> None:
    """Centralise the last_heartbeat_* bookkeeping so every error branch
    persists the same shape — a missing save here would let the idle timer
    re-fire on top of an in-flight backup."""
    st.last_heartbeat_at_ms = now_override if now_override is not None else api.now_ms()
    st.last_heartbeat_status = status if ok else "error"


def run_once(cfg: Config, token: str, repo_password: str) -> int:
    """One full backup cycle. Returns a process exit code."""
    st = state.load()

    # 1. Mint creds (with retry on network/server failures).
    try:
        creds = _retry_credentials(cfg.server, token)
    except ApiError as e:
        if e.kind == "auth":
            log.error("auth failed: %s — token may be revoked, run 'clawkeep pair' again", e)
            # Don't heartbeat — we have no valid auth to send it with.
            # Also don't stamp local state (no portal exchange happened).
            return EXIT_AUTH_REVOKED
        msg_prefix = {"quota_full": "quota full", "tier": "tier", "server": "server"}.get(e.kind)
        prefixed = f"{msg_prefix}: {e}" if msg_prefix else str(e)
        log.error("%s: %s", e.kind, e)
        ok = _heartbeat_safe(cfg.server, token, status="error", error=prefixed)
        _stamp_heartbeat(st, ok, "error")
        state.save(st)
        if e.kind == "quota_full":
            return EXIT_QUOTA_FULL
        if e.kind == "tier":
            return EXIT_TIER
        if e.kind == "server":
            return EXIT_SERVER
        return EXIT_NETWORK if e.kind == "network" else EXIT_UNKNOWN

    # 2. Tell server we're starting.
    running_ok = _heartbeat_safe(cfg.server, token, status="running")
    _stamp_heartbeat(st, running_ok, "running")

    repo = restic.repo_url(creds)
    env = restic.restic_env(creds, repo_password)

    # 3. Init repo (idempotent).
    try:
        restic.init(cfg.restic.binary, repo, env)
    except restic.ResticError as e:
        log.error("restic init failed: %s", e)
        ok = _heartbeat_safe(cfg.server, token, status="error", error=f"restic init: {e}")
        _stamp_heartbeat(st, ok, "error")
        state.save(st)
        return EXIT_RESTIC

    # 4. Backup. _run already converts plumbing failures (TimeoutExpired,
    # ENOENT) into a failed BackupResult, so we don't need to catch
    # ResticError here — but keep the OSError fallback in case the
    # restic module ever bubbles one up directly.
    try:
        result = restic.backup(
            cfg.restic.binary,
            repo,
            env,
            paths=cfg.paths,
            excludes=cfg.exclude,
            compression=cfg.restic.compression,
            read_concurrency=cfg.restic.read_concurrency,
        )
    except (restic.ResticError, OSError) as e:
        log.error("restic backup raised: %s", e)
        ok = _heartbeat_safe(cfg.server, token, status="error", error=f"restic backup: {e}")
        _stamp_heartbeat(st, ok, "error")
        state.save(st)
        return EXIT_RESTIC

    if not result.ok:
        log.error("restic backup failed: %s", result.last_line)
        ok = _heartbeat_safe(cfg.server, token, status="error", error=result.last_line)
        _stamp_heartbeat(st, ok, "error")
        state.save(st)
        return EXIT_BACKUP_FAILED

    # 5. Stats. If unavailable, leave the stats fields *unsent* — sending
    #    zero would clobber the portal's last-known cloudBytes/snapshotCount.
    stats: restic.Stats | None
    try:
        stats = restic.stats(cfg.restic.binary, repo, env)
    except restic.ResticError as e:
        log.warning("restic stats failed (continuing): %s", e)
        stats = None

    now = api.now_ms()

    # 6. Heartbeat success.
    heartbeat_ok = _heartbeat_safe(
        cfg.server,
        token,
        status="ok",
        cloud_bytes=stats.total_size if stats is not None else None,
        snapshot_count=stats.snapshot_count if stats is not None else None,
        last_backup_at=now,
    )

    # 7. Persist state. The backup itself succeeded locally regardless of
    #    the heartbeat outcome, so we always record last_backup_at_ms.
    #    cloudBytes/snapshotCount only update when stats are real — a
    #    failed restic.stats shouldn't show "0 B" in the desktop UI.
    _stamp_heartbeat(st, heartbeat_ok, "ok", now_override=now)
    st.last_backup_at_ms = now
    if stats is not None:
        st.last_cloud_bytes = stats.total_size
        st.last_snapshot_count = stats.snapshot_count
    state.save(st)

    log.info(
        "backup ok: %d bytes added, %d files new, %d files changed; cloud=%s/%d, snapshots=%s",
        result.bytes_added,
        result.files_new,
        result.files_changed,
        stats.total_size if stats is not None else "?",
        creds.quotaBytes,
        stats.snapshot_count if stats is not None else "?",
    )
    return EXIT_OK


def run_idle(cfg: Config, token: str) -> int:
    """Send an `idle` heartbeat if the last heartbeat is older than
    cfg.heartbeat.idle_interval_hours. Used by clawkeep-idle.timer."""
    st = state.load()
    interval_ms = cfg.heartbeat.idle_interval_hours * 3600 * 1000
    now = api.now_ms()
    if st.last_heartbeat_at_ms and (now - st.last_heartbeat_at_ms) < interval_ms:
        log.info("recent heartbeat (%d ms ago), skipping idle", now - st.last_heartbeat_at_ms)
        return EXIT_OK

    try:
        api.heartbeat(cfg.server, token, status="idle")
    except ApiError as e:
        log.warning("idle heartbeat failed (%s): %s", e.kind, e)
        return EXIT_NETWORK if e.kind == "network" else EXIT_UNKNOWN

    st.last_heartbeat_at_ms = now
    st.last_heartbeat_status = "idle"
    state.save(st)
    return EXIT_OK
