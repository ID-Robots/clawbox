import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetModelFallbackForTests,
  handleModelFallback,
  zeroQuotaInGatewayLog,
  type ModelFallbackDeps,
} from "@/lib/provider-model-fallback";

// The server half of "this account cannot run that model". The real failure:
// xAI answered grok-4.6 with `Requests per Minute (actual/limit): 0/0` and the
// core retried it nine times over a minute, while Grok 4.7 on the same account
// answered at once. The box confirms the zero limit from the gateway's own log,
// stops the retry loop, moves the chat to the next newest model, and sends the
// turn again — and an ordinary throttle is left to the core's retry.

const NOW = Date.parse("2026-10-28T12:00:00.000Z");

/** The core's failed-attempt line, the way the gateway file log holds it. */
function agentEndLine(opts: { model: string; raw: string; at?: number }): string {
  return JSON.stringify({
    0: JSON.stringify({ subsystem: "agent/embedded" }),
    1: "embedded run agent end",
    2: { event: "embedded_run_agent_end", provider: "xai", model: opts.model, failoverReason: "rate_limit", rawErrorPreview: opts.raw },
    _meta: { logLevelName: "WARN", date: new Date(opts.at ?? NOW - 2_000).toISOString() },
    time: new Date(opts.at ?? NOW - 2_000).toISOString(),
  });
}

const ZERO = "429 Too many requests for team T and model grok-4.6. Your team's rate limit is — Requests per Minute (actual/limit): 0/0.";
const THROTTLE = "429 Too many requests for team T and model grok-4.6. Requests per Minute (actual/limit): 61/60.";

const LIVE = [
  { id: "grok-4.7", label: "Grok 4.7" },
  { id: "grok-4.6", label: "Grok 4.6" },
  { id: "grok-4.5", label: "Grok 4.5" },
];

function deps(over: Partial<ModelFallbackDeps> & { lines?: string[] } = {}) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const d: ModelFallbackDeps & { calls: typeof calls } = {
    calls,
    logsTail: vi.fn(async () => ({ lines: over.lines ?? [agentEndLine({ model: "grok-4.6", raw: ZERO })] })),
    gatewayCall: vi.fn(async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      return {};
    }),
    switchModel: vi.fn(async () => true),
    readPrimary: vi.fn(async () => "xai/grok-4.6"),
    readModels: vi.fn(async () => LIVE),
    readUnavailable: vi.fn(async () => new Set<string>()),
    markUnavailable: vi.fn(async () => true),
    forgetPick: vi.fn(async () => undefined),
    sleep: vi.fn(async () => undefined),
    now: () => NOW,
    ...over,
  };
  return d;
}

const report = {
  provider: "xai",
  model: "grok-4.6",
  reason: "rate_limit",
  evidence: "⚠️ The AI service needs a short break. Please try again in a few minutes.",
  sessionKey: "agent:main:main",
  runId: "run-1",
  message: "hello there",
};

beforeEach(() => {
  _resetModelFallbackForTests();
});

