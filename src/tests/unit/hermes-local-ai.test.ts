import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Enabling Gemma 4 on a Hermes box left Settings saying "configured" while the
 * chat's provider picker had never heard of it. Everything the configure route
 * wrote went into OpenClaw's config; Hermes keeps its own `providers:` block,
 * so the model was running and unreachable. These cover the registration that
 * closes that gap.
 */
const cliMock = vi.hoisted(() => vi.fn());
const patchMock = vi.hoisted(() => vi.fn());
const readMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hermes-cli", () => ({ runHermesCli: cliMock }));
vi.mock("@/lib/hermes-config-yaml", () => ({
  patchHermesConfig: patchMock,
  readHermesConfigValue: readMock,
}));
vi.mock("@/lib/hermes-model-options", () => ({ invalidateModelOptions: vi.fn() }));
vi.mock("@/lib/local-ai-token", () => ({ getLocalAiToken: () => "local-token-xyz" }));
// Mirrors the REAL url builders byte-for-byte — the previous mock answered a
// /v1 Ollama URL the real builder never produced, so this suite asserted a
// base_url no device ever wrote (TASK-448). The real builders' exact strings
// are pinned, unmocked, in local-ai-openai-base-url.test.ts.
vi.mock("@/lib/local-ai-runtime", () => ({
  getLocalAiProxyRootUrl: () => "http://127.0.0.1",
  getLocalAiOpenAiBaseUrl: (p: string) =>
    p === "llamacpp"
      ? "http://127.0.0.1/setup-api/local-ai/llamacpp/v1"
      : "http://127.0.0.1/setup-api/local-ai/ollama/v1",
}));
const getConfigMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/config-store", () => ({ get: getConfigMock }));

import {
  HERMES_LOCAL_PROVIDER,
  HermesLocalApplyError,
  _resetLocalAiReconcileForTests,
  applyLocalAiToHermes,
  reconcileLocalAiWithHermes,
  removeLocalAiFromHermes,
} from "@/lib/hermes-local-ai";

/** Every key the module wrote, as "key=value".
 *
 * One read-merge-write, not three-to-five `hermes config set` calls: each of
 * those re-serialised config.yaml and deleted every comment in it (b10), so the
 * assertion is on the patch, not on argv.
 */
function sets(): string[] {
  return patchMock.mock.calls.flatMap((c) =>
    Object.entries((c[0]?.set ?? {}) as Record<string, string>).map(([k, v]) => `${k}=${v}`),
  );
}

/** Every key the module removed. */
function unsets(): string[] {
  return patchMock.mock.calls.flatMap((c) => (c[0]?.unset ?? []) as string[]);
}

