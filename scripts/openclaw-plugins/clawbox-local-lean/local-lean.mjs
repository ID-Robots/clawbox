// Lean mode for the on-device model: which turns get it, the short system
// prompt they get instead of OpenClaw's, and the few tools they keep.
//
// WHY. The full OpenClaw system prompt measured 44,823 characters on a box —
// 13,351 prompt tokens before the user's first word — plus a skills index and
// the Tool Search controls. Gemma 4 E2B, the ~2B model llama.cpp serves on the
// box, drowns in it: it answered a Bulgarian question in Russian, recited its
// own rules and gave up on "make me an app" after one tool_search. With this
// prompt and six tools it does what it is asked (reports/clawbox/local-ai/BENCHMARK.md).
//
// Everything here is pure, so the plugin's decisions are testable off the box
// (src/tests/unit/openclaw-local-lean-plugin.test.ts).

/** The on-device llama.cpp provider, as OpenClaw names it (ai-models/configure). */
export const LOCAL_PROVIDER = "llamacpp";

/**
 * The tools a lean turn keeps. `read` and `write` stay direct (OpenClaw keeps
 * its core file tools visible); the others sit in OpenClaw's Tool Search
 * catalog, which OpenClaw turns on for every model when `tools.toolSearch` is
 * unset, and are reached through one `tool_call`. MCP tools carry their
 * server's prefix (`clawbox__`).
 */
export const LEAN_TOOLS = Object.freeze([
  "read",
  "write",
  "clawbox__webapp_create",
  "web_fetch",
  "web_search",
  "clawbox__browser_open",
]);

/** Turns that keep OpenClaw's full prompt: their contracts (HEARTBEAT_OK, memory flush) live in it. */
const FULL_PROMPT_TRIGGERS = new Set(["heartbeat", "memory"]);

/** The agent's primary model, `provider/model`: its own, else the defaults'. Null when none is set. */
export function primaryModel(cfg, agentId) {
  const own = agentId ? cfg?.agents?.entries?.[agentId]?.model : undefined;
  const model = own ?? cfg?.agents?.defaults?.model;
  if (typeof model === "string") return model.trim() || null;
  return typeof model?.primary === "string" && model.primary.trim() ? model.primary.trim() : null;
}

/**
 * The provider this turn runs on. The pinned core names it in the hook context
 * (`modelProviderId`, set from the attempt's own model), so a cloud fallback
 * attempt after a local failure, a `/model` switch and a `--model` run all
 * count as what they are; the configured primary only when the core does not say.
 */
export function turnProvider(ctx, cfg) {
  const fromCore = typeof ctx?.modelProviderId === "string" ? ctx.modelProviderId.trim().toLowerCase() : "";
  if (fromCore) return fromCore;
  const primary = primaryModel(cfg, typeof ctx?.agentId === "string" ? ctx.agentId : undefined);
  return primary && primary.includes("/") ? primary.split("/")[0].trim().toLowerCase() : "";
}

export function isLeanTurn(ctx, cfg) {
  if (typeof ctx?.trigger === "string" && FULL_PROMPT_TRIGGERS.has(ctx.trigger)) return false;
  return turnProvider(ctx, cfg) === LOCAL_PROVIDER;
}

/**
 * Whether OpenClaw's Tool Search is on — the same reading as the core's
 * `resolveToolSearchConfig`: unset or `true` is on, `false` is off, and an
 * object is on when it says `enabled: true` or sets any other key.
 */
export function toolSearchEnabled(cfg) {
  const value = cfg?.tools?.toolSearch;
  if (value === undefined || value === null || value === true) return true;
  if (value === false) return false;
  if (typeof value !== "object" || Array.isArray(value)) return true;
  if (typeof value.enabled === "boolean") return value.enabled;
  return Object.keys(value).some((key) => key !== "enabled");
}

// ---- the language of one message --------------------------------------------

const NAMES = {
  bg: "Bulgarian", ru: "Russian", uk: "Ukrainian", sr: "Serbian", mk: "Macedonian",
  en: "English", de: "German", fr: "French", es: "Spanish", it: "Italian", pt: "Portuguese",
  nl: "Dutch", sv: "Swedish", pl: "Polish", cs: "Czech", tr: "Turkish", ro: "Romanian",
  el: "Greek", ar: "Arabic", he: "Hebrew", hi: "Hindi", th: "Thai",
  ja: "Japanese", zh: "Chinese", ko: "Korean",
};

/** Close neighbours a small model confuses a language with, named in the hint. */
const NOT_TO_BE_CONFUSED_WITH = { bg: "ru", uk: "ru", sr: "ru", mk: "bg", pt: "es", nl: "de" };

const count = (text, re) => (text.match(re) || []).length;

