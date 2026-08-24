// ── Mascot phrase generation — LOCAL MODEL ONLY ──
//
// The transport half of the mascot's phrase refresh: one in-process call to
// the on-device llama.cpp server (Gemma 4 E2B), asking for a JSON batch of
// speech-bubble lines in the user's own language.
//
// There is NO cloud path here and there must never be one. The prompt this
// module is handed carries the device's own OpenClaw workspace memory; it
// stays on the box. The previous implementation targeted Ollama,
// which is not installed on a shipped ClawBox, so the mascot has in practice
// never had generated phrases at all.
//
// This module owns the transport and nothing else: the caller
// (`mascot-phrases-server.ts`) owns the schedule, the resource gates, the
// backoff and the validation of whatever comes back. Keeping the split means
// the model can be swapped without touching the cache, and the cache can be
// tested without a model.

import { beginLocalAiUse, endLocalAiUse, ensureLocalAiReady, getLocalAiRuntimeSnapshot } from "./local-ai-runtime";
import { getLlamaCppBaseUrl } from "./llamacpp";
import { getLlamaCppProvisioningStatus, resolveConfiguredLlamaCppAlias } from "./llamacpp-server";
import { PHRASE_CATEGORIES, type MascotPhraseSet } from "./mascot-phrases";

/**
 * How a generation attempt went wrong, which decides how long the caller
 * backs off. A model that answers with junk will keep answering with junk, so
 * "malformed" is penalised harder than a timeout that may clear on its own.
 */
export type FailureKind = "transport" | "timeout" | "malformed" | "unavailable";

/**
 * A local Gemma run on a Jetson is slow but not unbounded. Measured cold-start
 * plus ~1.4k tokens of output sits well inside this; anything past it means
 * the box is thrashing and we are better off with the pack.
 */
export const GENERATION_TIMEOUT_MS = 180_000;

/** Roughly 9 categories x ~10 short lines, with headroom for CJK. */
const MAX_OUTPUT_TOKENS = 2048;

/** High enough that a weekly re-run is not the same batch again. */
const GENERATION_TEMPERATURE = 0.9;

export type LocalGenerationOutcome =
  /** A parsed object. NOT yet validated — the caller's `validateBatch` does that. */
  | { status: "ok"; phrases: Partial<MascotPhraseSet> }
  /**
   * Nothing was attempted because the local model is serving the user. This
   * is NOT a failure: it must not arm the backoff, or a chatty afternoon
   * would cost the mascot half a day of refreshes.
   */
  | { status: "deferred"; reason: "busy" }
  | { status: "failed"; failure: FailureKind };

/**
 * The exact shape the model is constrained to. llama.cpp compiles this into a
 * GBNF grammar, so the answer is a parseable object by construction — the
 * hand-written "output ONLY JSON" plea in the prompt is belt-and-braces.
 */
export function buildResponseSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: Object.fromEntries(
      PHRASE_CATEGORIES.map((category) => [
        category,
        { type: "array", items: { type: "string" } },
      ]),
    ),
    required: [...PHRASE_CATEGORIES],
    additionalProperties: false,
  };
}

/**
 * The request body, exported so a test can assert on it without a server.
 *
 * `chat_template_kwargs.enable_thinking: false` is load-bearing, not a
 * preference: with thinking on this backend spends 8.4s and 253 tokens on
 * reasoning before the first phrase, versus 207ms and 4 tokens with it off.
 * The mascot has nothing to reason about.
 */
export function buildRequestBody(prompt: string, model: string): Record<string, unknown> {
  return {
    model,
    messages: [{ role: "user", content: prompt }],
    temperature: GENERATION_TEMPERATURE,
    max_tokens: MAX_OUTPUT_TOKENS,
    stream: false,
    chat_template_kwargs: { enable_thinking: false },
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "mascot_phrases",
        strict: true,
        schema: buildResponseSchema(),
      },
    },
  };
}

