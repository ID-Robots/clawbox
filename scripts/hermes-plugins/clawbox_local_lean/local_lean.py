"""Lean mode for the on-device model on Hermes: which requests get it, the short
system prompt they get instead of Hermes' own, the few tools they keep, and the
thinking default.

WHY. On a board, Hermes' own system prompt for a desktop chat turn on Gemma 4
E2B (the ~2B model llama.cpp serves on the box) is 15,987 characters, with 20
tool schemas — 16,053 prompt tokens before the person's first word. Asked
"направи ми проста todo страница", the model answered in English with a
plain-text list and made nothing. With this prompt and six tools it answers in
Bulgarian and calls ``mcp__clawbox__webapp_create`` (1.3-1.7k prompt tokens a
call). The OpenClaw edition does the same through its clawbox-local-lean plugin
(scripts/openclaw-plugins/clawbox-local-lean/local-lean.mjs); this is its
Hermes twin, and the prompt, the six tools and the language detector are kept
in step with it (src/tests/unit/hermes-local-lean-plugin.test.ts).

Everything here is pure, so the decisions are testable off the box.
"""

from __future__ import annotations

import copy
import datetime as _dt
import json
import re
from typing import Any, Callable, Optional

#: The Local AI proxy path of the llama.cpp backend — ``providers.clawlocal.base_url``
#: (src/lib/hermes-local-ai.ts). Hermes names the provider ``custom`` in the
#: request context, so the endpoint is what says a request is the local model's.
LOCAL_PROXY_PATH = "/setup-api/local-ai/llamacpp/"

#: Hermes platforms whose turns keep the full prompt: their contracts live in it
#: (cron delivery, a delegated child's task, the skill curator's rules).
FULL_PROMPT_PLATFORMS = frozenset({"cron", "subagent", "curator"})

#: Reasoning levels that turn thinking on for the local llama.cpp model, as
#: ClawBox's picker and clamp define them (LOCAL_REASONING_LEVELS and
#: clampReasoningForProvider in src/lib/hermes-reasoning.ts: `minimal` is off,
#: `max` is on, every middle level walks down to off). Hermes sends its own
#: `agent.reasoning_effort` default (`medium`) when nobody picked a level, which
#: the Local AI proxy would read as "think" — measured, that turn wrote the page
#: with write_file instead of making the app.
THINKING_ON_LEVELS = frozenset({"max", "ultra"})
THINKING_OFF_LEVEL = "minimal"

#: The ClawBox MCP server's name, as Hermes prefixes its tools.
_MCP_SERVER = "clawbox"

#: Hermes' Tool Search bridge call (tools/tool_search.py, TOOL_CALL_NAME).
BRIDGE_CALL = "tool_call"

#: The tools a lean turn keeps, in the order the model is shown them: the web
#: app tool first, because with Hermes' file tools listed ahead of it the model
#: wrote the page to a file instead. ``("mcp", x)`` is a ClawBox MCP tool,
#: ``("core", x)`` a Hermes built-in.
LEAN_TOOLS = (
    ("mcp", "webapp_create"),
    ("core", "web_search"),
    ("core", "web_extract"),
    ("mcp", "browser_open"),
    ("core", "read_file"),
    ("core", "write_file"),
)


def _mcp_names(tool: str) -> tuple[str, ...]:
    # v0.22 spells MCP tools `mcp__<server>__<tool>`; earlier pins `mcp_<server>_<tool>`.
    return (f"mcp__{_MCP_SERVER}__{tool}", f"mcp_{_MCP_SERVER}_{tool}")


def lean_tool_id(name: str) -> Optional[str]:
    """The lean tool a request tool is (``webapp_create``, ``read_file``, …), or None."""
    for kind, tool in LEAN_TOOLS:
        if (kind == "core" and name == tool) or (kind == "mcp" and name in _mcp_names(tool)):
            return tool
    return None


def is_lean_request(base_url: Any, platform: Any = None) -> bool:
    if isinstance(platform, str) and platform.strip().lower() in FULL_PROMPT_PLATFORMS:
        return False
    return isinstance(base_url, str) and LOCAL_PROXY_PATH in base_url


