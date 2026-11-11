"""The rules of clawbox_staff_guard, kept free of Hermes imports so they can be
tested on their own.

A member of staff on an organisation box runs on a Hermes profile of their own,
``~/.hermes/profiles/clawbox-staff-<name>`` (src/lib/hermes-staff-profile.ts),
whose config.yaml already builds their agent with the staff toolsets only. This
is the second lock, and the part toolsets cannot say:

* any tool config/org-staff-policy.json does not allow is refused here too;
* ``write_file`` and ``patch`` may touch only the member's own folder
  (``<profile>/workspace``); ``read_file``, ``search_files`` and
  ``vision_analyze`` may also open the chat's staged attachments, and nothing
  on the web;
* a relative path is made absolute INSIDE the folder (a ``modify``), so the
  file the tool opens is the one that was checked, whatever its working
  directory.

Every other profile — the owner's — gets no opinion.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any, Optional

_HERE = Path(__file__).resolve().parent
_USERNAME_RE = re.compile(r"^[a-z_][a-z0-9_-]{0,31}$")
_URL_RE = re.compile(r"^[a-z][a-z0-9+.-]*://", re.IGNORECASE)
_PATCH_FILE_RE = re.compile(r"^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$")
# The keys a Hermes file or vision tool names its target under.
PATH_KEYS = ("path", "file_path", "image_url", "url", "image", "target")

_table: Optional[dict] = None


def policy_table() -> dict:
    """config/org-staff-policy.json: beside the plugin once installed, at config/ in a checkout."""
    global _table
    if _table is not None:
        return _table
    for candidate in (_HERE / "org-staff-policy.json", _HERE.parent.parent.parent / "config" / "org-staff-policy.json"):
        try:
            parsed = json.loads(candidate.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(parsed, dict) and isinstance(parsed.get("hermes"), dict):
            _table = parsed
            return parsed
    raise RuntimeError("clawbox_staff_guard: config/org-staff-policy.json is missing or unreadable")


def attachments_dir() -> Optional[Path]:
    """The chat's staging directory, as register-mcp.sh recorded it beside the plugin."""
    try:
        paths = json.loads((_HERE / "clawbox-paths.json").read_text(encoding="utf-8"))
        value = paths.get("attachments") if isinstance(paths, dict) else None
        return Path(value) if isinstance(value, str) and value else None
    except (OSError, ValueError):
        return None


def staff_member_of(hermes_home: Any) -> Optional[str]:
    """The member of staff whose profile this home is, or None for every other profile."""
    if not hermes_home:
        return None
    home = Path(str(hermes_home))
    prefix = policy_table()["agentPrefix"]
    if home.parent.name != "profiles" or not home.name.startswith(prefix):
        return None
    name = home.name[len(prefix):]
    return name if _USERNAME_RE.match(name) else None


def _real(path: Path) -> Path:
    """The real path, symlinks resolved as far as the path exists."""
    try:
        return path.resolve(strict=False)
    except (OSError, RuntimeError):
        return Path(os.path.abspath(path))


def _inside(child: Path, parent: Path) -> bool:
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False


def _candidates(tool_name: str, args: dict) -> list[tuple[str, str]]:
    """``(key, value)`` for every path the call names; key ``""`` for one read out of a patch envelope."""
    out: list[tuple[str, str]] = []
    for key in PATH_KEYS:
        value = args.get(key)
        if isinstance(value, str) and value.strip():
            out.append((key, value))
    if tool_name == "patch":
        for value in args.values():
            if not isinstance(value, str):
                continue
            for line in value.splitlines():
                match = _PATCH_FILE_RE.match(line.strip())
                if match:
                    out.append(("", (match.group(1) or match.group(2)).strip()))
    return out


# Tool Search's controls: with tool search on, a deferred tool (session_search
# and todo_list on a staff profile) is reached only through these. What they
# search and describe is the profile's own tool list, already the staff one; a
# tool_call is judged by the tool it names, its own arguments rewritten in place.
TOOL_SEARCH_READS = ("tool_search", "tool_describe")
TOOL_SEARCH_CALL = "tool_call"