interface ExtractedCompletion {
  content: string | null;
  /** OpenAI `finish_reason`; "length" means the answer was cut at the budget. */
  finishReason: string | null;
}

/**
 * Pull the assistant's text — and why it stopped — out of an OpenAI-shaped
 * completion. A null `content` is treated as malformed by the caller UNLESS
 * `finishReason` is "length": that is a truncated answer, a transient budget
 * problem, not junk.
 */
function extractContent(payload: unknown): ExtractedCompletion {
  const none: ExtractedCompletion = { content: null, finishReason: null };
  if (!payload || typeof payload !== "object") return none;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return none;
  const choice = choices[0] as { message?: unknown; finish_reason?: unknown };
  const finishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : null;
  const message = choice?.message;
  if (!message || typeof message !== "object") return { content: null, finishReason };
  const content = (message as { content?: unknown }).content;
  return { content: typeof content === "string" ? content : null, finishReason };
}

/**
 * Parse the model's answer into a plain object of category -> lines.
 *
 * The grammar should make fences impossible, but a backend that ignored
 * `response_format` would otherwise fail for a cosmetic reason, so strip them.
 * Entries are NOT filtered here: `sanitizeCategory` on the caller's side is
 * the single place that decides what a usable phrase is.
 */
export function parsePhrasePayload(content: string): Partial<MascotPhraseSet> | null {
  const fenced = content.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const text = (fenced ? fenced[1] : content).trim();
  if (!text) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const source = parsed as Record<string, unknown>;
  const out: Partial<MascotPhraseSet> = {};
  let anyCategory = false;
  for (const category of PHRASE_CATEGORIES) {
    const value = source[category];
    if (!Array.isArray(value)) continue;
    out[category] = value as string[];
    anyCategory = true;
  }
  // A well-formed JSON object with none of our keys is the model answering a
  // different question. That is malformed, not an empty batch.
  return anyCategory ? out : null;
}

export interface LocalGenerationOptions {
  /** Already-built prompt. Assembled by the caller from on-device context only. */
  prompt: string;
  /** Only used for log lines. */
  locale: string;
  /** Overridable so tests do not wait three minutes. */
  timeoutMs?: number;
}

/**
 * Run one generation against the on-device model.
 *
 * Never throws: every path returns an outcome, because the caller
 * fire-and-forgets this from a render path.
 */
export async function generatePhrasesLocally(
  options: LocalGenerationOptions,
): Promise<LocalGenerationOutcome> {
  const { prompt, locale } = options;
  const timeoutMs = options.timeoutMs ?? GENERATION_TIMEOUT_MS;

  // Loading a 3.2GB model is not free. If the user is mid-chat, their turn
  // owns the runtime and the crab can wait.
  if (isBusy()) return { status: "deferred", reason: "busy" };

  // A phrase refresh may only ever WAKE a model somebody chose and installed —
  // never fetch one. This function is reached from a desktop page load
  // (GET /setup-api/mascot-lines kicks the background regen), and
  // `ensureLocalAiReady` hands the launcher an alias that the launcher will
  // DOWNLOAD (~3 GB) when the GGUF is missing. On a box whose owner never
  // enabled Local AI the alias resolution below answers null — but the wake
  // path's own fallback used to substitute the default Gemma alias, so merely
  // opening the desktop could arm an unattended multi-GB download. Consent to
  // download lives in the enable path (`activateLocalAiProvider` keeps the
  // same rule); a cosmetic refresh that cannot PROVE the weights are on disk —
  // resolution errors included — reports "unavailable" and the mascot keeps
  // its pack. No default alias is substituted here: that substitution is
  // exactly what handed the launcher a model to fetch.
  let configuredAlias: string | null = null;
  let modelOnDisk = false;
  try {
    configuredAlias = await resolveConfiguredLlamaCppAlias();
    if (configuredAlias) {
      modelOnDisk = (await getLlamaCppProvisioningStatus(configuredAlias)).modelAvailable;
    }
  } catch {
    // Cannot verify == not on disk; never launch a process that downloads.
  }
  if (!configuredAlias || !modelOnDisk) {
    if (configuredAlias) {
      console.warn(
        `[mascot-generation] skipping for ${locale}: local model ${configuredAlias} is not on disk, and a background refresh never downloads one`,
      );
    }
    return { status: "failed", failure: "unavailable" };
  }

  try {
    await ensureLocalAiReady("llamacpp");
  } catch (err) {
    // Local AI turned off, or no model configured. Not a transport fault, and
    // not worth retrying every few minutes.
    console.warn(
      `[mascot-generation] local AI unavailable for ${locale}:`,
      err instanceof Error ? err.message : err,
    );
    return { status: "failed", failure: "unavailable" };
  }

  // Starting the server can take tens of seconds, which is ample time for the
  // user to have sent a message. Re-check before claiming the runtime, so a
  // background nicety never queues in front of somebody waiting.
  if (isBusy()) return { status: "deferred", reason: "busy" };

  beginLocalAiUse("llamacpp");
  try {
    return await requestBatch(prompt, locale, timeoutMs, configuredAlias);
  } finally {
    // Unconditional: an exception here would otherwise leave activeRequests
    // pinned above zero forever, which both blocks every future refresh (the
    // idle gate above) and stops the runtime's idle timer from ever
    // unloading the model from a 8GB box.
    endLocalAiUse("llamacpp");
  }
}

