import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/lib/chat-history-cache";
import {
  chatFailureNote,
  clawaiSignInFailure,
  describeChatFailure,
  EMPTY_RUN_TEXT,
} from "@/lib/chat-error-text";
import { projectGatewayHistory } from "@/lib/harness/openclaw-gateway-adapter";
import {
  isAckOnlyReply,
  isEmptyReply,
  mergeRestoredTranscript,
  withEmptyRunNote,
} from "@/lib/chat-transcript-reconcile";

// A ClawBox AI box whose sign-in the gateway could not use (2026-10-30): an
// older device login left an expired sign-in at `deepseek:default`, the
// re-login could not replace it, and every turn ended on this error. The chat
// showed the owner's "хей" and nothing under it — the live line went up, the
// push for the stored row below re-read the transcript, and the re-read
// dropped both. Both shapes are what the pinned gateway sent on a board.
const RUN_ID = "3eaea7b3-9c7c-4e7a-810a-ab98470852a3";
const NO_KEY_ERROR =
  'No API key found for provider "deepseek". Auth store: /home/clawbox/.openclaw/agents/main/agent/openclaw-agent.sqlite '
  + "(agentDir: /home/clawbox/.openclaw/agents/main/agent). Configure an API key (openclaw models auth paste-api-key "
  + "--provider deepseek; add --agent <id> for a non-default agent) or copy only portable static auth profiles from "
  + "the main agentDir. | missing-provider-auth";
const STORED_FAILURE_ROW = {
  role: "custom",
  customType: "run-failed-before-reply",
  content: `Your request couldn't be completed: ${NO_KEY_ERROR}`,
  display: true,
  timestamp: 1793374114575,
  __openclaw: { id: "b64568fd-bf42-4cbd-80b2-fd9397e1e045", seq: 2, runId: RUN_ID },
};
const USER_ROW = {
  role: "user",
  content: [{ type: "text", text: "хей" }],
  timestamp: 1793374114000,
  idempotencyKey: `${RUN_ID}:user`,
};
// The ClawBox AI proxy's refusal of a token it does not know, as it answers it.
const PROXY_403 = 'HTTP 403: {"error":{"message":"Invalid token","type":"auth_error","code":"invalid_token"}}';

describe("a ClawBox AI turn the box's sign-in cannot serve", () => {
  it("names the missing sign-in as ClawBox AI's and offers to sign in again", () => {
    expect(clawaiSignInFailure(NO_KEY_ERROR)).toBe("missing");
    const note = chatFailureNote(NO_KEY_ERROR);
    expect(note.text).toMatch(/no working ClawBox AI sign-in/);
    expect(note.text).toMatch(/Sign in to ClawBox AI again/);
    expect(note.actions).toEqual({ signInClawai: true });
    // An error, not the calm zero-quota notice.
    expect(note.variant).toBeUndefined();
    // Never the operator's line: no path, no CLI, no core provider id.
    expect(note.text).not.toMatch(/\/home\/|openclaw|paste-api-key|deepseek/i);
  });

  it("reads the proxy's 403 on a ClawBox AI turn as a refused sign-in", () => {
    const context = { provider: "deepseek", model: "deepseek/deepseek-v4-flash" };
    expect(clawaiSignInFailure(PROXY_403, context)).toBe("rejected");
    expect(chatFailureNote(PROXY_403, context)).toEqual({
      text: expect.stringMatching(/ClawBox AI is not accepting this box's sign-in/),
      actions: { signInClawai: true },
    });
    // The proxy's own refusal code names ClawBox AI even when no frame did.
    expect(clawaiSignInFailure(PROXY_403)).toBe("rejected");
    // The gateway's auth reason on a ClawBox AI model, with no words at all.
    expect(clawaiSignInFailure("", { model: "deepseek/deepseek-v4-pro", reason: "auth" })).toBe("rejected");
  });

  it("reads a 402 or a lapsed plan on a ClawBox AI turn as the subscription", () => {
    const context = { provider: "deepseek" };
    expect(clawaiSignInFailure("HTTP 402: Payment Required", context)).toBe("subscription");
    expect(clawaiSignInFailure('{"error":{"code":"subscription_expired"}}', context)).toBe("subscription");
    expect(describeChatFailure("HTTP 402: Payment Required", context)).toMatch(/plan does not cover this/);
    expect(chatFailureNote("HTTP 402: Payment Required", context).actions).toEqual({ signInClawai: true });
  });

  it("leaves every other provider's failure, and every other ClawBox AI failure, as it was", () => {
    // Another provider with no sign-in: its own sentence, no ClawBox AI button.
    const anthropic = 'No API key found for provider "anthropic". | missing-provider-auth';
    expect(clawaiSignInFailure(anthropic)).toBeNull();
    expect(chatFailureNote(anthropic)).toEqual({ text: expect.stringMatching(/Anthropic/) });
    // Another provider's 403 is not ClawBox AI's.
    expect(clawaiSignInFailure("HTTP 403: Invalid token", { provider: "openai" })).toBeNull();
    expect(clawaiSignInFailure("HTTP 403: Invalid token")).toBeNull();
    // A ClawBox AI rate limit is a wait, not a sign-in.
    expect(clawaiSignInFailure("429 Too Many Requests: rate limit reached", { provider: "deepseek" })).toBeNull();
    // A zero quota stays the calm notice, with no sign-in button.
    const zero = "429 Too many requests. Requests per Minute (actual/limit): 0/0.";
    expect(chatFailureNote(zero, { provider: "xai", model: "xai/grok-4.6" })).toMatchObject({ variant: "notice" });
    expect(chatFailureNote(zero, { provider: "xai" }).actions).toBeUndefined();
  });
});

describe("the box's own record of a failed run, read back", () => {
  it("becomes the chat's failure line, tagged with its run", () => {
    const { messages } = projectGatewayHistory([USER_ROW, STORED_FAILURE_ROW], { items: [] });
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "user", text: "хей" });
    expect(messages[1]).toEqual({
      role: "system",
      text: chatFailureNote(NO_KEY_ERROR).text,
      timestamp: STORED_FAILURE_ROW.timestamp,
      failedRun: RUN_ID,
      actions: { signInClawai: true },
    });
  });

  it("is worded by the chat's translator when the read is handed one", () => {
    const words = { t: (key: string) => (key === "chat.allowanceWeekly" ? "ПОЛЗВАНЕТО Е ИЗЧЕРПАНО" : key), locale: "bg" };
    const allowance = {
      ...STORED_FAILURE_ROW,
      content: `Your request couldn't be completed: 429 {"error":{"type":"usage_limit","code":"weekly_limit_exceeded"}}`,
    };
    const { messages } = projectGatewayHistory([USER_ROW, allowance], { items: [] }, { failureWords: words });
    expect(messages[1].text).toMatch(/ПОЛЗВАНЕТО Е ИЗЧЕРПАНО/);
  });

  it("drops the rows that are not a shown failure", () => {
    const hidden = { ...STORED_FAILURE_ROW, display: false };
    const other = { ...STORED_FAILURE_ROW, customType: "compaction-summary" };
    const { messages } = projectGatewayHistory([USER_ROW, hidden, other], { items: [] });
    expect(messages.map((m) => m.role)).toEqual(["user"]);
  });
});

