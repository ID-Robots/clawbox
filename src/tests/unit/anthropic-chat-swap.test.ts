/**
 * The chat's half of the Anthropic account swap (TASK-1260): which failed turns
 * are reported at all, and the one line the chat adds under its failure
 * sentence, in the owner's language.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeChatSwap, isAnthropicAccountFailure, reportAnthropicChatFailure } from "@/lib/anthropic-chat-swap";

/** A loaded locale pack: the key, marked as translated (a bare key means "not loaded yet"). */
const t = (key: string, params?: Record<string, string | number>) => `T:${key}${params ? JSON.stringify(params) : ""}`;
const words = { t, locale: "en" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("which failures are an Anthropic account's", () => {
  it("is one when an Anthropic model failed on a limit or a refused credential", () => {
    expect(isAnthropicAccountFailure({ errorMessage: "rate limited", context: { provider: "anthropic", reason: "rate_limit" } })).toBe(true);
    expect(isAnthropicAccountFailure({ errorMessage: "x", context: { model: "anthropic/claude-opus-5-5", detail: "HTTP 401: {\"type\":\"error\",\"error\":{\"type\":\"authentication_error\"}}" } })).toBe(true);
    expect(isAnthropicAccountFailure({ errorMessage: "You've hit your session limit · resets 10:50pm", context: {} })).toBe(false);
  });

  it("is not one for another provider, or for a failure that is not the account's", () => {
    expect(isAnthropicAccountFailure({ errorMessage: "rate limited", context: { provider: "openai", reason: "rate_limit" } })).toBe(false);
    expect(isAnthropicAccountFailure({ errorMessage: "The request timed out.", context: { provider: "anthropic", reason: "timeout" } })).toBe(false);
  });

  it("costs no request when it is not one", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await reportAnthropicChatFailure({ errorMessage: "boom", context: { provider: "openai" }, sessionKey: "s", message: "hi" })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("hands the failure, the session and the turn to the route, and never throws", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ handled: true, activeLabel: "Personal", retry: "sent" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const answer = await reportAnthropicChatFailure({ errorMessage: "rate limited", context: { provider: "anthropic", reason: "rate_limit" }, sessionKey: "agent:main:main", message: "hi" });
    expect(answer).toMatchObject({ handled: true, activeLabel: "Personal" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/setup-api/anthropic/failure");
    expect(JSON.parse(String(init.body))).toMatchObject({ provider: "anthropic", reason: "rate_limit", sessionKey: "agent:main:main", message: "hi" });

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    expect(await reportAnthropicChatFailure({ errorMessage: "rate limited", context: { provider: "anthropic", reason: "rate_limit" }, sessionKey: null, message: null })).toBeNull();
  });
});

describe("the line the chat adds", () => {
  it("names the account it moved to, and whether the message went again", () => {
    expect(describeChatSwap({ handled: true, activeLabel: "Personal", retry: "sent" }, words)).toBe('T:settings.anthropicAccounts.chatSwitched{"label":"Personal"}');
    expect(describeChatSwap({ handled: true, activeLabel: "Personal", retry: "none" }, words)).toBe('T:settings.anthropicAccounts.chatSwitchedResend{"label":"Personal"}');
  });

  it("says every account is limited and when the message goes again", () => {
    const line = describeChatSwap({ handled: true, allLimited: true, nextResetAt: Date.now() + 3_600_000, retry: "held" }, words);
    expect(line).toMatch(/^T:settings\.anthropicAccounts\.chatAllLimited\{"time":"/);
    expect(describeChatSwap({ handled: true, allLimited: true, nextResetAt: null }, words)).toBe("T:settings.anthropicAccounts.chatNoAccount");
  });

  it("says it is still switching when the route could not wait", () => {
    expect(describeChatSwap({ handled: true, pending: true }, words)).toBe("T:settings.anthropicAccounts.chatSwitching");
  });

  it("adds nothing for an unhandled report, or while the locale pack still answers bare keys", () => {
    expect(describeChatSwap(null, words)).toBeNull();
    expect(describeChatSwap({ handled: false }, words)).toBeNull();
    expect(describeChatSwap({ handled: true, pending: true }, { t: (key) => key, locale: "en" })).toBeNull();
  });
});
