"""Which agent this device runs, and therefore which backup backend to use.

ClawKeep began as an OpenClaw-only tool: `runner` called
`openclaw.create_archive` directly and `restore` called
`openclaw.verify_archive` directly. This module is the seam that lets the same
daemon serve the Hermes SKU without either of those callers growing an
`if edition == "hermes"` branch — they ask here for a backend and get one.

Two questions live here and they are NOT the same question:

  * :func:`device_agent` — what does THIS BOX run? Decides what a new backup
    archives.
  * :func:`archive_agent` — what wrote THIS SNAPSHOT? Decides whether the box
    may restore it.

They have to be asked separately because one portal account gets ONE R2 prefix,
shared by every device paired to it. A customer with a ClawBox and a Hermes box
sees both devices' snapshots in one list — and so does a single box that was
converted from one edition to the other, which keeps its `~/.clawkeep` pairing
across the conversion. Restoring an OpenClaw snapshot onto a Hermes box would
swap `~/.openclaw` state onto a device that runs no OpenClaw and leave the
Hermes agent untouched: a restore that reports success and restores nothing the
customer can see. :func:`assert_archive_matches_device` is what stops that.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path

from . import hermes, openclaw
from .config import Config

#: The root-owned edition lock, same file `src/lib/edition-source.ts` reads.
#: Root-owned on purpose: it is the authority for the device SKU and a customer
#: with shell must not be able to flip it.
EDITION_FILE = os.environ.get("CLAWBOX_EDITION_FILE", "/etc/clawbox/edition.env")

AGENT_HERMES = hermes.AGENT_ID          # "hermes"
AGENT_OPENCLAW = "openclaw"

_EDITION_RE = re.compile(r"^\s*(?:export\s+)?CLAWBOX_EDITION\s*=\s*(.*)$")


class AgentMismatchError(Exception):
    """The snapshot belongs to a different agent than this device runs."""


class DestinationRefusedError(Exception):
    """The manifest wants to land an asset somewhere this box's agent keeps no
    state — or in a shape (file vs directory, sqlite) the agent never writes.

    Restore's destinations used to be READ from the manifest: `sourcePath` was
    checked to be a non-empty string and then renamed over. A snapshot is not
    a trustworthy document — every device paired to the account can write
    into the same prefix, and a legacy plaintext `.tar.gz` needs no passphrase
    at all — so a manifest naming `/home/clawbox/.ssh` would have had the
    owner's `authorized_keys` swapped out by clicking Restore. Every
    destination is now derived LOCALLY and the manifest may only agree.
    """


def _parse_edition_file(raw: str) -> str | None:
    """Minimal systemd EnvironmentFile parse — `KEY=value`, optional `export`,
    optional quotes. Deliberately the same shape as `parseEditionEnvFile` in
    `src/lib/edition-source.ts`; the two must never disagree about a box."""
    for line in raw.splitlines():
        match = _EDITION_RE.match(line)
        if not match:
            continue
        value = match.group(1).strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        return value.strip().lower()
    return None


def read_edition() -> str:
    """`"openclaw"` | `"hermes"` | `"dual"`. Root-owned file first, environment
    second, `"openclaw"` (the native SKU) as the default — matching the TS
    reader exactly, including its fallback order."""
    try:
        raw = Path(EDITION_FILE).read_text(encoding="utf-8")
    except OSError:
        raw = ""
    for candidate in (_parse_edition_file(raw), os.environ.get("CLAWBOX_EDITION")):
        value = (candidate or "").strip().lower()
        if value in (AGENT_OPENCLAW, AGENT_HERMES, "dual"):
            return value
    return AGENT_OPENCLAW


def device_agent() -> str:
    """Which agent's state a backup on this device should capture.

    A single-harness edition answers itself. `"dual"` — both runtimes
    installed, switcher licensed — answers by what is actually on disk, and
    prefers OpenClaw when both are, because that is the harness a dual box
    defaults to (`DEFAULT_HARNESS` in `src/lib/harness.ts`).

    Note what this does NOT do: it does not fall back to "whatever directory
    exists" on a single-harness box. A Hermes box that was converted from
    OpenClaw still has a stale `~/.openclaw` sitting there — 2.7 MB of dead
    state on the QA box this was written against — and letting its mere
    presence pick the backend would have that box faithfully backing up an
    agent it stopped running.
    """
    edition = read_edition()
    if edition in (AGENT_HERMES, AGENT_OPENCLAW):
        return edition
    # dual
    if Path(os.environ.get("HOME", "/home/clawbox"), ".openclaw").exists():
        return AGENT_OPENCLAW
    return AGENT_HERMES if hermes.hermes_home().exists() else AGENT_OPENCLAW


def create_archive(cfg: Config, *, output_dir: Path) -> openclaw.Archive:
    """Build one archive with whichever backend this device calls for.

    Raises `openclaw.OpenclawError` or `hermes.HermesError`; `runner` catches
    :data:`ARCHIVE_ERRORS` so it does not have to know which ran.
    """
    if device_agent() == AGENT_HERMES:
        return hermes.create_archive(
            output_dir=output_dir,
            only_config=cfg.openclaw.only_config,
            verify=cfg.openclaw.verify,
        )
    return openclaw.create_archive(
        cfg.openclaw.binary,
        output_dir=output_dir,
        include_workspace=cfg.openclaw.include_workspace,
        only_config=cfg.openclaw.only_config,
        verify=cfg.openclaw.verify,
    )


#: The exception types :func:`create_archive` and :func:`verify_archive` can
#: raise. One tuple so callers catch the union without importing both modules.
ARCHIVE_ERRORS = (openclaw.OpenclawError, hermes.HermesError)


def archive_agent(manifest: dict) -> str:
    """Which agent wrote the snapshot this manifest came out of.

    Absent `agent` means OpenClaw: every archive written before this key
    existed was an OpenClaw one, and defaulting the other way would make every
    historical snapshot unrestorable on the device that made it.
    """
    value = str(manifest.get("agent") or "").strip().lower()
    return value or AGENT_OPENCLAW


def assert_archive_matches_device(manifest: dict) -> None:
    """Refuse a snapshot that belongs to the other edition.

    Raises `AgentMismatchError` with a message written for the customer, not
    for us: they did not do anything wrong, they picked a snapshot from the
    list their portal account showed them, and the list legitimately contains
    both boxes' backups.
    """
    theirs = archive_agent(manifest)
    ours = device_agent()
    if theirs == ours:
        return
    raise AgentMismatchError(
        f"This snapshot was made by a {theirs} device and cannot be restored "
        f"onto this {ours} device. Your account's backups from every paired "
        "device appear in one list — pick one made by this device.",
    )


# ── where a restore may land ─────────────────────────────────────────────────

@dataclass(frozen=True)
class RestoreRoot:
    """One place this box's agent keeps state, as restore may accept it."""

    #: Normalised absolute path.
    path: str
    #: The agent's own word for it: a Hermes `ASSETS` kind, or an OpenClaw
    #: plan kind (`state`, `config`, `credentials`, `workspace`, `agent`).
    kind: str
    #: `"dir"` | `"file"` — what a manifest asset landing here must declare.
    entry: str
    #: Whether a manifest asset landing here may carry `sqlite: true`.
    sqlite: bool
    #: Hermes: the manifest's kind must be THIS root's kind (exact set, keyed
    #: by kind). OpenClaw: matched by path, kind unpinned.
    pin_kind: bool


