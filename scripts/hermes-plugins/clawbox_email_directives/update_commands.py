"""The owner's /update, and a tap on the weekly notice's Update button (TASK-2260).

TWO SEAMS ON THIS HARNESS, where OpenClaw needs one, and that is Hermes' doing:

  * /update is TEXT, so it rides ``pre_gateway_dispatch`` exactly like the
    emailed-draft reply in ``approvals.py``: matched here, handed to ClawBox
    (``/setup-api/update/chat-command``), and skipped.
  * The button's tap is a ``callback_query``, and Hermes' Telegram adapter
    dispatches callback data on a fixed prefix table (``mp:``, ``cp:``, ``ea:``,
    ``update_prompt:`` …) and DROPS anything else — it never becomes a message,
    so no inbound hook can see it. Hermes' own answer is
    ``ctx.register_telegram_handler``: a PTB ``CallbackQueryHandler`` the
    adapter hoists ahead of its catch-all, scoped with ``pattern=`` to exactly
    this button so every core button flow keeps working. OpenClaw instead turns
    an unknown tap into a synthetic ``callback_data: clawbox-update`` message,
    which is why its twin (``update-commands.mjs``) needs no handler of its own.

WHAT IT DOES NOT DECIDE. Not who the owner is (the hook runs BEFORE Hermes' own
auth, and so does the callback handler), not whether there is an update, never
whether one runs. Every gate is on the ClawBox side
(``src/lib/update-notice.ts``); the button only ever ASKS, and the update runs
only when the owner confirms on the desktop or the approvals bot.

FAIL CLOSED. A /update this hook does not claim goes on to Hermes' own
``/update`` command — ``hermes update``, which moves the agent off the commit
ClawBox pins. An owner who typed /update meant the ClawBox update; if ClawBox
cannot be asked, the message is dropped and the log says why. The one message
handed BACK is a stranger's: ClawBox answers ``outcome: "not_owner"`` and
Hermes' own auth, which runs right after this hook, refuses him before any
command runs.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import urllib.error
import urllib.request

from . import approvals

logger = logging.getLogger(__name__)

#: ``UPDATE_BUTTON_DATA`` in src/lib/update-notice.ts.
UPDATE_BUTTON_DATA = "clawbox-update"

#: ``/update`` or ``/update@<bot>`` — the shape ``parseUpdateChatCommand`` applies
#: (pinned by src/tests/unit/update-notice-plugin-parity.test.ts).
COMMAND_SHAPE = re.compile(r"/update(?:@[A-Za-z0-9_]{1,64})?", re.IGNORECASE)

#: ClawBox answers before it does the slow part, so this is a loopback round trip.
TIMEOUT_S = 15


def looks_like_update_command(text) -> bool:
    """``fullmatch`` on the same trim the approval shape uses (BOM off, then strip)."""
    if not isinstance(text, str):
        return False
    trimmed = approvals.trim_for_approval(text)
    return (
        COMMAND_SHAPE.fullmatch(trimmed) is not None
        or trimmed == UPDATE_BUTTON_DATA
        or trimmed == "callback_data: " + UPDATE_BUTTON_DATA
    )


#: What ClawBox answered: it took the message, it refused a stranger (whom
#: Hermes' own auth then refuses), or nothing usable — which fails closed.
CLAIMED, STRANGER, NO_ANSWER = "claimed", "stranger", "no_answer"


def _verdict(answer) -> str:
    if not isinstance(answer, dict):
        return NO_ANSWER
    if answer.get("handled") is True:
        return CLAIMED
    if answer.get("outcome") == "not_owner":
        return STRANGER
    return NO_ANSWER


def _post(token: str, body: dict) -> tuple[int, str]:
    matched = approvals.TOKEN_RE.fullmatch(token.strip())
    if not matched:
        return 0, NO_ANSWER
    request = urllib.request.Request(
        f"{approvals.API_BASE}/setup-api/update/chat-command",
        data=json.dumps(body).encode("utf-8"),
        headers={"content-type": "application/json", "authorization": f"Bearer {matched.group(0)}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:  # noqa: S310 - loopback, fixed scheme
            if response.status != 200:
                return response.status, NO_ANSWER
            answer = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        return err.code, NO_ANSWER
    return 200, _verdict(answer)


def ask_clawbox(body: dict) -> str:
    """``CLAIMED``, ``STRANGER`` or ``NO_ANSWER``. Never raises."""
    token = approvals._api_token()
    if not token:
        return NO_ANSWER
    try:
        status, verdict = _post(token, body)
        if status in (401, 403):
            approvals._cached_token = None
            fresh = approvals._api_token()
            if fresh and fresh != token:
                _, verdict = _post(fresh, body)
        return verdict
    except Exception:  # noqa: BLE001 - a hook must never raise into the dispatch path
        logger.warning("clawbox_email_directives: ClawBox could not be asked about /update", exc_info=True)
        return NO_ANSWER


def _platform_of(event) -> str:
    platform = getattr(getattr(event, "source", None), "platform", None)
    value = getattr(platform, "value", platform)
    return value.strip().lower() if isinstance(value, str) else ""


def _str_id(value) -> str:
    if isinstance(value, bool):
        return ""
    if isinstance(value, int):
        return str(value)
    return value.strip() if isinstance(value, str) else ""


def pre_gateway_dispatch(event=None, **kwargs):
    """``{"action": "skip"}`` for /update (or the button's data typed as text), ``None`` otherwise."""
    try:
        text = getattr(event, "text", None)
        if not looks_like_update_command(text):
            return None
        if _platform_of(event) != "telegram":
            return None
        source = getattr(event, "source", None)
        sender = _str_id(getattr(event, "user_id", None)) or _str_id(getattr(source, "user_id", None))
        chat_type = getattr(source, "chat_type", None)
        body = {
            "senderId": sender,
            "chatId": _str_id(getattr(source, "chat_id", None)),
            "isGroup": isinstance(chat_type, str) and chat_type.strip().lower() not in ("", "dm", "private"),
            "text": text,
            "channel": "telegram",
            "harness": "hermes",
        }
        verdict = ask_clawbox(body) if sender else NO_ANSWER
        if verdict == CLAIMED:
            return {"action": "skip", "reason": "clawbox_update"}
        if verdict == STRANGER:
            # Not the owner: Hermes' own auth, which runs right after this hook,
            # refuses him before any command runs. Claiming it here would leave
            # Hermes' typing indicator running in his chat (the skip path never
            # stops the keep-typing loop ingress started).
            return None
        logger.warning("clawbox_email_directives: /update could not be handed to ClawBox; dropped rather than run Hermes' own update")
        return {"action": "skip", "reason": "clawbox_update_unavailable"}
    except Exception:  # noqa: BLE001
        logger.warning("clawbox_email_directives: /update hook failed; dropped", exc_info=True)
        return {"action": "skip", "reason": "clawbox_update_unavailable"}


async def on_update_button(update, context=None) -> None:
    """The Update button's tap: acknowledge it, hand the presser to ClawBox, retire the button."""
    query = getattr(update, "callback_query", None)
    if query is None or getattr(query, "data", None) != UPDATE_BUTTON_DATA:
        return
    try:
        await query.answer()
    except Exception:  # noqa: BLE001 - a spinner left on the button is cosmetic
        pass
    try:
        message = getattr(query, "message", None)
        chat = getattr(message, "chat", None)
        chat_type = getattr(chat, "type", None)
        body = {
            "senderId": _str_id(getattr(getattr(query, "from_user", None), "id", None)),
            "chatId": _str_id(getattr(chat, "id", None)),
            "isGroup": isinstance(chat_type, str) and chat_type.strip().lower() != "private",
            "text": UPDATE_BUTTON_DATA,
            "channel": "telegram",
            "harness": "hermes",
        }
        if not body["senderId"]:
            return
        handled = await asyncio.to_thread(ask_clawbox, body) == CLAIMED
        if handled:
            # One tap, one question — the way OpenClaw clears a routed button.
            try:
                await query.edit_message_reply_markup(reply_markup=None)
            except Exception:  # noqa: BLE001
                pass
        else:
            logger.warning("clawbox_email_directives: the Update button's tap could not be handed to ClawBox")
    except Exception:  # noqa: BLE001
        logger.warning("clawbox_email_directives: the Update button handler failed", exc_info=True)


def telegram_handler_factory(native, adapter=None) -> None:
    """``register_telegram_handler``'s factory: one handler, scoped to this button only."""
    from telegram.ext import CallbackQueryHandler  # the adapter's own dependency, imported where it is used

    native.add_handler(CallbackQueryHandler(on_update_button, pattern=r"^clawbox-update$"))


def register_telegram_handlers(ctx) -> bool:
    """Wire the button where this Hermes can; True when it did. Never raises.

    A Hermes without ``register_telegram_handler`` (older than the commit
    ClawBox pins), or one running plugins out of process (``plugins.isolation:
    host`` refuses native SDK handlers), still answers /update, and the desktop's
    Settings → System Update still installs; but a tap on the button is then
    dropped by Hermes unanswered. The warning below is what says so.
    """
    register = getattr(ctx, "register_telegram_handler", None)
    if not callable(register):
        logger.warning("clawbox_email_directives: this Hermes cannot register Telegram handlers; the update notice's Update button will not answer (use /update or Settings → System Update)")
        return False
    try:
        register(telegram_handler_factory)
        return True
    except Exception:  # noqa: BLE001
        logger.warning("clawbox_email_directives: could not wire the Update button", exc_info=True)
        return False
