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
  /** Whether `models auth logout` removes the store row (and the profile entry). */
  logoutWorks: true,
  config: {} as Record<string, unknown>,
  store: {} as Record<string, unknown>,
  session: null as null | { status: string; createdAt: number },
  hot: { applied: true, how: "hot-reload" } as { applied: boolean; how?: string; why?: string },
  ready: [true, false] as boolean[],
}));

function signedInConfig(litellmKey: string = TOKEN): Record<string, unknown> {
  return {
    auth: { profiles: { "deepseek:default": { provider: "deepseek", mode: "api_key" }, "openai:manual": { provider: "openai", mode: "api_key" } } },
    models: { providers: { deepseek: { baseUrl: "https://proxy", apiKey: TOKEN, models: [] }, litellm: { apiKey: litellmKey, baseUrl: "https://proxy" } } },
    agents: { defaults: { model: { primary: "deepseek/deepseek-v4-flash" } } },
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
}));
vi.mock("@/lib/openclaw-config", () => cli);
vi.mock("@/lib/openclaw-auth-store", () => ({
  readGatewayAuthProfile: vi.fn(() => (box.storeRow ? { kind: "present", type: "api_key", store: "shared" } : { kind: "absent", store: "shared" })),
}));
const store = vi.hoisted(() => ({
  get: vi.fn(async (key: string) => box.store[key]),
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
  isClawAiSessionExpired: vi.fn(() => false),
}));
vi.mock("@/lib/clawai-connect", () => connect);
const gateway = vi.hoisted(() => ({
  readGatewayConfigBaseline: vi.fn(async () => ({ hash: "before" })),
  awaitGatewayHotApply: vi.fn(async () => box.hot),
  restartGatewayAnsweringEarly: vi.fn(async () => ({ back: Promise.resolve(true) })),
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
    expect(cli.runOpenclawConfigUnset.mock.calls.map((c) => c[0])).toEqual(["models.providers.deepseek.apiKey", "models.providers.litellm.apiKey"]);
    // The provider definition and the default stay: the chat says "sign in again".
    expect(box.config).toMatchObject({
      auth: { profiles: { "openai:manual": { provider: "openai" } } },
      models: { providers: { deepseek: { baseUrl: "https://proxy" } } },
      agents: { defaults: { model: { primary: "deepseek/deepseek-v4-flash" } } },
    });
    expect((box.config.auth as { profiles: Record<string, unknown> }).profiles).not.toHaveProperty("deepseek:default");

    // One write, the old account's token, badge, plan and pick gone; the rest kept.
    expect(store.setMany).toHaveBeenCalledTimes(1);
    expect(box.store).toEqual({ ai_model_explicit_picks: { openai: "gpt-5.6" }, ai_model_provider: "clawai" });
    expect(credentials.forgetClawaiCredentialRefusal).toHaveBeenCalledTimes(1);
    expect(connect.clearClawAiSession).toHaveBeenCalledTimes(1);

    // The gateway is asked to apply the credential change, not restarted.
    expect(gateway.awaitGatewayHotApply).toHaveBeenCalledWith({ baseline: { hash: "before" }, configChanged: true, credentialsWritten: true });
    expect(gateway.restartGatewayAnsweringEarly).not.toHaveBeenCalled();
    // The coding tools follow the readiness the token gave them.
    expect(refresh.refreshCodingAgentToolsIfReadinessChanged).toHaveBeenCalledWith(true, false);
  });

  it("leaves an image-provider key that is the owner's own, not ClawBox AI's", async () => {
    box.config = signedInConfig("sk-owners-own-litellm-key");
    expect(await signOutOfClawboxAi()).toMatchObject({ ok: true });
    expect(cli.runOpenclawConfigUnset.mock.calls.map((c) => c[0])).toEqual(["models.providers.deepseek.apiKey"]);
    expect(box.config).toMatchObject({ models: { providers: { litellm: { apiKey: "sk-owners-own-litellm-key" } } } });
  });

  it("removes a profile entry logout could not, with config unset", async () => {
    box.logoutWorks = false;
    box.storeRow = false;
    expect(await signOutOfClawboxAi()).toMatchObject({ ok: true, changed: true });
    expect(cli.runOpenclawConfigUnset.mock.calls.map((c) => c[0])).toEqual([
      "auth.profiles.deepseek:default",
      "models.providers.deepseek.apiKey",
      "models.providers.litellm.apiKey",
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
    expect(result).toMatchObject({ ok: false, kind: "still_signed_in", error: expect.stringMatching(/auth store/) });
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
    expect(cli.spawnOpenclawCli).not.toHaveBeenCalled();
    expect(store.setMany).not.toHaveBeenCalled();
    expect(box.store.clawai_token).toBe(TOKEN);
  });
});
