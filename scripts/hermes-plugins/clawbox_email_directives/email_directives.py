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

__all__ = ["strip_email_directives", "split_email_refs", "strip_draft_directives", "split_draft_refs"]

#: The characters JavaScript's ``String.prototype.trim()`` and ``\s`` remove.
#:
#: SPELLED OUT RATHER THAN INHERITED, because Python's idea of whitespace is not
#: JavaScript's and the two disagree in BOTH directions. A byte-order mark
#: (U+FEFF) is whitespace to JavaScript and not to Python, so ``\ufeffEMAIL:4471``
#: is a card in the chat window and would have stayed a visible id on Telegram;
#: U+001C-U+001F are whitespace to Python and not to JavaScript, so a line the
#: chat keeps as text would have been deleted from a channel reply instead.
#: Either direction is the drift the parity fixture exists to catch, and this is
#: the definition that makes the three copies agree.
_JS_WHITESPACE = (
    "\t\n\x0b\x0c\r \u00a0\u1680"
    "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a"
    "\u2028\u2029\u202f\u205f\u3000\ufeff"
)

#: A directive line: ``EMAIL:`` at the very start of the (stripped) line.
#:
#: ``[\s\S]`` AND NOT ``<ws>*(.*)``, matching the other two copies character for
#: character. In JavaScript the two quantifiers overlapped on the space and the
#: pattern was quadratic (see ``email-directives.mjs``); here the cost was the
#: OTHER divergence, because Python's ``.`` excludes only ``\n`` while
#: JavaScript's also excludes ``\r``, ``\u2028`` and ``\u2029`` — so a quoted
#: payload holding one of those three was a card to this copy and text to the
#: chat window. One character class removes both problems at once: it cannot
#: backtrack against itself, and it means the same thing in both languages.
#:
#: Dropping the leading-whitespace group costs nothing: ``_parse_uid`` strips
#: the payload with ``_JS_WHITESPACE`` before it reads it, exactly as the two
#: JavaScript copies call ``.trim()``.
#:
#: ``re.ASCII`` FOR THE SAME REASON ``_UID_RE`` SPELLS OUT ``[0-9]``: Python's
#: ``re.IGNORECASE`` is Unicode-aware and folds both ``İ`` (U+0130) and ``ı``
#: (U+0131) onto the ASCII ``i``, so ``EMAİL:7`` matched the keyword here and
#: this copy DELETED a line the chat window and the OpenClaw plugin both keep as
#: text. Neither matches in JavaScript, for two DIFFERENT reasons: ``İ``
#: uppercases to itself, so it never canonicalises to ``I`` at all; ``ı`` does
#: uppercase to ASCII ``I``, and ECMAScript's ``/i`` then refuses it under the
#: rule that a non-ASCII character whose fold is ASCII does not match. Those two
#: are the WHOLE offender set — swept over every code point, no other character
#: folds onto a letter of ``email``. The flag does not touch the payload class:
#: ``\S`` is the complement of whichever ``\s`` is in force, so ``[\s\S]`` is
#: still every character.
_EMAIL_LINE_RE = re.compile(r"^email:([\s\S]*)$", re.IGNORECASE | re.ASCII)

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

    lines = raw.split("\n")
    for line in lines:
        trimmed = line.strip(_JS_WHITESPACE)
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
    #
    # ONLY WHEN A LINE ACTUALLY WENT. The bail-out above already returns ``raw``
    # untouched for a reply with no ``email:`` in it; without this the SAME
    # reply with the word in it somewhere came back stripped and re-spaced
    # instead, so two otherwise identical replies were delivered differently
    # because one of them mentioned an address. This function may change a reply
    # only when it removed something from it.
    if len(kept) == len(lines):
        return (raw, uids)
    text = re.sub(r"\n{3,}", "\n\n", "\n".join(kept)).strip(_JS_WHITESPACE)
    return (text, uids)


def _parse_uid(payload: str):
    """A UID, or ``None`` when the payload is not one."""
    value = _unwrap_quoted(payload.strip(_JS_WHITESPACE))
    if not _UID_RE.fullmatch(value):
        return None
    uid = int(value)
    if uid < 1 or uid > _MAX_UID:
        return None
    return uid