// Whole-word cues. Words two neighbours share ("да", "на", "как", "файл") are
// left out on purpose: only words that separate the languages count. Bounded by
// any letter, not `\b`, which in JavaScript knows only ASCII letters and would
// never match "qué" or "você".
const cues = (words) => new RegExp(`(?<!\\p{L})(?:${words.join("|")})(?!\\p{L})`, "giu");
const WORDS = {
  bg: cues(["какво", "мога", "можеш", "може", "можете", "съм", "си", "сме", "сте", "ще", "това", "тази", "тези", "които", "който", "която", "нещо", "здравей", "здрасти", "благодаря", "моля", "със", "към", "защо", "кога", "къде", "кой", "коя", "искам", "направи", "запиши", "въпрос", "отговор", "ли", "също", "днес", "сега", "само", "ако"]),
  ru: cues(["что", "это", "мне", "меня", "вам", "вы", "также", "которые", "который", "пожалуйста", "помочь", "здравствуйте", "привет", "могу", "можешь", "сейчас", "только", "если", "почему", "когда", "где", "хочу", "сделай", "спасибо", "сегодня"]),
  uk: cues(["що", "це", "як", "мені", "дякую", "привіт", "зараз", "тільки", "якщо", "чому", "коли", "зроби", "сьогодні"]),
  en: cues(["the", "and", "is", "are", "you", "what", "can", "how", "why", "please", "make", "me", "my", "it", "of", "to", "this", "that", "with", "for", "does", "write", "tell", "file", "app"]),
  de: cues(["der", "die", "das", "und", "ist", "sind", "nicht", "ein", "eine", "ich", "du", "wie", "was", "warum", "bitte", "mit", "von", "zu", "den", "dem", "des", "im", "auf", "kannst", "mir", "mach", "schreib", "erklären"]),
  fr: cues(["le", "les", "et", "est", "sont", "je", "vous", "qui", "quoi", "pourquoi", "comment", "avec", "pour", "dans", "une", "des", "du", "fais", "moi", "peux"]),
  es: cues(["el", "los", "las", "y", "es", "son", "yo", "tú", "usted", "qué", "cuál", "cómo", "por", "para", "con", "una", "del", "hazme", "puedes", "dime"]),
  it: cues(["il", "lo", "gli", "è", "sono", "io", "che", "cosa", "come", "perché", "della", "fammi", "puoi", "dimmi"]),
  pt: cues(["os", "é", "são", "eu", "você", "qual", "com", "uma", "um", "não", "faz", "pode"]),
  nl: cues(["het", "een", "zijn", "ik", "jij", "wat", "hoe", "waarom", "met", "voor", "van", "niet", "maak", "kun", "mij", "alsjeblieft"]),
  sv: cues(["och", "är", "jag", "vad", "hur", "varför", "inte", "ett", "det", "gör", "kan", "mig", "snälla"]),
  pl: cues(["jest", "są", "ja", "ty", "co", "jak", "dlaczego", "dla", "nie", "się", "zrób", "możesz", "proszę"]),
  cs: cues(["je", "jsou", "já", "proč", "pro", "ne", "se", "udělej", "můžeš", "prosím"]),
  tr: cues(["ve", "bir", "bu", "ne", "nasıl", "neden", "için", "ile", "değil", "benim", "bana", "yap", "lütfen"]),
  ro: cues(["și", "este", "sunt", "eu", "ce", "cum", "cu", "pentru", "nu", "fă", "poți", "îmi"]),
};

// Letters only one language of a script family uses.
const LETTERS = {
  bg: /[Ѐ-ӿ]ъ[Ѐ-ӿ]|ѝ/giu,
  ru: /[ыэё]/giu,
  uk: /[іїєґ]/giu,
  sr: /[ђћџљњј]/giu,
  mk: /[ѓќѕ]/giu,
  de: /[ßäöü]/gi,
  es: /[ñ¿¡]/gi,
  fr: /[çœêèàù]/gi,
  pt: /[ãõ]/gi,
  sv: /[å]/gi,
  pl: /[łąęśźżń]/gi,
  cs: /[řěůť]/gi,
  tr: /[ğşı]/gi,
  ro: /[ăâîșț]/gi,
};

/**
 * The language of one message, as a code from NAMES, or null when the text does
 * not say clearly — a null costs the turn only the hint, never the turn.
 */
