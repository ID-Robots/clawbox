import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayAuthProfileRead } from "@/lib/openclaw-auth-store";

/**
 * The chat header and a Claude sign-in the gateway cannot use (the incident of
 * 2026-10-10).
 *
 * The header's Anthropic option was built from openclaw.json's `auth.profiles`
 * alone, so it stayed available while the gateway's store held a dead refresh
 * FENCE where the sign-in had been and every turn died with "No API key found
 * for provider anthropic". The ChatGPT sign-in the core cannot use already had
 * the honest shape — the row stays, greyed, saying "sign in again" — and this
 * is that shape for Claude, decided by the function the Providers strip asks.
 *
 * What would make it worthless or harmful if it broke:
 *
 *  1. THE ROW STAYS AND SAYS WHY: `available: false`, `reauthRequired`, never
 *     gone (which reads as "never connected").
 *  2. POSITIVE EVIDENCE ONLY: anything but a DEAD fence read out of the store,
 *     and any key beside the sign-in, leaves the option exactly as it was. A
 *     pending fence is a token renewal in flight, which every healthy box
 *     holds for a moment about three times a day.
 *  3. A PICK ON IT IS REFUSED BY NAME, with nothing written — and the way OFF
 *     the dead provider is never closed.
 *  4. THE STRIP AND THE HEADER AGREE, on the same box, about the same sign-in.
 */

vi.mock("child_process", () => ({ execFile: vi.fn() }));
vi.mock("util", () => ({ promisify: vi.fn() }));

const storeRead = vi.hoisted(() => vi.fn());
vi.mock("@/lib/openclaw-auth-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/openclaw-auth-store")>()),
  readGatewayAuthProfile: storeRead,
}));

vi.mock("@/lib/config-store", () => ({
  // Nowhere: the subscription-surface guard reads its cache under here, and a
  // device's real one must not decide a case in this file.
  DATA_DIR: "/nonexistent/clawbox-test-data",
  getAll: vi.fn(),
  // The status strip's own reads (the owner's switch, the local engine), and
  // the pair the persisted ClawBox AI refusal is read and written through.
  get: vi.fn(async () => null),
  set: vi.fn(async () => {}),
  getKnown: vi.fn(async () => ({ value: undefined, known: true })),
  setMany: vi.fn(),
}));

const { configSetMock } = vi.hoisted(() => ({ configSetMock: vi.fn() }));

