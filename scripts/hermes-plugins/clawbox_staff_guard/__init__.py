"""ClawBox's staff guard, as a Hermes plugin (TASK-2444, TASK-2445).

WHAT IT IS FOR. On an organisation box (org_mode, src/lib/org-mode.ts) a member
of staff's chat runs on a Hermes profile of their own,
``~/.hermes/profiles/clawbox-staff-<name>`` (src/lib/hermes-staff-profile.ts),
whose config.yaml builds the agent with the staff toolsets of
config/org-staff-policy.json and nothing else. This hook is the part of the rule
toolsets cannot express — a member's file tools write only inside their own
folder and read only there or in the chat's staged attachments — and a second
refusal of every tool the table does not name. See staff_guard.py.

THE NATIVE SEAM. Hermes' ``pre_tool_call`` hook (hermes_cli/plugins.py
``_get_pre_tool_call_directive_details``): a ``{"action": "block", "message"}``
return vetoes the call and its message becomes the tool result; ``{"action":
"modify", "args"}`` runs it with those arguments. The hook runs in the turn's
own context, where ``get_hermes_home()`` is the session's profile home — the
dashboard binds it per session (tui_gateway/methods_session.py), and the tool
pool copies the context into its workers (tools/daemon_pool.py).

Hook failures never block in Hermes, so this one judges defensively: a call it
cannot judge on a staff profile is refused.
"""

from __future__ import annotations

import logging

from .staff_guard import block, judge, staff_member_of

logger = logging.getLogger(__name__)


def _current_home():
    try:
        from hermes_constants import get_hermes_home

        return get_hermes_home()
    except Exception:
        return None


def pre_tool_call(tool_name=None, args=None, **kwargs):
    home = _current_home()
    try:
        return judge(str(tool_name or ""), args, home)
    except Exception:
        logger.warning("clawbox_staff_guard: could not judge a tool call", exc_info=True)
        try:
            if staff_member_of(home) is not None:
                return block("the staff policy could not be applied to this call")
        except Exception:
            # The table itself would not load; a staff profile still looks like one.
            if home is not None and "clawbox-staff-" in str(home):
                return block("the staff policy could not be read")
        return None


def register(ctx) -> None:
    ctx.register_hook("pre_tool_call", pre_tool_call)
