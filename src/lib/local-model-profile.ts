/**
 * The slim profile: what a turn looks like when the model answering it is the
 * one on this desk.
 *
 * THE MEASUREMENT THIS EXISTS FOR. A Hermes turn on this device ships a fixed
 * preamble before the customer's first word is read (measured with Hermes' own
 * `hermes prompt-size --platform cli --json`, plus a live `tools/list` against
 * the ClawBox MCP server over stdio):
 *
 *   system prompt text .......  22,565 chars
 *   skills index .............   7,703 chars
 *   user profile .............     204 chars
 *   built-in tool schemas ....  19 tools /  56,275 bytes
 *   ClawBox MCP tool schemas .  42 tools /  26,358 bytes
 *   ------------------------------------------------------
 *   total ....................  61 tools / ~113 KB per turn
 *
 * The tool SCHEMAS, not the prose, are the bulk of it — and the heaviest
 * built-ins are the ones a desktop chat never uses (computer_use alone is
 * 10.7 KB, session_search 7.0 KB, delegation 5.8 KB). On a 2-4B model with a
 * 64k configured window that preamble is most of the budget and it shows: the
 * model answers "what time is it" with tool-call preamble instead of the time.
 *
 * WHAT THIS MODULE DECIDES. Two things, both pure so they can be tested without
 * a device: whether the model on a given turn is one of the small ones, and
 * which built-in toolsets survive when it is.
 *
 * WHAT IT DOES NOT DECIDE. It never applies to a cloud provider. Every caller
 * gates on the provider being the on-device one FIRST (see the chat route and
 * mcp/lib/profile.ts) — an unknown size means "small" here precisely because
 * the question is only ever asked about a model running on this hardware.
 */

/**
 * The parameter count, in billions, above which a model is not "small".
 *
 * 8 rather than 4: the mcp `core` profile was already written for "a 4-8B local
 * model" (mcp/README.md), and an 8 GB Jetson cannot host a bigger one at a
 * usable speed anyway — the shipped default is Gemma 4 E2B and the largest
 * thing that fits beside the desktop is ~8B at Q4.
 */
export const SMALL_LOCAL_MODEL_MAX_PARAM_B = 8;

/**
 * A context window at or below this makes a model "small" whatever its
 * parameter count: ~113 KB of fixed preamble is roughly 28k tokens, so at 16k
 * the turn cannot fit its own preamble, let alone a conversation.
 */
export const SMALL_LOCAL_MODEL_MAX_CONTEXT_TOKENS = 16_384;

/**
 * Built-in Hermes toolsets a small on-device model keeps.
 *
 * VERIFIED against the installed agent before choosing this shape:
 *   - `hermes chat -t a,b` is a WHITELIST, not an addition — it becomes
 *     `enabled_toolsets`, documented in agent/agent_init.py as "Only enable
 *     tools from these toolsets", and model_tools.py builds the tool list from
 *     exactly those.
 *   - MCP-server tools are NOT part of that filter: they are merged separately,
 *     so trimming built-ins does not take the ClawBox device tools away. That
 *     is what makes this safe — `ui_open_app`, `system_stats`, `skill_search`
 *     and the rest still reach the model through the ClawBox MCP server.
 *   - `-Q` (which the chat route always passes) sets `quiet_mode=True`, so the
 *     "✅ Enabled toolset" line never lands in the reply.
 *
 * The four kept are the ones a plain desktop answer actually reaches for. What
 * goes is the agentic scaffolding a 2-4B model cannot drive and pays for on
 * every turn: computer_use, session_search, delegation, clarify,
 * code_execution, todo, tts, vision, image generation and cron.
 *
 * `skills` is dropped from the BUILT-INS only — skill_search / skill_list /
 * skill_info / skill_install are registered by the ClawBox MCP server in its
 * `core` profile, so the Hermes device keeps its headline feature.
 */
export const SMALL_LOCAL_MODEL_TOOLSETS: readonly string[] = ["web", "memory", "file", "terminal"];

