import { createRequire } from "module";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";

import {
  USER_LIMITS_KEY,
  USER_LIMIT_FIELDS,
  admitChatRequest,
  chatLimitSentence,
  defaultUserLimits,
  forgetChatRequests,
  formatLimitBytes,
  mbToBytes,
  quotaExceededMessage,
  uploadTooLargeMessage,
  userLimitsFrom,
  userLimitsPatch,
} from "@/lib/user-limits";
import { describeChatFailure, userChatLimitSentence } from "@/lib/chat-error-text";

/**
 * TASK-2446 — the owner's limits for every other user: what is stored, what a
 * change may set, and the chat counter both runtimes share (the OpenClaw
 * relay in production-server.js and the Hermes route in Next), which must be
 * ONE count across the two copies of scripts/user-limits.js a box loads.
 */

const requireCjs = createRequire(import.meta.url);
const cjs = requireCjs(path.resolve(process.cwd(), "scripts/user-limits.js")) as typeof import("../../../scripts/user-limits.js");

const MIN = 60_000;
const HOUR = 60 * MIN;

afterEach(() => forgetChatRequests());

describe("the stored limits", () => {
  it("lives under one config key, with generous defaults that 0 turns off", () => {
    expect(USER_LIMITS_KEY).toBe("user_limits");
    expect(defaultUserLimits()).toEqual({ uploadMaxMb: 100, homeQuotaMb: 10240, chatPerMinute: 20, chatPerHour: 300 });
    expect(mbToBytes(100)).toBe(100 * 1024 * 1024);
    expect(mbToBytes(0)).toBeNull();
  });

  it("reads a damaged or hand-edited value field by field, never as 'no limits'", () => {
    expect(userLimitsFrom(undefined)).toEqual(defaultUserLimits());
    expect(userLimitsFrom("off")).toEqual(defaultUserLimits());
    expect(userLimitsFrom([])).toEqual(defaultUserLimits());
    expect(userLimitsFrom({ uploadMaxMb: 5, homeQuotaMb: "0", chatPerMinute: -1, chatPerHour: 1.5 })).toEqual({
      ...defaultUserLimits(),
      uploadMaxMb: 5,
    });
    expect(userLimitsFrom({ uploadMaxMb: 0, homeQuotaMb: 0, chatPerMinute: 0, chatPerHour: 0 })).toEqual({
      uploadMaxMb: 0, homeQuotaMb: 0, chatPerMinute: 0, chatPerHour: 0,
    });
    expect(userLimitsFrom({ uploadMaxMb: USER_LIMIT_FIELDS.uploadMaxMb.max + 1 }).uploadMaxMb).toBe(100);
  });

  it("accepts a change of whole numbers in range only, and names the field it refuses", () => {
    expect(userLimitsPatch({ uploadMaxMb: 50 })).toEqual({ ok: true, patch: { uploadMaxMb: 50 } });
    expect(userLimitsPatch({ chatPerMinute: 0, chatPerHour: 10, extra: 1 })).toEqual({ ok: true, patch: { chatPerMinute: 0, chatPerHour: 10 } });
    expect(userLimitsPatch({ uploadMaxMb: "50" })).toEqual({ ok: false, field: "uploadMaxMb" });
    expect(userLimitsPatch({ homeQuotaMb: -1 })).toEqual({ ok: false, field: "homeQuotaMb" });
    expect(userLimitsPatch({ chatPerHour: 2.5 })).toEqual({ ok: false, field: "chatPerHour" });
    expect(userLimitsPatch({ chatPerHour: USER_LIMIT_FIELDS.chatPerHour.max + 1 })).toEqual({ ok: false, field: "chatPerHour" });
    expect(userLimitsPatch({})).toEqual({ ok: false, field: null });
    expect(userLimitsPatch(null)).toEqual({ ok: false, field: null });
    expect(userLimitsPatch([1])).toEqual({ ok: false, field: null });
  });
});

