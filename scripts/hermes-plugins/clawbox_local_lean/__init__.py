"""Lean mode for the on-device model, as a Hermes plugin.

WHAT IT IS FOR. When a turn runs on the llama.cpp model on the box (Gemma 4
E2B, ~2B parameters), each model call gets a short system prompt — who it is,
answer in the language of the user's last message, act instead of asking, keep
it short — and six tools instead of Hermes' full prompt and tool list, with
thinking off unless the turn asked for it. Every other call, on any cloud model,
is untouched. See local_lean.py.

THE NATIVE SEAM. ``llm_request`` middleware (hermes_cli/middleware.py, v0.22):
it receives the provider kwargs Hermes built — ``messages``, ``tools``,
``reasoning_effort`` — immediately before each provider call, with the call's
``base_url`` and ``platform`` beside them, and a ``{"request": {...}}`` return
replaces them for that call (agent/turn_api_request.py). Hooks cannot do this:
``pre_llm_call`` only appends context to the user message, and a plugin system
prompt section can only add to the core prompt, never replace it. Auxiliary
calls (titles, compression) do not pass through this middleware at all.

Middleware is fail-open in Hermes (a raising callback is logged and the request
goes out unchanged), and this one catches its own faults too: a fault costs the
call its lean prompt, never the call.
"""

from __future__ import annotations

import logging

from .local_lean import lean_request

logger = logging.getLogger(__name__)


def llm_request(request=None, base_url=None, platform=None, **kwargs):
    """The lean provider kwargs for a call on the on-device model, or None."""
    try:
        lean = lean_request(request, base_url, platform)
    except Exception:
        logger.warning("clawbox_local_lean: leaving the request unchanged", exc_info=True)
        return None
    if lean is None:
        return None
    return {"request": lean, "source": "clawbox_local_lean", "reason": "on-device model: lean prompt and tools"}


def register(ctx) -> None:
    ctx.register_middleware("llm_request", llm_request)


__all__ = ["llm_request", "register"]
