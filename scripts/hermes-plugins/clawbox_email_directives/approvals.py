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

  * A skip carries NO TEXT — and neither does the OpenClaw twin's claim, though
    it could. ClawBox posts the verdict itself on both editions, over the same
    bot it sent the question on, because that is the only arrangement where the
    fast path and the timeout path say the same thing exactly once.
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

#: The words ClawBox acts on, and the shape a reply must have to be one.
#:
#: THE VERBS ARE IN THE SHAPE, and this list has to stay identical to the one in
#: ``src/lib/email-approval-reply.ts``. Leaving them out looked tidier — "which
#: words mean approve is the device's decision" — and it was wrong: a bare
#: ``[A-Za-z]{1,10}`` matches "hello", so "hello there" and "good night" were
#: posted to /email/chat-reply on their way past, and ten of them inside ten
#: minutes spent the route's attempt budget on nothing.
#:
#: This plugin still decides NOTHING. Approve-versus-delete is settled once, on
#: the device; the list here only decides whether to ask. Ordered longest-first
#: so ``no`` wins over ``n``, and case-insensitive because a phone keyboard
#: capitalises the first word of a message.
#:
#: No ``\s`` and no ``$``: those are two of the three places these languages
#: disagree (``\s`` matches a newline everywhere, and Python's ``$`` also
#: matches before a trailing one). The third is U+FEFF — see
#: ``trim_for_approval``.
APPROVAL_WORDS = (
    "approve", "okay", "send", "yes", "ok", "y",
    "discard", "cancel", "delete", "reject", "deny", "no", "n",
)

APPROVAL_SHAPE = re.compile(
    r"(?:{})[ \t]+[A-Za-z0-9]{{5}}".format("|".join(APPROVAL_WORDS)),
    re.IGNORECASE,
)

#: U+FEFF is whitespace to JavaScript's ``trim`` and not to Python's ``strip``
#: (``"\ufeff".isspace()`` is false), so a stray byte order mark on the end of a
#: pasted code made the same message an approval on OpenClaw and ordinary
#: conversation here. Both copies now take it off explicitly.
#: Dropped wherever it appears rather than only at the ends, so this stays the
#: same rule as the JavaScript copy — which does it that way because an
#: anchored-at-the-end run of a character class is the polynomial-ReDoS shape,
#: and that hook reads every inbound message on every channel.
def trim_for_approval(text: str) -> str:
    return text.replace("\ufeff", "").strip()


def looks_like_approval(text) -> bool:
    """The trim and the full match the shape assumes, as one callable.

    ``fullmatch`` rather than ``match`` with ``$``: Python's ``$`` also matches
    just before a trailing newline, JavaScript's does not, and that one
    difference would give the two editions different answers for the same
    message.
    """
    return isinstance(text, str) and APPROVAL_SHAPE.fullmatch(trim_for_approval(text)) is not None


#: Long enough for one loopback POST plus the SMTP conversation behind it, and
#: THE SAME NUMBER the OpenClaw twin uses — two ceilings over identical
#: server-side work is two different answers to one question.
#:
#: The floor is the mail client's own worst case: ``src/lib/smtp-client.ts``
#: allows a 15 s connect and 20 s per command, so a sluggish server can take
#: well over a minute before ClawBox has an answer to give. This hook is
#: SYNCHRONOUS, so that is a real hold on the dispatch path — which is exactly
#: why the shape test above runs first and why only a verb-and-a-code ever
#: reaches the network.
TIMEOUT_S = 120

CLAWBOX_ROOT = os.environ.get("CLAWBOX_ROOT") or "/home/clawbox/clawbox"
API_BASE = os.environ.get("CLAWBOX_API_BASE") or "http://127.0.0.1:80"
MIN_TOKEN_LEN = 16