describe("handleModelFallback — a 429 stating a limit of zero", () => {
  it("confirms it from the gateway log, stops the retries, moves the chat to the next newest model and sends the turn again", async () => {
    const d = deps();
    const outcome = await handleModelFallback(report, d);

    expect(outcome).toMatchObject({
      handled: true,
      kind: "zero_quota",
      provider: "xai",
      model: "grok-4.6",
      modelLabel: "Grok 4.6",
      fallbackModel: "grok-4.7",
      fallbackLabel: "Grok 4.7",
      switched: true,
      resent: true,
      news: true,
    });
    expect(d.markUnavailable).toHaveBeenCalledWith("xai", "grok-4.6", "zero_quota");
    // The retry loop is stopped first, then the switch, then the resend.
    expect(d.calls.map((c) => c.method)).toEqual(["chat.abort", "chat.send"]);
    expect(d.calls[0].params).toEqual({ sessionKey: "agent:main:main", runId: "run-1" });
    expect(d.switchModel).toHaveBeenCalledWith("xai/grok-4.7");
    expect(d.forgetPick).toHaveBeenCalledWith("xai/grok-4.6");
    expect(d.calls[1].params).toMatchObject({ sessionKey: "agent:main:main", message: "hello there", deliver: false });
    expect(String(d.calls[1].params.idempotencyKey)).toMatch(/^clawbox-model-fallback-[0-9a-f]{16}$/);
  });

  it("leaves an ordinary throttle to the core's retry: nothing stopped, marked or switched", async () => {
    const d = deps({ lines: [agentEndLine({ model: "grok-4.6", raw: THROTTLE })] });
    expect(await handleModelFallback(report, d)).toEqual({ handled: false });
    expect(d.logsTail).toHaveBeenCalledTimes(3);
    expect(d.markUnavailable).not.toHaveBeenCalled();
    expect(d.calls).toEqual([]);
    expect(d.switchModel).not.toHaveBeenCalled();
  });

  it("acts on the provider's own words without the log when the chat already has them", async () => {
    const d = deps({ lines: [] });
    const outcome = await handleModelFallback({ ...report, evidence: ZERO }, d);
    expect(outcome.handled).toBe(true);
    expect(d.logsTail).not.toHaveBeenCalled();
  });

  it("is not confirmed when the gateway log cannot be read", async () => {
    const d = deps({ logsTail: vi.fn(async () => { throw new Error("gateway unavailable"); }) });
    expect(await handleModelFallback(report, d)).toEqual({ handled: false });
    expect(d.calls).toEqual([]);
  });

  it("still stops the retries, and says so, when the account has no other model", async () => {
    const d = deps({ readModels: vi.fn(async () => [{ id: "grok-4.6", label: "Grok 4.6" }]) });
    const outcome = await handleModelFallback(report, d);
    expect(outcome).toMatchObject({ handled: true, fallbackModel: null, switched: false, resent: false });
    expect(d.calls.map((c) => c.method)).toEqual(["chat.abort"]);
    expect(d.switchModel).not.toHaveBeenCalled();
  });

  it("does not repoint the box when the chat's primary is another model", async () => {
    const d = deps({ readPrimary: vi.fn(async () => "anthropic/claude-opus-5-5") });
    const outcome = await handleModelFallback(report, d);
    expect(outcome).toMatchObject({ handled: true, fallbackModel: "grok-4.7", switched: false, resent: false });
    expect(d.switchModel).not.toHaveBeenCalled();
  });

  it("skips a fallback this account was already refused on", async () => {
    const d = deps({ readUnavailable: vi.fn(async () => new Set(["grok-4.7"])) });
    const outcome = await handleModelFallback(report, d);
    expect(outcome.fallbackModel).toBe("grok-4.5");
    expect(d.switchModel).toHaveBeenCalledWith("xai/grok-4.5");
  });

  it("answers two windows reporting the same run with one action", async () => {
    const d = deps();
    const [a, b] = await Promise.all([handleModelFallback(report, d), handleModelFallback(report, d)]);
    expect(a).toBe(b);
    expect(d.switchModel).toHaveBeenCalledTimes(1);
    expect(d.calls.filter((c) => c.method === "chat.send")).toHaveLength(1);
  });

  it("does nothing for a provider whose models do not fall back, or a malformed report", async () => {
    const d = deps();
    expect(await handleModelFallback({ ...report, provider: "anthropic", model: "claude-opus-5-5" }, d)).toEqual({ handled: false });
    expect(await handleModelFallback({ ...report, reason: "overloaded" }, d)).toEqual({ handled: false });
    expect(await handleModelFallback({ ...report, model: "../../etc" }, d)).toEqual({ handled: false });
    expect(d.logsTail).not.toHaveBeenCalled();
  });
});

describe("handleModelFallback — a model the provider no longer offers", () => {
  it("needs no log: moves the chat and sends the ended turn again, with nothing to stop", async () => {
    const d = deps({ lines: [] });
    const outcome = await handleModelFallback({ ...report, reason: "model_not_found", model: "xai/grok-4.6" }, d);
    expect(outcome).toMatchObject({ handled: true, kind: "not_found", fallbackModel: "grok-4.7", switched: true, resent: true });
    expect(d.logsTail).not.toHaveBeenCalled();
    expect(d.markUnavailable).toHaveBeenCalledWith("xai", "grok-4.6", "not_found");
    expect(d.calls.map((c) => c.method)).toEqual(["chat.send"]);
  });
});

describe("zeroQuotaInGatewayLog", () => {
  it("finds the refusal for this provider and model, recently", () => {
    expect(zeroQuotaInGatewayLog([agentEndLine({ model: "grok-4.6", raw: ZERO })], "xai", "grok-4.6", NOW)).toBe(true);
  });

  it("does not take another model's, an old one's, or a throttle's line as evidence", () => {
    expect(zeroQuotaInGatewayLog([agentEndLine({ model: "grok-4.65", raw: ZERO.replace("grok-4.6", "grok-4.65") })], "xai", "grok-4.6", NOW)).toBe(false);
    expect(zeroQuotaInGatewayLog([agentEndLine({ model: "grok-4.6", raw: ZERO, at: NOW - 60 * 60_000 })], "xai", "grok-4.6", NOW)).toBe(false);
    expect(zeroQuotaInGatewayLog([agentEndLine({ model: "grok-4.6", raw: THROTTLE })], "xai", "grok-4.6", NOW)).toBe(false);
    expect(zeroQuotaInGatewayLog(["not json at all 0/0 grok-4.6 xai embedded run agent end"], "xai", "grok-4.6", NOW)).toBe(false);
    expect(zeroQuotaInGatewayLog([42, null], "xai", "grok-4.6", NOW)).toBe(false);
  });
});
