/**
 * Anthropic's own word on whether a Claude account is at its limit, and until
 * when (TASK-1260, the chat on the pool) — the windows core's own reader reads.
 * A spent window is a limit until ITS reset; a window short of full is not a
 * limit at all; Anthropic not answering is never read as "fine".
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAnthropicUsage, parseAnthropicUsage } from "@/lib/anthropic-usage";

const at = (iso: string) => Date.parse(iso);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reading the windows", () => {
  it("is the five-hour window's reset when that is the one spent", () => {
    expect(parseAnthropicUsage({
      five_hour: { utilization: 100, resets_at: "2026-10-14T18:10:00Z" },
      seven_day: { utilization: 43, resets_at: "2026-10-19T09:00:00Z" },
    })).toEqual({ exhausted: true, resetsAt: at("2026-10-14T18:10:00Z"), kind: "session" });
  });

  it("is a weekly limit, until the LATEST reset, when a week is spent too", () => {
    expect(parseAnthropicUsage({
      five_hour: { utilization: 100, resets_at: "2026-10-14T18:10:00Z" },
      seven_day_opus: { utilization: 100, resets_at: "2026-10-19T09:00:00Z" },
    })).toEqual({ exhausted: true, resetsAt: at("2026-10-19T09:00:00Z"), kind: "weekly" });
  });

  it("reads a model-scoped week from `limits[]`, and skips one Anthropic marks inactive", () => {
    expect(parseAnthropicUsage({
      five_hour: { utilization: 12, resets_at: null },
      limits: [
        { kind: "weekly_scoped", percent: 100, resets_at: "2026-10-20T00:00:00Z", scope: { model: { display_name: "Fable" } } },
        { kind: "weekly_scoped", percent: 100, is_active: false, resets_at: "2026-10-21T00:00:00Z" },
      ],
    })).toEqual({ exhausted: true, resetsAt: at("2026-10-20T00:00:00Z"), kind: "weekly" });
  });

  it("is no limit when every window has room, whatever else the answer holds", () => {
    expect(parseAnthropicUsage({ five_hour: { utilization: 99, resets_at: null }, seven_day: { utilization: 20 }, extra_usage: { utilization: 100 } }))
      .toEqual({ exhausted: false, resetsAt: null, kind: "session" });
    expect(parseAnthropicUsage(null)).toEqual({ exhausted: false, resetsAt: null, kind: "session" });
  });
});

describe("asking Anthropic", () => {
  it("asks with the account's own token and the OAuth beta core's reader sends", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ five_hour: { utilization: 100, resets_at: "2026-10-14T18:10:00Z" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchAnthropicUsage("sk-ant-oat01-acct")).toMatchObject({ exhausted: true, kind: "session" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/api/oauth/usage");
    expect(init.headers).toMatchObject({ Authorization: "Bearer sk-ant-oat01-acct", "anthropic-beta": "oauth-2025-04-20" });
  });

  it("answers null — never \"not limited\" — when Anthropic refuses or cannot be reached", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 403 })));
    expect(await fetchAnthropicUsage("x")).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ENOTFOUND"); }));
    expect(await fetchAnthropicUsage("x")).toBeNull();
  });
});
