import { describe, expect, it, vi } from "vitest";
import {
  isPatchableSession,
  patchSessionModels,
  sessionModelRef,
  SESSIONS_PATCH_MANY_MAX_TARGETS,
  type GatewayRpcCall,
  type SessionPatchTarget,
} from "@/lib/openclaw-session-model";

type Params = { targets: SessionPatchTarget[]; patch: { model: string | null } };

/** A gateway that answers `ok` for every target, unless `refuse` names it. */
function gatewayOf(refuse: Record<string, { code?: string; message?: string }> = {}) {
  // Typed as the real transport, so the fake cannot drift from the contract.
  return vi.fn<GatewayRpcCall>(async (_method, params) => {
    const { targets } = params as Params;
    return {
      outcomes: targets.map((t) =>
        refuse[t.key] ? { ok: false, key: t.key, agentId: t.agentId, error: refuse[t.key] } : { ok: true, key: t.key, agentId: t.agentId },
      ),
    };
  });
}

const targets = (...keys: string[]): SessionPatchTarget[] => keys.map((key) => ({ key, agentId: "main" }));

describe("isPatchableSession", () => {
  it("wants a session id: placeholder rows describe no session to patch", () => {
    expect(isPatchableSession({ sessionId: "abc" })).toBe(true);
    expect(isPatchableSession({ sessionId: "" })).toBe(false);
    expect(isPatchableSession({})).toBe(false);
    expect(isPatchableSession({ modelOverride: "x" })).toBe(false);
  });
});

describe("sessionModelRef", () => {
  it("reads the override pair, then the legacy pair, else nothing", () => {
    expect(sessionModelRef({ providerOverride: "deepseek", modelOverride: "deepseek-v4-pro" })).toBe("deepseek/deepseek-v4-pro");
    expect(sessionModelRef({ modelProvider: "anthropic", model: "claude-sonnet-4-6" })).toBe("anthropic/claude-sonnet-4-6");
    expect(sessionModelRef({ providerOverride: "deepseek" })).toBeNull();
    expect(sessionModelRef({ providerOverride: null, modelOverride: "x", modelProvider: "p", model: "m" })).toBe("p/m");
    expect(sessionModelRef({})).toBeNull();
  });
});