describe("registering the local model with Hermes", () => {
  beforeEach(() => {
    cliMock.mockReset();
    cliMock.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    patchMock.mockReset();
    patchMock.mockResolvedValue({ mode: "merge", backupPath: null });
    readMock.mockReset();
    readMock.mockResolvedValue(null);
  });
  afterEach(() => vi.clearAllMocks());

  it("points Hermes at our proxy, not at llama.cpp directly", async () => {
    await applyLocalAiToHermes({ provider: "llamacpp", model: "gemma4-e2b-it-q4_0" });
    // The proxy is what implements on-demand standby and survives a backend
    // port change; llama.cpp's own port would break both.
    expect(sets()).toContain(
      `providers.${HERMES_LOCAL_PROVIDER}.base_url=http://127.0.0.1/setup-api/local-ai/llamacpp/v1`,
    );
    expect(sets()).toContain(`providers.${HERMES_LOCAL_PROVIDER}.api_mode=openai`);
    expect(sets()).toContain(`providers.${HERMES_LOCAL_PROVIDER}.api_key=local-token-xyz`);
  });

  it("declares the model so Hermes' own picker has one while it sleeps", async () => {
    // Standby is the local model's normal resting state, and a sleeping model
    // answers no /v1/models — so Hermes' `/model` keyboard (which builds its
    // rows from the `providers:` block, hermes_cli/model_switch.py:3220) offers
    // "clawlocal (0)" and the customer cannot select the one model they have.
    // A declared id is what Hermes reads instead; a live probe that DOES answer
    // still wins (model_switch.py:3423-3431).
    await applyLocalAiToHermes({ provider: "llamacpp", model: "gemma4-e2b-it-q4_0" });
    expect(sets()).toContain(`providers.${HERMES_LOCAL_PROVIDER}.models=gemma4-e2b-it-q4_0`);
  });

  it("uses the ollama proxy when ollama is the local provider", async () => {
    await applyLocalAiToHermes({ provider: "ollama", model: "llama3.2:3b" });
    expect(sets()).toContain(
      `providers.${HERMES_LOCAL_PROVIDER}.base_url=http://127.0.0.1/setup-api/local-ai/ollama/v1`,
    );
  });

  it("does NOT take over the device's active provider by default", async () => {
    await applyLocalAiToHermes({ provider: "llamacpp", model: "gemma4-e2b-it-q4_0" });
    // Turning on a private fallback makes it available; it should not quietly
    // move the customer off the provider they chose.
    expect(sets().some((s) => s.startsWith("model.provider="))).toBe(false);
    expect(sets().some((s) => s.startsWith("model.default="))).toBe(false);
  });

  it("switches the device only when asked", async () => {
    await applyLocalAiToHermes({ provider: "llamacpp", model: "gemma4-e2b-it-q4_0", makeDefault: true });
    expect(sets()).toContain(`model.provider=${HERMES_LOCAL_PROVIDER}`);
    expect(sets()).toContain("model.default=gemma4-e2b-it-q4_0");
  });

  it("refuses a model id that argv would read as a flag", async () => {
    await expect(
      applyLocalAiToHermes({ provider: "llamacpp", model: "--yolo" }),
    ).rejects.toBeInstanceOf(HermesLocalApplyError);
    expect(patchMock).not.toHaveBeenCalled();
    expect(cliMock).not.toHaveBeenCalled();
  });

  it("writes the whole registration in ONE read-merge-write", async () => {
    await applyLocalAiToHermes({ provider: "ollama", model: "qwen2.5:3b", makeDefault: true });
    expect(patchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces a failed write rather than reporting success", async () => {
    patchMock.mockRejectedValueOnce(new Error("nope"));
    await expect(
      applyLocalAiToHermes({ provider: "llamacpp", model: "gemma4-e2b-it-q4_0" }),
    ).rejects.toThrow(/nope/);
  });

  it("unregisters on disable so the picker stops offering a stopped model", async () => {
    await removeLocalAiFromHermes();
    // `models` rides with the rest: left behind, it is a `providers.clawlocal`
    // block with a model id and no endpoint, which Hermes still renders as a
    // picker row — the dead-model-in-the-list state this removal exists to end.
    expect(unsets()).toEqual([
      `providers.${HERMES_LOCAL_PROVIDER}.base_url`,
      `providers.${HERMES_LOCAL_PROVIDER}.api_key`,
      `providers.${HERMES_LOCAL_PROVIDER}.api_mode`,
      `providers.${HERMES_LOCAL_PROVIDER}.models`,
    ]);
  });

  it("clears a model.provider that still points at the local model", async () => {
    // Leaving it set with the providers block gone is what made every chat turn
    // 502 with "Unknown provider 'clawlocal'" after a Local AI toggle-off.
    readMock.mockImplementation(async (key: string) =>
      key === "model.provider" ? HERMES_LOCAL_PROVIDER : "qwen2.5:3b",
    );
    const result = await removeLocalAiFromHermes();
    expect(result).toEqual({ wasDefault: true, model: "qwen2.5:3b" });
    expect(unsets()).toContain("model.provider");
    expect(unsets()).toContain("model.default");
  });

  it("leaves someone else's provider selection alone", async () => {
    readMock.mockImplementation(async (key: string) =>
      key === "model.provider" ? "openrouter" : "anthropic/claude-sonnet-4",
    );
    const result = await removeLocalAiFromHermes();
    expect(result.wasDefault).toBe(false);
    expect(unsets()).not.toContain("model.provider");
    expect(unsets()).not.toContain("model.default");
  });
});

describe("reconciling an already-configured device", () => {
  // No mockReset ritual: vitest.config.ts already runs clearMocks/mockReset
  // between tests — only the behaviour each test needs is established here.
  beforeEach(() => {
    _resetLocalAiReconcileForTests();
    patchMock.mockResolvedValue({ mode: "merge", backupPath: null });
    readMock.mockResolvedValue(null);
    getConfigMock.mockImplementation(async (key: string) => {
      if (key === "local_ai_configured") return true;
      if (key === "local_ai_provider") return "ollama";
      if (key === "local_ai_model") return "ollama/qwen3:8b";
      return undefined;
    });
  });

  /**
   * What `hermes config get providers.clawlocal.<key>` answers. `models`
   * defaults to "already declared" so each test states only the fact it is
   * about.
   */
  function registered(opts: { baseUrl: string; models?: string | null }) {
    const models = opts.models === undefined ? "qwen3:8b" : opts.models;
    cliMock.mockImplementation(async (args: string[]) => {
      if (args[2] === `providers.${HERMES_LOCAL_PROVIDER}.models`) {
        return models === null
          ? { code: 1, stdout: "", stderr: "config key not set" }
          : { code: 0, stdout: `${models}\n`, stderr: "" };
      }
      return { code: 0, stdout: `${opts.baseUrl}\n`, stderr: "" };
    });
  }

  function registeredBaseUrl(value: string) {
    registered({ baseUrl: value });
  }

  it("re-registers a device that got the bare (pre-/v1) Ollama root", async () => {
    // Every Ollama-configured Hermes box got this value before the fix, and
    // reconcile's "already registered → done" check would have preserved the
    // broken URL forever. It is a known-broken value, so it repairs like an
    // absent registration.
    registeredBaseUrl("http://127.0.0.1/setup-api/local-ai/ollama");
    await reconcileLocalAiWithHermes();
    expect(sets()).toContain(
      `providers.${HERMES_LOCAL_PROVIDER}.base_url=http://127.0.0.1/setup-api/local-ai/ollama/v1`,
    );
  });

  it("leaves a correctly registered device alone", async () => {
    registeredBaseUrl("http://127.0.0.1/setup-api/local-ai/ollama/v1");
    await reconcileLocalAiWithHermes();
    expect(patchMock).not.toHaveBeenCalled();
  });

  it("leaves a deliberately customised base_url alone", async () => {
    registeredBaseUrl("http://192.168.0.5:11434/v1");
    await reconcileLocalAiWithHermes();
    expect(patchMock).not.toHaveBeenCalled();
  });

  it("still registers a device with no registration at all", async () => {
    registeredBaseUrl("");
    await reconcileLocalAiWithHermes();
    expect(sets()).toContain(
      `providers.${HERMES_LOCAL_PROVIDER}.base_url=http://127.0.0.1/setup-api/local-ai/ollama/v1`,
    );
  });

  it("declares the model on a device registered before the catalogue existed", async () => {
    // The endpoint is right, so the old reconcile stopped here — and the box
    // kept showing "clawlocal (0)" in Hermes' own picker whenever the model was
    // asleep, which is most of the time.
    registered({ baseUrl: "http://127.0.0.1/setup-api/local-ai/ollama/v1", models: null });
    await reconcileLocalAiWithHermes();
    expect(sets()).toContain(`providers.${HERMES_LOCAL_PROVIDER}.models=qwen3:8b`);
  });

  it("leaves a config it could not read alone", async () => {
    // Unreadable is not unset: repairing off a failed read would overwrite
    // whatever is actually in the file.
    cliMock.mockImplementation(async (args: string[]) =>
      args[2] === `providers.${HERMES_LOCAL_PROVIDER}.models`
        ? { code: 1, stdout: "", stderr: "permission denied" }
        : { code: 0, stdout: "http://127.0.0.1/setup-api/local-ai/ollama/v1\n", stderr: "" });
    await reconcileLocalAiWithHermes();
    expect(patchMock).not.toHaveBeenCalled();
  });
});
