/**
 * The Flash client: the request it sends to the ClawBox AI proxy, how each
 * failure is classified, the retry policy, the cost estimate, and which
 * client answers (override → test-mode stub → the real proxy).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const creds = vi.hoisted(() => ({
  resolveClawaiToken: vi.fn(async (): Promise<string | null> => "claw_test_token"),
  clawaiCredentialGeneration: vi.fn(() => 3),
  noteClawaiCredentialRefused: vi.fn(async () => undefined),
  proxyRefusedClawaiCredential: vi.fn(async () => false),
}));
vi.mock("@/lib/harness/credentials", () => creds);

import {
  FlashCallError,
  backoffMs,
  completeWithRetry,
  createClawboxAiFlashClient,
  estimateUsd,
  flashAvailable,
  flashClient,
  readUsage,
  setFlashClientOverride,
  type FlashClient,
} from "@/lib/prime-radiant/flash-client";
import { STUB_MODEL } from "@/lib/prime-radiant/flash-stub";
import { buildWriterPrompt, parseWriterResponse } from "@/lib/prime-radiant/writer";

const okBody = {
  choices: [{ message: { content: "[]" } }],
  usage: { prompt_tokens: 1000, completion_tokens: 200, prompt_cache_hit_tokens: 400 },
};

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
}

const req = { system: "sys", user: "user", maxTokens: 100 };

beforeEach(() => {
  creds.resolveClawaiToken.mockReset().mockResolvedValue("claw_test_token");
  creds.noteClawaiCredentialRefused.mockClear();
  creds.proxyRefusedClawaiCredential.mockReset().mockResolvedValue(false);
  delete process.env.CLAWBOX_AI_PROXY_URL;
});

afterEach(() => {
  setFlashClientOverride(null);
  vi.unstubAllEnvs();
});

describe("the ClawBox AI client", () => {
  it("posts one chat completion to the proxy with the box's credential and the Flash model", async () => {
    process.env.CLAWBOX_AI_PROXY_URL = "https://proxy.example.com/api/ai/";
    const fetchImpl = vi.fn(async () => respond(200, okBody));
    const client = createClawboxAiFlashClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const out = await client.complete(req);
    expect(out).toEqual({
      text: "[]",
      model: "deepseek-v4-flash",
      usage: { promptTokens: 1000, completionTokens: 200, cacheHitTokens: 400 },
      finishReason: null,
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://proxy.example.com/api/ai/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer claw_test_token");
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "deepseek-v4-flash",
      temperature: 0,
      max_tokens: 100,
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "user" },
      ],
    });
  });

  it("says when the answer was cut at its output cap, and an empty one capped before it began", async () => {
    const capped = { ...okBody, choices: [{ message: { content: '[{"i":0,"verdict":"compatible"}' }, finish_reason: "length" }] };
    const client = createClawboxAiFlashClient({ fetchImpl: (async () => respond(200, capped)) as unknown as typeof fetch });
    expect(await client.complete(req)).toMatchObject({ finishReason: "length" });
    const empty = { ...okBody, choices: [{ message: { content: "" }, finish_reason: "length" }] };
    const none = createClawboxAiFlashClient({ fetchImpl: (async () => respond(200, empty)) as unknown as typeof fetch });
    await expect(none.complete(req)).rejects.toMatchObject({ kind: "bad_response", message: expect.stringMatching(/output cap/) });
  });

  it("refuses to call without a credential", async () => {
    creds.resolveClawaiToken.mockResolvedValue(null);
    const fetchImpl = vi.fn();
    await expect(createClawboxAiFlashClient({ fetchImpl: fetchImpl as unknown as typeof fetch }).complete(req)).rejects.toMatchObject({
      kind: "no_credential",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    [429, { "retry-after": "7" }, "rate_limited", 7000],
    [503, {}, "server", null],
    [400, {}, "refused", null],
  ])("classifies %i", async (status, headers, kind, retryAfter) => {
    const client = createClawboxAiFlashClient({ fetchImpl: (async () => respond(status, "x", headers)) as unknown as typeof fetch });
    const err = await client.complete(req).catch((e) => e);
    expect(err).toBeInstanceOf(FlashCallError);
    expect(err).toMatchObject({ kind, status, retryAfterMs: retryAfter });
  });

  it("remembers a credential the proxy itself refused, and nothing else", async () => {
    creds.proxyRefusedClawaiCredential.mockResolvedValueOnce(true);
    const client = createClawboxAiFlashClient({ fetchImpl: (async () => respond(401, { error: { code: "invalid_token" } })) as unknown as typeof fetch });
    await expect(client.complete(req)).rejects.toMatchObject({ kind: "auth", retryable: false });
    expect(creds.noteClawaiCredentialRefused).toHaveBeenCalledWith(401, 3);

    creds.noteClawaiCredentialRefused.mockClear();
    const plan = createClawboxAiFlashClient({ fetchImpl: (async () => respond(403, { error: { code: "plan" } })) as unknown as typeof fetch });
    await expect(plan.complete(req)).rejects.toMatchObject({ kind: "refused" });
    expect(creds.noteClawaiCredentialRefused).not.toHaveBeenCalled();
  });

  it("treats a dropped connection, non-JSON and an empty answer as retryable", async () => {
    const cases: Array<[() => Promise<Response>, string]> = [
      [async () => Promise.reject(new TypeError("fetch failed")), "network"],
      [async () => respond(200, "<html>"), "bad_response"],
      [async () => respond(200, { choices: [{ message: { content: "  " } }] }), "bad_response"],
    ];
    for (const [impl, kind] of cases) {
      const err = await createClawboxAiFlashClient({ fetchImpl: impl as unknown as typeof fetch }).complete(req).catch((e) => e);
      expect(err).toMatchObject({ kind, retryable: true });
    }
  });

  it("reads usage defensively", () => {
    expect(readUsage(null)).toEqual({ promptTokens: 0, completionTokens: 0, cacheHitTokens: 0 });
    expect(readUsage({ prompt_tokens: -1, completion_tokens: "9" })).toEqual({ promptTokens: 0, completionTokens: 0, cacheHitTokens: 0 });
  });
});

describe("completeWithRetry", () => {
  const ok = { text: "[]", model: "m", usage: { promptTokens: 1, completionTokens: 1, cacheHitTokens: 0 } };

  function scripted(...steps: Array<FlashCallError | typeof ok>): FlashClient & { calls: number } {
    const c = {
      model: "m",
      calls: 0,
      async complete() {
        const step = steps[Math.min(c.calls, steps.length - 1)];
        c.calls += 1;
        if (step instanceof FlashCallError) throw step;
        return step;
      },
    };
    return c;
  }

  it("retries 429 and 5xx with the server's Retry-After, then succeeds", async () => {
    const sleep = vi.fn(async () => undefined);
    const client = scripted(new FlashCallError("rate_limited", "busy", 429, 5000), new FlashCallError("server", "down", 502), ok);
    const out = await completeWithRetry(client, req, { sleep, random: () => 0 });
    expect(out).toEqual({ response: ok, attempts: 3 });
    expect(sleep.mock.calls.map((c) => (c as unknown[])[0])).toEqual([5000, 2000]);
  });

  it("does not retry a refused credential, a refused plan or a stop", async () => {
    for (const kind of ["auth", "refused", "no_credential", "aborted"] as const) {
      const client = scripted(new FlashCallError(kind, kind));
      await expect(completeWithRetry(client, req, { sleep: async () => undefined })).rejects.toMatchObject({ kind });
      expect(client.calls).toBe(1);
    }
  });

  it("does not resend what the caller says is not worth the same request again", async () => {
    const client = scripted(new FlashCallError("bad_response", "capped"), ok);
    await expect(
      completeWithRetry(client, req, { sleep: async () => undefined, retryOn: (e) => e.kind !== "bad_response" }),
    ).rejects.toMatchObject({ kind: "bad_response" });
    expect(client.calls).toBe(1);
    const busy = scripted(new FlashCallError("rate_limited", "busy", 429), ok);
    expect(await completeWithRetry(busy, req, { sleep: async () => undefined, retryOn: (e) => e.kind !== "bad_response" })).toMatchObject({ attempts: 2 });
  });

  it("gives up after the attempts, with the last error", async () => {
    const client = scripted(new FlashCallError("rate_limited", "busy", 429));
    const onRetry = vi.fn();
    await expect(completeWithRetry(client, req, { attempts: 3, sleep: async () => undefined, onRetry })).rejects.toMatchObject({
      kind: "rate_limited",
    });
    expect(client.calls).toBe(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("wraps a plain throw as a retryable network error", async () => {
    let n = 0;
    const client: FlashClient = {
      model: "m",
      async complete() {
        n += 1;
        if (n === 1) throw new Error("socket hang up");
        return ok;
      },
    };
    await expect(completeWithRetry(client, req, { sleep: async () => undefined })).resolves.toMatchObject({ attempts: 2 });
  });

  it("backs off exponentially with equal jitter, capped at a minute", () => {
    const e = new FlashCallError("server", "x");
    expect(backoffMs(e, 1, () => 0)).toBe(1000);
    expect(backoffMs(e, 1, () => 0.999)).toBe(1999);
    expect(backoffMs(e, 2, () => 0)).toBe(2000);
    expect(backoffMs(e, 3, () => 0)).toBe(4000);
    expect(backoffMs(e, 4, () => 0.5)).toBe(12000);
    expect(backoffMs(e, 100, () => 0)).toBe(30_000);
    expect(backoffMs(e, 100, () => 0.9999)).toBeLessThanOrEqual(60_000);
  });

  it("honours Retry-After and spreads the calls it refused together", () => {
    const e = new FlashCallError("rate_limited", "busy", 429, 5_000);
    expect(backoffMs(e, 1, () => 0)).toBe(5_000);
    expect(backoffMs(e, 1, () => 0.5)).toBe(6_000);
    const waits = new Set(Array.from({ length: 20 }, (_, i) => backoffMs(e, 1, () => i / 20)));
    expect(waits.size).toBe(20);
  });

  it("waits the backoff between attempts and passes the abort signal", async () => {
    const waits: number[] = [];
    let n = 0;
    const client: FlashClient = {
      model: "m",
      async complete() {
        n += 1;
        if (n < 4) throw new FlashCallError("rate_limited", "busy", 429);
        return ok;
      },
    };
    await completeWithRetry(client, req, { sleep: async (ms) => void waits.push(ms), random: () => 0 });
    expect(waits).toEqual([1000, 2000, 4000]);
  });
});

describe("cost estimate", () => {
  it("prices cache misses, cache hits and output separately", () => {
    expect(estimateUsd("deepseek-v4-flash", { promptTokens: 1_000_000, completionTokens: 1_000_000, cacheHitTokens: 0 })).toBeCloseTo(0.42, 6);
    expect(estimateUsd("deepseek-v4-flash", { promptTokens: 1_000_000, completionTokens: 0, cacheHitTokens: 1_000_000 })).toBeCloseTo(0.0028, 6);
    expect(estimateUsd("unknown-model", { promptTokens: 1_000_000, completionTokens: 1_000_000, cacheHitTokens: 0 })).toBe(0);
  });
});

describe("which client answers", () => {
  it("an override first, then the stub in test mode only, else the proxy", async () => {
    expect(flashClient().model).toBe("deepseek-v4-flash");
    vi.stubEnv("PRIME_RADIANT_FLASH_STUB", "1");
    expect(flashClient().model).toBe("deepseek-v4-flash");
    vi.stubEnv("CLAWBOX_TEST_MODE", "1");
    expect(flashClient().model).toBe(STUB_MODEL);
    const override: FlashClient = { model: "override", complete: async () => ({ text: "[]", model: "override", usage: readUsage({}) }) };
    setFlashClientOverride(override);
    expect(flashClient()).toBe(override);
  });

  it("is available with a credential, an override or the stub", async () => {
    creds.resolveClawaiToken.mockResolvedValue(null);
    expect(await flashAvailable()).toBe(false);
    vi.stubEnv("CLAWBOX_TEST_MODE", "1");
    vi.stubEnv("PRIME_RADIANT_FLASH_STUB", "1");
    expect(await flashAvailable()).toBe(true);
  });

  it("the stub answers every item in the writer's own format", async () => {
    vi.stubEnv("CLAWBOX_TEST_MODE", "1");
    vi.stubEnv("PRIME_RADIANT_FLASH_STUB", "1");
    const items = [
      { i: 0, path: "upload/acme-catalogue.md", kind: "md", text: "# Acme catalogue\n\nAcme Widgets Ltd sells blue widgets. Orders ship within two days." },
      { i: 1, path: "upload/notes.txt", kind: "txt", text: "short" },
    ];
    const prompt = buildWriterPrompt(items);
    const out = await flashClient().complete({ ...prompt, maxTokens: 100 });
    const verdicts = parseWriterResponse(out.text, items);
    expect(verdicts.get(0)).toMatchObject({ ok: true, draft: { title: "Acme catalogue", useful: true } });
    expect(verdicts.get(1)).toMatchObject({ ok: true, draft: { useful: false } });
    expect(out.usage.promptTokens).toBeGreaterThan(0);
  });
});