def judge(tool_name: str, args: Any, hermes_home: Any, user_home: Optional[str] = None) -> Optional[dict]:
    """The pre_tool_call directive for one call: ``None`` to let it run,
    ``{"action": "block", "message"}`` to refuse it, or ``{"action": "modify",
    "args"}`` to run it with its relative paths made absolute inside the folder."""
    username = staff_member_of(hermes_home)
    if username is None:
        return None
    if tool_name in TOOL_SEARCH_READS:
        return None
    if tool_name == TOOL_SEARCH_CALL:
        outer = args if isinstance(args, dict) else {}
        target = outer.get("id") or outer.get("name") or outer.get("tool")
        if not isinstance(target, str) or not target.strip():
            return block("`tool_call` without a tool it names")
        # The target's arguments: nested under `args`, or flat beside the id
        # (Hermes' bridge takes both; a small model drops the nesting).
        nested = isinstance(outer.get("args"), dict)
        inner_args = outer["args"] if nested else {k: v for k, v in outer.items() if k not in ("id", "name", "tool")}
        verdict = judge(target.strip().split(":")[-1], inner_args, hermes_home, user_home)
        if verdict is not None and verdict.get("action") == "modify":
            if nested:
                return {"action": "modify", "args": {**outer, "args": {**inner_args, **verdict["args"]}}}
            return {"action": "modify", "args": {**outer, **verdict["args"]}}
        return verdict
    policy = policy_table()["hermes"]
    if tool_name not in policy["allowTools"]:
        return block(f"`{tool_name}` is not available to members of staff")
    writing = tool_name in policy["writeTools"]
    reading = tool_name in policy["readTools"]
    if not writing and not reading:
        return None
    args = args if isinstance(args, dict) else {}
    folder = Path(str(hermes_home)) / "workspace"
    folder_real = _real(folder)
    attachments = attachments_dir()
    attachments_real = _real(attachments) if attachments else None
    home = user_home or os.path.expanduser("~")

    candidates = _candidates(tool_name, args)
    modified: dict = {}
    if not candidates:
        if writing:
            return block(f"`{tool_name}` without a file it names")
        # A search with no path searches the working directory: make that the folder.
        if tool_name == "search_files":
            modified["path"] = str(folder)
        return {"action": "modify", "args": modified} if modified else None

    for key, raw in candidates:
        value = raw.strip()
        # A file a patch envelope names relative to the working directory is
        # not rewritten (it is inside the patch text), so it is not run either.
        if not key and not os.path.isabs(value):
            return block(f"`{tool_name}` on {raw[:200]}, a relative path in a patch (name the file inside {folder})")
        if value.lower().startswith("file://"):
            value = value[len("file://"):]
        elif _URL_RE.match(value) or value.lower().startswith("data:"):
            return block(f"`{tool_name}` on {raw[:120]} (nothing on the web)")
        if value == "~" or value.startswith("~/"):
            value = os.path.join(home, value[2:]) if value != "~" else home
        absolute = Path(value) if os.path.isabs(value) else folder / value
        if not os.path.isabs(raw.strip()) and key:
            modified[key] = str(absolute)
        real = _real(absolute)
        if _inside(real, folder_real):
            continue
        if reading and attachments_real is not None and _inside(real, attachments_real):
            continue
        return block(f"`{tool_name}` on {raw[:200]}, outside their own folder ({folder})")
    return {"action": "modify", "args": modified} if modified else None


def block(reason: str) -> dict:
    return {
        "action": "block",
        "message": (
            f"Blocked by ClawBox: {reason}. On this organisation's ClawBox a member of staff's assistant "
            "answers questions, reads the files they attach, keeps their own memory and writes files only "
            "into their own folder; it has no web, browser, shell, messages, automations, sub-agents or "
            "system settings. Do not retry or look for another way; tell the user plainly that this is not "
            "available to them here and that their administrator can do it."
        ),
    }