@dataclass(frozen=True)
class RestoreRoots:
    agent: str
    roots: tuple[RestoreRoot, ...]


#: OpenClaw kinds whose destination may lie INSIDE a declared root rather
#: than equal one: a per-agent root or a workspace the owner has since moved
#: or removed from openclaw.json still sits under the state dir.
OPENCLAW_NESTED_KINDS = frozenset({"agent", "workspace"})

#: The one OpenClaw asset kind that is a single file (`openclaw.json`, when it
#: lives outside the state dir or in a config-only snapshot).
_OPENCLAW_FILE_KINDS = frozenset({"config"})


def restore_roots(cfg: Config) -> RestoreRoots:
    """Everywhere a restore on THIS box is allowed to land, derived locally.

    Hermes: exactly `{source_path(a) for a in hermes.ASSETS}` — this package is
    the only writer of a Hermes archive, so the set is closed and each root
    carries the entry shape and sqlite flag its kind was archived with.

    OpenClaw: what `openclaw backup create --dry-run --json` declares it would
    archive today (`openclaw.plan_roots`) — resolved by the CLI under the same
    environment it is spawned with here, so the list is by construction the
    one a snapshot of this box was written from. Raises `OpenclawError` when
    the CLI cannot answer; a restore then refuses rather than guessing.
    """
    if device_agent() == AGENT_HERMES:
        return RestoreRoots(
            agent=AGENT_HERMES,
            roots=tuple(
                RestoreRoot(
                    path=os.path.normpath(str(hermes.source_path(a))),
                    kind=a.kind,
                    entry=a.entry,
                    sqlite=a.sqlite,
                    pin_kind=True,
                )
                for a in hermes.ASSETS
            ),
        )
    planned = openclaw.plan_roots(cfg.openclaw.binary)
    return RestoreRoots(
        agent=AGENT_OPENCLAW,
        roots=tuple(
            RestoreRoot(
                path=os.path.normpath(root.path),
                kind=root.kind,
                entry="file" if root.kind in _OPENCLAW_FILE_KINDS else "dir",
                sqlite=False,
                pin_kind=False,
            )
            for root in planned
        ),
    )


def _inside(target: str, root: str) -> bool:
    return target != root and target.startswith(root.rstrip("/") + "/")


