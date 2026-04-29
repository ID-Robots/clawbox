"""Subprocess wrapper around the `openclaw backup` CLI.

clawkeep produces one timestamped tarball per run via
`openclaw backup create`, then ships it via :mod:`clawkeep.s3`.

CLI shape (https://docs.openclaw.ai/cli/backup):
    openclaw backup create --json --output <dir> [--no-include-workspace] [--only-config] [--verify]
    openclaw backup verify --json <archive>
"""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Archive:
    path: Path        # /<staging>/<timestamp>-openclaw-backup.tar.gz
    archive_root: str # tarball top-level dir reported by openclaw
    created_at: str   # ISO8601 from openclaw
    size_bytes: int   # local file size at upload time
    asset_count: int  # number of state assets (state, credentials, …)


class OpenclawError(Exception):
    pass


def _run(
    binary: str,
    args: list[str],
    *,
    timeout: float | None = None,
) -> subprocess.CompletedProcess[str]:
    """Run openclaw and convert plumbing failures into OpenclawError.

    A TimeoutExpired or missing binary must surface as a typed error, not
    crash the daemon.
    """
    try:
        return subprocess.run(
            [binary, *args],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as e:
        raise OpenclawError(f"openclaw timed out after {timeout}s: {e}") from e
    except OSError as e:
        raise OpenclawError(f"could not exec {binary}: {e}") from e


def _parse_json(stdout: str, what: str) -> dict:
    try:
        obj = json.loads(stdout)
    except (ValueError, json.JSONDecodeError) as e:
        raise OpenclawError(f"{what}: malformed JSON: {e}") from e
    if not isinstance(obj, dict):
        raise OpenclawError(f"{what}: expected JSON object, got {type(obj).__name__}")
    return obj


def create_archive(
    binary: str,
    *,
    output_dir: Path,
    include_workspace: bool = True,
    only_config: bool = False,
    verify: bool = True,
    timeout: float = 30 * 60,  # tarballing ~1GB on Jetson takes minutes; 30m hard cap
) -> Archive:
    """Run `openclaw backup create --json --output <dir>`. Returns archive metadata.

    `output_dir` must be a writable directory; openclaw drops a single
    timestamped `.tar.gz` inside it. We do *not* delete pre-existing archives
    in the directory — the runner cleans up the file it just created and
    leaves any others alone.
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    args = ["backup", "create", "--json", "--output", str(output_dir)]
    if not include_workspace:
        args.append("--no-include-workspace")
    if only_config:
        args.append("--only-config")
    if verify:
        args.append("--verify")

    cp = _run(binary, args, timeout=timeout)
    if cp.returncode != 0:
        tail = ((cp.stderr or "") + (cp.stdout or "")).strip()[-500:]
        raise OpenclawError(f"openclaw backup create failed (rc={cp.returncode}): {tail}")

    meta = _parse_json(cp.stdout, "openclaw backup create")
    archive_path_str = meta.get("archivePath")
    if not isinstance(archive_path_str, str) or not archive_path_str:
        raise OpenclawError(f"openclaw response missing archivePath: {cp.stdout[:500]}")
    archive_path = Path(archive_path_str)
    if not archive_path.is_file():
        raise OpenclawError(f"openclaw reported archive at {archive_path} but no file exists")

    try:
        size = archive_path.stat().st_size
    except OSError as e:
        raise OpenclawError(f"could not stat archive {archive_path}: {e}") from e

    assets = meta.get("assets", []) or []
    return Archive(
        path=archive_path,
        archive_root=str(meta.get("archiveRoot", "")),
        created_at=str(meta.get("createdAt", "")),
        size_bytes=size,
        asset_count=len(assets) if isinstance(assets, list) else 0,
    )


def verify_archive(binary: str, archive: Path, *, timeout: float = 5 * 60) -> None:
    """Run `openclaw backup verify --json <archive>`. Raises OpenclawError on failure.

    Useful as a defence-in-depth check before upload when the caller did
    *not* pass `--verify` to `create`. The runner already passes `--verify`
    by default, so this is mainly available for tests and ad-hoc tooling.
    """
    cp = _run(binary, ["backup", "verify", "--json", str(archive)], timeout=timeout)
    if cp.returncode != 0:
        tail = ((cp.stderr or "") + (cp.stdout or "")).strip()[-500:]
        raise OpenclawError(f"openclaw backup verify failed (rc={cp.returncode}): {tail}")
    meta = _parse_json(cp.stdout, "openclaw backup verify")
    if not meta.get("ok"):
        raise OpenclawError(f"openclaw backup verify reported not ok: {cp.stdout[:500]}")
