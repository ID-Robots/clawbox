"""The owner's "send AB2CD", taken off the wire before the model sees it.

THE NATIVE SEAM. ``pre_gateway_dispatch`` is Hermes' own inbound hook, fired for
every user-originated message with the whole ``MessageEvent`` before dispatch
(``gateway/run.py`` in the pinned 0.20.5). A handler returns a dict:
``{"action": "skip"}`` drops the message because the plugin handled it,
``{"action": "rewrite", "text": …}`` replaces it, and ``{"action": "allow"}`` or
``None`` is normal dispatch. That is the twin of the OpenClaw plugin's
``before_dispatch``, and it means neither edition needs a second Telegram bot for
the basic approval — see ``src/lib/email-approval-reply.ts``.

IT RUNS BEFORE HERMES' OWN AUTH, deliberately (the comment at the call site says
so: it is what lets a plugin handle unauthorized senders). So NOTHING here may
treat "the harness let this through" as "this is the owner". The sender id is
passed to ClawBox and ClawBox checks it against the harness's own approved-user
list, which is the same rule the button path applies to a callback query.

TWO WAYS THIS DIFFERS FROM THE OPENCLAW TWIN, both of them the harnesses' doing:

  * A skip carries NO TEXT. OpenClaw's ``{"handled": True, "text": …}`` answers
    in the thread the owner typed in; here the claim is silent, so ClawBox is
    asked to post the verdict itself (``deliverVerdict``) over the same bot it
    sent the question on.
  * The hook is SYNCHRONOUS (``hermes_cli/lifecycle.invoke_hook`` returns a
    list, it does not await), so the request below blocks the dispatch path for
    as long as it takes. That is why the shape test is applied HERE first: an
    ordinary message costs one regex and no I/O at all, and only a message that
    is exactly a verb and a code — from anyone — reaches the network. The
    ceiling is bounded, and a timeout FAILS OPEN, so a slow or missing ClawBox
    leaves the message to the agent rather than swallowing it.

WHAT IT DOES NOT DECIDE. Not who the owner is, not which draft, not whether
anything is sent. Every gate is on the ClawBox side
(``src/app/setup-api/email/chat-reply/route.ts``); a plugin cannot read the
queue, the fingerprints or the allowlist, and one place to be wrong is the
point.
"""

from __future__ import annotations

import json
import logging
import os
import re
import urllib.error
import urllib.request

logger = logging.getLogger(__name__)

#: The shape a reply must have, EXACTLY: a word, a code, nothing else.
#:
#: The authority is ``parseApprovalReply`` in ``src/lib/email-approval-reply.ts``
#: and ``src/tests/unit/email-approval-reply-parity.test.ts`` is what keeps the
#: three copies agreeing. Loose enough to accept "send the invoice AB2CD" would
#: fire on things a person said in passing; that message is a sentence about
#: mail, not an instruction to release one.
APPROVAL_SHAPE = re.compile(r"[A-Za-z]{1,10}[ \t]+[A-Za-z0-9]{4,8}")


def looks_like_approval(text) -> bool:
    """The trim and the full match the shape assumes, as one callable.

    ``fullmatch`` rather than ``match`` with ``$``: Python's ``$`` also matches
    just before a trailing newline, JavaScript's does not, and that one
    difference would give the two editions different answers for the same
    message.
    """
    return isinstance(text, str) and APPROVAL_SHAPE.fullmatch(text.strip()) is not None

#: Long enough for one loopback POST plus the SMTP conversation behind it, and
#: short enough that a wedged mail server cannot hold the gateway all day.
TIMEOUT_S = 30

CLAWBOX_ROOT = os.environ.get("CLAWBOX_ROOT") or "/home/clawbox/clawbox"
API_BASE = os.environ.get("CLAWBOX_API_BASE") or "http://127.0.0.1:80"
MIN_TOKEN_LEN = 16

_cached_token: str | None = None


def _api_token() -> str | None:
    """The per-install bearer ``/setup-api/*`` accepts beside a session cookie.

    Read the way ``mcp/lib/api.ts`` reads it — env first, then the file — and
    cached only on success, so a token written after the gateway started is
    still picked up. This is not what authorises the approval (the sender id
    is); it is what gets the request past middleware at all.
    """
    global _cached_token
    if _cached_token:
        return _cached_token
    from_env = (os.environ.get("CLAWBOX_MCP_TOKEN") or "").strip()
    if len(from_env) >= MIN_TOKEN_LEN:
        _cached_token = from_env
        return _cached_token
    try:
        with open(os.path.join(CLAWBOX_ROOT, "data", ".mcp-token"), encoding="utf-8") as handle:
            raw = handle.read().strip()
        if len(raw) >= MIN_TOKEN_LEN:
            _cached_token = raw
            return _cached_token
    except OSError:
        # No token on this box: nothing here can work, and the message goes on
        # to the agent, which is the state every box was in before this existed.
        pass
    return None


def _sender_of(event) -> str:
    """Who sent it, from the event and then from its source.

    Both are checked because ``MessageEvent`` carries the author itself only for
    adapters that fill it in, and ``source`` is where every platform puts it. A
    blank stays blank rather than being defaulted: ClawBox refuses an empty
    sender, and inventing one here would be the one way to turn "we do not know
    who this is" into an approval.
    """
    for candidate in (getattr(event, "user_id", None), getattr(getattr(event, "source", None), "user_id", None)):
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()
        if isinstance(candidate, int):
            return str(candidate)
    return ""


def _ask_clawbox(sender_id: str, text: str) -> bool:
    """True only when ClawBox says it has DEALT with this message."""
    token = _api_token()
    if not token:
        return False
    body = json.dumps({"senderId": sender_id, "text": text, "deliverVerdict": True}).encode("utf-8")
    request = urllib.request.Request(
        f"{API_BASE}/setup-api/email/chat-reply",
        data=body,
        headers={"content-type": "application/json", "authorization": f"Bearer {token}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:  # noqa: S310 - loopback, fixed scheme
            if response.status != 200:
                return False
            answer = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError, json.JSONDecodeError):
        # FAIL OPEN. ClawBox restarting mid-rebuild, a timeout, a body that is
        # not JSON: the message carries on to the agent exactly as it would have
        # without this plugin. An approval that does not go through is an owner
        # repeating himself; a message swallowed by a failed hook is a box that
        # has stopped listening.
        return False
    return isinstance(answer, dict) and answer.get("handled") is True


def pre_gateway_dispatch(event=None, **kwargs):
    """``{"action": "skip"}`` when ClawBox settled a draft, ``None`` otherwise.

    ``None`` and not ``{"action": "allow"}``: ``allow`` BREAKS the call site's
    loop over every plugin's result, so a handler that has no opinion would stop
    the ones after it from being consulted. ``None`` is skipped over.
    """
    try:
        text = getattr(event, "text", None)
        if not looks_like_approval(text):
            return None
        sender_id = _sender_of(event)
        if not sender_id:
            return None
        if not _ask_clawbox(sender_id, text):
            return None
        return {"action": "skip", "reason": "clawbox_email_approval"}
    except Exception:
        # Belt AND braces: Hermes already catches this at the call site, and
        # catching it here too keeps the failure attributable to this plugin in
        # the log instead of to the hook name. Either way the message goes on.
        logger.warning("clawbox_email_directives: leaving the message to the agent", exc_info=True)
        return None