def assert_destination_allowed(
    kind: str,
    entry: str,
    target: str,
    *,
    roots: RestoreRoots,
    sqlite: bool = False,
) -> RestoreRoot:
    """Vet ONE manifest asset's destination against the local roots.

    Returns the root the asset lands on. Its `path` is the path restore may
    use — the manifest's own string, which by then has been proven to be an
    absolute, already-normalised path equal to (or, for the OpenClaw nested
    kinds, inside) a root this box declared. Its `sqlite` is what restore
    must act on, and it is THIS BOX's word, never the manifest's: a Hermes
    `sessions` manifest that omits the flag still lands on the `state.db`
    root, and a restore that took the manifest's silence for "not sqlite"
    would leave the old database's `-wal`/`-shm` pair beside the new file
    for sqlite to replay into it. The manifest may only agree — `sqlite:
    true` on a root this box does not archive that way is refused, since
    honouring it would rename `config.yaml-wal` aside.
    Raises `DestinationRefusedError` naming the kind and the path otherwise.

    The shape rule first, whoever the agent is: `os.path.isabs(target)` and
    `os.path.normpath(target) == target`. That refuses a relative path (which
    would land wherever the daemon's cwd is — the ClawBox checkout, when the
    web server spawns it), `~`, any `..` or `.` segment, a doubled slash and a
    trailing slash — the CLI writes none of those, so a manifest carrying one
    was not written by the CLI.
    """
    where = f"{kind!r} asset at {target!r}"
    # `//x` is the one spelling POSIX `normpath` keeps as is (an
    # implementation-defined prefix), so it is named on its own.
    if (
        not os.path.isabs(target)
        or target.startswith("//")
        or os.path.normpath(target) != target
    ):
        raise DestinationRefusedError(
            f"refusing to restore the {where}: a destination must be an absolute, "
            "normalised path (no relative path, no '~', no '..', no doubled or "
            "trailing slash)",
        )

    if roots.agent == AGENT_HERMES:
        matched = next(
            (r for r in roots.roots if r.kind == kind and r.path == target), None,
        )
        if matched is None:
            known = next((r for r in roots.roots if r.kind == kind), None)
            if known is None:
                raise DestinationRefusedError(
                    f"refusing to restore the {where}: {kind!r} is not something "
                    "a Hermes backup contains",
                )
            raise DestinationRefusedError(
                f"refusing to restore the {where}: on this box the {kind!r} asset "
                f"lives at {known.path!r}, and a snapshot does not get to choose "
                "where it lands",
            )
    else:
        exact = next((r for r in roots.roots if r.path == target), None)
        if exact is not None:
            matched = exact
        elif kind in OPENCLAW_NESTED_KINDS and any(_inside(target, r.path) for r in roots.roots):
            # An agent root or workspace that sits under a declared root — the
            # box may have dropped that agent from openclaw.json since, and the
            # directory is still the agent's own.
            matched = RestoreRoot(path=target, kind=kind, entry="dir", sqlite=False, pin_kind=False)
        else:
            declared = ", ".join(sorted({r.path for r in roots.roots}))
            raise DestinationRefusedError(
                f"refusing to restore the {where}: it is not a place this box's "
                f"OpenClaw keeps state (declared: {declared}). A snapshot does not "
                "get to choose where it lands; if the state directory was moved "
                "since this backup, restore it by hand",
            )

    if entry != matched.entry:
        if roots.agent == AGENT_OPENCLAW and matched.entry == "file":
            # The CLI writes no `entry` key, so a manifest is not LYING when
            # it says nothing about a `config` asset: ClawKeep restores
            # OpenClaw state as directories only, and a single-file asset —
            # a config-only snapshot, or an openclaw.json kept outside the
            # state directory — is a limitation of this restore, not a fault
            # of the snapshot. Said as one, so the owner is not told to
            # distrust a backup that is fine.
            raise DestinationRefusedError(
                f"refusing to restore the {where}: on this box that is a single "
                "file, and ClawKeep restores OpenClaw state as directories only — "
                "a config-only snapshot, or an openclaw.json kept outside the "
                "state directory, has to be put back by hand",
            )
        raise DestinationRefusedError(
            f"refusing to restore the {where}: this box archives it as a "
            f"{matched.entry!r}, the manifest says {entry!r}",
        )
    if sqlite and not matched.sqlite:
        raise DestinationRefusedError(
            f"refusing to restore the {where}: it is not a sqlite database on this box",
        )
    # Every arm above leaves `matched.path == target` (the nested OpenClaw
    # root is built from `target`), so the caller reads the path from here.
    return matched


def verify_archive(cfg: Config, archive: Path, *, agent: str) -> None:
    """Verify a downloaded archive with the backend that WROTE it.

    Keyed on the archive's own agent rather than the device's, so a mismatch
    surfaces as the plain-language `AgentMismatchError` above instead of as
    "openclaw backup verify failed (rc=1)" — the caller checks the match
    first, and this then does the real integrity check.
    """
    if agent == AGENT_HERMES:
        hermes.verify_archive(archive)
        return
    openclaw.verify_archive(cfg.openclaw.binary, archive)
