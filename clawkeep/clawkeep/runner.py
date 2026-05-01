"""One backup run: mint creds → openclaw backup → s3 upload → stats → heartbeat.

Section 8 of clawkeep-plan.md drives this. The daemon module wires it up
to the systemd timer and exits with the appropriate code so systemd can
schedule the next run.

"""

from __future__ import annotations

import logging
import tempfile
import time
from pathlib import Path

from . import api, openclaw, s3, state
from .api import ApiError
from .config import Config

log = logging.getLogger(__name__)

# Exit codes — surfaceable to systemd via daemon.py.
EXIT_OK = 0
EXIT_BACKUP_FAILED = 1
EXIT_QUOTA_FULL = 2
EXIT_AUTH_REVOKED = 3
EXIT_TIER = 4
EXIT_SERVER = 5
EXIT_NETWORK = 6
EXIT_OPENCLAW = 7   # `openclaw backup create` failed
EXIT_UPLOAD = 8     # S3 PUT failed
EXIT_UNKNOWN = 99

# Backup phase identifiers — kept in lockstep with `STEP_LABELS` in
# src/components/ClawKeepApp.tsx. The strings are persisted to state.json
# and read by the UI, so renaming requires a coordinated TS-side change.
STEP_STARTING = "starting"
STEP_ARCHIVING = "archiving"
STEP_UPLOADING = "uploading"
STEP_CHECKING_STATS = "checking-stats"


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
    final_status = status if ok else "error"
    st.last_heartbeat_status = final_status
    # Clear the in-flight step on any terminal status so a reopened window
    # doesn't keep showing "Uploading…" after the run failed/finished.
    if final_status != "running":
        st.last_step = ""
        st.last_step_at_ms = 0
        # Also drop the live upload-progress fields — they're only meaningful
        # while last_step == "uploading"; leaving them set would render
        # "480/480 MB · 0 MB/s" in the panel after a successful finish.
        st.upload_bytes_total = 0
        st.upload_bytes_done = 0
        st.upload_started_at_ms = 0


def _stamp_step(st: state.State, step: str) -> None:
    """Persist the current backup phase so the UI can show "Uploading…"
    vs "Building archive…" — and so reopening the window mid-run shows
    the right step instead of restarting at zero. Empty string clears it."""
    st.last_step = step
    st.last_step_at_ms = api.now_ms() if step else 0
    state.save(st)


def _resolve_staging(cfg: Config) -> tuple[Path, bool]:
    """Pick the directory the openclaw archive lands in.

    Returns (path, ephemeral). When ephemeral is True the runner removes
    the directory after upload; when False the user-configured directory
    is preserved (only the archive itself is deleted).
    """
    if cfg.openclaw.output_dir:
        return Path(cfg.openclaw.output_dir), False
    return Path(tempfile.mkdtemp(prefix="clawkeep-")), True


