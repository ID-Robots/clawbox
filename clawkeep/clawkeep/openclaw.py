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
import re
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


#: What a failed archive build was ABOUT — the words `Failure.kind` takes.
#: The runner turns them into exit codes and the TS bridge into a sentence, so
#: nothing downstream has to match on the CLI's English.
FAILURE_SYMLINK = "symlink"      # a link the archiver refuses to carry
FAILURE_DUPLICATE = "duplicate"  # two sources claim one archive path
FAILURE_VANISHED = "vanished"    # a file went away while the walk ran
FAILURE_RACE = "race"            # live writes the CLI itself calls retryable
FAILURE_SQLITE = "sqlite"        # a database failed the integrity gate
FAILURE_OTHER = "other"


@dataclass(frozen=True)
class Failure:
    """One archive failure, read from the archiver's own sentence.

    `paths` are what the sentence names — SOURCE paths on this box where the
    CLI gave them, archive entry paths where it only had those
    (:func:`archive_source_path` maps one back). `transient` means a fresh
    walk can succeed without anybody doing anything: the tree was being
    written while it was read.
    """

    kind: str
    paths: tuple[str, ...] = ()
    transient: bool = False


class OpenclawError(Exception):
    """A failed `openclaw` call. `failure` is set where the caller already
    knows what the failure was about; :func:`failure_of` reads it back, or
    classifies the message when it is absent."""

    def __init__(self, message: str, *, failure: Failure | None = None) -> None:
        super().__init__(message)
        self.failure = failure


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
        # The CLI's own sentence, WHOLE: under `--json` it is the envelope's
        # `error.message`. The raw stderr+stdout tail this used to keep was
        # the last 500 characters of that envelope, which cut the front off
        # the long ones — the SQLite refusal names its database at the START.
        reason = _cli_error_message(cp)
        raise OpenclawError(
            f"openclaw backup create failed (rc={cp.returncode}): {reason}",
            failure=classify_failure(reason),
        )

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
#: directory at all. Matched by CONTAINMENT, never by prefix: the CLI prints
#: it both as the `error.message` of its `--json` answer and as a
#: "[openclaw] Reason:" line on stderr, and `_cli_error_message` hands back
#: the second form — the raw stderr+stdout tail, with "[openclaw] Could not
#: start the CLI." in front of it — whenever stdout carries no JSON envelope.
#: A prefix test read that form as some other failure and failed closed on
#: exactly the box a restore is for.
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

    A mirror of the CLI's `resolveStateDir` (one deliberate exception below):
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

    # Through `_home_value` like the two homes above. This is ClawKeep's own,
    # stricter rule, not the CLI's: the installed CLI only trims this
    # variable, so a unit that exported `OPENCLAW_STATE_DIR=undefined` would
    # have it resolve `<cwd>/undefined` — and here that would become the box's
    # ONE allowed restore root, so the manifest of the real state directory
    # could never pass the allowlist. Treating the placeholder as unset can
    # only widen a restore back to where the state really lives.
    override = _home_value(e.get("OPENCLAW_STATE_DIR"))
    if override is not None:
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
    if _NO_LOCAL_STATE in retry_reason:
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


@dataclass(frozen=True)
class PlannedAsset:
    """One root `openclaw backup create` WILL archive, as its dry-run says."""

    kind: str
    source_path: str
    archive_path: str


@dataclass(frozen=True)
class BackupPlan:
    """The dry-run answer for the backup this box is about to take.

    `skipped` keeps every `(kind, sourcePath, reason)` the CLI declined, so a
    walk over `assets` can step over what the archiver will step over
    (`regenerable` package trees, `private` update captures).
    """

    archive_root: str
    assets: tuple[PlannedAsset, ...]
    skipped: tuple[tuple[str, str, str], ...]


def plan_backup(
    binary: str,
    *,
    include_workspace: bool = True,
    only_config: bool = False,
    timeout: float = 5 * 60,
) -> BackupPlan:
    """`openclaw backup create --dry-run --json` with THIS backup's options.

    Not :func:`plan_roots`: that one is restore's allowlist and is always the
    full plan whatever the options say. This is the plan of the archive the
    very next call will write, which is what a pre-flight has to look at.
    Raises `OpenclawError` when the CLI cannot answer.
    """
    args = ["backup", "create", "--dry-run", "--json"]
    if not include_workspace:
        args.append("--no-include-workspace")
    if only_config:
        args.append("--only-config")
    cp = _run(binary, args, timeout=timeout)
    if cp.returncode != 0:
        reason = _cli_error_message(cp)
        raise OpenclawError(
            f"openclaw backup create --dry-run failed (rc={cp.returncode}): {reason}",
        )
    meta = _parse_json(cp.stdout, "openclaw backup create --dry-run")
    assets: list[PlannedAsset] = []
    for entry in meta.get("assets") or []:
        if not isinstance(entry, dict):
            continue
        kind, source, archive = entry.get("kind"), entry.get("sourcePath"), entry.get("archivePath")
        if all(isinstance(v, str) and v for v in (kind, source, archive)):
            assets.append(PlannedAsset(kind=kind, source_path=source, archive_path=archive))
    skipped: list[tuple[str, str, str]] = []
    for entry in meta.get("skipped") or []:
        if not isinstance(entry, dict):
            continue
        kind, source, reason = entry.get("kind"), entry.get("sourcePath"), entry.get("reason")
        if all(isinstance(v, str) and v for v in (kind, source, reason)):
            skipped.append((kind, source, reason))
    return BackupPlan(
        archive_root=str(meta.get("archiveRoot") or ""),
        assets=tuple(assets),
        skipped=tuple(skipped),
    )