vi.mock("@/lib/openclaw-gateway-ws", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/openclaw-gateway-ws")>()),
  gatewayWsCall: vi.fn(),
}));
vi.mock("@/app/setup-api/ai-models/catalog/route", () => ({
  notifyProviderSetChanged: vi.fn(),
  refreshInBackground: vi.fn(),
}));
vi.mock("@/lib/openclaw-config", () => ({
  gatewayIsAbsent: vi.fn(() => true),
  inferConfiguredLocalModel: vi.fn(),
  findOpenclawBin: vi.fn(() => "/usr/local/bin/openclaw"),
  readConfigStrict: vi.fn(async () => ({})),
  readConfig: vi.fn(),
  restartGateway: vi.fn(),
  repairClawboxAiFlashModelPolicy: vi.fn(async () => false),
  GatewayNotReadyError: class GatewayNotReadyError extends Error {},
  runOpenclawConfigSet: configSetMock,
  runOpenclawConfigSetBatch: vi.fn(async (ops: string[][]) => {
    for (const op of ops) await configSetMock(op);
  }),
  runOpenclawConfigUnset: vi.fn(),
  applyModelOverrideToAllAgentSessions: vi.fn(),
  parseFullyQualifiedModel: vi.fn(),
  setProviderPlugins: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/sqlite-store", () => ({ sqliteGet: vi.fn(), sqliteSet: vi.fn() }));
vi.mock("@/lib/provider-runnable", () => ({
  readProviderRunnable: vi.fn(async () => new Map<string, string>()),
}));
vi.mock("@/lib/ollama-capabilities", () => ({ ollamaModelCanChat: vi.fn(async () => true) }));
// The strip's half of the agreement case: no ClawBox AI token of its own, no
// plugin marked for repair.
vi.mock("@/lib/harness/credentials", () => ({ hasClawaiToken: vi.fn(async () => false) }));
vi.mock("@/lib/plugin-repair", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/plugin-repair")>()),
  readPluginRepairs: vi.fn(async () => ({})),
}));

import { getAll } from "@/lib/config-store";
import {
  applyModelOverrideToAllAgentSessions,
  gatewayIsAbsent,
  inferConfiguredLocalModel,
  parseFullyQualifiedModel,
  readConfig,
  readConfigStrict,
  runOpenclawConfigSet,
  runOpenclawConfigSetBatch,
  setProviderPlugins,
} from "@/lib/openclaw-config";
import { hasClawaiToken } from "@/lib/harness/credentials";
import { ANTHROPIC_DEFAULT_MODEL_ID } from "@/lib/provider-models";
import { readProviderRunnable } from "@/lib/provider-runnable";
import { sqliteGet, sqliteSet } from "@/lib/sqlite-store";

const ID = "anthropic:default";
const CLAUDE = "anthropic/claude-sonnet-4-6";
const OTHER_CLAUDE = "anthropic/claude-opus-4-7";
const FLASH = "deepseek/deepseek-v4-flash";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

/** The fence core made terminal. Its row's age does not matter: failed is failed. */
const FENCED: GatewayAuthProfileRead = {
  kind: "present", store: "shared", type: "oauth", fingerprint: null, refreshFingerprint: null, expires: 1, fenced: true,
  fence: "failed", storeUpdatedAtMs: 1,
};
/**
 * The same markers while core is still renewing, their row last written `ago`
 * before the moment of the call — built when the case runs, since the route
 * ages it against the real clock.
 */
const pending = (ago: number): GatewayAuthProfileRead => ({ ...FENCED, fence: "pending", storeUpdatedAtMs: Date.now() - ago });
const HEALTHY: GatewayAuthProfileRead = {
  kind: "present", store: "shared", type: "oauth", fingerprint: "0011223344556677", refreshFingerprint: "8899aabbccddeeff", expires: 1_900_000_000_000, fenced: false,
  fence: null, storeUpdatedAtMs: 1,
};

interface Option {
  id: string;
  label: string;
  model: string | null;
  provider: string | null;
  available: boolean;
  settingsSection: string;
  isLocal: boolean;
  reauthRequired?: boolean;
  disabledByOwner?: boolean;
}

/**
 * A box signed in to Claude by SUBSCRIPTION, as the configure route leaves
 * openclaw.json: the profile's metadata and no `models.providers.anthropic`.
 * ClawBox AI is linked beside it unless `clawai` is false.
 */
function claudeBox(opts: { primary?: string; clawai?: boolean; profiles?: Record<string, unknown>; providers?: Record<string, unknown> } = {}) {
  const clawai = opts.clawai ?? true;
  return {
    auth: {
      profiles: {
        [ID]: { provider: "anthropic", mode: "oauth" },
        ...(clawai ? { "deepseek:default": { provider: "deepseek", mode: "api_key" } } : {}),
        ...opts.profiles,
      },
    },
    models: { mode: "merge", providers: { ...opts.providers } },
    agents: { defaults: { model: { primary: opts.primary ?? CLAUDE } } },
  };
}

function post(POST: (r: Request) => Promise<Response>, body: Record<string, unknown>) {
  return POST(new Request("http://localhost/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

/** Every `config set` assignment of the request, batched or not, as its key. */
const writtenKeys = () => configSetMock.mock.calls.map(([op]) => (op as string[])[0]);

describe("/setup-api/chat/model and a Claude sign-in the gateway cannot use", () => {
  let GET: () => Promise<Response>;
  let POST: (request: Request) => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    storeRead.mockReset().mockReturnValue(FENCED);
    configSetMock.mockReset().mockResolvedValue(undefined);
    vi.mocked(gatewayIsAbsent).mockReturnValue(true);
    vi.mocked(readConfigStrict).mockReset().mockResolvedValue({} as never);
    vi.mocked(runOpenclawConfigSetBatch).mockReset().mockImplementation(async (ops) => {
      for (const op of ops) await vi.mocked(runOpenclawConfigSet)(op);
    });
    vi.mocked(setProviderPlugins).mockReset().mockResolvedValue(null as never);
    vi.mocked(applyModelOverrideToAllAgentSessions).mockResolvedValue({ filesUpdated: 0, sessionsUpdated: 0, sessionsSkipped: 0 });
    vi.mocked(parseFullyQualifiedModel).mockImplementation((fq: string) => {
      const idx = fq.indexOf("/");
      if (idx <= 0 || idx === fq.length - 1) return null;
      return { provider: fq.slice(0, idx), modelId: fq.slice(idx + 1) };
    });
    vi.mocked(getAll).mockResolvedValue({ ai_model_provider: "anthropic" });
    vi.mocked(readConfig).mockResolvedValue(claudeBox() as never);
    vi.mocked(inferConfiguredLocalModel).mockReturnValue(null);
    vi.mocked(sqliteGet).mockResolvedValue(null);
    vi.mocked(sqliteSet).mockResolvedValue();
    vi.mocked(readProviderRunnable).mockResolvedValue(new Map() as never);
    vi.mocked(hasClawaiToken).mockResolvedValue(false);

    const mod = await import("@/app/setup-api/chat/model/route");
    GET = mod.GET;
    POST = mod.POST;
  });

  async function state() {
    const response = await GET();
    expect(response.status).toBe(200);
    return (await response.json()) as {
      activeOptionId: string | null;
      activeModel: string | null;
      activeLabel: string | null;
      options: Option[];
      primary: { available: boolean; label: string | null; model: string | null; provider: string | null };
    };
  }
  const claudeOf = (body: { options: Option[] }) => body.options.find((option) => option.provider === "anthropic");

  it("keeps the option in the list, greyed, saying sign in again", async () => {
    const body = await state();

    expect(claudeOf(body)).toEqual({
      id: CLAUDE,
      label: "Anthropic Claude",
      model: CLAUDE,
      provider: "anthropic",
      available: false,
      reauthRequired: true,
      settingsSection: "ai",
      isLocal: false,
    });
    // Still the row the box is running: the header names it, with its reason.
    expect(body.activeOptionId).toBe(CLAUDE);
    expect(body.activeLabel).toBe("Anthropic Claude");
    expect(storeRead).toHaveBeenCalledWith(ID);
  });

  it("leaves every other option as it was, and offers the one that can answer as the way back", async () => {
    const fenced = await state();
    storeRead.mockReturnValue(HEALTHY);
    const healthy = await state();

    const others = (body: { options: Option[] }) => body.options.filter((option) => option.provider !== "anthropic");
    expect(others(fenced)).toEqual(others(healthy));
    expect(healthy.primary).toMatchObject({ available: true, provider: "anthropic", model: CLAUDE });
    expect(fenced.primary).toMatchObject({ available: true, provider: "clawai", model: FLASH });
  });

  it("reports no usable primary when the dead sign-in is all the box has", async () => {
    vi.mocked(readConfig).mockResolvedValue(claudeBox({ clawai: false }) as never);

    const body = await state();

    expect(claudeOf(body)).toMatchObject({ available: false, reauthRequired: true });
    expect(body.primary).toMatchObject({ available: false, provider: "anthropic" });
  });

  it.each<[string, () => GatewayAuthProfileRead]>([
    ["a healthy sign-in", () => HEALTHY],
    ["a store with no profile at that id", () => ({ kind: "absent", store: "shared" })],
    ["no store at all", () => ({ kind: "no-store" })],
    ["a store that could not be read", () => ({ kind: "unreadable" })],
    // The row a healthy box shows an outside reader for the length of every
    // token renewal: core's pending fence, written a moment ago.
    ["a renewal in flight — a pending fence written two seconds ago", () => pending(2 * SECOND)],
    ["a pending fence as old as core lets one refresh run", () => pending(2 * MINUTE)],
  ])("leaves the option available over %s", async (_name, answer) => {
    storeRead.mockImplementation(answer);

    const claude = claudeOf(await state());

    expect(claude).toMatchObject({ available: true, model: CLAUDE });
    expect(claude).not.toHaveProperty("reauthRequired");
  });

  it("greys it over a pending fence nobody has settled for five minutes — its owner is gone, and core never settles it", async () => {
    storeRead.mockImplementation(() => pending(5 * MINUTE));

    expect(claudeOf(await state())).toMatchObject({ available: false, reauthRequired: true });
  });

  it.each<[string, Parameters<typeof claudeBox>[0]]>([
    ["an API key under the provider definition", {
      providers: { anthropic: { apiKey: "sk-ant-api03-FAKE-a-pasted-key", baseUrl: "https://api.anthropic.com/v1", api: "openai-completions", models: [{ id: "claude-sonnet-4-6" }] } },
    }],
    ["an api_key profile beside the sign-in", { profiles: { "anthropic:manual": { provider: "anthropic", mode: "api_key" } } }],
    // A key ClawBox cannot read the value of — core resolves it from the gateway's environment — and a key all the same.
    ["a SecretRef where the provider definition's key goes", {
      providers: { anthropic: { apiKey: { source: "env", provider: "default", id: "MY_CLAUDE_KEY" }, baseUrl: "https://api.anthropic.com/v1", api: "openai-completions", models: [{ id: "claude-sonnet-4-6" }] } },
    }],
  ])("leaves it available, without opening the store, when the box also holds %s", async (_name, box) => {
    vi.mocked(readConfig).mockResolvedValue(claudeBox(box) as never);

    const claude = claudeOf(await state());

    expect(claude).toMatchObject({ available: true });
    expect(claude).not.toHaveProperty("reauthRequired");
    expect(storeRead).not.toHaveBeenCalled();
  });

  it("does not open the store on a box with no Claude sign-in", async () => {
    vi.mocked(getAll).mockResolvedValue({ ai_model_provider: "clawai" });
    vi.mocked(readConfig).mockResolvedValue({
      auth: { profiles: { "deepseek:default": { provider: "deepseek", mode: "api_key" } } },
      agents: { defaults: { model: { primary: FLASH } } },
    } as never);

    const body = await state();

    expect(claudeOf(body)).toBeUndefined();
    expect(storeRead).not.toHaveBeenCalled();
  });

  it("does not call a row that has no sign-in on file a dead one", async () => {
    // The row is there because the primary names Claude; nothing in
    // auth.profiles says how the box reaches it, so there is no id to ask about.
    vi.mocked(readConfig).mockResolvedValue({
      auth: { profiles: { "deepseek:default": { provider: "deepseek", mode: "api_key" } } },
      agents: { defaults: { model: { primary: CLAUDE } } },
    } as never);

    const claude = claudeOf(await state());

    expect(claude).toMatchObject({ available: true, model: CLAUDE });
    expect(claude).not.toHaveProperty("reauthRequired");
    expect(storeRead).not.toHaveBeenCalled();
  });

  it("keeps the owner's switch on top of it — both facts on the one row", async () => {
    vi.mocked(getAll).mockResolvedValue({ ai_model_provider: "clawai", ai_disabled_providers: ["anthropic"] });
    vi.mocked(readConfig).mockResolvedValue(claudeBox({ primary: FLASH }) as never);

    expect(claudeOf(await state())).toMatchObject({ available: false, reauthRequired: true, disabledByOwner: true });
  });

  it("refuses a model picked on the dead sign-in by name, and writes nothing", async () => {
    // The header's MODEL pill: another Claude model while Claude is the row.
    const response = await post(POST, { model: OTHER_CLAUDE, provider: "anthropic" });

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toMatchObject({ kind: "provider_reauth_required", provider: "anthropic" });
    expect(body.error).toContain("Anthropic Claude");
    expect(body.error).toMatch(/sign in again/i);
    // Not the sentence for a provider that was never set up.
    expect(body.error).not.toMatch(/not configured/i);
    expect(configSetMock).not.toHaveBeenCalled();
    expect(sqliteSet).not.toHaveBeenCalledWith(expect.anything(), OTHER_CLAUDE);
  });

  it("refuses the row's own model the same way when the box is on another provider", async () => {
    vi.mocked(readConfig).mockResolvedValue(claudeBox({ primary: FLASH }) as never);
    const rowModel = claudeOf(await state())?.model;
    expect(rowModel).toBe(`anthropic/${ANTHROPIC_DEFAULT_MODEL_ID}`);

    const response = await post(POST, { model: rowModel, provider: "anthropic" });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ kind: "provider_reauth_required", provider: "anthropic" });
    expect(configSetMock).not.toHaveBeenCalled();
  });

  it("takes the same pick once the sign-in is healthy", async () => {
    storeRead.mockReturnValue(HEALTHY);

    const response = await post(POST, { model: OTHER_CLAUDE, provider: "anthropic" });

    expect(response.status).toBe(200);
    expect(writtenKeys()).toContain("agents.defaults.model.primary");
    expect(configSetMock).toHaveBeenCalledWith(["agents.defaults.model.primary", OTHER_CLAUDE]);
  });

  it("takes the pick while the sign-in's token is being renewed — a pending fence is not a refusal", async () => {
    storeRead.mockImplementation(() => pending(2 * SECOND));

    const response = await post(POST, { model: OTHER_CLAUDE, provider: "anthropic" });

    expect(response.status).toBe(200);
    expect(configSetMock).toHaveBeenCalledWith(["agents.defaults.model.primary", OTHER_CLAUDE]);
  });

  it("refuses the pick over a pending fence left for five minutes, as it does over a failed one", async () => {
    storeRead.mockImplementation(() => pending(5 * MINUTE));

    const response = await post(POST, { model: OTHER_CLAUDE, provider: "anthropic" });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ kind: "provider_reauth_required", provider: "anthropic" });
    expect(configSetMock).not.toHaveBeenCalled();
  });

  it("never closes the way OFF the dead provider", async () => {
    const response = await post(POST, { model: FLASH, provider: "clawai" });

    expect(response.status).toBe(200);
    expect(configSetMock).toHaveBeenCalledWith(["agents.defaults.model.primary", FLASH]);
  });

  it("still answers 'not configured' for a provider with no row at all", async () => {
    const response = await post(POST, { model: "openrouter/anthropic/claude-haiku-4-5" });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Selected AI provider is not configured" });
  });

  it.each<[string, () => GatewayAuthProfileRead, string, boolean]>([
    ["a failed fence", () => FENCED, "needs-reauth", false],
    ["a renewal in flight", () => pending(2 * SECOND), "connected", true],
    ["a pending fence left for five minutes", () => pending(5 * MINUTE), "needs-reauth", false],
    ["a healthy sign-in", () => HEALTHY, "connected", true],
    ["no store", () => ({ kind: "no-store" }), "connected", true],
  ])("agrees with the Providers strip over %s", async (_name, answer, rowState, optionAvailable) => {
    storeRead.mockImplementation(answer);
    const { readProviderStatus } = await import("@/lib/provider-status");

    const [summary, body] = [await readProviderStatus(), await state()];

    expect(summary.degraded).toBe(false);
    expect(summary.providers.find((row) => row.id === "anthropic")?.state).toBe(rowState);
    expect(claudeOf(body)?.available).toBe(optionAvailable);
  });
});
