"""Lean mode for the on-device model, as a Hermes plugin.

WHAT IT IS FOR. When a turn runs on the llama.cpp model on the box (Gemma 4
E2B, ~2B parameters), each model call gets a short system prompt — who it is,
answer in the language of the user's last message, act instead of asking, keep
it short — and six tools instead of Hermes' full prompt and tool list, with
thinking off unless the turn asked for it. Every other call, on any cloud model,
is untouched. See local_lean.py.

THE NATIVE SEAMS. Hermes middleware (hermes_cli/middleware.py, v0.22):

* ``llm_request`` receives the provider kwargs Hermes built — ``messages``,
  ``tools``, ``reasoning_effort`` — immediately before each provider call, with
  the call's ``base_url`` and ``platform`` beside them, and a
  ``{"request": {...}}`` return replaces them for that call
  (agent/turn_api_request.py). Hooks cannot do this: ``pre_llm_call`` only
  appends to the user message, and a plugin prompt section can only add to the
  core prompt, never replace it.
* ``llm_execution`` wraps the provider call itself and returns its response
  (agent/turn_api_call.py), before Hermes checks the tool calls in it. Used for
  one thing: with Tool Search on, the ClawBox MCP tools are deferred and Hermes
  refuses a direct call to one ("Tool 'mcp__clawbox__webapp_create' does not
  exist"), while the 2B model cannot drive ``tool_call`` itself (it drops the
  tool's id). So the model is shown the tool directly and its call is handed to
  the bridge here — Hermes then runs it as any ``tool_call``.

Auxiliary calls (titles, compression) pass through neither. Middleware is
fail-open in Hermes, and this plugin catches its own faults too: a fault costs
the call its lean prompt, never the call — and the provider call itself always
runs exactly once, its own errors untouched.
"""

from __future__ import annotations

import logging

from .local_lean import bridge_deferred_calls, is_lean_request, lean_request

logger = logging.getLogger(__name__)


def _registry_schema(name: str):
    """A tool's schema from Hermes' own registry (deferred tools included)."""
    try:
        from tools.registry import registry

        return registry.get_schema(name)
    except Exception:
        return None


def llm_request(request=None, base_url=None, platform=None, **kwargs):
    """The lean provider kwargs for a call on the on-device model, or None."""
    try:
        lean = lean_request(request, base_url, platform, lookup=_registry_schema)
    except Exception:
        logger.warning("clawbox_local_lean: leaving the request unchanged", exc_info=True)
        return None
    if lean is None:
        return None
    return {"request": lean, "source": "clawbox_local_lean", "reason": "on-device model: lean prompt and tools"}


def llm_execution(request=None, original_request=None, next_call=None, base_url=None, platform=None, **kwargs):
    """Run the provider call; on the on-device model, hand a direct call to a
    deferred lean tool to Hermes' Tool Search bridge."""
    response = next_call(request)
    if is_lean_request(base_url, platform):
        try:
            bridge_deferred_calls(response, request, original_request)
        except Exception:
            logger.warning("clawbox_local_lean: leaving the response unchanged", exc_info=True)
    return response


def register(ctx) -> None:
    ctx.register_middleware("llm_request", llm_request)
    ctx.register_middleware("llm_execution", llm_execution)


__all__ = ["llm_execution", "llm_request", "register"]