describe("patchSessionModels", () => {
  it("sends one sessions.patchMany with every target and the model, and maps the outcomes back in order", async () => {
    const call = gatewayOf({ "agent:main:locked": { code: "INVALID_REQUEST", message: "model selection is locked" } });

    const outcomes = await patchSessionModels(targets("agent:main:a", "agent:main:locked", "agent:main:b"), "deepseek/v4", { call });

    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith(
      "sessions.patchMany",
      {
        targets: [
          { key: "agent:main:a", agentId: "main" },
          { key: "agent:main:locked", agentId: "main" },
          { key: "agent:main:b", agentId: "main" },
        ],
        patch: { model: "deepseek/v4" },
      },
      { timeoutMs: undefined },
    );
    expect(outcomes).toEqual([
      { key: "agent:main:a", agentId: "main", ok: true },
      { key: "agent:main:locked", agentId: "main", ok: false, error: "model selection is locked", retryable: false },
      { key: "agent:main:b", agentId: "main", ok: true },
    ]);
  });

  it("reads the gateway's own result shape (SessionsPatchManyResultSchema, core v2026.8.1)", async () => {
    // A literal response, NOT derived from the targets sent, so a drift in the
    // envelope (`outcomes`, `key`, `agentId`, `error: { code, message }`) is
    // caught here rather than on the box as N "no outcome" lines.
    const call = vi.fn<GatewayRpcCall>(async () => ({
      outcomes: [
        { ok: true, key: "agent:main:main", agentId: "main" },
        {
          ok: false,
          key: "agent:main:clawbox-1",
          agentId: "main",
          error: { code: "INVALID_REQUEST", message: "unknown model: nope/x", details: { retryable: false } },
        },
      ],
    }));

    const outcomes = await patchSessionModels(targets("agent:main:main", "agent:main:clawbox-1"), "nope/x", { call });

    expect(outcomes).toEqual([
      { key: "agent:main:main", agentId: "main", ok: true },
      { key: "agent:main:clawbox-1", agentId: "main", ok: false, error: "unknown model: nope/x", retryable: false },
    ]);
  });

  it("names the reason when a build sends the error as a bare string", async () => {
    const call = vi.fn<GatewayRpcCall>(async () => ({
      outcomes: [{ ok: false, key: "agent:main:a", error: "model catalog is still loading; retry in a few seconds" }],
    }));

    const outcomes = await patchSessionModels(targets("agent:main:a"), "deepseek/v4", { call, retryDelayMs: 0 });

    // Still recognised as transient, so it was retried once.
    expect(call).toHaveBeenCalledTimes(2);
    expect(outcomes[0]).toMatchObject({ ok: false, error: "model catalog is still loading; retry in a few seconds", retryable: true });
  });

  it("says once, loudly, when the envelope matches none of the targets", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const call = vi.fn<GatewayRpcCall>(async () => ({ results: [{ sessionKey: "agent:main:a", ok: true }] }));

    const outcomes = await patchSessionModels(targets("agent:main:a", "agent:main:b"), "deepseek/v4", { call });

    expect(outcomes.every((o) => !o.ok && !o.retryable)).toBe(true);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toMatch(/no recognisable outcome for any of 2 session\(s\); response keys: results/);
  });

  it("clears the pin with model: null", async () => {
    const call = gatewayOf();
    await patchSessionModels(targets("agent:main:a"), null, { call });
    expect(call.mock.calls[0][1]).toEqual({ targets: [{ key: "agent:main:a", agentId: "main" }], patch: { model: null } });
  });

  it("splits more targets than the gateway accepts per call into several calls", async () => {
    const call = gatewayOf();
    const many = targets(...Array.from({ length: SESSIONS_PATCH_MANY_MAX_TARGETS + 5 }, (_, i) => `agent:main:s${i}`));

    const outcomes = await patchSessionModels(many, "deepseek/v4", { call });

    expect(call).toHaveBeenCalledTimes(2);
    expect((call.mock.calls[0][1] as Params).targets).toHaveLength(SESSIONS_PATCH_MANY_MAX_TARGETS);
    expect((call.mock.calls[1][1] as Params).targets).toHaveLength(5);
    expect(outcomes.every((o) => o.ok)).toBe(true);
    expect(outcomes.map((o) => o.key)).toEqual(many.map((t) => t.key));
  });

  it("reports a target the gateway said nothing about as not patched", async () => {
    const call = vi.fn<GatewayRpcCall>(async () => ({ outcomes: [{ ok: true, key: "agent:main:a" }] }));

    const outcomes = await patchSessionModels(targets("agent:main:a", "agent:main:b"), "deepseek/v4", { call });

    expect(outcomes).toEqual([
      { key: "agent:main:a", agentId: "main", ok: true },
      { key: "agent:main:b", agentId: "main", ok: false, error: "the gateway reported no outcome for this session", retryable: false },
    ]);
  });

  it("retries once, for the transient targets only, when the catalog is still loading", async () => {
    // The core answers UNAVAILABLE "model catalog is still loading; retry in a
    // few seconds" right after a config change — exactly when a switch runs.
    let attempt = 0;
    const call = vi.fn<GatewayRpcCall>(async (_method, params) => {
      attempt += 1;
      const { targets } = params as Params;
      return {
        outcomes: targets.map((t) =>
          t.key === "agent:main:slow" && attempt === 1
            ? { ok: false, key: t.key, error: { code: "UNAVAILABLE", message: "model catalog is still loading; retry in a few seconds" } }
            : t.key === "agent:main:locked"
              ? { ok: false, key: t.key, error: { code: "INVALID_REQUEST", message: "model selection is locked" } }
              : { ok: true, key: t.key },
        ),
      };
    });

    const outcomes = await patchSessionModels(targets("agent:main:a", "agent:main:slow", "agent:main:locked"), "deepseek/v4", { call, retryDelayMs: 0 });

    expect(call).toHaveBeenCalledTimes(2);
    expect((call.mock.calls[1][1] as Params).targets).toEqual([{ key: "agent:main:slow", agentId: "main" }]);
    expect(outcomes).toEqual([
      { key: "agent:main:a", agentId: "main", ok: true },
      { key: "agent:main:slow", agentId: "main", ok: true },
      { key: "agent:main:locked", agentId: "main", ok: false, error: "model selection is locked", retryable: false },
    ]);
  });

  it("retries once when the gateway was not reachable, then reports every target with the transport's words", async () => {
    const call = vi.fn<GatewayRpcCall>(async () => {
      throw new Error("gateway closed (1006)");
    });

    const outcomes = await patchSessionModels(targets("agent:main:a", "agent:main:b"), "deepseek/v4", { call, retryDelayMs: 0 });

    expect(call).toHaveBeenCalledTimes(2);
    expect(outcomes).toEqual([
      { key: "agent:main:a", agentId: "main", ok: false, error: "gateway closed (1006)", retryable: true },
      { key: "agent:main:b", agentId: "main", ok: false, error: "gateway closed (1006)", retryable: true },
    ]);
  });

  it("does not retry a refusal that will not change", async () => {
    const call = gatewayOf({ "agent:main:a": { code: "INVALID_REQUEST", message: "unknown model: nope/x" } });
    await patchSessionModels(targets("agent:main:a"), "nope/x", { call, retryDelayMs: 0 });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("forwards the timeout to the transport", async () => {
    const call = gatewayOf();
    await patchSessionModels(targets("agent:main:a"), "deepseek/v4", { call, timeoutMs: 5_000 });
    expect(call.mock.calls[0][2]).toEqual({ timeoutMs: 5_000 });
  });
});
