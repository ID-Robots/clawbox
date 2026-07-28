import { describe, it, expect, vi } from "vitest";
import {
  CODEX_FALLBACK_MODEL,
  CODEX_MODEL_PREFERENCE,
  classifyProbeResponse,
  extractChatGptAccountId,
  probeCodexModel,
  resolveEntitledCodexModel,
} from "@/lib/codex-model-probe";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}

function makeJwt(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `header.${payload}.signature`;
}

describe("classifyProbeResponse", () => {
  it("treats success as available", () => {
    expect(classifyProbeResponse(200, "{}")).toBe("available");
  });

  it("treats a payload-shape 400 as available", () => {
    // Upstream got far enough to validate the body, so the model was accepted.
    expect(classifyProbeResponse(400, '{"error":{"message":"Input must be a list"}}')).toBe("available");
  });

  it("treats a model-gated 400 as unavailable", () => {
    expect(
      classifyProbeResponse(
        400,
        '{"error":{"message":"The \'gpt-5.6-sol\' model requires a newer version of Codex."}}',
      ),
    ).toBe("unavailable");
    expect(
      classifyProbeResponse(
        400,
        '{"error":{"message":"model not supported when using Codex with a ChatGPT account"}}',
      ),
    ).toBe("unavailable");
  });

  it("treats forbidden and not-found as unavailable", () => {
    expect(classifyProbeResponse(403, "")).toBe("unavailable");
    expect(classifyProbeResponse(404, "")).toBe("unavailable");
  });

  it("refuses to guess on auth, rate-limit, or upstream errors", () => {
    // None of these say anything about entitlement — guessing "available" here
    // is what pins an account to a model that fails every turn.
    expect(classifyProbeResponse(401, "")).toBe("indeterminate");
    expect(classifyProbeResponse(429, "")).toBe("indeterminate");
    expect(classifyProbeResponse(500, "")).toBe("indeterminate");
  });
});

describe("extractChatGptAccountId", () => {
  it("reads chatgpt_account_id from the auth claim", () => {
    const jwt = makeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" } });
    expect(extractChatGptAccountId(jwt)).toBe("acct_123");
  });

  it("returns null for an opaque token", () => {
    expect(extractChatGptAccountId("not-a-jwt")).toBeNull();
  });
});

describe("probeCodexModel", () => {
  it("sends the account header and bearer token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    await probeCodexModel("gpt-5.6-sol", {
      accessToken: "tok",
      accountId: "acct_1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain("chatgpt.com/backend-api/codex/responses");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok");
    expect(headers["chatgpt-account-id"]).toBe("acct_1");
    expect(JSON.parse((init as RequestInit).body as string).model).toBe("gpt-5.6-sol");
  });

  it("is indeterminate when the request throws", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    await expect(
      probeCodexModel("gpt-5.6-sol", {
        accessToken: "tok",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toBe("indeterminate");
  });
});

describe("resolveEntitledCodexModel", () => {
  it("returns Sol for an entitled account without probing further", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    const model = await resolveEntitledCodexModel({
      accessToken: "tok",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(model).toBe("gpt-5.6-sol");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("walks down to the newest model the account actually has", async () => {
    // Partial 5.6 entitlement: sol and terra gated, luna not.
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(400, { error: { message: "requires a newer version of Codex" } }))
      .mockResolvedValueOnce(jsonResponse(403, ""))
      .mockResolvedValueOnce(jsonResponse(200, {}));

    const model = await resolveEntitledCodexModel({
      accessToken: "tok",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(model).toBe("gpt-5.6-luna");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("only probes plan-gated models — gpt-5.5 is the floor, not a candidate", () => {
    // gpt-5.5 runs on every ChatGPT tier including Free. Probing it would spend
    // a setup round-trip to confirm something we already hold.
    expect([...CODEX_MODEL_PREFERENCE]).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);
    expect(CODEX_FALLBACK_MODEL).toBe("gpt-5.5");
  });

  it("keeps the caller's default when nothing is available", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(403, ""));
    await expect(
      resolveEntitledCodexModel({
        accessToken: "tok",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toBeNull();
  });

  it("gives up after two indeterminate probes instead of hammering upstream", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(401, ""));
    const model = await resolveEntitledCodexModel({
      accessToken: "tok",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(model).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("stops when the time budget is spent", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(403, ""));
    let clock = 0;
    const model = await resolveEntitledCodexModel({
      accessToken: "tok",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      totalBudgetMs: 10,
      now: () => (clock += 6),
    });

    expect(model).toBeNull();
    // Budget is checked before each probe, so it can't run the whole list.
    expect(fetchImpl.mock.calls.length).toBeLessThan(CODEX_MODEL_PREFERENCE.length);
  });

  it("does nothing without an access token", async () => {
    const fetchImpl = vi.fn();
    await expect(
      resolveEntitledCodexModel({
        accessToken: "  ",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never proposes the fallback — that is the caller's job", () => {
    expect(CODEX_MODEL_PREFERENCE).not.toContain(CODEX_FALLBACK_MODEL);
  });
});
