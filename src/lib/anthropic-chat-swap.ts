/**
 * The chat's half of the Anthropic account swap (TASK-1260) — client-safe.
 *
 * A gateway turn that dies on the Claude account's limit, or on Anthropic
 * refusing its credential, ends in the chat's `error` frame and nowhere else:
 * the server never sees it. So the chat hands it to
 * /setup-api/anthropic/failure, which swaps every Claude consumer on the box to
 * the next account and sends the turn again into its session, once
 * (src/lib/anthropic-gateway.ts). This module is what both chat surfaces share
 * for that: the cheap local question "is this one of those at all?", the
 * report, and the one line the chat adds under its failure sentence, in the
 * owner's language.
 *
 * Only a turn that failed on an ANTHROPIC model is reported, and only when its
 * words read as a limit or a refused credential — the same narrow parser the
 * server applies (src/lib/anthropic-limit.ts). Every other failure costs no
 * request at all.
 */

import { classifyAnthropicFailure } from "@/lib/anthropic-limit";
import type { ChatRunFailureContext } from "@/lib/chat-error-text";

/** The route's answer. */
export interface ChatSwapAnswer {
  handled: boolean;
  /** The route stopped waiting; the swap and the retry carry on behind it. */
  pending?: boolean;
  kind?: "limit" | "auth" | null;
  activeLabel?: string | null;
  allLimited?: boolean;
  nextResetAt?: number | null;
  retry?: "sent" | "held" | "none";
}

export interface ChatSwapInput {
  errorMessage: unknown;
  context: ChatRunFailureContext | undefined;
  sessionKey: string | null;
  /** The turn's text, when it can be sent again as it was (no attachments). */
  message: string | null;
}

const text = (v: unknown): string => (typeof v === "string" ? v : "");

/** Is this failed turn one the account swap is for? Local, no request. */
export function isAnthropicAccountFailure(input: Pick<ChatSwapInput, "errorMessage" | "context">): boolean {
  const context = input.context ?? {};
  const provider = (context.provider ?? "").toLowerCase();
  const model = (context.model ?? "").toLowerCase();
  const anthropic = provider === "anthropic" || /^(?:anthropic\/)?claude/.test(model)
    || /anthropic|claude/i.test(`${text(context.detail)} ${text(input.errorMessage)}`);
  if (!anthropic) return false;
  const words = [text(context.detail), text(input.errorMessage)].filter(Boolean).join("\n");
  return classifyAnthropicFailure(words, Date.now(), { reason: context.reason ?? null }) !== null;
}

/** Hand the failure over. Null when it was not one, or the report could not be made. Never throws. */
export async function reportAnthropicChatFailure(input: ChatSwapInput): Promise<ChatSwapAnswer | null> {
  if (!isAnthropicAccountFailure(input)) return null;
  const context = input.context ?? {};
  try {
    const res = await fetch("/setup-api/anthropic/failure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        errorMessage: text(input.errorMessage).slice(0, 2_000),
        detail: text(context.detail).slice(0, 2_000),
        reason: context.reason ?? null,
        provider: context.provider ?? null,
        model: context.model ?? null,
        sessionKey: input.sessionKey,
        message: input.message,
      }),
    });
    if (!res?.ok) return null;
    const answer = await res.json() as ChatSwapAnswer;
    return answer && typeof answer === "object" && answer.handled === true ? answer : null;
  } catch {
    return null;
  }
}

/** A reset in the owner's own clock, with the weekday when it is not today. Shared with the accounts card. */
export function formatAccountReset(at: number, locale: string, now: number = Date.now()): string {
  const sameDay = new Date(at).toDateString() === new Date(now).toDateString();
  try {
    return new Intl.DateTimeFormat(locale, sameDay
      ? { hour: "2-digit", minute: "2-digit" }
      : { weekday: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(at));
  } catch {
    return new Date(at).toISOString().slice(11, 16);
  }
}

type Translate = (key: string, params?: Record<string, string | number>) => string;

/**
 * The line the chat adds under its failure sentence: what the box did about
 * it. Null when there is nothing to add — or when the locale pack has not
 * loaded and `t` answers the bare key, which must never reach the transcript.
 */
export function describeChatSwap(answer: ChatSwapAnswer | null, words: { t: Translate; locale: string }): string | null {
  if (!answer?.handled) return null;
  const { t, locale } = words;
  let line: string;
  if (answer.pending) line = t("settings.anthropicAccounts.chatSwitching");
  else if (answer.allLimited) {
    line = typeof answer.nextResetAt === "number"
      ? t(answer.retry === "held" ? "settings.anthropicAccounts.chatAllLimited" : "settings.anthropicAccounts.chatAllLimitedNoRetry", { time: formatAccountReset(answer.nextResetAt, locale) })
      : t("settings.anthropicAccounts.chatNoAccount");
  } else if (answer.activeLabel) {
    line = t(answer.retry === "sent" ? "settings.anthropicAccounts.chatSwitched" : "settings.anthropicAccounts.chatSwitchedResend", { label: answer.activeLabel });
  } else return null;
  return line.startsWith("settings.") ? null : line;
}