describe("a failed turn's line across a history re-read", () => {
  const question: ChatMessage = { role: "user", text: "хей", timestamp: 1, idempotencyKey: RUN_ID };
  const liveLine: ChatMessage = {
    role: "system", text: "live words", timestamp: 2, failedRun: RUN_ID, actions: { signInClawai: true },
  };

  it("stays in the mascot chat when the read does not hold it", () => {
    const merged = mergeRestoredTranscript([question, liveLine], [{ ...question }], { keepFailureNotes: true });
    expect(merged.map((m) => m.text)).toEqual(["хей", "live words"]);
  });

  it("is not shown beside the box's stored copy of the same failure", () => {
    const stored: ChatMessage = { role: "system", text: "stored words", timestamp: 3, failedRun: RUN_ID };
    for (const opts of [{ keepFailureNotes: true }, { keepLocalNotes: true }]) {
      const merged = mergeRestoredTranscript([question, liveLine], [{ ...question }, stored], opts);
      expect(merged.map((m) => m.text)).toEqual(["хей", "stored words"]);
    }
  });

  it("keeps the mascot chat's other notes out of the carry, as before", () => {
    const stopped: ChatMessage = { role: "system", text: "Stopped.", timestamp: 2, variant: "stopped" };
    const merged = mergeRestoredTranscript([question, stopped], [{ ...question }], { keepFailureNotes: true });
    expect(merged.map((m) => m.text)).toEqual(["хей"]);
  });
});

describe("a run that ended with nothing", () => {
  const note = { role: "system" as const, text: EMPTY_RUN_TEXT, timestamp: 9, failedRun: RUN_ID, variant: "notice" as const };
  const question: ChatMessage = { role: "user", text: "хей", timestamp: 1, idempotencyKey: RUN_ID };

  it("is told apart from an ack that promises a reply", () => {
    expect(isEmptyReply({ text: "", images: [], audio: [], files: [] })).toBe(true);
    expect(isEmptyReply({ text: "  ", images: [], audio: [], files: [] })).toBe(true);
    expect(isAckOnlyReply({ text: "Sent.", images: [], audio: [], files: [] })).toBe(true);
    expect(isEmptyReply({ text: "Sent.", images: [], audio: [], files: [] })).toBe(false);
    expect(isEmptyReply({ text: "", images: ["/setup-api/chat/media?p=a.png"], audio: [], files: [] })).toBe(false);
  });

  it("gets a line under its question when the re-read found nothing either", () => {
    expect(withEmptyRunNote([question], note)).toEqual([question, note]);
  });

  it("gets none when anything answered the question, or a newer question is up", () => {
    const reply: ChatMessage = { role: "assistant", text: "Здрасти!", timestamp: 3 };
    expect(withEmptyRunNote([question, reply], note)).toEqual([question, reply]);
    const failure: ChatMessage = { role: "system", text: "failed", timestamp: 3, failedRun: RUN_ID };
    expect(withEmptyRunNote([question, failure], note)).toEqual([question, failure]);
    const newer: ChatMessage = { role: "user", text: "още", timestamp: 4, idempotencyKey: "another-run" };
    expect(withEmptyRunNote([question, newer], note)).toEqual([question, newer]);
  });
});
