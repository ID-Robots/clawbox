"""The rules of clawbox_staff_guard, kept free of Hermes imports so they can be
tested on their own.

A member of staff on an organisation box runs on a Hermes profile of their own,
``~/.hermes/profiles/clawbox-staff-<name>`` (src/lib/hermes-staff-profile.ts),
whose config.yaml already builds their agent with the staff toolsets only. This
is the second lock, and the part toolsets cannot say:

* any tool config/org-staff-policy.json does not allow is refused here too;
* ``write_file`` and ``patch`` may touch only the member's own folder
  (``<profile>/workspace``); ``read_file``, ``search_files`` and
  ``vision_analyze`` may also open the chat's staged attachments THAT ARE
  THEIRS — by the record ClawBox keeps of whose upload each staged file is
  (src/lib/chat-media-owners.ts), so a member who learns another's
  attachment path still cannot open it — and nothing on the web;
* a relative path is made absolute INSIDE the folder (a ``modify``), so the
  file the tool opens is the one that was checked, whatever its working
  directory;
* an MCP tool runs only when it belongs to a relay entry the owner granted
  THIS member (TASK-2516): ClawBox writes each member's entries
  (``cbstaff-<8 hex>-<server>``, src/lib/staff-mcp.ts) into their profile's
  ``mcp_servers`` and lists them per profile in ``staff-mcp-grants.json``
  beside this plugin; missing or unreadable grants nothing.

Every other profile — the owner's — gets no opinion, except that it never
calls a member's relay entry (it carries that member's relay token).
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


def recorded_paths() -> dict:
    """What register-mcp.sh recorded beside the plugin (clawbox-paths.json), as
    the dashboard process does not know where ClawBox keeps its data:
    ``attachments`` (the chat's staging directory) and ``mediaOwners`` (whose
    upload each staged file is, ``{realpath: username}``,
    src/lib/chat-media-owners.ts). ``{}`` when it cannot be read: then no
    staged file is a member's (fail closed)."""
    try:
        paths = json.loads((_HERE / "clawbox-paths.json").read_text(encoding="utf-8"))
        return paths if isinstance(paths, dict) else {}
    except (OSError, ValueError):
        return {}


def _path_of(paths: dict, key: str) -> Optional[Path]:
    value = paths.get(key)
    return Path(value) if isinstance(value, str) and value else None