/** Env kill switch, honoured by every caller: `off` restores the full profile. */
const PROFILE_ENV = "CLAWBOX_SMALL_MODEL_PROFILE";

/** False when an operator has turned the slim profile off for this device. */
export function slimLocalProfileEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env[PROFILE_ENV] || "").trim().toLowerCase();
  return raw !== "off" && raw !== "0" && raw !== "false";
}

/**
 * The toolset list to pass to `hermes chat -t`, honouring an operator override
 * in `CLAWBOX_SMALL_MODEL_TOOLSETS`.
 *
 * Names must start with an alphanumeric and contain only `[a-z0-9_-]`, because
 * the result reaches argv and a leading "-" is a flag, not a name. A list
 * that filters down to nothing falls back to the built-in one rather than
 * sending `-t ""`, which would leave the model with no built-in tools at all.
 */
export function smallLocalModelToolsets(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const raw = (env.CLAWBOX_SMALL_MODEL_TOOLSETS || "").trim();
  if (!raw) return SMALL_LOCAL_MODEL_TOOLSETS;
  const names = raw
    .split(",")
    .map((name) => name.trim().toLowerCase())
    // Must START with an alphanumeric, not merely consist of safe characters:
    // `[a-z0-9_-]+` happily accepts `--yolo`, which hermes would read as a flag
    // rather than a toolset name.
    .filter((name) => /^[a-z0-9][a-z0-9_-]*$/.test(name));
  return names.length ? names : SMALL_LOCAL_MODEL_TOOLSETS;
}

/**
 * Parameter count in billions read out of a model id, or null when the id does
 * not carry one.
 *
 * Model ids are the only size signal available on most paths, and they do
 * carry it by convention: `qwen2.5:3b`, `llama3.2-1b-instruct-q8_0`,
 * `gemma4-e2b-it-q4_0` (Gemma's "E2B" is its effective parameter count).
 *
 * A LETTER may precede the digits, which is what makes `e2b` readable — the
 * cost is that only a `<number>b` not followed by another alphanumeric counts,
 * so quantisation tags (`q4_0`, `q8_0`) and versions (`qwen2.5`) never match.
 *
 * A mixture-of-experts name (`8x7b`) is read as the PRODUCT, not the second
 * factor: 8x7b is a 47B model and calling it 7B would slim a model that has
 * ample room. Overestimating is the safe direction — the failure mode is a big
 * model keeping the full tool set, not a small one drowning in it.
 *
 * WHY THIS IS SCANNED BY HAND rather than with the two obvious regexes.
 * `/(\d+(?:\.\d+)?)\s*b(?![a-z0-9])/` is quadratic on its input: the engine
 * retries at every digit offset and `\d+` re-scans the rest of the run each
 * time. CodeQL flags it as `js/polynomial-redos` (high), and the timing is
 * real — on a string of n `0`s the pair of regexes measured 11.7 ms at
 * n=2,000, 47.3 ms at 4,000, 251.8 ms at 8,000 and 861.4 ms at 16,000, the
 * clean 4x-per-doubling of an O(n²) scan.
 *
 * The id reaching this function is client-supplied (the chat request body's
 * `model`). The chat route happens to bound it first — isSafeHermesModelId
 * caps it at 200 characters — but mcp/lib/profile.ts calls the same function
 * with whatever `/setup-api/hermes/models` reports, and a parser should not
 * depend on one of its two callers screening the input. The scan below visits
 * each character a constant number of times, so the cost is linear and there is
 * no backtracking to exploit.
 *
 * One deliberate difference from the regexes: a run with two decimal points
 * (`1.2.3b`) is read as the maximal leading number and then a fresh one after
 * each stray dot, so it yields 3 where the backtracking regex yielded 2.3.
 * Neither reading is meaningful for a real id and both land on the same side of
 * the size threshold; the case is pinned by a test so the choice stays visible.
 */

const isDigit = (ch: string | undefined): boolean => ch !== undefined && ch >= "0" && ch <= "9";

/** Single-character classes: no repetition, so nothing here can backtrack. */
const SPACE = /\s/;
const ID_CHAR = /[a-z0-9]/i;

