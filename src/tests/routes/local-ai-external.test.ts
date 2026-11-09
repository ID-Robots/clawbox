import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Settings → Local AI → External engine (TASK-2376): save, validate and remove
 * through `/setup-api/local-ai/external` on both harnesses, and the key never
 * leaving the box's own 0600 file except into the harness's provider block.
 */

const KEY = "sk-test-external-engine-placeholder-0123456789";
const BASE = "http://192.0.2.10:8000/v1";
const MODEL = "Qwen/Qwen3-32B";
const REF = `clawext/${MODEL}`;

let root: string;
let store: Record<string, unknown>;

vi.mock("@/lib/config-store", () => ({
  get: vi.fn(async (key: string) => store[key]),
  getAll: vi.fn(async () => ({ ...store })),
  setMany: vi.fn(async (entries: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(entries)) {
      if (v === undefined) delete store[k];
      else store[k] = JSON.parse(JSON.stringify(v));
    }
  }),
  resolveConfigRoot: () => root,
}));
vi.mock("@/lib/route-auth", () => ({ requireSession: vi.fn(async () => null) }));
vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn(async () => "openclaw") }));
vi.mock("@/lib/openclaw-config", () => ({
  readConfig: vi.fn(),
  runOpenclawConfigSetBatch: vi.fn(async () => {}),
  runOpenclawConfigUnset: vi.fn(async () => {}),
  openclawIsAbsent: vi.fn(() => false),
}));
vi.mock("@/lib/gateway-hot-apply", () => ({
  readGatewayConfigBaseline: vi.fn(async () => null),
  settleConfigWrite: vi.fn(async () => "applied"),
  restartGatewayAnsweringEarly: vi.fn(async () => {}),
}));
vi.mock("@/lib/local-ai-runtime", () => ({ stopLocalAiProvider: vi.fn(async () => {}) }));
vi.mock("@/lib/hermes-config-yaml", () => ({
  patchHermesConfig: vi.fn(async () => ({ mode: "merge", backupPath: null })),
  resolveHermesConfigValue: vi.fn(async () => ({ state: "absent" })),
}));
vi.mock("@/lib/hermes-local-ai", () => ({
  applyLocalAiToHermes: vi.fn(async () => ({ provider: "clawlocal", model: "gemma4-e2b-it-q4_0" })),
  removeLocalAiFromHermes: vi.fn(async () => ({ wasDefault: true, model: "gemma4-e2b-it-q4_0" })),
  HermesLocalRemovalError: class HermesLocalRemovalError extends Error {},
}));
vi.mock("@/lib/hermes-model-options", () => ({ invalidateModelOptions: vi.fn() }));
vi.mock("@/lib/provider-mcp-refresh", () => ({ withProviderMcpRefresh: vi.fn((fn: () => Promise<unknown>) => fn()) }));
vi.mock("@/lib/provider-verified", () => ({ forgetProviderVerified: vi.fn(async () => {}) }));
vi.mock("@/app/setup-api/chat/model/route", () => ({
  POST: vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
  readChatModelStateUnfiltered: vi.fn(async () => ({ primary: { model: "deepseek/deepseek-v4-flash" } })),
}));

import { DELETE, GET, POST } from "@/app/setup-api/local-ai/external/route";
import { POST as TEST } from "@/app/setup-api/local-ai/external/test/route";
import { requireSession } from "@/lib/route-auth";
import { getActiveHarness } from "@/lib/harness";
import { readConfig, runOpenclawConfigSetBatch, runOpenclawConfigUnset } from "@/lib/openclaw-config";
import { stopLocalAiProvider } from "@/lib/local-ai-runtime";
import { patchHermesConfig, resolveHermesConfigValue } from "@/lib/hermes-config-yaml";
import { applyLocalAiToHermes, removeLocalAiFromHermes } from "@/lib/hermes-local-ai";
import { POST as chatModelPost } from "@/app/setup-api/chat/model/route";

