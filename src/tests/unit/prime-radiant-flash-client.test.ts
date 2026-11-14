/**
 * The Flash client: the request it sends to the ClawBox AI proxy, how each
 * failure is classified, the retry policy, the cost estimate, and which
 * client answers (override → test-mode stub → the engine feature-engine.ts
 * names: ClawBox AI's proxy, or the box's own engine — TASK-2501 PR-C).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const creds = vi.hoisted(() => ({
  resolveClawaiToken: vi.fn(async (): Promise<string | null> => "claw_test_token"),
  clawaiCredentialGeneration: vi.fn(() => 3),
  noteClawaiCredentialRefused: vi.fn(async () => undefined),
  proxyRefusedClawaiCredential: vi.fn(async () => false),
}));
vi.mock("@/lib/harness/credentials", () => creds);

type Engine = { kind: "clawbox-ai" } | { kind: "local"; engine: typeof LOCAL_ENGINE } | { kind: "none"; reason: "cloud_ai_locked" | "no_credential" };
const feature = vi.hoisted(() => ({ resolveFeatureEngine: vi.fn() }));
vi.mock("@/lib/feature-engine", () => feature);

const LOCAL_ENGINE = {
  kind: "llamacpp" as const,
  model: "gemma4-e2b-it-q4_0",
  modelRef: "llamacpp/gemma4-e2b-it-q4_0",
  chatUrl: "http://127.0.0.1:3005/setup-api/local-ai/llamacpp/v1/chat/completions",
  authorization: "Bearer local-install-token",
  contextTokens: 32768,
  maxOutputTokens: 8192,
  parallel: 1,
  imageInput: false as boolean | null,
};

import {
  FlashCallError,
  backoffMs,
  completeWithRetry,
  createClawboxAiFlashClient,
  createLocalFlashClient,
  estimateUsd,
  flashAvailable,
  flashClient,
  flashEngine,
  flashUnavailableReason,
  fitsWindow,
  itemsThatFit,
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
  feature.resolveFeatureEngine.mockReset().mockResolvedValue({ kind: "clawbox-ai" } satisfies Engine);
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

  it.each([
    ["weekly_limit_exceeded", "weekly"],
    ["burst_limit_exceeded", "burst"],
  ])("reads a 429 naming %s as a spent allowance, asked once and never retried", async (code, allowanceKind) => {
    const fetchImpl = vi.fn(async () => respond(429, { error: { code, resetAt: "2026-10-25T00:00:00Z" } }, { "retry-after": "7" }));
    const client = createClawboxAiFlashClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect.soft(await client.complete(req).catch((e) => e)).toMatchObject({
      kind: "allowance",
      retryable: false,
      status: 429,
      allowance: { kind: allowanceKind, resetAt: "2026-10-25T00:00:00Z" },
    });
    fetchImpl.mockClear();
    await expect.soft(completeWithRetry(client, req, { sleep: async () => {} })).rejects.toMatchObject({ kind: "allowance" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps a 429 that names no allowance a busy proxy, retried after its Retry-After", async () => {
    const fetchImpl = vi.fn(async () => respond(429, { error: { code: "rate_limit_exceeded", message: "Too many requests" } }, { "retry-after": "3" }));
    const client = createClawboxAiFlashClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await client.complete(req).catch((e) => e)).toMatchObject({ kind: "rate_limited", retryable: true, retryAfterMs: 3000 });
    fetchImpl.mockClear();
    await expect(completeWithRetry(client, req, { sleep: async () => {} })).rejects.toMatchObject({ kind: "rate_limited" });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("reads no more of a 429's body than a refusal needs", async () => {
    // A megabyte of something else, the allowance code past the read: still just busy.
    const client = createClawboxAiFlashClient({ fetchImpl: (async () => respond(429, "x".repeat(1_000_000) + "weekly_limit_exceeded")) as unknown as typeof fetch });
    expect(await client.complete(req).catch((e) => e)).toMatchObject({ kind: "rate_limited", retryable: true });
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
    expect((await flashClient()).model).toBe("deepseek-v4-flash");
    vi.stubEnv("PRIME_RADIANT_FLASH_STUB", "1");
    expect((await flashClient()).model).toBe("deepseek-v4-flash");
    vi.stubEnv("CLAWBOX_TEST_MODE", "1");
    expect((await flashClient()).model).toBe(STUB_MODEL);
    const override: FlashClient = { model: "override", complete: async () => ({ text: "[]", model: "override", usage: readUsage({}) }) };
    setFlashClientOverride(override);
    expect(await flashClient()).toBe(override);
  });

  it("is the box's own engine where the box's AI runs on it, with the engine's budget", async () => {
    feature.resolveFeatureEngine.mockResolvedValue({ kind: "local", engine: LOCAL_ENGINE } satisfies Engine);
    const client = await flashClient();
    expect(client.model).toBe("llamacpp/gemma4-e2b-it-q4_0");
    expect(client.engine).toBe("local");
    expect(client.budget).toEqual({ contextTokens: 32768, maxOutputTokens: 8192, parallel: 1 });
    expect(await flashEngine()).toBe("local");
    expect(await flashUnavailableReason()).toBeNull();
  });

  it("answers no_engine on a locked box with no model of its own, and never asks the cloud", async () => {
    feature.resolveFeatureEngine.mockResolvedValue({ kind: "none", reason: "cloud_ai_locked" } satisfies Engine);
    const client = await flashClient();
    await expect(client.complete(req)).rejects.toMatchObject({ kind: "no_engine", retryable: false });
    expect(creds.resolveClawaiToken).not.toHaveBeenCalled();
    expect(await flashUnavailableReason()).toBe("cloud_ai_locked");
    expect(await flashEngine()).toBeNull();
  });

  it("is available with either engine, an override or the stub; the reason says which is missing", async () => {
    feature.resolveFeatureEngine.mockResolvedValue({ kind: "none", reason: "no_credential" } satisfies Engine);
    expect(await flashAvailable()).toBe(false);
    expect(await flashUnavailableReason()).toBe("no_credential");
    feature.resolveFeatureEngine.mockResolvedValue({ kind: "local", engine: LOCAL_ENGINE } satisfies Engine);
    expect(await flashAvailable()).toBe(true);
    feature.resolveFeatureEngine.mockResolvedValue({ kind: "none", reason: "no_credential" } satisfies Engine);
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
    const out = await (await flashClient()).complete({ ...prompt, maxTokens: 100 });
    const verdicts = parseWriterResponse(out.text, items);
    expect(verdicts.get(0)).toMatchObject({ ok: true, draft: { title: "Acme catalogue", useful: true } });
    expect(verdicts.get(1)).toMatchObject({ ok: true, draft: { useful: false } });
    expect(out.usage.promptTokens).toBeGreaterThan(0);
  });
});

describe("the box's own engine as a Flash client", () => {
  const sized = { system: "s".repeat(2_500), user: "u".repeat(25_000), maxTokens: 48_000 };

  it("posts to the engine, cuts the answer's ceiling to what the window leaves, and records the engine's ref", async () => {
    const fetchImpl = vi.fn(async () => respond(200, { model: "gemma", choices: [{ message: { content: "[]" }, finish_reason: "stop" }], usage: { prompt_tokens: 11_000, completion_tokens: 50 } }));
    const client = createLocalFlashClient(LOCAL_ENGINE, { fetchImpl: fetchImpl as unknown as typeof fetch });
    const out = await client.complete(sized);
    expect(out).toEqual({ text: "[]", model: "llamacpp/gemma4-e2b-it-q4_0", usage: { promptTokens: 11_000, completionTokens: 50, cacheHitTokens: 0 }, finishReason: "stop" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(LOCAL_ENGINE.chatUrl);
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer local-install-token");
    const body = JSON.parse(String(init.body));
    // 48,000 asked; the engine answers at most 8,192, and the window has room for that beside ~11k of prompt.
    expect(body).toMatchObject({ model: "gemma4-e2b-it-q4_0", temperature: 0, max_tokens: 8192, reasoning_effort: "none", stream: false });
    expect(body.messages).toEqual([{ role: "system", content: sized.system }, { role: "user", content: sized.user }]);
    expect(creds.resolveClawaiToken).not.toHaveBeenCalled();
  });

  it("cuts the ceiling to the window's room when the prompt is long, and refuses as too_long before sending when none is left", async () => {
    const fetchImpl = vi.fn(async () => respond(200, okBody));
    const client = createLocalFlashClient({ ...LOCAL_ENGINE, contextTokens: 16_384 }, { fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.complete({ system: "s", user: "u".repeat(30_000), maxTokens: 48_000 });
    const asked = JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body)).max_tokens;
    expect(asked).toBe(16_384 - Math.ceil(1 / 2.5) - 12_000 - 320);
    fetchImpl.mockClear();
    await expect(client.complete({ system: "s", user: "u".repeat(40_000), maxTokens: 1_000 })).rejects.toMatchObject({ kind: "too_long", retryable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("words each failure as the box's own engine, in the kinds every pass already reads", async () => {
    const cases: Array<[Response, string]> = [
      [respond(400, { error: { type: "exceed_context_size_error", message: "the request exceeds the available context size" } }), "too_long"],
      [respond(400, { error: "bad request" }), "refused"],
      [respond(401, { error: "local-ai bearer token required" }), "auth"],
      [respond(429, "busy"), "rate_limited"],
      [respond(502, { error: "Failed to start llamacpp" }), "server"],
      [respond(503, { code: "external_engine_selected" }), "server"],
      [respond(200, "not json"), "bad_response"],
      [respond(200, { choices: [{ message: { content: "" }, finish_reason: "length" }] }), "bad_response"],
    ];
    for (const [res, kind] of cases) {
      const client = createLocalFlashClient(LOCAL_ENGINE, { fetchImpl: (async () => res) as unknown as typeof fetch });
      const err = await client.complete(req).catch((e) => e);
      expect(err, `${res.status} → ${kind}`).toBeInstanceOf(FlashCallError);
      expect((err as FlashCallError).kind, `${res.status} → ${kind}`).toBe(kind);
      expect((err as FlashCallError).message).toMatch(/model on this box/);
    }
    const external = createLocalFlashClient({ ...LOCAL_ENGINE, kind: "clawext", modelRef: "clawext/qwen3-32b" }, { fetchImpl: (async () => respond(403, "no")) as unknown as typeof fetch });
    await expect(external.complete(req)).rejects.toMatchObject({ kind: "auth", message: expect.stringMatching(/External engine refused this box's key/) });
  });

  it("calls an unreachable engine a network failure, one cut by its time too_long, and one the owner stopped aborted", async () => {
    const down = createLocalFlashClient(LOCAL_ENGINE, { fetchImpl: (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch });
    await expect(down.complete(req)).rejects.toMatchObject({ kind: "network", retryable: true });

    const hang = (async (_url: string, init: RequestInit) =>
      await new Promise<Response>((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    const slow = createLocalFlashClient(LOCAL_ENGINE, { fetchImpl: hang, timeoutMs: 20 });
    await expect(slow.complete(req)).rejects.toMatchObject({ kind: "too_long", retryable: false });

    const stop = new AbortController();
    const stopped = createLocalFlashClient(LOCAL_ENGINE, { fetchImpl: hang });
    const pending = stopped.complete({ ...req, signal: stop.signal });
    stop.abort();
    await expect(pending).rejects.toMatchObject({ kind: "aborted" });
  });

  it("is never resent as it was when too long: completeWithRetry asks it once", async () => {
    const fetchImpl = vi.fn(async () => respond(400, { error: "context size exceeded" }));
    const client = createLocalFlashClient(LOCAL_ENGINE, { fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(completeWithRetry(client, req, { sleep: async () => undefined })).rejects.toMatchObject({ kind: "too_long" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("sizing a call to a bounded window", () => {
  const budget = { contextTokens: 4_096, maxOutputTokens: 2_048, parallel: 1 };
  const build = (n: number) => ({ system: "s".repeat(500), user: "u".repeat(1_000 * n), maxTokens: 256 * n });

  it("fits a request whose prompt, frame and longest answer the window holds, by the client's own estimate", () => {
    expect(fitsWindow(budget, { system: "s".repeat(500), user: "u".repeat(1_000), maxTokens: 1_000 })).toBe(true);
    // 200 + 4,000 tokens of prompt: no window left.
    expect(fitsWindow(budget, { system: "s".repeat(500), user: "u".repeat(10_000), maxTokens: 1 })).toBe(false);
    // The answer counts up to the engine's own ceiling, not the one asked.
    expect(fitsWindow(budget, { system: "s", user: "u", maxTokens: 1_000_000 })).toBe(true);
  });

  it("takes the most items that fit, at least one, and every item with no budget", () => {
    const n = itemsThatFit(budget, 8, build);
    expect(n).toBeGreaterThan(1);
    expect(n).toBeLessThan(8);
    expect(fitsWindow(budget, build(n))).toBe(true);
    expect(fitsWindow(budget, build(n + 1))).toBe(false);
    expect(itemsThatFit({ ...budget, contextTokens: 100 }, 8, build)).toBe(1);
    expect(itemsThatFit(undefined, 8, build)).toBe(8);
  });
});

describe("the box's own engine: what it reads of an answer", () => {
  it("reads no more than a few KB of a refusal's body", async () => {
    let pulled = 0;
    const big = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 1_000) controller.close();
        else controller.enqueue(new TextEncoder().encode("x".repeat(1_024)));
      },
    });
    const client = createLocalFlashClient(LOCAL_ENGINE, { fetchImpl: (async () => new Response(big, { status: 400 })) as unknown as typeof fetch });
    await expect(client.complete(req)).rejects.toMatchObject({ kind: "refused" });
    expect(pulled).toBeLessThan(20);
  });

  it("calls an answer cut by the clock while it arrives too_long, never a bad answer to resend", async () => {
    const stalled = (async (_url: string, init: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{\"choices\": ["));
          init.signal!.addEventListener("abort", () => controller.error(init.signal!.reason));
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
    const client = createLocalFlashClient(LOCAL_ENGINE, { fetchImpl: stalled, timeoutMs: 30 });
    await expect(client.complete(req)).rejects.toMatchObject({ kind: "too_long" });
  });
});