def staged_file_owned_by(username: str, real: Path, root_real: Path, owners_file: Optional[Path]) -> bool:
    """Is ``real``, a resolved path below the staging root ``root_real``,
    recorded as ``username``'s upload? The file itself or a folder it sits in
    below the root (a dropped folder is recorded once, by its root) — the rule
    of chat-media-owners.ts ``isMediaOwnedBy``. No record: nobody's."""
    if owners_file is None:
        return False
    try:
        owners = json.loads(owners_file.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    if not isinstance(owners, dict):
        return False
    current = real
    while _inside(current, root_real) and current != root_real:
        owner = owners.get(str(current))
        if isinstance(owner, str):
            return owner == username
        current = current.parent
    return False


def staff_mcp_grants(paths: Optional[dict] = None) -> dict:
    """``{agent id: [entry names]}`` from ``staff-mcp-grants.json`` beside the
    plugin (``paths["staffMcpGrants"]`` stands in for it in tests). ``{}`` when it
    cannot be read: then no relay entry is anyone's (fail closed)."""
    if paths is not None and "staffMcpGrants" in paths:
        raw = paths.get("staffMcpGrants")
    else:
        try:
            raw = json.loads((_HERE / "staff-mcp-grants.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
    agents = raw.get("agents") if isinstance(raw, dict) else None
    if not isinstance(agents, dict):
        return {}
    return {k: [n for n in v if isinstance(n, str)] for k, v in agents.items() if isinstance(k, str) and isinstance(v, list)}


def _mcp_name_component(value: str) -> str:
    """An MCP server name as Hermes puts it into a tool's registry name."""
    return re.sub(r"[^A-Za-z0-9_]", "_", value)


def _mcp_tool_prefixes(entry: str) -> tuple:
    """The registry-name prefixes of a server's tools: ``mcp__<server>__`` (current
    Hermes) and ``mcp_<server>_`` (earlier releases)."""
    s = _mcp_name_component(entry)
    return (f"mcp__{s}__", f"mcp_{s}_")


def is_staff_relay_tool(tool_name: str) -> bool:
    """Does this tool belong to a member's relay entry (``cbstaff-…``)?"""
    prefix = _mcp_name_component(policy_table().get("mcpEntryPrefix", "cbstaff-")).lower()
    name = tool_name.lower()
    return name.startswith(f"mcp__{prefix}") or name.startswith(f"mcp_{prefix}")


def granted_relay_tool(username: str, tool_name: str, paths: Optional[dict] = None) -> bool:
    """Is ``tool_name`` a tool of a relay entry granted to ``username``'s profile?"""
    agent = policy_table()["agentPrefix"] + username
    for entry in staff_mcp_grants(paths).get(agent, []):
        if any(tool_name.startswith(prefix) for prefix in _mcp_tool_prefixes(entry)):
            return True
    return False


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


def judge(tool_name: str, args: Any, hermes_home: Any, user_home: Optional[str] = None, paths: Optional[dict] = None) -> Optional[dict]:
    """The pre_tool_call directive for one call: ``None`` to let it run,
    ``{"action": "block", "message"}`` to refuse it, or ``{"action": "modify",
    "args"}`` to run it with its relative paths made absolute inside the folder.
    ``paths`` stands in for clawbox-paths.json (tests)."""
    username = staff_member_of(hermes_home)
    if username is None:
        # The owner's (or any other) profile never calls a member's relay
        # entry: it carries that member's relay token.
        if is_staff_relay_tool(tool_name):
            return {"action": "block", "message": "Blocked by ClawBox: this MCP server belongs to a member of staff's assistant."}
        return None
    if tool_name in TOOL_SEARCH_READS:
        return None
    if tool_name == TOOL_SEARCH_CALL:
        return _judge_tool_call(args, hermes_home, user_home, paths)
    policy = policy_table()["hermes"]
    if tool_name not in policy["allowTools"]:
        # A tool of an MCP server the owner granted this member (TASK-2516):
        # the relay behind it holds its tools to the owner's grant.
        if is_staff_relay_tool(tool_name) and granted_relay_tool(username, tool_name, paths):
            return None
        return block(f"`{tool_name}` is not available to members of staff")
    writing = tool_name in policy["writeTools"]
    reading = tool_name in policy["readTools"]
    if not writing and not reading:
        return None
    args = args if isinstance(args, dict) else {}
    folder = Path(str(hermes_home)) / "workspace"
    folder_real = _real(folder)
    recorded = recorded_paths() if paths is None else paths
    attachments = _path_of(recorded, "attachments")
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
            if staged_file_owned_by(username, real, attachments_real, _path_of(recorded, "mediaOwners")):
                continue
            return block(f"`{tool_name}` on {raw[:200]}, a chat attachment that is not theirs")
        return block(f"`{tool_name}` on {raw[:200]}, outside their own folder ({folder})")
    return {"action": "modify", "args": modified} if modified else None


def _entry_arguments(entry: dict) -> tuple[Optional[str], dict]:
    """``(key, arguments)`` of one tool_call entry: Hermes' own ``arguments``
    (a dict, or JSON text), an ``args`` dict, or — flat — the entry's other fields."""
    for key in ("arguments", "args"):
        value = entry.get(key)
        if isinstance(value, str):
            try:
                value = json.loads(value)
            except ValueError:
                value = None
        if isinstance(value, dict):
            return key, value
    return None, {k: v for k, v in entry.items() if k not in ("name", "id", "tool")}


def _judge_tool_call(args: Any, hermes_home: Any, user_home: Optional[str], paths: Optional[dict] = None) -> Optional[dict]:
    """A Tool Search ``tool_call`` judged by the tool(s) it names: Hermes takes
    ``{"name", "arguments"}`` or a batch under ``calls`` (tools/tool_labels.py),
    and a small model may send the target's fields flat. Any refused entry refuses
    the whole call; relative paths are rewritten inside each entry."""
    outer = args if isinstance(args, dict) else {}
    batched = isinstance(outer.get("calls"), list)
    entries = outer["calls"] if batched else [outer]
    rewritten = []
    changed = False
    for raw in entries:
        entry = raw if isinstance(raw, dict) else {}
        target = entry.get("name") or entry.get("id") or entry.get("tool")
        if not isinstance(target, str) or not target.strip():
            return block("`tool_call` without a tool it names")
        key, inner = _entry_arguments(entry)
        verdict = judge(target.strip().split(":")[-1], inner, hermes_home, user_home, paths)
        if verdict is not None and verdict.get("action") == "block":
            return verdict
        if verdict is not None and verdict.get("action") == "modify":
            changed = True
            entry = {**entry, key: {**inner, **verdict["args"]}} if key else {**entry, **verdict["args"]}
        rewritten.append(entry)
    if not changed:
        return None
    return {"action": "modify", "args": {**outer, "calls": rewritten} if batched else rewritten[0]}


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
