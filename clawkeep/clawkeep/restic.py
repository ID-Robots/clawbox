"""Subprocess wrapper around the `restic` binary.

Keeps every restic invocation in one place so the retry/timeout/env-shape
rules from sections 8 and 10 of clawkeep-plan.md don't drift between
init/backup/stats sites.
"""

from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass

from .api import Credentials


@dataclass(frozen=True)
class BackupResult:
    ok: bool
    last_line: str  # first 500 chars of stderr/stdout tail — fed into heartbeat error
    files_new: int
    files_changed: int
    bytes_added: int


@dataclass(frozen=True)
class Stats:
    total_size: int
    snapshot_count: int


class ResticError(Exception):
    pass


def restic_env(creds: Credentials, repo_password: str) -> dict[str, str]:
    """Environment vars restic needs for R2 + STS-style creds.

    AWS_SESSION_TOKEN is the easy-to-miss one — Cloudflare's temp creds are
    STS-style and AccessDenied at upload time is the symptom of forgetting it
    (section 8 of clawkeep-plan.md flags this as the #1 footgun).
    """
    env = os.environ.copy()
    env["AWS_ACCESS_KEY_ID"] = creds.accessKeyId
    env["AWS_SECRET_ACCESS_KEY"] = creds.secretAccessKey
    env["AWS_SESSION_TOKEN"] = creds.sessionToken
    env["RESTIC_PASSWORD"] = repo_password
    return env


def repo_url(creds: Credentials) -> str:
    return f"s3:{creds.endpoint}/{creds.bucket}/{creds.prefix}"


def _run(
    binary: str,
    args: list[str],
    env: dict[str, str],
    *,
    timeout: float | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [binary, *args],
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


def init(binary: str, repo: str, env: dict[str, str]) -> None:
    """Idempotent: restic returns a specific error if the repo already exists.
    Treat that as success."""
    cp = _run(binary, ["-r", repo, "init"], env, timeout=120)
    if cp.returncode == 0:
        return
    combined = (cp.stderr or "") + (cp.stdout or "")
    if "already exists" in combined or "already initialized" in combined:
        return
    raise ResticError(f"restic init failed (rc={cp.returncode}): {combined.strip()[:500]}")


def backup(
    binary: str,
    repo: str,
    env: dict[str, str],
    *,
    paths: list[str],
    excludes: list[str] | None = None,
    compression: str = "auto",
    read_concurrency: int = 2,
    timeout: float = 4 * 60 * 60,  # 4h hard cap (matches systemd TimeoutStartSec)
) -> BackupResult:
    args: list[str] = [
        "-r", repo, "backup",
        "--json",
        "--compression", compression,
        "--read-concurrency", str(read_concurrency),
    ]
    for ex in excludes or []:
        args.extend(["--exclude", ex])
    args.extend(paths)

    cp = _run(binary, args, env, timeout=timeout)
    last = ((cp.stderr or "") + (cp.stdout or "")).strip().splitlines()
    last_line = last[-1] if last else ""
    if cp.returncode != 0:
        return BackupResult(False, last_line[:500], 0, 0, 0)

    # Parse the final JSON summary line emitted by `restic backup --json`.
    files_new = files_changed = bytes_added = 0
    for line in reversed(cp.stdout.splitlines() if cp.stdout else []):
        try:
            obj = json.loads(line)
        except (ValueError, json.JSONDecodeError):
            continue
        if obj.get("message_type") == "summary":
            files_new = int(obj.get("files_new", 0))
            files_changed = int(obj.get("files_changed", 0))
            bytes_added = int(obj.get("data_added", 0))
            break

    return BackupResult(True, last_line[:500], files_new, files_changed, bytes_added)


def stats(binary: str, repo: str, env: dict[str, str]) -> Stats:
    """`restic stats --json --mode raw-data` for total bytes; snapshot count
    via `restic snapshots --json`."""
    cp = _run(binary, ["-r", repo, "stats", "--json", "--mode", "raw-data"], env, timeout=300)
    if cp.returncode != 0:
        raise ResticError(f"restic stats failed: {(cp.stderr or '').strip()[:500]}")
    try:
        s = json.loads(cp.stdout)
    except (ValueError, json.JSONDecodeError) as e:
        raise ResticError(f"restic stats: malformed JSON: {e}") from e
    total_size = int(s.get("total_size", 0))

    cp2 = _run(binary, ["-r", repo, "snapshots", "--json"], env, timeout=120)
    snapshot_count = 0
    if cp2.returncode == 0:
        try:
            snaps = json.loads(cp2.stdout)
            if isinstance(snaps, list):
                snapshot_count = len(snaps)
        except (ValueError, json.JSONDecodeError):
            pass

    return Stats(total_size=total_size, snapshot_count=snapshot_count)