# ── what a failed `backup create` was about ──────────────────────────────────
#
# Each pattern is the CLI's own sentence in OpenClaw 2026.9.4
# (`src/infra/backup-archive-path-policy.ts`, `backup-verify.ts`,
# `backup-create.ts`, `backup-tar-retry.ts`). A sentence none of them matches
# is FAILURE_OTHER, which is what every failure was before this existed.

_SYMLINK_RE = re.compile(
    r"Archive symbolic link (?:target must be relative|target must use forward slashes"
    r"|target is outside the declared archive root|is outside the declared backup assets"
    r"|is missing its target): (?P<rest>[^\n]+)",
)
_DUPLICATE_RE = re.compile(r"Archive contains duplicate entry path: (?P<entry>[^\n]+)")
_COLLISION_RE = re.compile(
    r"Archive contains a portable path collision: (?P<a>[^\n]+?) and (?P<b>[^\n]+)",
)
_SQLITE_RE = re.compile(
    r"SQLite database cannot be compacted safely for backup: (?P<path>[^\n]+?\.sqlite)\.(?:\s|$)",
)
_ENOENT_RE = re.compile(r"ENOENT: no such file or directory, [a-z]+ '(?P<path>[^'\n]+)'")
_OFFENDING_RE = re.compile(r"\(last offending path: (?P<path>[^\n]+?), after \d+ attempts?\)")
#: Sentences the CLI itself answers with "retry": live writes it caught.
_RACE_RES = (
    re.compile(r"SQLite state appeared after snapshot discovery: (?P<path>[^\n]+?)\. Retry backup"),
    re.compile(r"Canonical SQLite path changed after discovery: (?P<path>[^\n]+)"),
    re.compile(r"SQLite file generation did not stabilize during confirmation: (?P<path>[^\n]+)"),
    re.compile(r"Legacy audit database rows changed during SQLite backup"),
    re.compile(r"(?:did not encounter expected|encountered unexpected) EOF|TAR_BAD_ARCHIVE", re.I),
)
#: The retry wrapper's tail, "(after 1 attempt)" or "(last offending path: …,
#: after 3 attempts)", which follows whatever the sentence ended with.
_ATTEMPT_TAIL_RE = re.compile(r"\s*\((?:last offending path: [^\n]*, )?after \d+ attempts?\)\s*$")


def _clean_tail(value: str) -> str:
    return _ATTEMPT_TAIL_RE.sub("", value).strip().rstrip(".")


def archive_source_path(entry: str) -> str | None:
    """The source path an archive entry was written from: the CLI names
    members `<root>/payload/posix/<absolute path without its leading slash>`.
    `None` for a name that is not in that shape (the manifest, say)."""
    parts = entry.strip().lstrip("/").split("/", 3)
    if len(parts) < 4 or parts[1] != "payload" or parts[2] != "posix":
        return None
    return "/" + parts[3]


def classify_failure(message: str) -> Failure:
    """Read a `backup create` failure. Pure; the tests feed it the CLI's
    sentences verbatim."""
    text = message or ""
    match = _SQLITE_RE.search(text)
    if match:
        return Failure(FAILURE_SQLITE, (match.group("path"),))
    match = _SYMLINK_RE.search(text)
    if match:
        rest = _clean_tail(match.group("rest"))
        entry, _, link = rest.partition(" -> ")
        return Failure(FAILURE_SYMLINK, tuple(p for p in (entry.strip(), link.strip()) if p))
    match = _DUPLICATE_RE.search(text)
    if match:
        return Failure(FAILURE_DUPLICATE, (_clean_tail(match.group("entry")),))
    match = _COLLISION_RE.search(text)
    if match:
        return Failure(FAILURE_DUPLICATE, (match.group("a").strip(), _clean_tail(match.group("b"))))
    for pattern in _RACE_RES:
        match = pattern.search(text)
        if match:
            path = match.groupdict().get("path")
            return Failure(FAILURE_RACE, (_clean_tail(path),) if path else (), transient=True)
    match = _ENOENT_RE.search(text) or _OFFENDING_RE.search(text)
    if match:
        return Failure(FAILURE_VANISHED, (match.group("path"),), transient=True)
    if re.search(r"\bENOENT\b", text):
        # Node's code without its usual ", op 'path'" — still a path that was
        # there when the walk listed it and gone when it came back for it.
        return Failure(FAILURE_VANISHED, (), transient=True)
    return Failure(FAILURE_OTHER)


def failure_of(exc: BaseException) -> Failure:
    """The `Failure` an archive error carries, or the one its message reads as."""
    failure = getattr(exc, "failure", None)
    return failure if isinstance(failure, Failure) else classify_failure(str(exc))


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