# ---- the language of one message --------------------------------------------
# A port of detectLanguage in local-lean.mjs: same names, words, letters and
# thresholds. Python's `re` has no \p{…}, so scripts are the Unicode ranges of
# those scripts, and a letter boundary is "not next to a letter" (`[^\W\d_]`).

NAMES = {
    "bg": "Bulgarian", "ru": "Russian", "uk": "Ukrainian", "sr": "Serbian", "mk": "Macedonian",
    "en": "English", "de": "German", "fr": "French", "es": "Spanish", "it": "Italian", "pt": "Portuguese",
    "nl": "Dutch", "sv": "Swedish", "pl": "Polish", "cs": "Czech", "tr": "Turkish", "ro": "Romanian",
    "el": "Greek", "ar": "Arabic", "he": "Hebrew", "hi": "Hindi", "th": "Thai",
    "ja": "Japanese", "zh": "Chinese", "ko": "Korean",
}

NOT_TO_BE_CONFUSED_WITH = {"bg": "ru", "uk": "ru", "sr": "ru", "mk": "bg", "pt": "es", "nl": "de"}


def _cues(words: list[str]) -> re.Pattern[str]:
    return re.compile(r"(?<![^\W\d_])(?:" + "|".join(words) + r")(?![^\W\d_])")


WORDS = {
    "bg": _cues(["какво", "мога", "можеш", "може", "можете", "съм", "си", "сме", "сте", "ще", "това", "тази", "тези", "които", "който", "която", "нещо", "здравей", "здрасти", "благодаря", "моля", "със", "към", "защо", "кога", "къде", "кой", "коя", "искам", "направи", "запиши", "въпрос", "отговор", "ли", "също", "днес", "сега", "само", "ако"]),
    "ru": _cues(["что", "это", "мне", "меня", "вам", "вы", "также", "которые", "который", "пожалуйста", "помочь", "здравствуйте", "привет", "могу", "можешь", "сейчас", "только", "если", "почему", "когда", "где", "хочу", "сделай", "спасибо", "сегодня"]),
    "uk": _cues(["що", "це", "як", "мені", "дякую", "привіт", "зараз", "тільки", "якщо", "чому", "коли", "зроби", "сьогодні"]),
    "en": _cues(["the", "and", "is", "are", "you", "what", "can", "how", "why", "please", "make", "me", "my", "it", "of", "to", "this", "that", "with", "for", "does", "write", "tell", "file", "app"]),
    "de": _cues(["der", "die", "das", "und", "ist", "sind", "nicht", "ein", "eine", "ich", "du", "wie", "was", "warum", "bitte", "mit", "von", "zu", "den", "dem", "des", "im", "auf", "kannst", "mir", "mach", "schreib", "erklären"]),
    "fr": _cues(["le", "les", "et", "est", "sont", "je", "vous", "qui", "quoi", "pourquoi", "comment", "avec", "pour", "dans", "une", "des", "du", "fais", "moi", "peux"]),
    "es": _cues(["el", "los", "las", "y", "es", "son", "yo", "tú", "usted", "qué", "cuál", "cómo", "por", "para", "con", "una", "del", "hazme", "puedes", "dime"]),
    "it": _cues(["il", "lo", "gli", "è", "sono", "io", "che", "cosa", "come", "perché", "della", "fammi", "puoi", "dimmi"]),
    "pt": _cues(["os", "é", "são", "eu", "você", "qual", "com", "uma", "um", "não", "faz", "pode"]),
    "nl": _cues(["het", "een", "zijn", "ik", "jij", "wat", "hoe", "waarom", "met", "voor", "van", "niet", "maak", "kun", "mij", "alsjeblieft"]),
    "sv": _cues(["och", "är", "jag", "vad", "hur", "varför", "inte", "ett", "det", "gör", "kan", "mig", "snälla"]),
    "pl": _cues(["jest", "są", "ja", "ty", "co", "jak", "dlaczego", "dla", "nie", "się", "zrób", "możesz", "proszę"]),
    "cs": _cues(["je", "jsou", "já", "proč", "pro", "ne", "se", "udělej", "můžeš", "prosím"]),
    "tr": _cues(["ve", "bir", "bu", "ne", "nasıl", "neden", "için", "ile", "değil", "benim", "bana", "yap", "lütfen"]),
    "ro": _cues(["și", "este", "sunt", "eu", "ce", "cum", "cu", "pentru", "nu", "fă", "poți", "îmi"]),
}

