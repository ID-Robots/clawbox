/**
 * Signing the box out of ClawBox AI (src/lib/clawai-sign-out.ts): the
 * gateway's auth profile through the core's own `models auth logout`, what
 * logout leaves in openclaw.json through `config unset`, ClawBox's records of
 * the account in one store write, the remembered refusal and the finished
 * device login — and a result READ BACK, so a credential still on the box is
 * never answered as signed out.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const TOKEN = "claw_test_token_0123456789";

/** The box as the mocks below answer it; each case edits it. */
const box = vi.hoisted(() => ({
  harness: "openclaw" as "openclaw" | "hermes",
  storeRow: true,
  /** The auth store as `readGatewayAuthProfile` answers when it cannot be read. */
  storeUnreadable: false,
  /** `data/config.json` unreadable for the strict reader. */
  configStoreUnreadable: false,
  /** Whether `models auth logout` removes the store row (and the profile entry). */
  logoutWorks: true,
  config: {} as Record<string, unknown>,
  store: {} as Record<string, unknown>,
  session: null as null | { status: string; createdAt: number; configuringStartedAt?: number },
  hot: { applied: true, how: "hot-reload" } as { applied: boolean; how?: string; why?: string },
  restartRefused: false,
  ready: [true, false] as boolean[],
}));

function signedInConfig(litellmKey: string = TOKEN): Record<string, unknown> {
  return {
    auth: { profiles: { "deepseek:default": { provider: "deepseek", mode: "api_key" }, "openai:manual": { provider: "openai", mode: "api_key" } } },
    models: { providers: {
      deepseek: { baseUrl: "https://proxy", apiKey: TOKEN, models: [] },
      litellm: { apiKey: litellmKey, baseUrl: "https://proxy" },
      anthropic: { apiKey: "sk-ant-owners-own" },
    } },
    agents: { defaults: { model: { primary: "deepseek/deepseek-v4-flash" } } },
    // The cloud voice the boot script arms with the token, stamped as ours.
    tts: { providers: { openai: { baseUrl: "https://proxy/v1", model: "voice", apiKey: TOKEN, clawboxManaged: true }, elevenlabs: { apiKey: "el-own" } } },
  };
}

/** `config unset <path>` on the fake config. */
function unsetPath(config: Record<string, unknown>, dotted: string): void {
  // Profile ids carry a colon, never a dot, so a plain split is exact here.
  const parts = dotted.split(".");
  let node = config as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) {
    node = (node[part] ?? {}) as Record<string, unknown>;
  }
  delete node[parts[parts.length - 1]];
}

const cli = vi.hoisted(() => ({
  spawnOpenclawCli: vi.fn(),
  runOpenclawConfigUnset: vi.fn(),
  flushConfigWrites: vi.fn(async () => undefined),
  readConfig: vi.fn(),
  readConfigStrict: vi.fn(),
}));
vi.mock("@/lib/openclaw-config", () => cli);
vi.mock("@/lib/openclaw-auth-store", () => ({
  readGatewayAuthProfile: vi.fn(() => (box.storeUnreadable
    ? { kind: "unreadable" }
    : box.storeRow ? { kind: "present", type: "api_key", store: "shared" } : { kind: "absent", store: "shared" })),
}));
const store = vi.hoisted(() => ({
  DATA_DIR: "/nonexistent-clawai-sign-out-test",
  get: vi.fn(async (key: string) => box.store[key]),
  getKnown: vi.fn(async (key: string) => (box.configStoreUnreadable ? { value: undefined, known: false } : { value: box.store[key], known: true })),
  setMany: vi.fn(async (entries: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(entries)) {
      if (v === undefined) delete box.store[k];
      else box.store[k] = v;
    }
  }),
}));
vi.mock("@/lib/config-store", () => store);
const credentials = vi.hoisted(() => ({
  forgetClawaiCredentialRefusal: vi.fn(async () => undefined),
  resolveClawaiToken: vi.fn(),
}));
vi.mock("@/lib/harness/credentials", () => credentials);
vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn(async () => box.harness) }));
const connect = vi.hoisted(() => ({
  readClawAiSession: vi.fn(async () => box.session),
  clearClawAiSession: vi.fn(async () => undefined),
}));
// The real window (`isClawAiSessionConfiguring`); only the session file is faked.
vi.mock("@/lib/clawai-connect", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/clawai-connect")>()), ...connect }));
const gateway = vi.hoisted(() => ({
  readGatewayConfigBaseline: vi.fn(async () => ({ hash: "before" })),
  awaitGatewayHotApply: vi.fn(async () => box.hot),
  restartGatewayAnsweringEarly: vi.fn(async () => {
    if (box.restartRefused) throw new Error("Unit clawbox-gateway.service is masked.");
    return { back: Promise.resolve(true) };
  }),
  diffConfigPaths: vi.fn((a: unknown, b: unknown) => (JSON.stringify(a) === JSON.stringify(b) ? [] : ["models"])),
}));
vi.mock("@/lib/gateway-hot-apply", () => gateway);
const readiness = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@/lib/coding-agent", () => ({
  getCodingAgentStatus: vi.fn(async () => ({ ready: box.ready[Math.min(readiness.calls++, box.ready.length - 1)] })),
}));
const refresh = vi.hoisted(() => ({ refreshCodingAgentToolsIfReadinessChanged: vi.fn(async () => undefined) }));
vi.mock("@/lib/coding-agent-mcp-refresh", () => refresh);

