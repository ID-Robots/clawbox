import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, statSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * The external AI engine's pure half and its server helpers (TASK-2376): the
 * input rule, the base-URL rule, the `/models` probe and its error codes, and
 * the key file — which must be 0600 and never surface in a view or an error.
 */

const KEY = "sk-test-external-engine-placeholder-0123456789";

let root: string;
vi.mock("@/lib/config-store", () => ({
  get: vi.fn(async () => undefined),
  resolveConfigRoot: () => root,
}));

import {
  externalEngineDisplayName,
  externalEngineModelRef,
  isExternalEngineRef,
  normalizeExternalBaseUrl,
  parseExternalApiKey,
  validateExternalEngineInput,
} from "@/lib/external-engine-shared";
import {
  deleteExternalEngineKey,
  externalEngineFromState,
  externalEngineSummary,
  externalEngineView,
  openclawExternalProviderDefinition,
  probeExternalEngine,
  probeExternalEngineReasoning,
  readExternalEngineKey,
  writeExternalEngineKey,
} from "@/lib/external-engine";

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "external-engine-"));
  mkdirSync(path.join(root, "data"), { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("normalizeExternalBaseUrl", () => {
  it("keeps http(s) URLs and drops a trailing slash", () => {
    expect(normalizeExternalBaseUrl("http://192.0.2.10:8000/v1/")).toBe("http://192.0.2.10:8000/v1");
    expect(normalizeExternalBaseUrl(" https://engine.example.com/v1 ")).toBe("https://engine.example.com/v1");
    expect(normalizeExternalBaseUrl("http://127.0.0.1:8000")).toBe("http://127.0.0.1:8000");
  });

  it("refuses credentials, queries, fragments and other schemes", () => {
    expect(normalizeExternalBaseUrl("http://user:pass@192.0.2.10/v1")).toBeNull();
    expect(normalizeExternalBaseUrl("http://192.0.2.10/v1?key=x")).toBeNull();
    expect(normalizeExternalBaseUrl("http://192.0.2.10/v1#x")).toBeNull();
    expect(normalizeExternalBaseUrl("ftp://192.0.2.10/v1")).toBeNull();
    expect(normalizeExternalBaseUrl("not a url")).toBeNull();
    expect(normalizeExternalBaseUrl("")).toBeNull();
    expect(normalizeExternalBaseUrl(42)).toBeNull();
  });

  it("refuses the box's own Local AI proxy, the back door to llama.cpp", () => {
    expect(normalizeExternalBaseUrl("http://127.0.0.1/setup-api/local-ai/llamacpp/v1")).toBeNull();
  });
});

describe("validateExternalEngineInput", () => {
  const base = { baseUrl: "http://192.0.2.10:8000/v1", modelId: "Qwen/Qwen3-32B" };

  it("fills the window and output defaults", () => {
    const r = validateExternalEngineInput(base);
    expect(r).toEqual({
      ok: true,
      value: { baseUrl: "http://192.0.2.10:8000/v1", modelId: "Qwen/Qwen3-32B", contextWindow: 32768, maxTokens: 4096, imageInput: false, reasoning: false },
    });
  });

  it("accepts numbers typed as strings and the image switch", () => {
    const r = validateExternalEngineInput({ ...base, contextWindow: "131072", maxTokens: "8192", imageInput: true });
    expect(r.ok && r.value).toMatchObject({ contextWindow: 131072, maxTokens: 8192, imageInput: true });
  });

  it("takes the reasoning switch only as an explicit true (TASK-2497)", () => {
    const on = validateExternalEngineInput({ ...base, reasoning: true });
    expect(on.ok && on.value.reasoning).toBe(true);
    for (const reasoning of [undefined, false, "true", 1, "on"]) {
      const r = validateExternalEngineInput({ ...base, reasoning });
      expect(r.ok && r.value.reasoning).toBe(false);
    }
  });

  it.each([
    [{ ...base, baseUrl: "nope" }, "invalid_base_url"],
    [{ ...base, modelId: "" }, "invalid_model"],
    [{ ...base, modelId: "-rf" }, "invalid_model"],
    [{ ...base, modelId: "a b" }, "invalid_model"],
    [{ ...base, modelId: "x\ny" }, "invalid_model"],
    [{ ...base, contextWindow: 100 }, "invalid_context_window"],
    [{ ...base, contextWindow: 1.5 }, "invalid_context_window"],
    [{ ...base, contextWindow: 8192, maxTokens: 16384 }, "invalid_max_tokens"],
    [{ ...base, maxTokens: 10 }, "invalid_max_tokens"],
  ])("refuses %j with %s", (body, code) => {
    const r = validateExternalEngineInput(body as Record<string, unknown>);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(code);
  });
});

describe("parseExternalApiKey", () => {
  it("treats empty as no key and refuses multi-line or spaced keys", () => {
    expect(parseExternalApiKey(undefined)).toEqual({ ok: true, key: null });
    expect(parseExternalApiKey("  ")).toEqual({ ok: true, key: null });
    expect(parseExternalApiKey(` ${KEY} `)).toEqual({ ok: true, key: KEY });
    expect(parseExternalApiKey("a\nb").ok).toBe(false);
    expect(parseExternalApiKey("a b").ok).toBe(false);
    expect(parseExternalApiKey(5).ok).toBe(false);
  });
});

describe("names and refs", () => {
  it("keeps the model's own slashes after the provider prefix", () => {
    expect(externalEngineModelRef("Qwen/Qwen3-32B")).toBe("clawext/Qwen/Qwen3-32B");
    expect(isExternalEngineRef("clawext/Qwen/Qwen3-32B")).toBe(true);
    expect(isExternalEngineRef("clawext/")).toBe(false);
    expect(isExternalEngineRef("llamacpp/gemma4-e2b-it-q4_0")).toBe(false);
    expect(externalEngineDisplayName("clawext/Qwen/Qwen3-32B")).toBe("Qwen3-32B");
    expect(externalEngineDisplayName("llama-3.3-70b")).toBe("llama-3.3-70b");
  });
});

describe("the key file", () => {
  it("is written 0600, read back, and deleted", () => {
    expect(readExternalEngineKey()).toBeNull();
    writeExternalEngineKey(KEY);
    const file = path.join(root, "data", ".external-engine-key");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readExternalEngineKey()).toBe(KEY);
    deleteExternalEngineKey();
    expect(readExternalEngineKey()).toBeNull();
    expect(() => deleteExternalEngineKey()).not.toThrow();
  });

  it("never appears in the owner's view or the status summary", () => {
    writeExternalEngineKey(KEY);
    const record = externalEngineFromState({
      external_engine: {
        baseUrl: "http://192.0.2.10:8000/v1",
        modelId: "Qwen/Qwen3-32B",
        contextWindow: 65536,
        maxTokens: 4096,
        imageInput: false,
        harness: "openclaw",
        savedAt: "2026-11-09T00:00:00.000Z",
        previous: { store: {} },
      },
    });
    expect(record).not.toBeNull();
    const view = externalEngineView(record);
    expect(view).toMatchObject({ configured: true, apiKeySet: true, displayName: "Qwen3-32B", modelRef: "clawext/Qwen/Qwen3-32B" });
    expect(JSON.stringify(view)).not.toContain(KEY);
    expect(JSON.stringify(externalEngineSummary(record))).not.toContain(KEY);
  });

  it("reads the reasoning switch back; a record from before it is off (TASK-2497)", () => {
    const base = { baseUrl: "http://192.0.2.10:8000/v1", modelId: "m", contextWindow: 65536, maxTokens: 4096, previous: { store: {} } };
    const on = externalEngineFromState({ external_engine: { ...base, reasoning: true } });
    expect(on?.reasoning).toBe(true);
    expect(externalEngineView(on)).toMatchObject({ reasoning: true });
    expect(externalEngineSummary(on)).toMatchObject({ reasoning: true });
    expect(externalEngineFromState({ external_engine: base })?.reasoning).toBe(false);
    expect(externalEngineFromState({ external_engine: { ...base, reasoning: "yes" } })?.reasoning).toBe(false);
  });

  it("a record ClawBox did not write is no record", () => {
    expect(externalEngineFromState({})).toBeNull();
    expect(externalEngineFromState({ external_engine: "x" })).toBeNull();
    expect(externalEngineFromState({ external_engine: { baseUrl: "http://192.0.2.10/v1", modelId: "m", contextWindow: 0, maxTokens: 1 } })).toBeNull();
  });
});

describe("openclawExternalProviderDefinition", () => {
  it("is an openai-completions provider with the window, output cap and modalities", () => {
    const def = openclawExternalProviderDefinition(
      { baseUrl: "http://192.0.2.10:8000/v1", modelId: "Qwen/Qwen3-32B", contextWindow: 131072, maxTokens: 8192, imageInput: true, reasoning: false },
      KEY,
    );
    expect(def).toMatchObject({ baseUrl: "http://192.0.2.10:8000/v1", api: "openai-completions", apiKey: KEY });
    expect(def.models[0]).toMatchObject({ id: "Qwen/Qwen3-32B", name: "Qwen3-32B", contextWindow: 131072, maxTokens: 8192, input: ["text", "image"], reasoning: false });
    // Off: no reasoning contract at all, exactly the entry an engine had before TASK-2497.
    expect(def.models[0]).not.toHaveProperty("compat");
  });

  it("a reasoning engine is `reasoning: true` with OpenClaw's effort contract, Off sent as none (TASK-2497)", () => {
    const def = openclawExternalProviderDefinition(
      { baseUrl: "http://192.0.2.10:8000/v1", modelId: "deepseek-ai/DeepSeek-V4", contextWindow: 131072, maxTokens: 8192, imageInput: false, reasoning: true },
      KEY,
    );
    expect(def.models[0]).toMatchObject({ reasoning: true });
    expect((def.models[0] as { compat?: unknown }).compat).toEqual({
      supportedReasoningEfforts: ["none", "low", "medium", "high"],
      reasoningEffortMap: { off: "none" },
    });
  });

  it("carries a placeholder bearer when the engine needs no key", () => {
    const def = openclawExternalProviderDefinition(
      { baseUrl: "http://192.0.2.10:8000/v1", modelId: "m", contextWindow: 8192, maxTokens: 1024, imageInput: false, reasoning: false },
      null,
    );
    expect(def.apiKey).toBe("none");
    expect(def.models[0].input).toEqual(["text"]);
  });
});

describe("probeExternalEngine", () => {
  const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const opts = { baseUrl: "http://192.0.2.10:8000/v1", modelId: "Qwen/Qwen3-32B" };

  it("lists the models and sends the key as a bearer, without following redirects", async () => {
    const fetchImpl = vi.fn(async () => ok({ object: "list", data: [{ id: "Qwen/Qwen3-32B" }, { id: "other" }] }));
    const r = await probeExternalEngine({ ...opts, apiKey: KEY, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r).toMatchObject({ ok: true, models: ["Qwen/Qwen3-32B", "other"] });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://192.0.2.10:8000/v1/models");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(init.redirect).toBe("manual");
  });

  it("sends no Authorization header with no key", async () => {
    const fetchImpl = vi.fn(async () => ok({ data: [{ id: "Qwen/Qwen3-32B" }] }));
    await probeExternalEngine({ ...opts, apiKey: null, fetchImpl: fetchImpl as unknown as typeof fetch });
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("401 and 403 are `unauthorized`, and the message never echoes the key", async () => {
    for (const status of [401, 403]) {
      const fetchImpl = vi.fn(async () => ok({ error: "bad key" }, status));
      const r = await probeExternalEngine({ ...opts, apiKey: KEY, fetchImpl: fetchImpl as unknown as typeof fetch });
      expect(r).toMatchObject({ ok: false, code: "unauthorized", status });
      expect(JSON.stringify(r)).not.toContain(KEY);
    }
  });

  it("a model the engine does not list is `model_not_listed`, with what it does list", async () => {
    const fetchImpl = vi.fn(async () => ok({ data: [{ id: "a" }, { id: "b" }] }));
    const r = await probeExternalEngine({ ...opts, apiKey: null, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r).toMatchObject({ ok: false, code: "model_not_listed", models: ["a", "b"] });
  });

  it("a refused connection and a timeout are `unreachable`", async () => {
    const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    const r1 = await probeExternalEngine({ ...opts, apiKey: KEY, fetchImpl: vi.fn(async () => { throw refused; }) as unknown as typeof fetch });
    expect(r1).toMatchObject({ ok: false, code: "unreachable" });
    expect((r1 as { error: string }).error).toContain("ECONNREFUSED");
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    const r2 = await probeExternalEngine({ ...opts, apiKey: KEY, timeoutMs: 50, fetchImpl: vi.fn(async () => { throw timeout; }) as unknown as typeof fetch });
    expect(r2).toMatchObject({ ok: false, code: "unreachable" });
    expect(JSON.stringify([r1, r2])).not.toContain(KEY);
  });

  it("a redirect, a 404, non-JSON and a list-less answer are `bad_response`", async () => {
    const cases: Response[] = [
      new Response(null, { status: 302, headers: { Location: "http://elsewhere.example/v1/models" } }),
      new Response("not found", { status: 404 }),
      new Response("<html></html>", { status: 200 }),
      ok({ hello: "world" }),
    ];
    for (const res of cases) {
      const r = await probeExternalEngine({ ...opts, apiKey: null, fetchImpl: vi.fn(async () => res) as unknown as typeof fetch });
      expect(r).toMatchObject({ ok: false, code: "bad_response" });
    }
  });
});

describe("probeExternalEngineReasoning (TASK-2497)", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const opts = { baseUrl: "http://192.0.2.10:8000/v1", modelId: "deepseek-ai/DeepSeek-V4" };
  const completion = (message: Record<string, unknown>) => json({ choices: [{ index: 0, message: { role: "assistant", ...message } }] });

  it("asks one tiny completion at reasoning_effort low, with the key as a bearer and no redirects", async () => {
    const fetchImpl = vi.fn(async () => completion({ content: "5", reasoning_content: "2 plus 3 is 5." }));
    expect(await probeExternalEngineReasoning({ ...opts, apiKey: KEY, fetchImpl: fetchImpl as unknown as typeof fetch })).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://192.0.2.10:8000/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: "deepseek-ai/DeepSeek-V4", reasoning_effort: "low", stream: false });
    expect(body.max_tokens).toBeLessThanOrEqual(64);
  });

  it("reads `reasoning` too, and an answer without either is no reasoning", async () => {
    const run = (res: Response) => probeExternalEngineReasoning({ ...opts, apiKey: null, fetchImpl: vi.fn(async () => res) as unknown as typeof fetch });
    expect(await run(completion({ content: "5", reasoning: "thinking" }))).toBe(true);
    expect(await run(completion({ content: "5" }))).toBe(false);
    expect(await run(completion({ content: "5", reasoning_content: "  " }))).toBe(false);
    expect(await run(completion({ content: "5", reasoning_content: null }))).toBe(false);
  });

  it("an engine that refuses the field (4xx) does not reason as OpenClaw would ask it to", async () => {
    const r = await probeExternalEngineReasoning({ ...opts, apiKey: null, fetchImpl: vi.fn(async () => json({ error: "unknown field reasoning_effort" }, 400)) as unknown as typeof fetch });
    expect(r).toBe(false);
  });

  it("cannot tell (null) on a timeout, a 5xx, a redirect-less 3xx, non-JSON or a body that is not a completion", async () => {
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    expect(await probeExternalEngineReasoning({ ...opts, apiKey: null, fetchImpl: vi.fn(async () => { throw timeout; }) as unknown as typeof fetch })).toBeNull();
    for (const res of [
      new Response("busy", { status: 503 }),
      new Response(null, { status: 302, headers: { Location: "http://elsewhere.example/" } }),
      new Response("<html></html>", { status: 200 }),
      json({ hello: "world" }),
    ]) {
      expect(await probeExternalEngineReasoning({ ...opts, apiKey: null, fetchImpl: vi.fn(async () => res) as unknown as typeof fetch })).toBeNull();
    }
  });

  it("never asks an address an engine can never be", async () => {
    const fetchImpl = vi.fn();
    const r = await probeExternalEngineReasoning({ ...opts, baseUrl: "http://169.254.169.254/v1", apiKey: KEY, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