describe("chat turns per user", () => {
  it("admits up to the per-minute limit, then refuses with the wait until a slot frees", () => {
    const limits = { chatPerMinute: 3, chatPerHour: 0 };
    const t0 = 1_000_000;
    expect(admitChatRequest("ivan", limits, t0).ok).toBe(true);
    expect(admitChatRequest("ivan", limits, t0 + 10_000).ok).toBe(true);
    expect(admitChatRequest("ivan", limits, t0 + 20_000).ok).toBe(true);
    expect(admitChatRequest("ivan", limits, t0 + 30_000)).toEqual({ ok: false, window: "minute", limit: 3, retryAfterSeconds: 30 });
    // Sliding: the first turn leaves the window a minute after it was made.
    expect(admitChatRequest("ivan", limits, t0 + MIN - 1).ok).toBe(false);
    expect(admitChatRequest("ivan", limits, t0 + MIN + 1).ok).toBe(true);
  });

  it("does not count a refused turn against the user", () => {
    const limits = { chatPerMinute: 1, chatPerHour: 0 };
    const t0 = 5_000_000;
    expect(admitChatRequest("ivan", limits, t0).ok).toBe(true);
    for (let i = 1; i <= 20; i++) expect(admitChatRequest("ivan", limits, t0 + i * 1000).ok).toBe(false);
    expect(admitChatRequest("ivan", limits, t0 + MIN + 1).ok).toBe(true);
  });

  it("holds the hourly limit across minutes", () => {
    const limits = { chatPerMinute: 0, chatPerHour: 4 };
    const t0 = 9_000_000;
    for (let i = 0; i < 4; i++) expect(admitChatRequest("ivan", limits, t0 + i * 5 * MIN).ok).toBe(true);
    const refused = admitChatRequest("ivan", limits, t0 + 30 * MIN);
    expect(refused).toEqual({ ok: false, window: "hour", limit: 4, retryAfterSeconds: 30 * 60 });
    expect(admitChatRequest("ivan", limits, t0 + HOUR + 1).ok).toBe(true);
  });

  it("counts each user on their own, and admits everything with both limits off", () => {
    const limits = { chatPerMinute: 1, chatPerHour: 0 };
    expect(admitChatRequest("ivan", limits, 1).ok).toBe(true);
    expect(admitChatRequest("maria", limits, 2).ok).toBe(true);
    expect(admitChatRequest("ivan", limits, 3).ok).toBe(false);
    for (let i = 0; i < 100; i++) expect(admitChatRequest("ivan", { chatPerMinute: 0, chatPerHour: 0 }, 4 + i).ok).toBe(true);
  });

  it("forgets a removed user's count", () => {
    const limits = { chatPerMinute: 1, chatPerHour: 0 };
    expect(admitChatRequest("ivan", limits, 1).ok).toBe(true);
    forgetChatRequests("ivan");
    expect(admitChatRequest("ivan", limits, 2).ok).toBe(true);
  });

  it("is ONE count for the relay's copy of the module and the routes' copy", () => {
    const limits = { chatPerMinute: 2, chatPerHour: 0 };
    expect(cjs.admitChatRequest("ivan", limits, 100).ok).toBe(true);
    expect(admitChatRequest("ivan", limits, 200).ok).toBe(true);
    expect(cjs.admitChatRequest("ivan", limits, 300).ok).toBe(false);
    expect(admitChatRequest("ivan", limits, 400).ok).toBe(false);
    cjs.forgetChatRequests();
    expect(admitChatRequest("ivan", limits, 500).ok).toBe(true);
  });
});

describe("what a refusal says", () => {
  it("words a refused turn with the limit and the wait", () => {
    expect(chatLimitSentence({ window: "minute", limit: 20, retryAfterSeconds: 35 })).toBe(
      "You have reached your chat limit on this ClawBox: 20 messages a minute. Try again in 35 seconds.",
    );
    expect(chatLimitSentence({ window: "hour", limit: 1, retryAfterSeconds: 1 })).toBe(
      "You have reached your chat limit on this ClawBox: 1 message an hour. Try again in 1 second.",
    );
    expect(chatLimitSentence({ window: "hour", limit: 300, retryAfterSeconds: 1500 })).toBe(
      "You have reached your chat limit on this ClawBox: 300 messages an hour. Try again in 25 minutes.",
    );
  });

  it("is shown by the chat in place of the generic failure, for every wording the box sends", () => {
    for (const verdict of [
      { window: "minute" as const, limit: 20, retryAfterSeconds: 35 },
      { window: "hour" as const, limit: 1, retryAfterSeconds: 1 },
      { window: "hour" as const, limit: 300, retryAfterSeconds: 3599 },
    ]) {
      const sentence = chatLimitSentence(verdict);
      expect(userChatLimitSentence(sentence)).toBe(sentence);
      expect(describeChatFailure(sentence)).toBe(sentence);
    }
    expect(userChatLimitSentence("You have reached your chat limit on this ClawBox: see /etc/passwd")).toBeNull();
    expect(userChatLimitSentence("Rate limit exceeded")).toBeNull();
  });

  it("names the upload limit and the quota in bytes a person reads", () => {
    expect(formatLimitBytes(100 * 1024 * 1024)).toBe("100 MB");
    expect(formatLimitBytes(10 * 1024 * 1024 * 1024)).toBe("10 GB");
    expect(formatLimitBytes(Math.round(2.5 * 1024 * 1024))).toBe("2.5 MB");
    expect(formatLimitBytes(512)).toBe("512 B");
    expect(uploadTooLargeMessage(100 * 1024 * 1024)).toBe("This file is larger than the 100 MB upload limit for your account on this ClawBox.");
    expect(quotaExceededMessage(9.5 * 1024 ** 3, 10 * 1024 ** 3)).toContain("9.5 GB of its 10 GB quota");
  });
});