import { signOutOfClawboxAi } from "@/lib/clawai-sign-out";

beforeEach(() => {
  vi.clearAllMocks();
  readiness.calls = 0;
  box.harness = "openclaw";
  box.storeRow = true;
  box.storeUnreadable = false;
  box.configStoreUnreadable = false;
  box.restartRefused = false;
  box.logoutWorks = true;
  box.config = signedInConfig();
  box.store = {
    clawai_token: TOKEN,
    clawai_tier: "flash",
    clawai_plan_tier: "flash",
    ai_model_explicit_picks: { clawai: "deepseek-v4-pro", openai: "gpt-5.6" },
    ai_model_provider: "clawai",
  };
  box.session = null;
  box.hot = { applied: true, how: "hot-reload" };
  box.ready = [true, false];
  cli.readConfig.mockImplementation(async () => structuredClone(box.config));
  cli.readConfigStrict.mockImplementation(async () => structuredClone(box.config));
  cli.spawnOpenclawCli.mockImplementation(async (args: string[]) => {
    if (args.join(" ") !== "models auth logout deepseek:default --yes") throw new Error(`unexpected ${args.join(" ")}`);
    if (!box.logoutWorks) throw new Error("logout failed");
    box.storeRow = false;
    unsetPath(box.config, "auth.profiles.deepseek:default");
    return { stdout: "", stderr: "" };
  });
  cli.runOpenclawConfigUnset.mockImplementation(async (dotted: string) => { unsetPath(box.config, dotted); });
  credentials.resolveClawaiToken.mockImplementation(async () => {
    const inline = ((box.config.models as { providers?: Record<string, { apiKey?: unknown }> } | undefined)?.providers?.deepseek?.apiKey);
    return typeof inline === "string" ? inline : (typeof box.store.clawai_token === "string" ? box.store.clawai_token : null);
  });
});

