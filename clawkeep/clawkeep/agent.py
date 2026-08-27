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