def _unwrap_quoted(value: str) -> str:
    """Strips one layer of the quoting a model tends to wrap a value in."""
    text = value.strip(_JS_WHITESPACE)
    for quote in _QUOTES:
        if len(text) >= 2 and text.startswith(quote) and text.endswith(quote):
            return text[1:-1].strip(_JS_WHITESPACE)
    return text


# ── ``EMAIL_DRAFT:<id>`` — a draft waiting for the person's Send ────────────
#
# THE THIRD OF THREE COPIES of the draft grammar. The original is
# ``src/lib/chat-email-draft-refs.ts`` (``splitDraftRefs``), which the ClawBox
# chat turns into a send-approval card; the JavaScript copy sits beside the
# ``EMAIL:`` one in ``scripts/openclaw-plugins/clawbox-email-directives/``.
# ``src/tests/unit/email-draft-directive-parity.test.ts`` holds the three to one
# answer. A channel has no card, so the line is stripped there — after the
# ``EMAIL:`` lines, in the same order the chat applies them.

_DRAFT_LINE_RE = re.compile(r"^email_draft:([\s\S]*)$", re.IGNORECASE | re.ASCII)
_DRAFT_ID_RE = re.compile(r"(?!\.+\Z)[A-Za-z0-9._~+/=:@-]{1,512}", re.ASCII)
_MAX_DRAFT_REFS = 5

#: A line of fence markers and whatever follows them on that line. A fence is
#: closed only by its OWN marker character, in a run at least as long and alone
#: on its line, so ``~~~`` inside a backtick fence is content and not a closer.
#: ``_FENCE_RE`` above stays as the ``EMAIL:`` grammar's, which is pinned to its
#: own case table. Matched with ``fullmatch``, which is what JavaScript's ``$``
#: means here (Python's ``$`` also matches before a trailing newline).
_DRAFT_FENCE_RE = re.compile(r"(`{3,}|~{3,})([\s\S]*)")


def _opens_fence(trimmed: str):
    """The fence ``trimmed`` opens, as ``(marker, length)``, or ``None``."""
    match = _DRAFT_FENCE_RE.fullmatch(trimmed)
    if match is None:
        return None
    marker = match.group(1)[0]
    # A backtick fence's info string may not hold a backtick (CommonMark).
    if marker == "`" and "`" in match.group(2):
        return None
    return (marker, len(match.group(1)))


def _closes_fence(trimmed: str, fence) -> bool:
    """Whether ``trimmed`` closes ``fence``."""
    match = _DRAFT_FENCE_RE.fullmatch(trimmed)
    if match is None:
        return False
    marker, length = fence
    return match.group(1)[0] == marker and len(match.group(1)) >= length and not match.group(2).strip(_JS_WHITESPACE)


def strip_draft_directives(raw: str) -> str:
    """``raw`` without the ``EMAIL_DRAFT:`` lines a ClawBox chat would have carded."""
    return split_draft_refs(raw)[0]


def split_draft_refs(raw: str) -> Tuple[str, List[str]]:
    """The reply without its draft directives, and the draft ids they named."""
    if not isinstance(raw, str):
        return ("", [])
    if "email_draft:" not in raw.lower():
        return (raw, [])
    ids: List[str] = []
    kept: List[str] = []
    fence = None
    lines = raw.split("\n")
    for line in lines:
        trimmed = line.strip(_JS_WHITESPACE)
        if fence is not None:
            if _closes_fence(trimmed, fence):
                fence = None
            kept.append(line)
            continue
        opened = _opens_fence(trimmed)
        if opened is not None:
            fence = opened
            kept.append(line)
            continue
        match = _DRAFT_LINE_RE.match(_unwrap_quoted(trimmed))
        draft_id = _parse_draft_id(match.group(1)) if match is not None else None
        if draft_id is None:
            kept.append(line)
            continue
        if draft_id in ids:
            continue
        if len(ids) >= _MAX_DRAFT_REFS:
            kept.append(line)
            continue
        ids.append(draft_id)
    if len(kept) == len(lines):
        return (raw, ids)
    text = re.sub(r"\n{3,}", "\n\n", "\n".join(kept)).strip(_JS_WHITESPACE)
    return (text, ids)


def _parse_draft_id(payload: str):
    """A draft id, or ``None`` when the payload is not one."""
    value = _unwrap_quoted(payload.strip(_JS_WHITESPACE))
    return value if _DRAFT_ID_RE.fullmatch(value) else None