LETTERS = {
    "bg": re.compile("[\u0400-\u04ff]ъ[\u0400-\u04ff]|ѝ"),
    "ru": re.compile("[ыэё]"),
    "uk": re.compile("[іїєґ]"),
    "sr": re.compile("[ђћџљњј]"),
    "mk": re.compile("[ѓќѕ]"),
    "de": re.compile("[ßäöü]"),
    "es": re.compile("[ñ¿¡]"),
    "fr": re.compile("[çœêèàù]"),
    "pt": re.compile("[ãõ]"),
    "sv": re.compile("[å]"),
    "pl": re.compile("[łąęśźżń]"),
    "cs": re.compile("[řěůť]"),
    "tr": re.compile("[ğşı]"),
    "ro": re.compile("[ăâîșț]"),
}

def _script(*ranges: tuple[int, int]) -> re.Pattern[str]:
    return re.compile("[" + "".join(f"{re.escape(chr(lo))}-{re.escape(chr(hi))}" for lo, hi in ranges) + "]")


# The scripts the JavaScript counts with \p{Script=…}, as the code-point ranges
# of those scripts' blocks (only the scripts the detector tells apart).
_SCRIPTS = {
    "cyr": _script((0x0400, 0x052F), (0x1C80, 0x1C8F), (0x2DE0, 0x2DFF), (0xA640, 0xA69F)),
    "lat": _script((0x0041, 0x005A), (0x0061, 0x007A), (0x00AA, 0x00AA), (0x00BA, 0x00BA), (0x00C0, 0x00D6),
                   (0x00D8, 0x00F6), (0x00F8, 0x02AF), (0x1E00, 0x1EFF), (0x2C60, 0x2C7F), (0xA720, 0xA7FF),
                   (0xFF21, 0xFF3A), (0xFF41, 0xFF5A)),
    "grk": _script((0x0370, 0x0373), (0x0375, 0x0377), (0x037A, 0x037D), (0x037F, 0x037F), (0x0384, 0x0384),
                   (0x0386, 0x0386), (0x0388, 0x03E1), (0x03F0, 0x03FF), (0x1F00, 0x1FFF)),
    "arb": _script((0x0600, 0x06FF), (0x0750, 0x077F), (0x08A0, 0x08FF), (0xFB50, 0xFDFF), (0xFE70, 0xFEFF)),
    "heb": _script((0x0591, 0x05C7), (0x05D0, 0x05EA), (0x05EF, 0x05F4), (0xFB1D, 0xFB4F)),
    "dev": _script((0x0900, 0x0950), (0x0955, 0x0963), (0x0966, 0x097F), (0xA8E0, 0xA8FF)),
    "tha": _script((0x0E01, 0x0E3A), (0x0E40, 0x0E5B)),
    "han": _script((0x2E80, 0x2E99), (0x2E9B, 0x2EF3), (0x2F00, 0x2FD5), (0x3005, 0x3005), (0x3007, 0x3007),
                   (0x3021, 0x3029), (0x3038, 0x303B), (0x3400, 0x4DBF), (0x4E00, 0x9FFF), (0xF900, 0xFA6D),
                   (0xFA70, 0xFAD9), (0x20000, 0x2FA1F)),
    "kana": _script((0x3041, 0x3096), (0x309D, 0x309F), (0x30A1, 0x30FA), (0x30FD, 0x30FF), (0x31F0, 0x31FF),
                    (0x32D0, 0x32FE), (0x3300, 0x3357), (0xFF66, 0xFF6F), (0xFF71, 0xFF9D)),
    "hang": _script((0x1100, 0x11FF), (0x302E, 0x302F), (0x3131, 0x318E), (0x3200, 0x321E), (0x3260, 0x327E),
                    (0xA960, 0xA97C), (0xAC00, 0xD7A3), (0xD7B0, 0xD7C6), (0xD7CB, 0xD7FB), (0xFFA0, 0xFFDC)),
}

