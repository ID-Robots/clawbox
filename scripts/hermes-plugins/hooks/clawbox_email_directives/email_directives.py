"""The ``EMAIL:<uid>`` directive grammar, as Python.

THE SECOND OF THREE COPIES, AND THE ONE THAT MUST NOT DRIFT. The original is
``src/lib/chat-email-refs.ts`` (``splitEmailRefs``), which is what the ClawBox
chat window renders cards from; ``scripts/openclaw-plugins/
clawbox-email-directives/email-directives.mjs`` is the third. They cannot share
a file: this one is imported by a Python plugin inside the Hermes agent's own
process, that one by a JavaScript plugin inside the OpenClaw gateway's, and the
original by a Next.js browser bundle. What they CAN share is a case table, and
``src/tests/fixtures/email-directive-cases.ts`` is run through all three by
``src/tests/unit/email-directive-parity.test.ts`` so a change to one that is not
made to the others fails a test rather than shipping.

WHY A STRIP EXISTS AT ALL. ``EMAIL:4471`` is how the agent tells a ClawBox chat
that its reply refers to a message the owner can open; the chat lifts the line
out and shows a card. Telegram, WhatsApp, Discord and the spoken reply have no
cards, so there the line is just an internal id printed at the owner (the
2026-09-03 screenshot behind TASK-679). The tool instruction asks the model not
to write one there — and a sentence is something a model can misread, which is
why this runs on the way out regardless.

NO ``hermes`` IMPORTS, deliberately: this module is imported both by the plugin
(inside the agent) and by ``scripts/openclaw/clawbox-tts.sh`` (a bare
``python3`` with nothing on ``sys.path`` but this directory), and it is what the
parity test imports as well.
"""

from __future__ import annotations

import re
from typing import List, Tuple

__all__ = ["strip_email_directives", "split_email_refs"]

#: A directive line: ``EMAIL:`` at the very start of the (stripped) line.
_EMAIL_LINE_RE = re.compile(r"^email:\s*(.*)$", re.IGNORECASE)

#: Opening or closing marker of a fenced code block.
_FENCE_RE = re.compile(r"^(?:```|~~~)")

#: ``[0-9]`` and not ``\d``: Python's ``\d`` also matches Arabic-Indic and other
#: Unicode digits, JavaScript's does not. Matching more here than the TypeScript
#: original does would make this copy strip a line the chat window keeps.
_UID_RE = re.compile(r"[0-9]{1,10}")

#: IMAP UIDs are 32-bit and start at 1.
_MAX_UID = 4_294_967_295

#: Most cards shown under one reply, however many the agent named.
_MAX_REFS = 25

_QUOTES = ("`", '"', "'")


def strip_email_directives(raw: str) -> str:
    """``raw`` without the directive lines a ClawBox chat would have carded."""
    return split_email_refs(raw)[0]


def split_email_refs(raw: str) -> Tuple[str, List[int]]:
    """The reply without its directives, and the ids they named.

    Recognised only at the start of a line and never inside a fenced code block,
    so a reply that EXPLAINS the syntax still keeps it as text. A directive
    whose payload is not a usable id is KEPT, for the same reason the chat
    window keeps it: dropping the line would hide that the agent meant to point
    at something.
    """
    if not isinstance(raw, str):
        return ("", [])
    # Cheap bail-out, and the empty string's split is itself.
    if "email:" not in raw.lower():
        return (raw, [])

    uids: List[int] = []
    seen = set()
    kept: List[str] = []
    in_fence = False

    for line in raw.split("\n"):
        trimmed = line.strip()
        if _FENCE_RE.match(trimmed):
            in_fence = not in_fence
            kept.append(line)
            continue
        match = None if in_fence else _EMAIL_LINE_RE.match(trimmed)
        if match is None:
            kept.append(line)
            continue
        uid = _parse_uid(match.group(1))
        if uid is None:
            kept.append(line)
            continue
        if uid in seen:
            continue
        # Past the cap the line goes back to being TEXT rather than
        # disappearing: this function may remove a line only when the chat
        # window would have turned that line into a card.
        if len(uids) >= _MAX_REFS:
            kept.append(line)
            continue
        seen.add(uid)
        uids.append(uid)

    # Removing a line from the middle of a reply leaves a hole; collapse the run
    # of blank lines behind it so the prose keeps its shape.
    text = re.sub(r"\n{3,}", "\n\n", "\n".join(kept)).strip()
    return (text, uids)


def _parse_uid(payload: str):
    """A UID, or ``None`` when the payload is not one."""
    value = _unwrap_quoted(payload.strip())
    if not _UID_RE.fullmatch(value):
        return None
    uid = int(value)
    if uid < 1 or uid > _MAX_UID:
        return None
    return uid


def _unwrap_quoted(value: str) -> str:
    """Strips one layer of the quoting a model tends to wrap a value in."""
    text = value.strip()
    for quote in _QUOTES:
        if len(text) >= 2 and text.startswith(quote) and text.endswith(quote):
            return text[1:-1].strip()
    return text
