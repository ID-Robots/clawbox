import { describe, expect, it, vi } from "vitest";

// The question the fallback asks before it moves the chat onto a model: can
// THIS account run it? One request, one output token, the provider's answer
// read narrowly — only a stated zero limit marks a model dead, only a 2xx says
// it runs, and everything else decides nothing.

vi.mock("@/lib/openclaw-auth-store", () => ({
  readGatewayProviderSecret: vi.fn(() => null),
}));

import { canProbeProvider, classifyProbeAnswer, probeProviderModel } from "@/lib/provider-model-probe";

const ZERO_BODY = JSON.stringify({
  code: "Some resource has been exhausted",
  error: "Too many requests for team T and model grok-4.6. Your team's rate limit is — Requests per Minute (actual/limit): 0/0. Your rate limit tier is determined based on your historical API spend.",
});
const THROTTLE_BODY = JSON.stringify({ error: "Too many requests. Requests per Minute (actual/limit): 61/60." });

function answer(status: number, body = "") {
  return new Response(body, { status, headers: { "Content-Type": "application/json" } });
}

describe("classifyProbeAnswer", () => {
  it("reads a 2xx as a model that runs", () => {
    expect(classifyProbeAnswer(200, "")).toBe("ok");
  });

  it("reads a 429 stating a limit of zero as no quota — and an ordinary throttle as no verdict", () => {
    expect(classifyProbeAnswer(429, ZERO_BODY)).toBe("zero_quota");
    expect(classifyProbeAnswer(429, THROTTLE_BODY)).toBe("unknown");
    // The provider's words without the status still read as the 429 they came with.
    expect(classifyProbeAnswer(429, "Requests per Minute (actual/limit): 0/0")).toBe("zero_quota");
  });

  it("reads a 404, or a refusal naming an unknown model, as a model the provider does not serve", () => {
    expect(classifyProbeAnswer(404, "")).toBe("not_found");
    expect(classifyProbeAnswer(400, JSON.stringify({ error: "The model grok-9 does not exist or your team does not have access to it." }))).toBe("not_found");
  });

  it("decides nothing on anything else: a refused key, a bad request, a provider outage", () => {
    expect(classifyProbeAnswer(401, "Incorrect API key")).toBe("unknown");
    expect(classifyProbeAnswer(400, "max_tokens is not supported")).toBe("unknown");
    expect(classifyProbeAnswer(503, "")).toBe("unknown");
  });
});

describe("probeProviderModel", () => {
  it("asks xAI about exactly that model, with one output token and the gateway's credential", async () => {
    const fetchImpl = vi.fn(async () => answer(200, JSON.stringify({ choices: [{ message: { content: "O" } }] })));
    const verdict = await probeProviderModel("xai", "grok-4.6", { fetchImpl, readSecret: () => "test-key-placeholder" });
    expect(verdict).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.x.ai/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key-placeholder");
    expect(JSON.parse(String(init.body))).toMatchObject({ model: "grok-4.6", max_tokens: 1, stream: false });
  });

  it("answers what the provider proved", async () => {
    const readSecret = () => "test-key-placeholder";
    expect(await probeProviderModel("xai", "grok-4.6", { readSecret, fetchImpl: vi.fn(async () => answer(429, ZERO_BODY)) })).toBe("zero_quota");
    expect(await probeProviderModel("xai", "grok-4.6", { readSecret, fetchImpl: vi.fn(async () => answer(429, THROTTLE_BODY)) })).toBe("unknown");
    expect(await probeProviderModel("xai", "grok-9", { readSecret, fetchImpl: vi.fn(async () => answer(404, "")) })).toBe("not_found");
  });

  it("decides nothing — and sends nothing — without a credential the box can spend", async () => {
    const fetchImpl = vi.fn(async () => answer(200));
    expect(await probeProviderModel("xai", "grok-4.6", { fetchImpl, readSecret: () => null })).toBe("unknown");
    // The default reader is the gateway's auth store (mocked empty here).
    expect(await probeProviderModel("xai", "grok-4.6", { fetchImpl })).toBe("unknown");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("decides nothing for a provider it has no endpoint for, or when the network fails", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("getaddrinfo ENOTFOUND"); });
    expect(canProbeProvider("xai")).toBe(true);
    expect(canProbeProvider("anthropic")).toBe(false);
    expect(await probeProviderModel("anthropic", "claude-opus-5-5", { fetchImpl, readSecret: () => "k" })).toBe("unknown");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await probeProviderModel("xai", "grok-4.6", { fetchImpl, readSecret: () => "k" })).toBe("unknown");
  });
});