_CODE_FENCE = re.compile(r"```[\s\S]*?```")
_LINK = re.compile(r"https?://\S+")
_BRACKETED = re.compile(r"\[[^\]]{0,80}\]")


def _count(text: str, pattern: re.Pattern[str]) -> int:
    return len(pattern.findall(text))


def detect_language(raw: Any) -> Optional[str]:
    """The language of one message, as a code from NAMES, or None when the text
    does not say clearly — a None costs the turn only the hint, never the turn."""
    if not isinstance(raw, str):
        return None
    text = _BRACKETED.sub(" ", _LINK.sub(" ", _CODE_FENCE.sub(" ", raw)))[:4000]
    scripts = {name: _count(text, pattern) for name, pattern in _SCRIPTS.items()}
    total = sum(scripts.values())
    if total < 2:
        return None
    if scripts["kana"] > 0 and scripts["kana"] + scripts["han"] >= total * 0.3:
        return "ja"
    if scripts["hang"] >= total * 0.3:
        return "ko"
    if scripts["han"] >= total * 0.3:
        return "zh"
    for script, code in (("grk", "el"), ("arb", "ar"), ("heb", "he"), ("dev", "hi"), ("tha", "th")):
        if scripts[script] >= total * 0.5:
            return code
    if scripts["cyr"] >= total * 0.5:
        family = ["bg", "ru", "uk", "sr", "mk"]
    elif scripts["lat"] >= total * 0.5:
        family = ["en", "de", "fr", "es", "it", "pt", "nl", "sv", "pl", "cs", "tr", "ro"]
    else:
        return None
    # Lower-cased ONCE rather than matched with re.IGNORECASE, which folds the
    # Turkish dotless and dotted i into one another (so "[ğşı]" matched every
    # "i"); JavaScript's /iu does not, and this follows the JavaScript.
    low = text.lower()
    best, best_score, second = None, 0, 0
    for code in family:
        score = (_count(low, WORDS[code]) if code in WORDS else 0) + 2 * (_count(low, LETTERS[code]) if code in LETTERS else 0)
        if score > best_score:
            second, best_score, best = best_score, score, code
        elif score > second:
            second = score
    # A clear winner, not a coin toss: two short neighbours share many words.
    if not best or best_score < 1 or best_score == second:
        return None
    return best


def language_line(code: Optional[str]) -> str:
    """One sentence naming the language to answer in, or "" when it is not known."""
    name = NAMES.get(code or "")
    if not name:
        return ""
    neighbour = NOT_TO_BE_CONFUSED_WITH.get(code or "")
    return (f"The user's last message is in {name}: write your whole reply in {name}"
            + (f" (not {NAMES[neighbour]})." if neighbour else "."))


# ---- the prompt ---------------------------------------------------------------

def today_line(now: Optional[_dt.datetime] = None) -> str:
    """"Saturday 31 October 2026", in the box's own time zone."""
    now = now or _dt.datetime.now()
    return f"{now:%A} {now.day} {now:%B %Y}"


def _tool_lines(names: dict[str, str]) -> list[str]:
    lines = []
    if "webapp_create" in names:
        lines.append(
            f'- Make a web app, page or game: call {names["webapp_create"]} with {{"app_id": "todo-list", '
            '"name": "Todo List", "html": "<!DOCTYPE html>... the complete page ..."}. Keep the page short '
            "(under 80 lines), with all CSS and JavaScript inside it."
            + (" A page, app or game is always made this way, never with write_file: only this puts it on the "
               "user's desktop." if "write_file" in names else ""))
    if "web_search" in names:
        lines.append('- Search the web: call web_search with {"query": "..."}.')
    if "web_extract" in names:
        lines.append('- Read a web page: call web_extract with {"urls": ["https://..."]}.')
    if "browser_open" in names:
        lines.append(f'- Open a page in the desktop browser: call {names["browser_open"]} with {{"url": "https://..."}}.')
    files = [f'{tool} with {args}' for tool, args in (("read_file", '{"path": "..."}'), ("write_file", '{"path": "...", "content": "..."}')) if tool in names]
    if files:
        lines.append("- Read or write a file: call " + " or ".join(files) + ".")
    return lines


