/**
 * Turning the on-device model's thinking on and off, per request.
 *
 * BACKGROUND. Reasoning for llama.cpp looks like a launch-time decision:
 * `scripts/start-llamacpp.sh` passes `--reasoning on|off|auto`, and flipping it
 * means restarting llama-server (measured on this hardware: ~10 s to kill and
 * wake through the proxy). That would be a poor dial — a ten-second stall on a
 * control the cloud providers apply instantly.
 *
 * It is also unnecessary. VERIFIED against the shipped binary (llama-server
 * version 1 (db7d8b2), aarch64) with the server running `--reasoning off`, same
 * question each time:
 *
 *   no field                                 →   0 reasoning chars,   4 tok,  355 ms
 *   chat_template_kwargs.enable_thinking=true→ 703 reasoning chars, 253 tok, 8416 ms
 *   chat_template_kwargs.enable_thinking=false→  0 reasoning chars,   4 tok,  207 ms
 *
 * Both directions work on a running server, so no restart is needed. The launch
 * flag remains the DEFAULT for requests that say nothing.
 *
 * WHY NOT `reasoning_effort`: sending it changes nothing — the response was
 * byte-identical to sending no field at all. llama.cpp's OpenAI-compatible
 * server ignores unknown top-level keys (an invented field name returns HTTP
 * 200). `chat_template_kwargs.enable_thinking` is different in a way that
 * proves it is read: a non-boolean value returns HTTP 400. That contrast is the
 * evidence this control is real and `reasoning_effort` is not.
 *
 * WHY NOT a graded Low/Medium/High: the only knob that could grade it is
 * `--reasoning-budget`, and it is not honoured per request — budget 64 produced
 * 371 reasoning chars and budget 0 produced 518, i.e. sampling noise, not
 * enforcement. Offering graded levels would repeat exactly the mistake
 * NO_REASONING_CONTROL was added to prevent: a picker whose settings all do the
 * same nothing. Two honest states only.
 *
 * WHY HERE and not in Hermes: Hermes exposes no per-provider `extra_body` for a
 * generic `api_mode: openai` provider, and it addresses the local model through
 * this proxy (`providers.clawlocal.base_url`). The proxy is the one place we
 * control the outgoing request body.
 */

import { isHermesReasoningLevel, type HermesReasoningLevel } from "@/lib/hermes-reasoning";

/**
 * Levels that mean "think". `hermes --reasoning` sends one of eight words as
 * `reasoning_effort`; the backend has two states, so the eight collapse onto
 * them. `none` and `minimal` are the two that read as "don't", which keeps the
 * mapping monotonic — raising the level can never reduce thinking.
 */
const NON_THINKING_LEVELS: ReadonlySet<HermesReasoningLevel> = new Set(["none", "minimal"]);

/** Whether a reasoning-effort string should turn thinking on. */
export function thinkingEnabledForLevel(level: string): boolean {
  return isHermesReasoningLevel(level) && !NON_THINKING_LEVELS.has(level);
}

/**
 * Only chat completions carry a chat template, so only that path is rewritten.
 * Everything else (`/models`, embeddings, completions, the slots endpoints)
 * stays a straight stream — see proxyLocalAiRequest.
 */
export function isChatCompletionsPath(pathSegments: readonly string[]): boolean {
  return pathSegments.length === 2
    && pathSegments[0] === "chat"
    && pathSegments[1] === "completions";
}

/**
 * Ceiling on a request body we are willing to hold in memory to rewrite.
 *
 * The device has 7.6 GB total and the model already occupies ~3.9 GB of it, so
 * an unbounded buffer here is a real hazard rather than a theoretical one. A
 * chat completion is text; 8 MB is far above any legitimate turn and far below
 * anything that would hurt. Over the cap we do not fail the request — we give
 * up on rewriting and stream it through untouched, because a turn that runs
 * with the server's default thinking setting is much better than no turn.
 */
export const MAX_REWRITABLE_BODY_BYTES = 8 * 1024 * 1024;

/**
 * Rewrite a chat-completions body so the on-device model's thinking matches the
 * requested effort.
 *
 * Returns the original text unchanged when there is nothing to do, so the
 * caller can forward bytes it did not need to touch.
 */
export function applyThinkingToChatBody(bodyText: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    // Not JSON we understand. Forward it verbatim and let llama.cpp judge it —
    // rejecting here would turn a backend's clear error into our vague one.
    return bodyText;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return bodyText;

  const body = parsed as Record<string, unknown>;
  const effort = typeof body.reasoning_effort === "string" ? body.reasoning_effort.trim() : "";
  if (!effort) return bodyText;

  // `reasoning_effort` itself is inert here (verified: ignored by this
  // backend). Drop it rather than forward a field that only ever misleads
  // anyone reading a capture of this traffic.
  delete body.reasoning_effort;

  const existing = body.chat_template_kwargs;
  const kwargs: Record<string, unknown> =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};

  // MERGE, never replace: a caller that already set other template kwargs must
  // keep them. An explicit enable_thinking from the caller also wins — they
  // addressed the backend directly and in its own vocabulary.
  if (!("enable_thinking" in kwargs)) {
    // Must be a real boolean. A non-boolean is the one value this backend
    // rejects outright (HTTP 400), which is also how we know it is read.
    kwargs.enable_thinking = thinkingEnabledForLevel(effort);
  }
  body.chat_template_kwargs = kwargs;

  return JSON.stringify(body);
}