function isBusy(): boolean {
  try {
    return getLocalAiRuntimeSnapshot("llamacpp").activeRequests > 0;
  } catch {
    return true; // cannot tell -> assume busy
  }
}

async function requestBatch(
  prompt: string,
  locale: string,
  timeoutMs: number,
  model: string,
): Promise<LocalGenerationOutcome> {
  const url = `${getLlamaCppBaseUrl().replace(/\/+$/, "")}/chat/completions`;
  const controller = new AbortController();
  // `signal.reason` is not reliable across runtimes, so track our own abort:
  // a timeout and a socket reset both surface as an AbortError otherwise.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildRequestBody(prompt, model)),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.warn(`[mascot-generation] ${locale}: llama.cpp returned HTTP ${response.status}`);
      return { status: "failed", failure: "transport" };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return { status: "failed", failure: "malformed" };
    }

    const { content, finishReason } = extractContent(payload);
    // A grammar-constrained JSON answer cut at MAX_OUTPUT_TOKENS parses as
    // nothing, but it is a budget problem that clears on a re-run, not "junk
    // the model will keep producing" — so it must NOT arm the 24h malformed
    // backoff. CJK locales (ja/zh) spend the most tokens and are the exposed
    // ones. A shorter run may fit next time, so treat it as transient.
    const truncated = finishReason === "length";
    if (content === null) {
      console.warn(`[mascot-generation] ${locale}: no assistant content (finish_reason=${finishReason})`);
      return { status: "failed", failure: truncated ? "timeout" : "malformed" };
    }

    const phrases = parsePhrasePayload(content);
    if (!phrases) {
      if (truncated) {
        console.warn(`[mascot-generation] ${locale}: answer truncated at the token budget`);
        return { status: "failed", failure: "timeout" };
      }
      console.warn(`[mascot-generation] ${locale}: could not parse a phrase object from the answer`);
      return { status: "failed", failure: "malformed" };
    }

    return { status: "ok", phrases };
  } catch (err) {
    if (timedOut) {
      console.warn(`[mascot-generation] ${locale}: timed out after ${timeoutMs}ms`);
      return { status: "failed", failure: "timeout" };
    }
    console.warn(
      `[mascot-generation] ${locale}: transport error:`,
      err instanceof Error ? err.message : err,
    );
    return { status: "failed", failure: "transport" };
  } finally {
    clearTimeout(timer);
  }
}