def run_once(cfg: Config, token: str) -> int:
    """One full backup cycle. Returns a process exit code."""
    st = state.load()

    try:
        creds = _retry_credentials(cfg.server, token)
    except ApiError as e:
        if e.kind == "auth":
            log.error("auth failed: %s — token may be revoked, run 'clawkeep pair' again", e)
            # No portal exchange happened — don't heartbeat or stamp state.
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

    running_ok = _heartbeat_safe(cfg.server, token, status="running")
    _stamp_heartbeat(st, running_ok, "running")
    _stamp_step(st, STEP_STARTING)

    staging, ephemeral = _resolve_staging(cfg)
    archive: openclaw.Archive | None = None
    try:
        _stamp_step(st, STEP_ARCHIVING)
        try:
            archive = openclaw.create_archive(
                cfg.openclaw.binary,
                output_dir=staging,
                include_workspace=cfg.openclaw.include_workspace,
                only_config=cfg.openclaw.only_config,
                verify=cfg.openclaw.verify,
            )
        except openclaw.OpenclawError as e:
            log.error("openclaw backup create failed: %s", e)
            ok = _heartbeat_safe(
                cfg.server, token, status="error", error=f"openclaw: {e}"[:500],
            )
            _stamp_heartbeat(st, ok, "error")
            state.save(st)
            return EXIT_OPENCLAW

        _stamp_step(st, STEP_UPLOADING)
        # Seed live upload-progress fields so the UI immediately switches from
        # the indeterminate "Uploading…" bar to a determinate one anchored at
        # 0/total. The progress callback below increments upload_bytes_done
        # and re-saves state, throttled so we don't write state.json hundreds
        # of times per second on multipart parts.
        st.upload_bytes_total = int(archive.size_bytes)
        st.upload_bytes_done = 0
        st.upload_started_at_ms = api.now_ms()
        state.save(st)

        # boto3 calls Callback per chunk with the *delta* bytes since the last
        # call — we accumulate and persist at most every 250 ms. The final
        # write happens unconditionally after upload_file returns so the UI
        # always sees done == total at the moment we move to checking-stats.
        last_save_ms = 0
        SAVE_THROTTLE_MS = 250

        def _on_upload_progress(delta: int) -> None:
            nonlocal last_save_ms
            st.upload_bytes_done += int(delta)
            now = api.now_ms()
            if now - last_save_ms >= SAVE_THROTTLE_MS:
                last_save_ms = now
                try:
                    state.save(st)
                except OSError as save_err:
                    # Disk hiccup mid-upload shouldn't kill the upload itself.
                    log.warning("upload progress save failed: %s", save_err)

        try:
            s3.upload(
                creds,
                archive_path=archive.path,
                object_name=archive.path.name,
                progress_cb=_on_upload_progress,
            )
        except s3.S3Error as e:
            log.error("s3 upload failed: %s", e)
            # Clear the live progress fields so a reopened window doesn't
            # render a half-finished MB/s readout against a failed run.
            st.upload_bytes_total = 0
            st.upload_bytes_done = 0
            st.upload_started_at_ms = 0
            ok = _heartbeat_safe(cfg.server, token, status="error", error=f"upload: {e}"[:500])
            _stamp_heartbeat(st, ok, "error")
            state.save(st)
            return EXIT_UPLOAD

        # Upload finished — pin the readout at 100% before moving on.
        st.upload_bytes_done = st.upload_bytes_total
        state.save(st)

        # Best-effort stats — leave the per-run fields *unsent* on failure
        # so a transient ListBucket doesn't clobber the portal's last-known
        # cloudBytes/snapshotCount.
        _stamp_step(st, STEP_CHECKING_STATS)
        cloud: s3.CloudStats | None
        try:
            cloud = s3.stats(creds)
        except s3.S3Error as e:
            log.warning("s3 stats failed (continuing): %s", e)
            cloud = None

        now = api.now_ms()

        heartbeat_ok = _heartbeat_safe(
            cfg.server,
            token,
            status="ok",
            cloud_bytes=cloud.cloud_bytes if cloud is not None else None,
            snapshot_count=cloud.snapshot_count if cloud is not None else None,
            last_backup_at=now,
        )

        # Backup succeeded regardless of heartbeat outcome → always record
        # last_backup_at_ms. cloudBytes/snapshotCount only update when stats
        # are real, so a failed list-objects can't show "0 B" in the UI.
        _stamp_heartbeat(st, heartbeat_ok, "ok", now_override=now)
        st.last_backup_at_ms = now
        if cloud is not None:
            st.last_cloud_bytes = cloud.cloud_bytes
            st.last_snapshot_count = cloud.snapshot_count
        state.save(st)

        log.info(
            "backup ok: archive=%s (%d bytes); cloud=%s/%d, snapshots=%s",
            archive.path.name,
            archive.size_bytes,
            cloud.cloud_bytes if cloud is not None else "?",
            creds.quotaBytes,
            cloud.snapshot_count if cloud is not None else "?",
        )
        return EXIT_OK

    finally:
        # Always clean up the local archive — devices have ~32GB of disk
        # and we don't want every run to leave a 300MB tarball behind.
        # If staging is ephemeral (default), nuke the whole tmpdir.
        if archive is not None:
            try:
                archive.path.unlink(missing_ok=True)
            except OSError as e:
                log.warning("failed to remove staging archive %s: %s", archive.path, e)
        if ephemeral:
            try:
                staging.rmdir()
            except OSError:
                # Non-empty (e.g. verify left a temp dir, or the user pointed
                # output_dir at a shared location even though we treated it as
                # ephemeral) — best-effort, leave it for the OS to reap.
                pass


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
