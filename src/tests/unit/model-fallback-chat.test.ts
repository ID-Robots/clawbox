import { describe, expect, it } from "vitest";
import { describeModelFallback, ModelFallbackWatch } from "@/lib/model-fallback-chat";
import { modelAvailabilityEn } from "@/lib/edition-translations/en-model-availability";

// The chat's half of the model fallback: which frames are reported, once per
// run; the "Stopped." a box-made stop must not show; and the line the owner
// reads. Wire shapes as the pinned core (2026.10.7) sends them before a retry.

const finishing = (runId: string, provider: string, model: string, reason = "rate_limit") => ({
  runId,
  sessionKey: "agent:main:main",
  stream: "lifecycle",
  data: {
    phase: "finishing",
    error: "⚠️ The AI service needs a short break. Please try again in a few minutes.",
    errorObservation: { provider, model, failoverReason: reason },
  },
});

const retrying = (runId: string, reason = "rate_limit") => ({
  runId,
  sessionKey: "agent:main:main",
  stream: "run_status",
  data: { phase: "retrying", reason, attempt: 2, maxAttempts: 10, delayMs: 8000 },
});

/** A translator that knows nothing, like a locale pack still loading. */
const bare = { t: (key: string) => key };
/** The English catalogue, the way the chat's own `t` fills placeholders. */
const en = {
  t: (key: string, params?: Record<string, string | number>) => {
    let out = modelAvailabilityEn[key] ?? key;
    for (const [k, v] of Object.entries(params ?? {})) out = out.replaceAll(`{${k}}`, String(v));
    return out;
  },
};

describe("ModelFallbackWatch", () => {
  it("reports an xAI attempt about to be retried on a rate limit, once per run", () => {
    const watch = new ModelFallbackWatch();
    const signal = watch.fromAgentFrame(finishing("run-1", "xai", "grok-4.6"), undefined);
    expect(signal).toMatchObject({ runId: "run-1", provider: "xai", model: "grok-4.6", reason: "rate_limit" });
    expect(signal?.evidence).toContain("short break");
    watch.begin("run-1");
    expect(watch.fromAgentFrame(finishing("run-1", "xai", "grok-4.6"), undefined)).toBeNull();
    expect(watch.fromAgentFrame(retrying("run-1"), { provider: "xai", model: "grok-4.6" })).toBeNull();
  });

  it("reads a retry frame through what the run's earlier frames said", () => {
    const watch = new ModelFallbackWatch();
    expect(watch.fromAgentFrame(retrying("run-2"), { provider: "xai", model: "grok-4.6" }))
      .toMatchObject({ runId: "run-2", provider: "xai", model: "grok-4.6" });
    // Nothing known about the run: nothing to report.
    expect(watch.fromAgentFrame(retrying("run-3"), undefined)).toBeNull();
  });

  it("costs nothing for any other provider, reason or frame", () => {
    const watch = new ModelFallbackWatch();
    expect(watch.fromAgentFrame(finishing("a", "anthropic", "claude-opus-5-5"), undefined)).toBeNull();
    expect(watch.fromAgentFrame(finishing("b", "xai", "grok-4.6", "overloaded"), undefined)).toBeNull();
    expect(watch.fromAgentFrame(retrying("c", "overloaded"), { provider: "xai", model: "grok-4.6" })).toBeNull();
    expect(watch.fromAgentFrame({ runId: "d", stream: "tool", data: { phase: "start" } }, undefined)).toBeNull();
    expect(watch.fromAgentFrame(null, undefined)).toBeNull();
  });

  it("reports a model the provider no longer offers from the run's error", () => {
    const watch = new ModelFallbackWatch();
    expect(watch.fromChatError("run-4", { provider: "xai", model: "xai/grok-4.6", reason: "model_not_found" }, "x"))
      .toMatchObject({ runId: "run-4", provider: "xai", model: "xai/grok-4.6", reason: "model_not_found" });
    expect(watch.fromChatError("run-5", { provider: "xai", model: "grok-4.6", reason: "rate_limit" }, "x")).toBeNull();
  });

  it("holds the Stopped line for a run the box stopped, and gives it back when the box did not act", () => {
    const watch = new ModelFallbackWatch();
    // Never reported: an owner's own Stop.
    expect(watch.holdStop("run-x")).toBe(false);

    watch.begin("run-6");
    expect(watch.holdStop("run-6")).toBe(true);
    expect(watch.settle("run-6", { handled: true })).toBe(false);

    watch.begin("run-7");
    expect(watch.holdStop("run-7")).toBe(true);
    // The box did not act after all, and the owner stopped the run meanwhile.
    expect(watch.settle("run-7", { handled: false })).toBe(true);
    expect(watch.holdStop("run-7")).toBe(false);
  });
});

describe("describeModelFallback", () => {
  const zero = {
    handled: true,
    kind: "zero_quota" as const,
    provider: "xai",
    model: "grok-4.6",
    modelLabel: "Grok 4.6",
    fallbackModel: "grok-4.7",
    fallbackLabel: "Grok 4.7",
    switched: true,
    resent: true,
  };

  it("says the model is not available on this account, where the chat went, and how to get it back", () => {
    expect(describeModelFallback(zero, en)).toBe(
      "Grok 4.6 is not available on this xAI account — its rate limit is 0 (no API credit or quota for it yet)."
      + " Switched the chat to Grok 4.7 and sent your message again."
      + " To use Grok 4.6, add credit at console.x.ai.",
    );
  });

  it("falls back to English when the locale pack has not loaded", () => {
    expect(describeModelFallback(zero, bare)).toBe(describeModelFallback(zero, en));
  });

  it("asks the owner to pick the model, or another provider, when the box could not move the chat", () => {
    expect(describeModelFallback({ ...zero, switched: false, resent: false }, en))
      .toContain("Pick Grok 4.7 in the chat header and send your message again.");
    expect(describeModelFallback({ ...zero, fallbackModel: null, fallbackLabel: null, switched: false }, en))
      .toContain("No other xAI model is available on this account");
  });

  it("words a dropped model without the credit line", () => {
    const line = describeModelFallback({ ...zero, kind: "not_found" }, en);
    expect(line).toBe("xAI no longer offers Grok 4.6 to this account. Switched the chat to Grok 4.7 and sent your message again.");
  });

  it("says nothing when the box did not act", () => {
    expect(describeModelFallback({ handled: false }, en)).toBeNull();
    expect(describeModelFallback(null, en)).toBeNull();
  });
});
