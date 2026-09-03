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

import { hermesPickerModels } from "@/tests/helpers/hermes-picker-catalogue";
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
    // `providers.clawlocal.models` absent — the state every device in the field
    // is in, and the one the registration is allowed to write.
    cliMock.mockImplementation(async (args: string[]) =>
      args?.[2] === `providers.${HERMES_LOCAL_PROVIDER}.models`
        ? { code: 1, stdout: "", stderr: "config key not set" }
        : { code: 0, stdout: "", stderr: "" });
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

  it("declares it in a shape Hermes' own picker reads", async () => {
    // The write above is only half the claim; this is the half that matters.
    // A bare STRING has to count as an allowlist for Hermes, or the sleeping
    // model's empty probe replaces it and the picker is empty again. Judged by
    // the same mirror of `list_authenticated_providers` the ClawBox AI side is.
    await applyLocalAiToHermes({ provider: "ollama", model: "qwen2.5:3b" });
    const declared = patchMock.mock.calls[0][0].set[`providers.${HERMES_LOCAL_PROVIDER}.models`];
    // `[]` is the sleeping model: standby answers no /v1/models at all.
    expect(hermesPickerModels({ models: declared }, [])).toEqual(["qwen2.5:3b"]);
    // Awake, whatever it is actually running still wins.
    expect(hermesPickerModels({ models: declared }, ["qwen2.5:3b", "llama3.2:3b"]))
      .toEqual(["qwen2.5:3b", "llama3.2:3b"]);
  });

  it("leaves a catalogue Hermes wrote itself alone", async () => {
    // Hermes caches its own discovered catalogue under the same key, as a
    // nested block. The comment-preserving splice refuses a leaf that opens
    // one, and that refusal drops the WHOLE patch onto `hermes config set` —
    // which deletes every comment in config.yaml. So the key is skipped, and
    // the endpoint keys still land.
    cliMock.mockImplementation(async (args: string[]) =>
      args?.[2] === `providers.${HERMES_LOCAL_PROVIDER}.models`
        ? { code: 0, stdout: "{'qwen3:8b': {'context_length': 40960}}\n", stderr: "" }
        : { code: 0, stdout: "", stderr: "" });
    await applyLocalAiToHermes({ provider: "ollama", model: "qwen3:8b" });
    expect(sets().some((kv) => kv.startsWith(`providers.${HERMES_LOCAL_PROVIDER}.models=`))).toBe(false);
    expect(sets()).toContain(`providers.${HERMES_LOCAL_PROVIDER}.api_mode=openai`);
  });

  it("updates the declared id when the local model changes", async () => {
    // A scalar there is OUR shape, so it is ours to move — otherwise switching
    // Gemma to Qwen leaves the picker offering the model that is gone.
    readMock.mockImplementation(async (key: string) =>
      key === `providers.${HERMES_LOCAL_PROVIDER}.models` ? "gemma4-e2b-it-q4_0" : null,
    );
    await applyLocalAiToHermes({ provider: "ollama", model: "qwen3:8b" });
    expect(sets()).toContain(`providers.${HERMES_LOCAL_PROVIDER}.models=qwen3:8b`);
  });

  it("writes no catalogue when the CLI never answered", async () => {
    // 127 is the shim over a rebuilding venv, not "the key is unset".
    cliMock.mockImplementation(async (args: string[]) =>
      args?.[2] === `providers.${HERMES_LOCAL_PROVIDER}.models`
        ? { code: 127, stdout: "", stderr: "" }
        : { code: 0, stdout: "", stderr: "" });
    await applyLocalAiToHermes({ provider: "ollama", model: "qwen3:8b" });
    expect(sets().some((kv) => kv.startsWith(`providers.${HERMES_LOCAL_PROVIDER}.models=`))).toBe(false);
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
    expect(sets()).toEqual([`providers.${HERMES_LOCAL_PROVIDER}.models=qwen3:8b`]);
  });

  it("repairs the catalogue WITHOUT re-registering the endpoint", async () => {
    // Re-running the full apply would drag every field box down the path built
    // for a stale self-written URL, and that path substitutes a llama.cpp
    // default for an unreadable model id — which on this Ollama box would put
    // `gemma4-e2b-it-q4_0` in the picker for an endpoint that cannot serve it.
    registered({ baseUrl: "http://127.0.0.1/setup-api/local-ai/ollama/v1", models: null });
    await reconcileLocalAiWithHermes();
    expect(sets().some((kv) => kv.startsWith(`providers.${HERMES_LOCAL_PROVIDER}.base_url=`))).toBe(false);
  });

  it("declares nothing when it does not know what the model is", async () => {
    getConfigMock.mockImplementation(async (key: string) => {
      if (key === "local_ai_configured") return true;
      if (key === "local_ai_provider") return "ollama";
      return undefined;
    });
    registered({ baseUrl: "http://127.0.0.1/setup-api/local-ai/ollama/v1", models: null });
    await reconcileLocalAiWithHermes();
    // An id we do not have is a reason to write nothing, never to invent one.
    expect(patchMock).not.toHaveBeenCalled();
  });

  it("hands the catalogue back to the repair when an enable could not read it", async () => {
    // The repair runs once per process. If it has already run — a settled box,
    // nothing to do — and the customer THEN enables local AI while the CLI is
    // mid-`step_hermes_install` rebuild, the enable rightly writes no `models`
    // and the latched repair never asks again: the key stays missing until the
    // web server restarts, on the one box that just asked for the feature.
    registered({ baseUrl: "http://127.0.0.1/setup-api/local-ai/ollama/v1" });
    await reconcileLocalAiWithHermes();

    cliMock.mockImplementation(async (args: string[]) =>
      args[2] === `providers.${HERMES_LOCAL_PROVIDER}.models`
        ? { code: 127, stdout: "", stderr: "" }
        : { code: 0, stdout: "http://127.0.0.1/setup-api/local-ai/ollama/v1\n", stderr: "" });
    await applyLocalAiToHermes({ provider: "ollama", model: "qwen3:8b" });
    expect(sets().some((kv) => kv.startsWith(`providers.${HERMES_LOCAL_PROVIDER}.models=`))).toBe(false);

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
