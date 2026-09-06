"""Subprocess wrapper around the `openclaw backup` CLI.

clawkeep produces one timestamped tarball per run via
`openclaw backup create`, then ships it via :mod:`clawkeep.s3`.

CLI shape (https://docs.openclaw.ai/cli/backup):
    openclaw backup create --json --output <dir> [--no-include-workspace] [--only-config] [--verify]
    openclaw backup create --dry-run --json
    openclaw backup verify --json <archive>
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path
from . import limits

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class Archive:
    path: Path        # /<staging>/<timestamp>-openclaw-backup.tar.gz
    archive_root: str # tarball top-level dir reported by openclaw
    created_at: str   # ISO8601 from openclaw
    size_bytes: int   # local file size at upload time
    asset_count: int  # number of state assets (state, credentials, …)


class OpenclawError(Exception):
    pass


@dataclass(frozen=True)
class PlannedRoot:
    """One place `openclaw backup create` would archive from on THIS box.

    `kind` is the CLI's own word for it (`state`, `config`, `credentials`,
    `workspace`, `agent`); `path` is the canonical absolute path the CLI
    resolved. Restore compares a manifest's destinations against these.
    """

    kind: str
    path: str


#: The `skipped[].reason` values whose `sourcePath` is still a place the CLI
#: declares as its own. `covered` is a root inside another root (the workspace
#: under the state dir); `missing` is a root the box does not have right now —
#: which is exactly what a restore is about to put back. `regenerable` is left
#: out: those are caches the CLI refuses to archive, so no manifest of its
#: writing ever names one.
_PLAN_SKIPPED_REASONS_KEPT = frozenset({"covered", "missing"})


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


#: Re-exported so `openclaw.<name>` keeps working for anything that reads it
#: here; the one definition lives in `limits.py`, beside `crypto.py`'s use of
#: the same bound. See that module for why it is this number.
SUBPROCESS_TIMEOUT_S = limits.SUBPROCESS_TIMEOUT_S


def create_archive(
    binary: str,
    *,
    output_dir: Path,
    include_workspace: bool = True,
    only_config: bool = False,
    verify: bool = True,
    timeout: float = SUBPROCESS_TIMEOUT_S,
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


#: The CLI's own sentence for a box with nothing to back up — no state
#: directory at all. Matched by prefix, because the CLI prints it both as the
#: `error.message` of its `--json` answer and as a "[openclaw] Reason:" line.
_NO_LOCAL_STATE = "No local OpenClaw state was found"

#: The two state-directory names the CLI looks for under the home, in the
#: order it prefers them (`NEW_STATE_DIRNAME`, `LEGACY_STATE_DIRNAMES`).
_STATE_DIRNAME = ".openclaw"
_LEGACY_STATE_DIRNAMES = (".clawdbot",)


def _cli_error_message(cp: subprocess.CompletedProcess[str]) -> str:
    """What the CLI said went wrong: `error.message` from the JSON it prints
    on stdout under `--json` even when it fails, else the raw tail."""
    try:
        obj = json.loads(cp.stdout or "")
    except ValueError:
        obj = None
    if isinstance(obj, dict):
        err = obj.get("error")
        if isinstance(err, dict) and isinstance(err.get("message"), str) and err["message"]:
            return err["message"]
    return ((cp.stderr or "") + (cp.stdout or "")).strip()[-500:]


def _home_value(value: str | None) -> str | None:
    """The CLI's `normalizeHomeValue`: a shell placeholder that leaked into
    the environment (`undefined`, `null`) counts as unset."""
    trimmed = (value or "").strip()
    if not trimmed or trimmed in ("undefined", "null"):
        return None
    return trimmed


def state_dir(env: dict[str, str] | None = None) -> str:
    """The state directory the CLI would resolve under `env` — the one root
    a box with NO state cannot be denied.

    A mirror of the CLI's `resolveStateDir`, and deliberately nothing more:
    `OPENCLAW_STATE_DIR` first (`~` expanded); else `OPENCLAW_HOME` read as the
    ACCOUNT home — never as the state dir, the confusion `gateway-pre-start.sh`
    guards against — with `HOME` behind it; then `<home>/.openclaw` when it
    exists, a legacy `<home>/.clawdbot` when only that does, and
    `<home>/.openclaw` when neither does. That last arm is the whole reason
    this exists: the dry-run cannot plan a box whose state directory is gone,
    and gone is what a restore is for.
    """
    e = os.environ if env is None else env
    os_home = _home_value(e.get("HOME")) or _home_value(e.get("USERPROFILE")) or os.path.expanduser("~")
    explicit = _home_value(e.get("OPENCLAW_HOME"))
    if explicit is not None:
        if explicit == "~" or explicit.startswith("~/"):
            explicit = os_home + explicit[1:]
        home = os.path.abspath(explicit)
    else:
        home = os.path.abspath(os_home)

    override = (e.get("OPENCLAW_STATE_DIR") or "").strip()
    if override:
        if override == "~" or override.startswith("~/"):
            override = home + override[1:]
        return os.path.abspath(override)

    next_dir = os.path.join(home, _STATE_DIRNAME)
    if os.path.exists(next_dir):
        return next_dir
    for name in _LEGACY_STATE_DIRNAMES:
        legacy = os.path.join(home, name)
        if os.path.exists(legacy):
            return legacy
    return next_dir


def _collect_plan(meta: dict) -> tuple[PlannedRoot, ...]:
    roots: list[PlannedRoot] = []
    seen: set[tuple[str, str]] = set()

    def keep(kind: object, source: object) -> None:
        if not isinstance(source, str) or not source or not isinstance(kind, str):
            return
        key = (kind, source)
        if key in seen:
            return
        seen.add(key)
        roots.append(PlannedRoot(kind=kind, path=source))

    for entry in meta.get("assets") or []:
        if isinstance(entry, dict):
            keep(entry.get("kind"), entry.get("sourcePath"))
    for entry in meta.get("agentRoots") or []:
        if isinstance(entry, dict):
            keep("agent", entry.get("sourcePath"))
    for entry in meta.get("skipped") or []:
        if isinstance(entry, dict) and entry.get("reason") in _PLAN_SKIPPED_REASONS_KEPT:
            keep(entry.get("kind"), entry.get("sourcePath"))
    return tuple(roots)


def plan_roots(binary: str, *, timeout: float = 5 * 60) -> tuple[PlannedRoot, ...]:
    """Ask the CLI where a FULL backup of this box would archive from.

    `openclaw backup create --dry-run --json` answers the plan without writing
    a byte: the included assets, the per-agent roots and the roots it skipped,
    each with the canonical `sourcePath` the CLI resolved under the very same
    environment clawkeep spawned it with. Restore uses that as the allowlist of
    destinations a manifest may name — the CLI is the one authority on where
    OpenClaw keeps its state (`OPENCLAW_STATE_DIR`, `OPENCLAW_HOME` read as the
    ACCOUNT home, `OPENCLAW_CONFIG_PATH`, `OPENCLAW_OAUTH_DIR`, the workspace
    per agent in openclaw.json…), and re-deriving that list here would be a
    second copy that drifts the next time the CLI learns a new variable.

    Always the FULL plan (workspace included, not config-only), whatever the
    box's own backup options say today: a snapshot taken with the workspace in
    it must still be restorable after the owner switched the option off.

    A box that NEEDS a restore is a box whose state is in trouble, and the
    full plan refuses exactly there: with an openclaw.json the CLI cannot
    parse it exits 1 ("Config invalid … rerun with --no-include-workspace"),
    because the workspace roots live in that file; with no state directory at
    all it exits 1 ("No local OpenClaw state was found"). So the full plan is
    tried first, then ONCE more without the workspace — the CLI's own advice,
    which under a broken config still answers the state root — and when even
    that says there is no state, the plan is the one root the CLI cannot
    deny: the state directory the same environment names (:func:`state_dir`).
    Each step down is logged, because each narrows where a restore may land:
    a workspace the owner kept OUTSIDE the state directory is refused under
    the partial plan, with the declared roots named, and the owner puts that
    one back by hand. Any other failure still fails closed.
    """
    args = ["backup", "create", "--dry-run", "--json"]
    cp = _run(binary, args, timeout=timeout)
    if cp.returncode == 0:
        roots = _collect_plan(_parse_json(cp.stdout, "openclaw backup create --dry-run"))
        if not roots:
            raise OpenclawError(
                f"openclaw backup create --dry-run declared no source paths: {cp.stdout[:500]}",
            )
        return roots

    reason = _cli_error_message(cp)
    partial_args = [*args, "--no-include-workspace"]
    retry = _run(binary, partial_args, timeout=timeout)
    if retry.returncode == 0:
        roots = _collect_plan(_parse_json(retry.stdout, "openclaw backup create --dry-run"))
        if not roots:
            raise OpenclawError(
                "openclaw backup create --dry-run --no-include-workspace declared no "
                f"source paths: {retry.stdout[:500]}",
            )
        log.warning(
            "openclaw could not plan the workspace roots (%s); a restore may land only "
            "in what it planned without them: %s",
            reason, ", ".join(sorted({r.path for r in roots})),
        )
        return roots

    retry_reason = _cli_error_message(retry)
    if retry_reason.startswith(_NO_LOCAL_STATE):
        fallback = state_dir()
        log.warning(
            "openclaw found no local state to plan a backup from (%s); a restore may "
            "land only in the state directory this environment names: %s",
            retry_reason, fallback,
        )
        return (PlannedRoot(kind="state", path=fallback),)

    raise OpenclawError(
        f"openclaw backup create --dry-run failed (rc={cp.returncode}): {reason}; "
        f"and without the workspace (rc={retry.returncode}): {retry_reason}",
    )


def verify_archive(
    binary: str,
    archive: Path,
    *,
    timeout: float = SUBPROCESS_TIMEOUT_S,
) -> None:
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