#: What a bearer may be made of.
#:
#: The token is read off disk and interpolated into an ``Authorization`` header,
#: so its charset is load-bearing: a stray CR or LF would be header injection.
#: ``src/lib/mcp-token.ts`` mints hex, so this is wide enough for anything
#: token-shaped and narrow enough to be a check worth making.
TOKEN_RE = re.compile(r"[A-Za-z0-9._~+/=-]{16,512}")

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


def _post(token: str, body: dict) -> tuple[int, bool]:
    """One POST. Answers ``(status, handled)`` so the caller can tell a stale
    token — worth one retry — from every other unhappy answer, which is not."""
    # Rebuilt from the match, never tested and passed through — see TOKEN_RE.
    matched = TOKEN_RE.fullmatch(token.strip())
    if not matched:
        return 0, False
    request = urllib.request.Request(
        f"{API_BASE}/setup-api/email/chat-reply",
        data=json.dumps(body).encode("utf-8"),
        headers={"content-type": "application/json", "authorization": f"Bearer {matched.group(0)}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:  # noqa: S310 - loopback, fixed scheme
            if response.status != 200:
                return response.status, False
            answer = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        return err.code, False
    return 200, isinstance(answer, dict) and answer.get("handled") is True


def _channel_of(event) -> str:
    """Which surface this arrived on.

    The allowlist ClawBox checks the sender against is a TELEGRAM one, so the
    channel travels with the request and the device refuses anything else. A
    message this plugin cannot place is not offered — an unknown surface is not
    an argument for treating its ids as Telegram's.
    """
    platform = getattr(getattr(event, "source", None), "platform", None)
    value = getattr(platform, "value", platform)
    return value.strip().lower() if isinstance(value, str) and value.strip() else ""


def _ask_clawbox(sender_id: str, text: str, channel: str) -> bool | None:
    """``True`` claimed, ``False`` not ours, ``None`` we do not know.

    ``None`` is the timeout, and it is the one answer that must NOT be read as
    "carry on": ClawBox replies only once the whole send has finished, so a
    timeout means the mail may already be on the wire. Letting the message
    through would hand the model a "send <code>" it can only answer by queueing
    the same mail again.
    """
    global _cached_token
    token = _api_token()
    if not token:
        return False
    body = {"senderId": sender_id, "text": text, "channel": channel, "harness": "hermes"}
    try:
        status, handled = _post(token, body)
        if status in (401, 403):
            # The token this process cached may be older than the file on disk.
            # The Hermes gateway outlives `register-mcp.sh`, which mints
            # `data/.mcp-token` at web-server boot, so a stale cache is a real
            # state and a silent one — every approval would answer 403 for as
            # long as the gateway happened to stay up.
            _cached_token = None
            fresh = _api_token()
            if fresh and fresh != token:
                _, handled = _post(fresh, body)
        return handled
    except TimeoutError:
        return None
    except (urllib.error.URLError, OSError, ValueError, json.JSONDecodeError) as err:
        # A socket timeout arrives as one of these on some builds, so it is
        # separated by inspection rather than by class alone.
        if isinstance(getattr(err, "reason", None), TimeoutError):
            return None
        # FAIL OPEN for everything else — ClawBox restarting mid-rebuild, a
        # refused connection, a body that is not JSON: nothing happened, so the
        # message carries on to the agent exactly as it would have without this
        # plugin. An approval that does not go through is an owner repeating
        # himself; a message swallowed by a failed hook is a box that has
        # stopped listening.
        return False


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
        channel = _channel_of(event)
        if not channel:
            return None
        answered = _ask_clawbox(sender_id, text, channel)
        if answered is False:
            return None
        # True (claimed) and None (we timed out and the mail may be going) both
        # end the message here; only the second is silent, and ClawBox posts the
        # verdict for it.
        return {"action": "skip", "reason": "clawbox_email_approval"}
    except Exception:
        # Belt AND braces: Hermes already catches this at the call site, and
        # catching it here too keeps the failure attributable to this plugin in
        # the log instead of to the hook name. Either way the message goes on.
        logger.warning("clawbox_email_directives: leaving the message to the agent", exc_info=True)
        return None