describe("signOutOfClawboxAi", () => {
  it("removes the profile natively, the key copies logout leaves, and the account's records — and says so", async () => {
    const result = await signOutOfClawboxAi();
    expect(result).toEqual({ ok: true, changed: true, gatewayRestarting: false });

    expect(cli.spawnOpenclawCli).toHaveBeenCalledWith(["models", "auth", "logout", "deepseek:default", "--yes"], expect.objectContaining({ timeoutMs: 60_000 }));
    expect(cli.runOpenclawConfigUnset.mock.calls.map((c) => c[0])).toEqual([
      "models.providers.deepseek.apiKey",
      "models.providers.litellm.apiKey",
      // Our own cloud voice goes whole: the boot script never withdraws it once the token is gone.
      "tts.providers.openai",
    ]);
    // The provider definition and the default stay: the chat says "sign in again".
    expect(box.config).toMatchObject({
      auth: { profiles: { "openai:manual": { provider: "openai" } } },
      models: { providers: { deepseek: { baseUrl: "https://proxy" }, anthropic: { apiKey: "sk-ant-owners-own" } } },
      agents: { defaults: { model: { primary: "deepseek/deepseek-v4-flash" } } },
      tts: { providers: { elevenlabs: { apiKey: "el-own" } } },
    });
    expect((box.config.tts as { providers: Record<string, unknown> }).providers).not.toHaveProperty("openai");
    expect((box.config.auth as { profiles: Record<string, unknown> }).profiles).not.toHaveProperty("deepseek:default");

    // The old account's token, badge, plan and pick gone; the rest kept.
    expect(box.store).toEqual({ ai_model_explicit_picks: { openai: "gpt-5.6" }, ai_model_provider: "clawai" });
    expect(credentials.forgetClawaiCredentialRefusal).toHaveBeenCalledTimes(1);
    expect(connect.clearClawAiSession).toHaveBeenCalledTimes(1);

    // The gateway is asked to apply the credential change, not restarted.
    expect(gateway.awaitGatewayHotApply).toHaveBeenCalledWith({ baseline: { hash: "before" }, configChanged: true, credentialsWritten: true });
    expect(gateway.restartGatewayAnsweringEarly).not.toHaveBeenCalled();
    // The coding tools follow the readiness the token gave them.
    expect(refresh.refreshCodingAgentToolsIfReadinessChanged).toHaveBeenCalledWith(true, false);
  });

  it("leaves the owner's own keys, takes every ClawBox AI copy — and only the key out of an owner's own voice entry", async () => {
    box.config = signedInConfig("sk-owners-own-litellm-key");
    (box.config.models as { providers: Record<string, unknown> }).providers.openai = { apiKey: "claw_legacy_image_slot" };
    box.config.tts = { providers: { openai: { baseUrl: "https://owners-own/v1", apiKey: TOKEN } } };
    expect(await signOutOfClawboxAi()).toMatchObject({ ok: true });
    expect(cli.runOpenclawConfigUnset.mock.calls.map((c) => c[0])).toEqual([
      "models.providers.deepseek.apiKey",
      "models.providers.openai.apiKey",
      "tts.providers.openai.apiKey",
    ]);
    expect(box.config).toMatchObject({
      models: { providers: { litellm: { apiKey: "sk-owners-own-litellm-key" } } },
      tts: { providers: { openai: { baseUrl: "https://owners-own/v1" } } },
    });
  });

  it("signs out a box where only the voice copy was left, rather than answer it already signed out", async () => {
    box.storeRow = false;
    box.config = { models: { providers: { deepseek: { baseUrl: "https://proxy" } } }, tts: signedInConfig().tts };
    box.store = {};
    expect(await signOutOfClawboxAi()).toMatchObject({ ok: true, changed: true });
    expect(cli.runOpenclawConfigUnset.mock.calls.map((c) => c[0])).toEqual(["tts.providers.openai"]);
  });

  it("removes a profile entry logout could not, with config unset", async () => {
    box.logoutWorks = false;
    box.storeRow = false;
    expect(await signOutOfClawboxAi()).toMatchObject({ ok: true, changed: true });
    expect(cli.runOpenclawConfigUnset.mock.calls.map((c) => c[0])).toEqual([
      "auth.profiles.deepseek:default",
      "models.providers.deepseek.apiKey",
      "models.providers.litellm.apiKey",
      "tts.providers.openai",
    ]);
  });

  it("restarts the gateway when it does not confirm the change, and follows one it is making itself", async () => {
    box.hot = { applied: false, why: "timeout" };
    expect(await signOutOfClawboxAi()).toEqual({ ok: true, changed: true, gatewayRestarting: true });
    expect(gateway.restartGatewayAnsweringEarly).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    box.config = signedInConfig();
    box.storeRow = true;
    box.store.clawai_token = TOKEN;
    box.hot = { applied: false, why: "gateway-restarting" };
    expect(await signOutOfClawboxAi()).toEqual({ ok: true, changed: true, gatewayRestarting: true });
    expect(gateway.restartGatewayAnsweringEarly).not.toHaveBeenCalled();
  });

  it("never answers signed out while the gateway's store still holds the profile", async () => {
    box.logoutWorks = false;
    const result = await signOutOfClawboxAi();
    expect(result).toMatchObject({ ok: false, kind: "still_signed_in", error: expect.stringMatching(/removed from the gateway's auth store/) });
  });

  it("never answers signed out over a store it could not read to check", async () => {
    box.configStoreUnreadable = true;
    expect(await signOutOfClawboxAi()).toMatchObject({ ok: false, kind: "still_signed_in", error: expect.stringMatching(/checked in the ClawBox config store/) });
    box.configStoreUnreadable = false;
    box.config = signedInConfig();
    box.storeRow = true;
    box.store.clawai_token = TOKEN;
    cli.readConfigStrict.mockRejectedValueOnce(new Error("openclaw.json is not valid JSON"));
    expect(await signOutOfClawboxAi()).toMatchObject({ ok: false, kind: "still_signed_in", error: expect.stringMatching(/checked in openclaw.json/) });
    box.config = signedInConfig();
    box.storeRow = true;
    box.store.clawai_token = TOKEN;
    box.logoutWorks = false;
    box.storeUnreadable = true;
    expect(await signOutOfClawboxAi()).toMatchObject({ ok: false, kind: "still_signed_in", error: expect.stringMatching(/checked in the gateway's auth store/) });
  });

  it("says so when the gateway restart that would drop the old sign-in was refused", async () => {
    box.hot = { applied: false, why: "timeout" };
    box.restartRefused = true;
    expect(await signOutOfClawboxAi()).toMatchObject({ ok: false, kind: "restart_refused" });
    // The box itself is signed out: a second tap has nothing left to remove.
    expect(box.store.clawai_token).toBeUndefined();
  });

  it("answers an already signed-out box at once, touching nothing", async () => {
    box.storeRow = false;
    box.config = { models: { providers: { deepseek: { baseUrl: "https://proxy" } } } };
    box.store = { ai_model_provider: "clawai" };
    expect(await signOutOfClawboxAi()).toEqual({ ok: true, changed: false, gatewayRestarting: false });
    expect(cli.spawnOpenclawCli).not.toHaveBeenCalled();
    expect(cli.runOpenclawConfigUnset).not.toHaveBeenCalled();
    expect(gateway.awaitGatewayHotApply).not.toHaveBeenCalled();
  });

  it("refuses on Hermes, and while a device login is writing its token — before anything is touched", async () => {
    box.harness = "hermes";
    expect(await signOutOfClawboxAi()).toMatchObject({ ok: false, kind: "not_supported" });
    box.harness = "openclaw";
    box.session = { status: "configuring", createdAt: Date.now() };
    expect(await signOutOfClawboxAi()).toMatchObject({ ok: false, kind: "sign_in_in_progress" });
    // The poll's window runs from when the configure began, not from the code.
    box.session = { status: "configuring", createdAt: Date.now() - 20 * 60_000, configuringStartedAt: Date.now() - 30_000 } as typeof box.session;
    expect(await signOutOfClawboxAi()).toMatchObject({ ok: false, kind: "sign_in_in_progress" });
    expect(cli.spawnOpenclawCli).not.toHaveBeenCalled();
    expect(store.setMany).not.toHaveBeenCalled();
    expect(box.store.clawai_token).toBe(TOKEN);
  });

  it("goes ahead over a configure the poll has already given up on", async () => {
    box.session = { status: "configuring", createdAt: Date.now() - 20 * 60_000, configuringStartedAt: Date.now() - 4 * 60_000 } as typeof box.session;
    expect(await signOutOfClawboxAi()).toMatchObject({ ok: true, changed: true });
    expect(connect.clearClawAiSession).toHaveBeenCalled();
  });
});