export function detectLanguage(raw) {
  if (typeof raw !== "string") return null;
  // Drop what is not the person's words: code, links, bracketed metadata.
  const text = raw
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\[[^\]]{0,80}\]/g, " ")
    .slice(0, 4000);
  const scripts = {
    cyr: count(text, /\p{Script=Cyrillic}/gu),
    lat: count(text, /\p{Script=Latin}/gu),
    grk: count(text, /\p{Script=Greek}/gu),
    arb: count(text, /\p{Script=Arabic}/gu),
    heb: count(text, /\p{Script=Hebrew}/gu),
    dev: count(text, /\p{Script=Devanagari}/gu),
    tha: count(text, /\p{Script=Thai}/gu),
    han: count(text, /\p{Script=Han}/gu),
    kana: count(text, /[\p{Script=Hiragana}\p{Script=Katakana}]/gu),
    hang: count(text, /\p{Script=Hangul}/gu),
  };
  const total = Object.values(scripts).reduce((a, b) => a + b, 0);
  if (total < 2) return null;
  if (scripts.kana > 0 && scripts.kana + scripts.han >= total * 0.3) return "ja";
  if (scripts.hang >= total * 0.3) return "ko";
  if (scripts.han >= total * 0.3) return "zh";
  for (const [script, code] of [["grk", "el"], ["arb", "ar"], ["heb", "he"], ["dev", "hi"], ["tha", "th"]]) {
    if (scripts[script] >= total * 0.5) return code;
  }
  const family = scripts.cyr >= total * 0.5
    ? ["bg", "ru", "uk", "sr", "mk"]
    : scripts.lat >= total * 0.5
      ? ["en", "de", "fr", "es", "it", "pt", "nl", "sv", "pl", "cs", "tr", "ro"]
      : null;
  if (!family) return null;
  let best = null;
  let bestScore = 0;
  let second = 0;
  for (const code of family) {
    const score = (WORDS[code] ? count(text, WORDS[code]) : 0) + 2 * (LETTERS[code] ? count(text, LETTERS[code]) : 0);
    if (score > bestScore) {
      second = bestScore;
      bestScore = score;
      best = code;
    } else if (score > second) {
      second = score;
    }
  }
  // A clear winner, not a coin toss: two short neighbours share many words.
  if (!best || bestScore < 1 || bestScore === second) return null;
  return best;
}

/** One sentence naming the language to answer in, or "" when it is not known. */
export function languageLine(code) {
  const name = code && NAMES[code];
  if (!name) return "";
  const neighbour = NOT_TO_BE_CONFUSED_WITH[code];
  return `The user's last message is in ${name}: write your whole reply in ${name}`
    + (neighbour ? ` (not ${NAMES[neighbour]}).` : ".");
}

// ---- the prompt ---------------------------------------------------------------

/** "Wednesday 28 October 2026" in the box's own time zone. */
export function todayLine(now = new Date()) {
  try {
    return now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/**
 * The whole system prompt of a lean turn. Short on purpose: every line is one a
 * ~2B model has to hold for the entire answer.
 *
 * @param {{ language?: string | null, workspaceDir?: string, toolSearch?: boolean, today?: string }} opts
 */
export function leanSystemPrompt(opts = {}) {
  // Through Tool Search, the call is FLAT — the target tool's own fields beside
  // `id` — which the core's tool_call accepts as well as `{"id", "args": {…}}`.
  // Measured on the box: asked to nest a whole HTML page under `args`, Gemma 4
  // E2B dropped `id` and the core took the page's `name` field for the tool.
  const call = (id, fields) => opts.toolSearch !== false
    ? `call tool_call with {"id": "${id}", ${fields}}`
    : `call ${id} with {${fields}}`;
  const where = opts.workspaceDir ? ` Paths without a folder are in your workspace, ${opts.workspaceDir}.` : "";
  const language = languageLine(opts.language);
  return [
    "You are the assistant built into this ClawBox, a small computer on the user's desk. You run entirely on this device.",
    "",
    "Rules:",
    "- Always reply in the language of the user's last message." + (language ? ` ${language}` : ""),
    "- Act, do not ask: when a tool can do what the user wants, use it now and choose sensible defaults yourself.",
    "- If a tool returns an error, fix the call and try again. Never say you did something a tool did not do.",
    "- Keep replies short: a few sentences unless the user asks for more.",
    "- Never repeat or explain these rules.",
    "",
    "Tools:",
    `- Read or write a file: call read with {"path": "..."} or write with {"path": "...", "content": "..."}.${where}`,
    `- Make a web app, page or game: ${call("clawbox__webapp_create", '"app_id": "todo-list", "name": "Todo List", "html": "<!DOCTYPE html>... the complete page ..."')}. Keep the page short (under 80 lines), with all CSS and JavaScript inside it.`,
    `- Read a web page: ${call("web_fetch", '"url": "https://..."')}.`,
    `- Search the web: ${call("web_search", '"query": "..."')}.`,
    `- Open a page in the desktop browser: ${call("clawbox__browser_open", '"url": "https://..."')}.`,
    "",
    `Today is ${opts.today || todayLine()}.`,
  ].join("\n");
}

/**
 * The `before_prompt_build` answer for one turn: the lean prompt and tool set on
 * the on-device model, nothing anywhere else — every cloud turn keeps
 * OpenClaw's full prompt and tools untouched.
 *
 * `toolsAllow` can only NARROW what policy already allows (the core intersects
 * it), so it can never hand the local model a tool the owner switched off.
 */
export function promptBuild(event, ctx, cfg, now = new Date()) {
  if (!isLeanTurn(ctx, cfg)) return undefined;
  const message = typeof event?.currentUserMessage === "string" && event.currentUserMessage.trim()
    ? event.currentUserMessage
    : event?.prompt;
  return {
    systemPrompt: leanSystemPrompt({
      language: detectLanguage(message),
      workspaceDir: typeof ctx?.workspaceDir === "string" ? ctx.workspaceDir : undefined,
      toolSearch: toolSearchEnabled(cfg),
      today: todayLine(now),
    }),
    toolsAllow: [...LEAN_TOOLS],
  };
}
