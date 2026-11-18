import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayAuthProfileRead } from "@/lib/openclaw-auth-store";

/**
 * The chat header and a ChatGPT sign-in the gateway cannot use (SUP-1023) — the
 * Claude rule (chat-model-claude-fenced-sign-in.test.ts), asked of the `codex`
 * row the ChatGPT subscription fills.
 *
 * A re-sign-in that was rolled back, or a renewal that could not reach the
 * token endpoint, leaves `openai:chatgpt` in the gateway's store as core's
 * refresh FENCE while openclaw.json still says a sign-in was filed. The header
 * kept the row available and every turn died on it. Decided by the function the
 * Providers strip asks, so the header and the strip cannot disagree.
 *
 *  1. THE ROW STAYS AND SAYS WHY: `available: false`, `reauthRequired`.
 *  2. POSITIVE EVIDENCE ONLY: anything but a DEAD fence read out of the store,
 *     and any OpenAI key beside the sign-in, leaves the option as it was.
 *  3. THE STRIP AND THE HEADER AGREE, on the same box.
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
  // One strict read of several keys: the picker asks whether the cloud providers
  // are hidden (src/lib/cloud-providers-server.ts). Nothing set, store readable.
  getKnownMany: vi.fn(async () => ({ values: {}, known: true })),
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
import { readProviderRunnable } from "@/lib/provider-runnable";
import { sqliteGet, sqliteSet } from "@/lib/sqlite-store";

const ID = "openai:chatgpt";
const CHATGPT_MODEL = "openai/gpt-5.5";

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
 * A box signed in to ChatGPT by SUBSCRIPTION, as the configure route leaves
 * openclaw.json: the profile's metadata and no `models.providers.openai`.
 * ClawBox AI is linked beside it unless `clawai` is false.
 */
function chatgptBox(opts: { primary?: string; clawai?: boolean; profiles?: Record<string, unknown>; providers?: Record<string, unknown> } = {}) {
  const clawai = opts.clawai ?? true;
  return {
    auth: {
      profiles: {
        [ID]: { provider: "openai", mode: "oauth" },
        ...(clawai ? { "deepseek:default": { provider: "deepseek", mode: "api_key" } } : {}),
        ...opts.profiles,
      },
    },
    models: { mode: "merge", providers: { ...opts.providers } },
    agents: { defaults: { model: { primary: opts.primary ?? CHATGPT_MODEL } } },
  };
}

describe("/setup-api/chat/model and a ChatGPT sign-in the gateway cannot use", () => {
  let GET: () => Promise<Response>;

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
    vi.mocked(getAll).mockResolvedValue({ ai_model_provider: "openai" });
    vi.mocked(readConfig).mockResolvedValue(chatgptBox() as never);
    vi.mocked(inferConfiguredLocalModel).mockReturnValue(null);
    vi.mocked(sqliteGet).mockResolvedValue(null);
    vi.mocked(sqliteSet).mockResolvedValue();
    vi.mocked(readProviderRunnable).mockResolvedValue(new Map() as never);
    vi.mocked(hasClawaiToken).mockResolvedValue(false);

    const mod = await import("@/app/setup-api/chat/model/route");
    GET = mod.GET;
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
  const chatgptOf = (body: { options: Option[] }) => body.options.find((option) => option.provider === "codex");

  it("keeps the option in the list, greyed, saying sign in again", async () => {
    const body = await state();

    expect(chatgptOf(body)).toMatchObject({
      provider: "codex",
      available: false,
      reauthRequired: true,
      settingsSection: "ai",
      isLocal: false,
    });
    expect(storeRead).toHaveBeenCalledWith(ID);
  });

  it("leaves every other option as it was", async () => {
    const fenced = await state();
    storeRead.mockReturnValue(HEALTHY);
    const healthy = await state();

    const others = (body: { options: Option[] }) => body.options.filter((option) => option.provider !== "codex");
    expect(others(fenced)).toEqual(others(healthy));
  });

  it.each<[string, () => GatewayAuthProfileRead]>([
    ["a healthy sign-in", () => HEALTHY],
    ["a store with no profile at that id", () => ({ kind: "absent", store: "shared" })],
    ["no store at all", () => ({ kind: "no-store" })],
    ["a store that could not be read", () => ({ kind: "unreadable" })],
    ["a renewal in flight — a pending fence written two seconds ago", () => pending(2 * SECOND)],
    ["a pending fence as old as core lets one refresh run", () => pending(2 * MINUTE)],
  ])("leaves the option available over %s", async (_name, answer) => {
    storeRead.mockImplementation(answer);

    const chatgpt = chatgptOf(await state());

    expect(chatgpt).toMatchObject({ available: true });
    expect(chatgpt).not.toHaveProperty("reauthRequired");
  });

  it("greys it over a pending fence nobody has settled for five minutes", async () => {
    storeRead.mockImplementation(() => pending(5 * MINUTE));

    expect(chatgptOf(await state())).toMatchObject({ available: false, reauthRequired: true });
  });

  it("leaves the option available, without opening the store, when the box also holds an OpenAI API key", async () => {
    vi.mocked(readConfig).mockResolvedValue(chatgptBox({
      profiles: { "openai:default": { provider: "openai", mode: "api_key" } },
    }) as never);

    const chatgpt = chatgptOf(await state());

    expect(chatgpt).toMatchObject({ available: true });
    expect(storeRead).not.toHaveBeenCalledWith(ID);
  });

  it("agrees with the Providers strip about the same sign-in on the same box", async () => {
    const { readProviderStatus } = await import("@/lib/provider-status");

    const header = chatgptOf(await state());
    const strip = (await readProviderStatus()).providers.find((row) => row.id === "openai");

    expect(header).toMatchObject({ available: false, reauthRequired: true });
    expect(strip?.state).toBe("needs-reauth");

    storeRead.mockReturnValue(HEALTHY);
    const healthyHeader = chatgptOf(await state());
    const healthyStrip = (await readProviderStatus()).providers.find((row) => row.id === "openai");
    expect(healthyHeader).toMatchObject({ available: true });
    expect(healthyStrip?.state).toBe("connected");
  });
});
