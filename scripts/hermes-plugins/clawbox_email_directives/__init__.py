"""ClawBox's outbound guard for ``EMAIL:`` card directives, as a Hermes plugin.

WHAT IT IS FOR. ``EMAIL:4471`` is how the agent tells a ClawBox CHAT that its
reply refers to a message the owner can open: ``chat-email-refs.ts`` lifts the
line out and the bubble shows a card. Telegram, WhatsApp, Discord and every
other channel have no cards, so there the line is an internal id printed at the
owner — the 2026-09-03 screenshot behind TASK-679.

PR #605 fixed the half ClawBox owns: the email tools now ask for the directive
only on the two ClawBox chat surfaces. That half is a SENTENCE in a tool result,
and a sentence is something a model can misread. This is the other half: the
strip happens on the way out, whatever the model wrote.

THE NATIVE SEAM. ``transform_llm_output`` — Hermes' own plugin hook, fired once
per turn after the tool loop and BEFORE delivery and speech
(``agent/turn_finalizer.py:592-613`` in the 0.20.5 checkout on the box). A
non-empty ``str`` return replaces the reply; ``None`` leaves it alone; the
dispatcher catches every exception (``hermes_cli/plugins.py:5140``,
``turn_finalizer.py:612``), so a fault here can never block a reply.

WHY THE RULE IS "KEEP ON A NAMED SET, STRIP OTHERWISE" AND NEVER A CHANNEL
DENY-LIST. ``Platform._missing_`` (``gateway/config.py:349``) mints a platform
member for any channel a plugin adapter brings, so a deny-list of channel names
would silently miss the next channel anyone installs. The keep-list is closed
and knowable; everything outside it is a surface where a card cannot render.
"""

from __future__ import annotations

import logging

from .approvals import pre_gateway_dispatch
from .email_directives import strip_email_directives

logger = logging.getLogger(__name__)

#: Surfaces that KEEP the directive.
#:
#: ``clawbox-chat`` is ClawBox's own label: its dashboard chat names itself in
#: the ``session.create``/``session.resume`` params (``src/lib/
#: hermes-dashboard-turn.ts``), Hermes stores it as the session ``source``
#: (``tui_gateway/methods_session.py:35,106``) and hands it to the agent as
#: ``platform`` (``tui_gateway/server.py:7199`` → ``agent/agent_init.py:654``).
#: Nothing but ClawBox produces that string, and it is the surface that renders
#: the card — so the directive has to survive there.
#:
#: The rest is Hermes' OWN definition of a surface with a person at the machine,
#: copied from ``agent/coding_context.py:72``
#: (``INTERACTIVE_CODING_PLATFORMS = {"cli", "tui", "acp", "desktop", ""}``)
#: rather than invented here. ``cli`` is deliberately among them and carries its
#: own weight twice: it is ClawBox's chat spawn fallback (``/setup-api/hermes/
#: chat`` runs ``hermes chat -q``, which sets ``platform="cli"``), and on that
#: path a REPLACING transform would make the CLI print
#: "[Response transformed after streaming]" above the whole answer
#: (``cli.py:3502-3518``) — a banner ClawBox's route would capture as part of
#: the reply. Keeping ``cli`` means this plugin never fires there.
#:
#: ``subagent`` and ``curator`` are here for a different reason: they are not
#: SURFACES at all. A delegated turn's answer is consumed by the PARENT AGENT
#: (``tools/delegate_tool.py:1955``, ``agent/curator.py:1949``), so a strip there
#: deletes something the parent still needs rather than something a person
#: cannot use — the owner asks the chat to read their mail, the mailbox work is
#: delegated, and the parent comes back with a summary whose ids are already
#: gone and no cards to render. ``cron`` and ``api_server`` are deliberately NOT
#: here: their output does end up in front of somebody.
KEEP_PLATFORMS = frozenset(
    {"", "cli", "tui", "acp", "desktop", "clawbox-chat", "subagent", "curator"}
)

#: What a reply that was NOTHING BUT directives becomes.
#:
#: The hook cannot say "send nothing": ``turn_finalizer.py:607`` accepts a
#: replacement only when it is a non-empty ``str``, and the shipped docs say so
#: outright ("an empty string is not accepted as a replacement"). So the choice
#: on this harness is between delivering the internal ids and delivering
#: something that carries none. This is the second. It cannot be mistaken for
#: an answer, it is the same in every language, and it is unreachable unless the
#: model both ignored the tool instruction AND wrote no prose at all.
#:
#: THE OPENCLAW TWIN ANSWERS THIS DIFFERENTLY, and deliberately: there the hook
#: returns an empty text and the core suppresses the message outright
#: (`empty_after_reply_payload_sending_hook`), which is the better outcome and
#: is simply not available here. The divergence is the harnesses', not a
#: decision taken twice — see
#: `scripts/openclaw-plugins/clawbox-email-directives/index.mjs`.
EMPTY_REPLY_PLACEHOLDER = "…"


def transform_llm_output(response_text=None, platform=None, **kwargs):
    """The reply without its `EMAIL:` directives, or `None` to leave it alone.

    `None` on every "nothing to do" path, because that is the return Hermes
    reads as "unchanged" — an unnecessary replacement would set
    `response_transformed`, which makes the gateway re-send or edit an already
    streamed message (`gateway/run.py:29745`, `:29804`) for no reason.
    """
    try:
        if not isinstance(response_text, str) or not response_text:
            return None
        if (platform or "").strip().lower() in KEEP_PLATFORMS:
            return None
        stripped = strip_email_directives(response_text)
        if stripped == response_text:
            return None
        return stripped or EMPTY_REPLY_PLACEHOLDER
    except Exception:
        # Belt AND braces: Hermes already catches this (plugins.py:5140), and
        # catching it here too keeps the failure attributable to this plugin in
        # the log instead of to the hook name. Either way the turn continues
        # with the reply as the model wrote it — a directive read by the owner
        # is a blemish, a reply that never arrives is a broken box.
        logger.warning("clawbox_email_directives: leaving the reply unchanged", exc_info=True)
        return None


def register(ctx) -> None:
    ctx.register_hook("transform_llm_output", transform_llm_output)
    # The inbound half. See approvals.py: it claims ONLY a message that is
    # exactly a verb and a code, so every other message reaches the agent
    # untouched, and it fails open on anything unexpected.
    ctx.register_hook("pre_gateway_dispatch", pre_gateway_dispatch)


__all__ = ["pre_gateway_dispatch", "register", "transform_llm_output"]
