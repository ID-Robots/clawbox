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
            return EXIT_AUTH_REVOKED
        if e.kind == "quota_full":
            log.error("quota full: %s", e)
            _heartbeat_safe(cfg.server, token, status="error", error=f"quota full: {e}")
            return EXIT_QUOTA_FULL
        if e.kind == "tier":
            log.error("tier error: %s", e)
            _heartbeat_safe(cfg.server, token, status="error", error=f"tier: {e}")
            return EXIT_TIER
        if e.kind == "server":
            log.error("server error: %s", e)
            _heartbeat_safe(cfg.server, token, status="error", error=f"server: {e}")
            return EXIT_SERVER
        # network or other
        log.error("credentials failed (%s): %s", e.kind, e)
        _heartbeat_safe(cfg.server, token, status="error", error=str(e))
        return EXIT_NETWORK if e.kind == "network" else EXIT_UNKNOWN

    # 2. Tell server we're starting.
    _heartbeat_safe(cfg.server, token, status="running")

    repo = restic.repo_url(creds)
    env = restic.restic_env(creds, repo_password)

    # 3. Init repo (idempotent).
    try:
        restic.init(cfg.restic.binary, repo, env)
    except restic.ResticError as e:
        log.error("restic init failed: %s", e)
        _heartbeat_safe(cfg.server, token, status="error", error=f"restic init: {e}")
        return EXIT_RESTIC

    # 4. Backup.
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
        _heartbeat_safe(cfg.server, token, status="error", error=f"restic backup: {e}")
        return EXIT_RESTIC
    except Exception as e:  # subprocess.TimeoutExpired and friends
        log.error("restic backup unexpected error: %s", e)
        _heartbeat_safe(cfg.server, token, status="error", error=str(e)[:500])
        return EXIT_RESTIC

    if not result.ok:
        log.error("restic backup failed: %s", result.last_line)
        _heartbeat_safe(cfg.server, token, status="error", error=result.last_line)
        return EXIT_BACKUP_FAILED

    # 5. Stats.
    try:
        stats = restic.stats(cfg.restic.binary, repo, env)
    except restic.ResticError as e:
        # Don't fail the run — we did back up. But heartbeat without stats.
        log.warning("restic stats failed (continuing): %s", e)
        stats = restic.Stats(total_size=0, snapshot_count=0)

    now = api.now_ms()

    # 6. Heartbeat success.
    heartbeat_ok = _heartbeat_safe(
        cfg.server,
        token,
        status="ok",
        cloud_bytes=stats.total_size,
        snapshot_count=stats.snapshot_count,
        last_backup_at=now,
    )

    # 7. Persist state. The backup itself succeeded locally regardless of
    #    the heartbeat outcome, so we always record last_backup_at_ms / cloud
    #    bytes / snapshot count. But last_heartbeat_status reflects whether
    #    the portal actually heard about it; an "ok" stamp here would lie to
    #    the idle timer (and the UI) on a heartbeat-network failure.
    st.last_heartbeat_at_ms = now
    st.last_heartbeat_status = "ok" if heartbeat_ok else "error"
    st.last_backup_at_ms = now
    st.last_cloud_bytes = stats.total_size
    st.last_snapshot_count = stats.snapshot_count
    state.save(st)

    log.info(
        "backup ok: %d bytes added, %d files new, %d files changed; cloud=%d/%d, snapshots=%d",
        result.bytes_added,
        result.files_new,
        result.files_changed,
        stats.total_size,
        creds.quotaBytes,
        stats.snapshot_count,
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
