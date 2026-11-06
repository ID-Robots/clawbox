/**
 * A long conversation on Local AI (TASK-2127).
 *
 * WHY. A chat tab holding ~100k tokens was switched to Local AI — Gemma 4 E2B
 * on llama.cpp, a 32k window on OpenClaw — and the owner asked a one-line
 * question. OpenClaw's pre-prompt check saw a history that could not fit and
 * compacted it with the active model, the 2B one: 121 s for the summary, then
 * retries of 14–40 s each, while the status line said "Loading the local
 * model…" over a llama-server that was up and healthy the whole time.
 *
 * The chat's answer, and the rules this module holds for it:
 *  - the conversation's size against the local model's window decides whether
 *    the chat offers a choice — a new chat (recommended, one click, the waiting
 *    message goes with it) or a summary first — instead of sending into a
 *    minutes-long compaction (`tooLongForLocal`);
 *  - the status line names what is really happening: shortening while a
 *    compaction runs, loading only while llama-server is not ready
 *    (`localTurnPhase`);
 *  - a local turn still shortening after `LOCAL_COMPACTION_DEADLINE_MS` ends
 *    with a message and the new-chat offer instead of spinning.
 *
 * The server half is src/lib/local-compaction-model.ts: it points OpenClaw's
 * own compaction (`agents.defaults.compaction.model`) at the cloud model the
 * owner left, so a summary costs seconds rather than minutes on the box.
 */

import { DEFAULT_LLAMACPP_MAX_TOKENS } from "@/lib/llamacpp";

/** How long a local turn (or a "shorten first") may spend shortening before the chat stops it. */
export const LOCAL_COMPACTION_DEADLINE_MS = 90_000;

/**
 * What a local reply keeps free of the window: the reply itself. OpenClaw's
 * llama.cpp row is written with this `maxTokens` (src/lib/llamacpp.ts), and a
 * prompt that leaves less than it is a prompt the harness compacts first.
 */
export const LOCAL_FIT_REPLY_RESERVE_TOKENS = DEFAULT_LLAMACPP_MAX_TOKENS;

/** How large a conversation is, as its harness last measured or estimated it. */
export interface ConversationSize {
  /** Tokens the conversation's next prompt carries. */
  tokens: number;
  /**
   * Above this many tokens the harness compacts before the local model can
   * answer, when the harness says (Hermes: its compression threshold). Without
   * it the window minus the reply's reserve is the line (`localFitLimit`).
   */
  limit?: number | null;
  /** The local model's window, when the harness knows it (the chat names it on the card). */
  window?: number | null;
}

function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * The tokens an OpenClaw session row says its next prompt carries: the larger
 * of the last prompt as the provider measured it (`totalTokens`) and the
 * core's own pre-prompt estimate (`contextBudgetStatus.estimatedPromptTokens`,
 * the number behind `[context-pressure-diagnostic] … estimatedPromptTokens=`).
 * Null for a row that carries neither — a session with no turn yet.
 */
export function openclawSessionTokens(row: unknown): number | null {
  if (!row || typeof row !== "object") return null;
  const r = row as { totalTokens?: unknown; contextBudgetStatus?: unknown };
  const measured = positive(r.totalTokens);
  const status = r.contextBudgetStatus && typeof r.contextBudgetStatus === "object"
    ? r.contextBudgetStatus as { estimatedPromptTokens?: unknown }
    : null;
  const estimated = positive(status?.estimatedPromptTokens);
  if (measured === null && estimated === null) return null;
  return Math.max(measured ?? 0, estimated ?? 0);
}

/** The token count above which a conversation does not fit a local `window`. */
export function localFitLimit(window: number, reserve: number = LOCAL_FIT_REPLY_RESERVE_TOKENS): number {
  // Never below half the window: a tiny window must not make every chat "too long".
  return Math.max(Math.floor(window / 2), Math.floor(window - reserve));
}

/**
 * Is the conversation larger than the local model can take without a summary
 * first? False whenever either side is unknown: the offer is a help, and a
 * chat that could not be measured is sent as it always was.
 */
export function tooLongForLocal(size: ConversationSize | null | undefined, window: number | null | undefined): boolean {
  const tokens = positive(size?.tokens);
  if (tokens === null) return false;
  const limit = positive(size?.limit) ?? (positive(window) !== null ? localFitLimit(window as number) : null);
  return limit !== null && tokens > limit;
}

/** "100k", "32k", "850": the counts the offer names (thousands rounded down, so 32768 reads "32k"). */
export function shortTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0";
  if (tokens < 1000) return String(Math.round(tokens));
  return `${Math.floor(tokens / 1000)}k`;
}

/** What a Local AI turn's status line names, or null for the usual words. */
export type LocalTurnPhase = "shortening" | "loading" | null;

/**
 * The status line of a turn on Local AI.
 *
 * - `shortening` while a compaction runs — the harness said so, or the turn
 *   was sent on a conversation known to be too long and has not been heard
 *   from yet (that is the compaction OpenClaw runs before the first token);
 * - `loading` only while llama-server is not ready (`serverReady === false`,
 *   read from /setup-api/llamacpp/status). Unknown is not "loading": a status
 *   that says the model is loading over a server that is up is the lie this
 *   task removes. An Ollama model has no such probe and keeps the old words
 *   until its first token;
 * - null otherwise: the spinner verb, as on any turn.
 */
export function localTurnPhase(state: {
  compacting: boolean;
  serverReady: boolean | null;
  llamaCpp: boolean;
  heardFrom: boolean;
}): LocalTurnPhase {
  if (state.compacting) return "shortening";
  if (state.heardFrom) return null;
  if (!state.llamaCpp) return "loading";
  return state.serverReady === false ? "loading" : null;
}

/**
 * An OpenClaw `agent` frame on the compaction stream — the core emits
 * `{ stream: "compaction", data: { phase: "start" | "end" } }` around every
 * compaction of a run, automatic or recovery — as `start`, `end`, or null for
 * any other frame.
 */
export function compactionFramePhase(payload: unknown): "start" | "end" | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as { stream?: unknown; data?: unknown };
  if (p.stream !== "compaction") return null;
  const phase = p.data && typeof p.data === "object" ? (p.data as { phase?: unknown }).phase : undefined;
  return phase === "start" ? "start" : phase === "end" ? "end" : null;
}