let openclaw: Record<string, unknown>;
let logs: string[];
let engineModels: string[];
let engineStatus: number;
let seenAuth: (string | null)[];

function req(method: string, body?: unknown, url = "http://localhost/setup-api/local-ai/external"): Request {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const saveBody = (extra: Record<string, unknown> = {}) => ({
  baseUrl: BASE,
  apiKey: KEY,
  modelId: MODEL,
  contextWindow: 131072,
  maxTokens: 8192,
  imageInput: false,
  ...extra,
});

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "ext-route-"));
  mkdirSync(path.join(root, "data"), { recursive: true });
  store = {
    ai_model_configured: true,
    local_ai_configured: true,
    local_ai_provider: "llamacpp",
    local_ai_model: "llamacpp/gemma4-e2b-it-q4_0",
    local_ai_configured_at: "2026-10-01T00:00:00.000Z",
  };
  openclaw = {
    agents: { defaults: { model: { primary: "llamacpp/gemma4-e2b-it-q4_0", fallbacks: ["deepseek/deepseek-v4-flash", "llamacpp/gemma4-e2b-it-q4_0"] } } },
    models: { providers: { llamacpp: { baseUrl: "http://127.0.0.1/setup-api/local-ai/llamacpp/v1" } } },
  };
  vi.mocked(readConfig).mockImplementation(async () => JSON.parse(JSON.stringify(openclaw)));
  vi.mocked(runOpenclawConfigSetBatch).mockImplementation(async (ops) => {
    for (const [p, v] of ops as string[][]) {
      if (p === "models.providers.clawext") {
        (openclaw.models as { providers: Record<string, unknown> }).providers.clawext = JSON.parse(v);
      } else if (p === "agents.defaults.model.fallbacks") {
        (openclaw.agents as { defaults: { model: Record<string, unknown> } }).defaults.model.fallbacks = JSON.parse(v);
      }
    }
  });
  vi.mocked(runOpenclawConfigUnset).mockImplementation(async (p) => {
    if (p === "models.providers.clawext") delete (openclaw.models as { providers: Record<string, unknown> }).providers.clawext;
  });
  vi.mocked(chatModelPost).mockImplementation((async (r: Request) => {
    const body = await r.json();
    (openclaw.agents as { defaults: { model: Record<string, unknown> } }).defaults.model.primary = body.model;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as never);
  vi.mocked(getActiveHarness).mockResolvedValue("openclaw");
  vi.mocked(requireSession).mockResolvedValue(null);
  engineModels = [MODEL, "other-model"];
  engineStatus = 200;
  seenAuth = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    seenAuth.push((init?.headers as Record<string, string> | undefined)?.Authorization ?? null);
    if (engineStatus !== 200) return new Response("{}", { status: engineStatus });
    return new Response(JSON.stringify({ object: "list", data: engineModels.map((id) => ({ id })) }), { status: 200 });
  }));
  logs = [];
  for (const level of ["log", "warn", "error", "info"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => (a instanceof Error ? a.message : typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    });
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function keyFile(): string | null {
  const p = path.join(root, "data", ".external-engine-key");
  return existsSync(p) ? readFileSync(p, "utf-8") : null;
}

describe("access", () => {
  it("is owner only on every method", async () => {
    const refused = new Response(JSON.stringify({ code: "owner_only" }), { status: 403 });
    vi.mocked(requireSession).mockResolvedValue(refused as never);
    expect((await GET(req("GET"))).status).toBe(403);
    expect((await POST(req("POST", saveBody()))).status).toBe(403);
    expect((await DELETE(req("DELETE"))).status).toBe(403);
    expect((await TEST(req("POST", saveBody()))).status).toBe(403);
    expect(vi.mocked(requireSession).mock.calls.every(([, opts]) => (opts as { ownerOnly?: boolean })?.ownerOnly === true)).toBe(true);
  });
});

describe("validation", () => {
  it("refuses bad fields with 400 and a code, before anything is probed or written", async () => {
    const res = await POST(req("POST", saveBody({ baseUrl: "http://user:pw@192.0.2.10/v1" })));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_base_url");
    const bad = await POST(req("POST", saveBody({ apiKey: "two\nlines" })));
    expect((await bad.json()).code).toBe("invalid_api_key");
    expect(fetch).not.toHaveBeenCalled();
    expect(runOpenclawConfigSetBatch).not.toHaveBeenCalled();
  });

  it("Test answers the probe's verdict and writes nothing", async () => {
    const ok = await (await TEST(req("POST", saveBody()))).json();
    expect(ok).toMatchObject({ ok: true, models: [MODEL, "other-model"] });
    expect(seenAuth).toEqual([`Bearer ${KEY}`]);
    engineModels = ["something-else"];
    const missing = await (await TEST(req("POST", saveBody()))).json();
    expect(missing).toMatchObject({ ok: false, code: "model_not_listed", models: ["something-else"] });
    engineStatus = 401;
    const denied = await (await TEST(req("POST", saveBody()))).json();
    expect(denied).toMatchObject({ ok: false, code: "unauthorized" });
    expect(runOpenclawConfigSetBatch).not.toHaveBeenCalled();
    expect(keyFile()).toBeNull();
    expect(JSON.stringify([ok, missing, denied])).not.toContain(KEY);
  });

  it("a save the endpoint fails is refused 422 with the probe's code, and nothing is written", async () => {
    engineStatus = 401;
    const res = await POST(req("POST", saveBody()));
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("unauthorized");
    expect(runOpenclawConfigSetBatch).not.toHaveBeenCalled();
    expect(store.external_engine).toBeUndefined();
    expect(keyFile()).toBeNull();
  });

  it("is refused while Local-only mode is on", async () => {
    store.local_only_mode = true;
    const res = await POST(req("POST", saveBody()));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("local_only_mode");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("on OpenClaw", () => {
  it("save writes its own provider, makes it primary through chat/model and stops llama.cpp", async () => {
    const res = await POST(req("POST", saveBody()));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ success: true, configured: true, modelRef: REF, displayName: "Qwen3-32B", apiKeySet: true });

    const providers = (openclaw.models as { providers: Record<string, Record<string, unknown>> }).providers;
    expect(providers.clawext).toMatchObject({ baseUrl: BASE, api: "openai-completions", apiKey: KEY });
    expect((providers.clawext.models as unknown[])[0]).toMatchObject({ id: MODEL, contextWindow: 131072, maxTokens: 8192, input: ["text"] });
    // Not `llamacpp`: the on-device provider stays as it was, for the way back.
    expect(providers.llamacpp).toBeDefined();
    const model = (openclaw.agents as { defaults: { model: { primary: string; fallbacks: string[] } } }).defaults.model;
    expect(model.primary).toBe(REF);
    expect(model.fallbacks).toEqual(["deepseek/deepseek-v4-flash"]);
    expect(vi.mocked(chatModelPost)).toHaveBeenCalledTimes(1);

    expect(store).toMatchObject({ local_ai_configured: true, local_ai_provider: "clawext", local_ai_model: REF });
    const record = store.external_engine as Record<string, unknown>;
    expect(record).toMatchObject({ baseUrl: BASE, modelId: MODEL, harness: "openclaw" });
    expect((record.previous as { store: Record<string, unknown> }).store).toMatchObject({ local_ai_provider: "llamacpp", local_ai_model: "llamacpp/gemma4-e2b-it-q4_0" });
    expect((record.previous as { openclaw: unknown }).openclaw).toEqual({
      primary: "llamacpp/gemma4-e2b-it-q4_0",
      removedFallbacks: ["llamacpp/gemma4-e2b-it-q4_0"],
      addedFallbacks: [],
    });
    expect(stopLocalAiProvider).toHaveBeenCalledWith("llamacpp");
    expect(keyFile()).toBe(KEY);
  });

  it("never answers or logs the key, and GET says only that one is on file", async () => {
    const saved = await (await POST(req("POST", saveBody()))).text();
    const got = await (await GET(req("GET", undefined, "http://localhost/setup-api/local-ai/external?probe=1"))).json();
    expect(got).toMatchObject({ configured: true, apiKeySet: true, status: { reachable: true, modelListed: true } });
    expect(saved).not.toContain(KEY);
    expect(JSON.stringify(got)).not.toContain(KEY);
    expect(JSON.stringify(store)).not.toContain(KEY);
    expect(logs.join("\n")).not.toContain(KEY);
  });

  it("a re-save without a key keeps the stored one for the same host, never for another", async () => {
    await POST(req("POST", saveBody()));
    seenAuth = [];
    await POST(req("POST", saveBody({ apiKey: undefined, contextWindow: 65536 })));
    expect(seenAuth).toEqual([`Bearer ${KEY}`]);
    expect(keyFile()).toBe(KEY);
    seenAuth = [];
    await POST(req("POST", saveBody({ apiKey: undefined, baseUrl: "http://198.51.100.7:8000/v1" })));
    expect(seenAuth).toEqual([null]);
    // The previous Local AI is still the one from before the FIRST save.
    expect(((store.external_engine as { previous: { store: Record<string, unknown> } }).previous.store).local_ai_provider).toBe("llamacpp");
  });

  it("remove puts the previous Local AI back: store keys, primary, fallbacks, and no provider", async () => {
    await POST(req("POST", saveBody()));
    vi.mocked(chatModelPost).mockClear();
    const res = await DELETE(req("DELETE"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, removed: true });
    const model = (openclaw.agents as { defaults: { model: { primary: string; fallbacks: string[] } } }).defaults.model;
    expect(model.primary).toBe("llamacpp/gemma4-e2b-it-q4_0");
    expect(model.fallbacks).toEqual(["deepseek/deepseek-v4-flash", "llamacpp/gemma4-e2b-it-q4_0"]);
    expect((openclaw.models as { providers: Record<string, unknown> }).providers.clawext).toBeUndefined();
    expect(store).toMatchObject({
      local_ai_configured: true,
      local_ai_provider: "llamacpp",
      local_ai_model: "llamacpp/gemma4-e2b-it-q4_0",
      local_ai_configured_at: "2026-10-01T00:00:00.000Z",
    });
    expect(store.external_engine).toBeUndefined();
    expect(keyFile()).toBeNull();
  });

  it("remove on a box that had no Local AI clears the keys it set", async () => {
    store = { ai_model_configured: true, local_ai_configured: false };
    (openclaw.agents as { defaults: { model: Record<string, unknown> } }).defaults.model = { primary: "deepseek/deepseek-v4-flash", fallbacks: [] };
    await POST(req("POST", saveBody()));
    await DELETE(req("DELETE"));
    expect(store).toEqual({ ai_model_configured: true, local_ai_configured: false });
    expect((openclaw.agents as { defaults: { model: { primary: string } } }).defaults.model.primary).toBe("deepseek/deepseek-v4-flash");
  });

  it("a remove whose chat cannot move keeps the engine selected and says so", async () => {
    await POST(req("POST", saveBody()));
    vi.mocked(chatModelPost).mockResolvedValue(new Response("{}", { status: 409 }) as never);
    const res = await DELETE(req("DELETE"));
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe("primary_stuck");
    expect(store.local_ai_provider).toBe("clawext");
    expect(store.external_engine).toBeDefined();
    expect(runOpenclawConfigUnset).not.toHaveBeenCalled();
  });

  it("remove with nothing selected is a no-op", async () => {
    const res = await DELETE(req("DELETE"));
    expect(await res.json()).toEqual({ success: true, removed: false });
  });
});

describe("on Hermes", () => {
  beforeEach(() => {
    vi.mocked(getActiveHarness).mockResolvedValue("hermes");
    vi.mocked(resolveHermesConfigValue).mockImplementation(async (key: string) =>
      key === "model.provider" ? { state: "value", value: "clawlocal" }
        : key === "model.default" ? { state: "value", value: "gemma4-e2b-it-q4_0" }
          : { state: "absent" });
  });

  it("refuses a window under Hermes' 64k floor", async () => {
    const res = await POST(req("POST", saveBody({ contextWindow: 32768, maxTokens: 4096 })));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("context_too_small_for_hermes");
    expect(patchHermesConfig).not.toHaveBeenCalled();
  });

  it("save unregisters the on-device model and selects its own provider block", async () => {
    const res = await POST(req("POST", saveBody()));
    expect(res.status).toBe(200);
    expect(removeLocalAiFromHermes).toHaveBeenCalledTimes(1);
    const set = vi.mocked(patchHermesConfig).mock.calls.map(([p]) => p.set ?? {}).find((s) => s["model.provider"]);
    expect(set).toMatchObject({
      "providers.clawext.base_url": BASE,
      "providers.clawext.api_key": KEY,
      "providers.clawext.models": MODEL,
      "providers.clawext.context_length": "131072",
      "model.provider": "clawext",
      "model.default": MODEL,
    });
    expect(runOpenclawConfigSetBatch).not.toHaveBeenCalled();
    expect(chatModelPost).not.toHaveBeenCalled();
    expect((store.external_engine as { previous: { hermes: unknown } }).previous.hermes).toEqual({
      provider: "clawlocal", model: "gemma4-e2b-it-q4_0", localRegistered: true,
    });
    expect(stopLocalAiProvider).toHaveBeenCalledWith("llamacpp");
    expect(logs.join("\n")).not.toContain(KEY);
  });

  it("remove takes the block out and registers the on-device model as the default again", async () => {
    await POST(req("POST", saveBody()));
    vi.mocked(patchHermesConfig).mockClear();
    vi.mocked(resolveHermesConfigValue).mockImplementation(async (key: string) =>
      key === "model.provider" ? { state: "value", value: "clawext" } : { state: "value", value: "x" });
    const res = await DELETE(req("DELETE"));
    expect(res.status).toBe(200);
    const patch = vi.mocked(patchHermesConfig).mock.calls[0][0];
    expect(patch.unset).toEqual(expect.arrayContaining(["providers.clawext.base_url", "providers.clawext.api_key", "model.provider", "model.default"]));
    expect(applyLocalAiToHermes).toHaveBeenCalledWith({ provider: "llamacpp", model: "gemma4-e2b-it-q4_0", makeDefault: true });
    expect(store.local_ai_provider).toBe("llamacpp");
    expect(store.external_engine).toBeUndefined();
  });

  it("remove puts a cloud selection back when that was the default", async () => {
    store = { ai_model_configured: true };
    vi.mocked(resolveHermesConfigValue).mockImplementation(async (key: string) =>
      key === "model.provider" ? { state: "value", value: "clawai" }
        : key === "model.default" ? { state: "value", value: "deepseek-v4-flash" }
          : { state: "absent" });
    await POST(req("POST", saveBody()));
    expect(removeLocalAiFromHermes).not.toHaveBeenCalled();
    vi.mocked(patchHermesConfig).mockClear();
    vi.mocked(resolveHermesConfigValue).mockImplementation(async (key: string) =>
      key === "model.provider" ? { state: "value", value: "clawext" } : { state: "value", value: "x" });
    await DELETE(req("DELETE"));
    expect(vi.mocked(patchHermesConfig).mock.calls[0][0].set).toEqual({ "model.provider": "clawai", "model.default": "deepseek-v4-flash" });
    expect(applyLocalAiToHermes).not.toHaveBeenCalled();
  });
});