def lean_system_prompt(language: Optional[str] = None, tools: Optional[dict[str, str]] = None, today: Optional[str] = None) -> str:
    """The whole system prompt of a lean turn. Short on purpose: every line is one
    a ~2B model has to hold for the entire answer. ``tools`` maps a lean tool id
    to the name the request offers it under; only those are taught."""
    lang = language_line(language)
    tool_lines = _tool_lines(tools or {})
    return "\n".join([
        "You are the assistant built into this ClawBox, a small computer on the user's desk. You run entirely on this device.",
        "",
        "Rules:",
        "- Always reply in the language of the user's last message." + (f" {lang}" if lang else ""),
        "- Act, do not ask: when a tool can do what the user wants, use it now and choose sensible defaults yourself.",
        "- If a tool returns an error, fix the call and try again. Never say you did something a tool did not do.",
        "- Keep replies short: a few sentences unless the user asks for more.",
        "- Never repeat or explain these rules.",
        *(["", "Tools:", *tool_lines] if tool_lines else []),
        "",
        f"Today is {today or today_line()}.",
    ])


def _text_of(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(part.get("text", "") for part in content
                        if isinstance(part, dict) and isinstance(part.get("text"), str))
    return ""


def _tool_name(tool: Any) -> str:
    if not isinstance(tool, dict):
        return ""
    fn = tool.get("function")
    name = fn.get("name") if isinstance(fn, dict) else tool.get("name")
    return name if isinstance(name, str) else ""


def _names(tools: Any) -> set[str]:
    return {_tool_name(tool) for tool in tools or []} - {""}


def _bridged_call(tool_call: Any) -> Optional[tuple[str, Any]]:
    """``(name, arguments)`` of a bridge call that runs ONE lean MCP tool, else None."""
    fn = tool_call.get("function") if isinstance(tool_call, dict) else None
    if not isinstance(fn, dict) or fn.get("name") != BRIDGE_CALL:
        return None
    try:
        args = json.loads(fn.get("arguments") or "{}")
    except (TypeError, ValueError):
        return None
    calls = args.get("calls") if isinstance(args, dict) else None
    if not (isinstance(calls, list) and len(calls) == 1 and isinstance(calls[0], dict)):
        return None
    name = calls[0].get("name")
    if not isinstance(name, str) or not any(name in _mcp_names(tool) for kind, tool in LEAN_TOOLS if kind == "mcp"):
        return None
    return name, calls[0].get("arguments")


def _direct_history(messages: list) -> list:
    """The conversation with each bridge call this plugin made shown as the direct
    call the model wrote, so the model reads back its own call, not the bridge."""
    out = []
    for message in messages:
        calls = message.get("tool_calls") if isinstance(message, dict) else None
        if isinstance(calls, list) and any(_bridged_call(call) for call in calls):
            unwrapped = []
            for call in calls:
                bridged = _bridged_call(call)
                if bridged:
                    name, args = bridged
                    arguments = args if isinstance(args, str) else json.dumps(args if args is not None else {}, ensure_ascii=False)
                    call = {**call, "function": {**call["function"], "name": name, "arguments": arguments}}
                unwrapped.append(call)
            message = {**message, "tool_calls": unwrapped}
        out.append(message)
    return out


def lean_request(request: Any, base_url: Any, platform: Any = None, now: Optional[_dt.datetime] = None,
                 lookup: Optional[Callable[[str], Optional[dict]]] = None) -> Optional[dict]:
    """The provider kwargs of a lean turn, or None to leave the request alone.

    The system prompt is replaced, the tools are NARROWED to the lean set, and a
    reasoning level that is not a thinking one is sent as the model's off level.

    Never widened past what the session has: a tool the request carries is kept;
    a lean ClawBox MCP tool it does not carry is offered only when the request
    carries Hermes' Tool Search bridge — the tool is then deferred, still the
    session's, and reachable through ``tool_call`` — with the schema ``lookup``
    finds for it (Hermes' registry). The model calls it by name; the response
    side (:func:`bridge_deferred_calls`) hands that call to the bridge. A tool
    switched off is in neither, so it is neither offered nor taught. The
    conversation is untouched but for those bridged calls, which the model
    reads back as the direct calls it made.
    """
    if not is_lean_request(base_url, platform) or not isinstance(request, dict):
        return None
    messages = request.get("messages")
    if not isinstance(messages, list):
        return None
    lean = copy.copy(request)

    offered: dict[str, Any] = {}
    for tool in request.get("tools") or []:
        tool_id = lean_tool_id(_tool_name(tool))
        if tool_id and tool_id not in offered:
            offered[tool_id] = tool
    if BRIDGE_CALL in _names(request.get("tools")) and lookup is not None:
        for kind, tool_id in LEAN_TOOLS:
            if kind != "mcp" or tool_id in offered:
                continue
            for name in _mcp_names(tool_id):
                schema = lookup(name)
                if isinstance(schema, dict) and schema.get("name") == name:
                    offered[tool_id] = {"type": "function", "function": schema}
                    break
    order = [tool for _, tool in LEAN_TOOLS]
    kept = [offered[tool_id] for tool_id in order if tool_id in offered]
    if kept:
        lean["tools"] = kept
    else:
        lean.pop("tools", None)
        lean.pop("tool_choice", None)

    last_user = next((_text_of(m.get("content")) for m in reversed(messages)
                      if isinstance(m, dict) and m.get("role") == "user"), "")
    prompt = lean_system_prompt(
        language=detect_language(last_user),
        tools={tool_id: _tool_name(offered[tool_id]) for tool_id in order if tool_id in offered},
        today=today_line(now),
    )
    rest = _direct_history(messages)
    if rest and isinstance(rest[0], dict) and rest[0].get("role") == "system":
        rest[0] = {**rest[0], "content": prompt}
    else:
        rest.insert(0, {"role": "system", "content": prompt})
    lean["messages"] = rest

    effort = request.get("reasoning_effort")
    if isinstance(effort, str) and effort.strip().lower() not in THINKING_ON_LEVELS:
        lean["reasoning_effort"] = THINKING_OFF_LEVEL
    return lean


def _field(obj: Any, key: str) -> Any:
    return obj.get(key) if isinstance(obj, dict) else getattr(obj, key, None)


def _set_field(obj: Any, key: str, value: Any) -> None:
    if isinstance(obj, dict):
        obj[key] = value
    else:
        setattr(obj, key, value)


def bridge_deferred_calls(response: Any, request: Any, original_request: Any) -> int:
    """Hand the model's direct calls to deferred lean tools to Hermes' bridge.

    Hermes checks each call's name against the tools the SESSION lists, where a
    deferred tool is not — it is reached through ``tool_call``, whose documented
    shape is ``{"calls": [{"name", "arguments"}]}`` (tools/tool_search.py). The
    tools this plugin offered directly although the original request did not
    carry them are exactly those; a call to one becomes that bridge call, with
    the model's own arguments string, in place. Returns how many were handed on.
    """
    if not isinstance(request, dict) or not isinstance(original_request, dict):
        return 0
    original = _names(original_request.get("tools"))
    if BRIDGE_CALL not in original:
        return 0
    bridged = _names(request.get("tools")) - original
    if not bridged:
        return 0
    handed = 0
    for choice in _field(response, "choices") or []:
        message = _field(choice, "message")
        for call in _field(message, "tool_calls") or []:
            fn = _field(call, "function")
            name = _field(fn, "name")
            if name not in bridged:
                continue
            arguments = _field(fn, "arguments")
            _set_field(fn, "name", BRIDGE_CALL)
            _set_field(fn, "arguments", json.dumps(
                {"calls": [{"name": name, "arguments": arguments if arguments is not None else "{}"}]},
                ensure_ascii=False))
            handed += 1
    return handed