/** The first index at or after `i` that is not whitespace. */
function skipSpace(id: string, i: number): number {
  let k = i;
  while (k < id.length && SPACE.test(id[k])) k++;
  return k;
}

/**
 * True when the `b` that turns a number into a parameter count sits at `i`
 * (after optional whitespace) and is not itself part of a longer word — the
 * `(?![a-z0-9])` of the original expression, which is what keeps `q4_0` and
 * `qwen2.5` from parsing as sizes.
 */
function hasBillionsSuffix(id: string, i: number): boolean {
  const k = skipSpace(id, i);
  const ch = id[k];
  if (ch !== "b" && ch !== "B") return false;
  const next = id[k + 1];
  return next === undefined || !ID_CHAR.test(next);
}

interface NumberToken {
  value: number;
  start: number;
  /** Index just past the last character of the number. */
  end: number;
}

/** Every number in `id`, left to right, in one pass. */
function scanNumbers(id: string): NumberToken[] {
  const found: NumberToken[] = [];
  let i = 0;
  while (i < id.length) {
    if (!isDigit(id[i])) {
      i++;
      continue;
    }
    let j = i;
    while (isDigit(id[j])) j++;
    // At most one decimal point, and only when a digit follows it — so the `.`
    // of `qwen2.5:3b` joins the version but a trailing dot never does.
    if (id[j] === "." && isDigit(id[j + 1])) {
      j++;
      while (isDigit(id[j])) j++;
    }
    found.push({ value: Number(id.slice(i, j)), start: i, end: j });
    i = j;
  }
  return found;
}

export function parseModelParamBillions(modelId: string): number | null {
  const id = (modelId || "").trim();
  if (!id) return null;

  const numbers = scanNumbers(id);

  // Mixture-of-experts first, on the whole id, exactly as the two-phase regex
  // version did: `<a> x <b> b` is the product. The two numbers are necessarily
  // adjacent tokens, because only whitespace and the `x` may sit between them.
  for (let n = 0; n + 1 < numbers.length; n++) {
    const left = numbers[n];
    const right = numbers[n + 1];
    const afterLeft = skipSpace(id, left.end);
    if (id[afterLeft] !== "x" && id[afterLeft] !== "X") continue;
    if (skipSpace(id, afterLeft + 1) !== right.start) continue;
    if (!hasBillionsSuffix(id, right.end)) continue;
    const product = left.value * right.value;
    return Number.isFinite(product) && product > 0 ? product : null;
  }

  for (const number of numbers) {
    if (!hasBillionsSuffix(id, number.end)) continue;
    return Number.isFinite(number.value) && number.value > 0 ? number.value : null;
  }
  return null;
}

export interface LocalModelSizeInput {
  /** The bare model id, e.g. `gemma4-e2b-it-q4_0` or `qwen2.5:3b`. */
  modelId?: string | null;
  /** Exact parameter count when a backend reports one (Ollama's `/api/show`). */
  parameterCount?: number | null;
  /** The configured context window in tokens, when known. */
  contextTokens?: number | null;
}

/**
 * Whether a model running on THIS device should get the slim profile.
 *
 * Callers must already have decided the turn runs on the on-device provider;
 * this only sizes it. That is why an unreadable id answers `true`: everything
 * this hardware can host is small, and the alternative — sending 113 KB of
 * preamble to a model we could not identify — is the failure being fixed.
 */
export function isSmallLocalModel(input: LocalModelSizeInput): boolean {
  const context = input.contextTokens ?? null;
  if (context !== null && context > 0 && context <= SMALL_LOCAL_MODEL_MAX_CONTEXT_TOKENS) {
    return true;
  }

  const exact = input.parameterCount ?? null;
  const billions = exact !== null && Number.isFinite(exact) && exact > 0
    ? exact / 1e9
    : parseModelParamBillions(input.modelId || "");

  if (billions === null) return true;
  return billions <= SMALL_LOCAL_MODEL_MAX_PARAM_B;
}
