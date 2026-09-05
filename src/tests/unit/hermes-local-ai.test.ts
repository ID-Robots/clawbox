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
// Defaults survive `mockReset` because they are the implementation `vi.fn()` was
// created with — the resolved form answers "absent" unless a test says otherwise.
const resolveMock = vi.hoisted(() =>
  vi.fn<(key: string) => Promise<{ state: string; value?: string }>>(async () => ({ state: "absent" })),
);
vi.mock("@/lib/hermes-cli", () => ({ runHermesCli: cliMock }));
vi.mock("@/lib/hermes-config-yaml", () => ({
  patchHermesConfig: patchMock,
  readHermesConfigValue: readMock,
  resolveHermesConfigValue: resolveMock,
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

  it("still registers when the CLI could not be RUN at all", async () => {
    // `runHermesCli` rejects (a missing binary, a timeout, its own SIGKILL)
    // rather than returning a code. That is a question that failed, exactly as
    // 127 is, and it is now read the same way: no catalogue is written, the
    // repair is handed back, and the endpoint keys still land. It used to
    // propagate and fail the whole enable with a raw error.
    cliMock.mockRejectedValue(new Error("hermes timed out"));
    await applyLocalAiToHermes({ provider: "ollama", model: "qwen3:8b" });
    expect(sets().some((kv) => kv.startsWith(`providers.${HERMES_LOCAL_PROVIDER}.models=`))).toBe(false);
    expect(sets()).toContain(`providers.${HERMES_LOCAL_PROVIDER}.api_mode=openai`);
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

  /**
   * A key that is THERE in a shape that is not a scalar — a `models:` block or
   * list, which is what Hermes' own discovery writes. The file reader answers
   * `{ state: "present" }` for it, and the removal has to read that as a
   * leftover: an entry Hermes still renders as a picker row.
   */
  const NON_SCALAR = Symbol("non-scalar");

  /**
   * A config.yaml the reads and the writes SHARE, because the removal is now
   * proved by reading the file back rather than by the patch call returning.
   * `patchHermesConfig` is stubbed to apply the unsets, which is what a device
   * does; the failing case below stubs one that does not.
   */
  function deviceConfig(initial: Record<string, string | typeof NON_SCALAR>) {
    const file: Record<string, string | typeof NON_SCALAR | undefined> = { ...initial };
    readMock.mockImplementation(async (key: string) => (typeof file[key] === "string" ? file[key] : null));
    resolveMock.mockImplementation(async (key: string) => {
      const value = file[key];
      if (typeof value === "string") return { state: "value", value };
      return value === NON_SCALAR ? { state: "present" } : { state: "absent" };
    });
    patchMock.mockImplementation(async (patch: { unset?: string[] }) => {
      for (const key of patch.unset ?? []) delete file[key];
      return { mode: "merge", backupPath: null };
    });
    return file;
  }

  it("clears a model.provider that still points at the local model", async () => {
    // Leaving it set with the providers block gone is what made every chat turn
    // 502 with "Unknown provider 'clawlocal'" after a Local AI toggle-off.
    deviceConfig({
      [`providers.${HERMES_LOCAL_PROVIDER}.base_url`]: "http://127.0.0.1/setup-api/local-ai/llamacpp/v1",
      "model.provider": HERMES_LOCAL_PROVIDER,
      "model.default": "qwen2.5:3b",
    });
    const result = await removeLocalAiFromHermes();
    expect(result).toEqual({ wasDefault: true, model: "qwen2.5:3b" });
    expect(unsets()).toContain("model.provider");
    expect(unsets()).toContain("model.default");
  });

  it("leaves someone else's provider selection alone", async () => {
    deviceConfig({
      [`providers.${HERMES_LOCAL_PROVIDER}.base_url`]: "http://127.0.0.1/setup-api/local-ai/llamacpp/v1",
      "model.provider": "openrouter",
      "model.default": "anthropic/claude-sonnet-4",
    });
    const result = await removeLocalAiFromHermes();
    expect(result.wasDefault).toBe(false);
    expect(unsets()).not.toContain("model.provider");
    expect(unsets()).not.toContain("model.default");
  });

  it("refuses to report a removal the config did not take", async () => {
    // `patchHermesConfig`'s merge path reads every key back, but its CLI
    // fallback does not: `applyViaCli`'s unset loop discards the exit code, so
    // a `hermes` binary mid-rebuild (127 before argparse) let a whole removal
    // return normally with `providers.clawlocal` still in the file. The disable
    // route answers on this return for the Hermes SKU, so it has to be a fact.
    deviceConfig({
      [`providers.${HERMES_LOCAL_PROVIDER}.base_url`]: "http://127.0.0.1/setup-api/local-ai/llamacpp/v1",
    });
    patchMock.mockResolvedValue({ mode: "cli", backupPath: null });

    await expect(removeLocalAiFromHermes()).rejects.toThrow(/still registered/i);
  });

  it("refuses when only the model list survived the removal", async () => {
    // `providers.clawlocal.models` on its own is still an entry Hermes renders
    // as a picker row, so a removal that dropped the endpoint and kept the
    // catalogue has not ended the state it was called to end. The CLI fallback
    // walks the unsets one call at a time, so partial is a real outcome.
    const file = deviceConfig({
      [`providers.${HERMES_LOCAL_PROVIDER}.base_url`]: "http://127.0.0.1/setup-api/local-ai/llamacpp/v1",
      [`providers.${HERMES_LOCAL_PROVIDER}.models`]: "gemma4-e2b-it-q4_0",
    });
    patchMock.mockImplementation(async (patch: { unset?: string[] }) => {
      for (const key of patch.unset ?? []) {
        if (!key.endsWith(".models")) delete file[key];
      }
      return { mode: "cli", backupPath: null };
    });

    await expect(removeLocalAiFromHermes()).rejects.toThrow(/still registered/i);
  });

  it("refuses when the catalogue survived as a block Hermes wrote itself", async () => {
    // `providers.clawlocal.models` is a scalar only while WE own it. Hermes'
    // own discovery writes a nested block, and a hand-edited file may hold a
    // list — both are still a `providers.clawlocal` entry Hermes renders as a
    // picker row. The scalar-only reader answered `null` for them, exactly as
    // it does for a key that is gone, so a partial removal read as complete.
    const file = deviceConfig({
      [`providers.${HERMES_LOCAL_PROVIDER}.base_url`]: "http://127.0.0.1/setup-api/local-ai/llamacpp/v1",
      [`providers.${HERMES_LOCAL_PROVIDER}.models`]: NON_SCALAR,
    });
    patchMock.mockImplementation(async (patch: { unset?: string[] }) => {
      for (const key of patch.unset ?? []) {
        if (!key.endsWith(".models")) delete file[key];
      }
      return { mode: "cli", backupPath: null };
    });

    await expect(removeLocalAiFromHermes()).rejects.toThrow(/still registered/i);
  });

  it("carries wasDefault out with the refusal so the selection can be restored", async () => {
    // The partial `applyViaCli`'s one-call-per-key loop produces: the selection
    // goes, a providers key stays. `wasDefault` was read BEFORE the patch, and
    // this refusal is the last moment it exists — the retry reads a
    // `model.provider` that is already gone, answers false, and re-enabling
    // Local AI would put the device on nothing instead of back where it was.
    const file = deviceConfig({
      [`providers.${HERMES_LOCAL_PROVIDER}.base_url`]: "http://127.0.0.1/setup-api/local-ai/llamacpp/v1",
      "model.provider": HERMES_LOCAL_PROVIDER,
      "model.default": "gemma4-e2b-it-q4_0",
    });
    patchMock.mockImplementation(async (patch: { unset?: string[] }) => {
      for (const key of patch.unset ?? []) {
        if (!key.startsWith("providers.")) delete file[key];
      }
      return { mode: "cli", backupPath: null };
    });

    await expect(removeLocalAiFromHermes()).rejects.toMatchObject({ wasDefault: true });
  });

  it("asks Hermes' own reader when our reader cannot resolve the file", async () => {
    // HARNESS FIRST. The CLI fallback is entered BECAUSE the line editor could
    // not work with this file, so a read-back that cannot resolve the path is
    // the companion of the write, not the exotic case — and answering
    // "unproven" there is a 502 the owner can never clear, because the retry
    // reads the same file. `hermes config get` is Hermes' own reader of it.
    deviceConfig({
      [`providers.${HERMES_LOCAL_PROVIDER}.base_url`]: "http://127.0.0.1/setup-api/local-ai/llamacpp/v1",
    });
    patchMock.mockResolvedValue({ mode: "cli", backupPath: null });
    resolveMock.mockResolvedValue({ state: "unreadable" });
    cliMock.mockResolvedValue({ code: 1, stdout: "", stderr: "config key not set" });

    await expect(removeLocalAiFromHermes()).resolves.toMatchObject({ wasDefault: false });
  });

  it("refuses a write that changed nothing rather than confirming it", async () => {
    // The shape that makes the proof worth having: a config.yaml the line
    // editor cannot INDEX makes `unsetYamlPath` a no-op, `patchText`'s own
    // verification pass, and no CLI fallback run — so `patchHermesConfig`
    // returns `{mode:"merge"}` over a file it never touched. If the read-back
    // uses the same reader and reads its blind spot as "absent", it can only
    // ever confirm that no-op. Here the file cannot answer and Hermes says the
    // keys are still there.
    deviceConfig({
      [`providers.${HERMES_LOCAL_PROVIDER}.base_url`]: "http://127.0.0.1/setup-api/local-ai/llamacpp/v1",
    });
    patchMock.mockResolvedValue({ mode: "merge", backupPath: null });
    resolveMock.mockResolvedValue({ state: "unreadable" });
    cliMock.mockResolvedValue({ code: 0, stdout: "http://127.0.0.1/v1", stderr: "" });

    await expect(removeLocalAiFromHermes()).rejects.toThrow(/still registered/i);
  });

  it("refuses when Hermes' own reader cannot answer either", async () => {
    // Both readers silent is the only genuinely unknowable state, and it is the
    // one this sentence is for: a `hermes` shim mid-`step_hermes_install`
    // rebuild exits 127 without reaching argparse.
    deviceConfig({
      [`providers.${HERMES_LOCAL_PROVIDER}.base_url`]: "http://127.0.0.1/setup-api/local-ai/llamacpp/v1",
    });
    patchMock.mockResolvedValue({ mode: "cli", backupPath: null });
    resolveMock.mockResolvedValue({ state: "unreadable" });
    cliMock.mockResolvedValue({ code: 127, stdout: "", stderr: "" });

    await expect(removeLocalAiFromHermes()).rejects.toThrow(/could not be read back/i);
  });

  it("reports a key Hermes' own reader says is still there", async () => {
    deviceConfig({
      [`providers.${HERMES_LOCAL_PROVIDER}.base_url`]: "http://127.0.0.1/setup-api/local-ai/llamacpp/v1",
    });
    patchMock.mockResolvedValue({ mode: "cli", backupPath: null });
    resolveMock.mockResolvedValue({ state: "unreadable" });
    cliMock.mockResolvedValue({ code: 0, stdout: "http://127.0.0.1/v1", stderr: "" });

    await expect(removeLocalAiFromHermes()).rejects.toThrow(/still registered/i);
  });

  it("refuses when the selection still points at a provider that is gone", async () => {
    // The other half of the same state, and the worse one: every chat turn 502s
    // with "Unknown provider 'clawlocal'".
    const file = deviceConfig({
      [`providers.${HERMES_LOCAL_PROVIDER}.base_url`]: "http://127.0.0.1/setup-api/local-ai/llamacpp/v1",
      "model.provider": HERMES_LOCAL_PROVIDER,
      "model.default": "gemma4-e2b-it-q4_0",
    });
    patchMock.mockImplementation(async (patch: { unset?: string[] }) => {
      // The providers block goes; the selection does not.
      for (const key of patch.unset ?? []) {
        if (key !== "model.provider") delete file[key];
      }
      return { mode: "cli", backupPath: null };
    });

    await expect(removeLocalAiFromHermes()).rejects.toThrow(/still registered/i);
  });
});

describe("reconciling an already-configured device", () => {
  // No mockReset ritual: vitest.config.ts already runs clearMocks/mockReset
  // between tests — only the behaviour each test needs is established here.
  beforeEach(() => {
    _resetLocalAiReconcileForTests();
    // A FAILED attempt is held for a minute, so a test that proves a retry has
    // to say how much later that retry is.
    vi.useFakeTimers();
    patchMock.mockResolvedValue({ mode: "merge", backupPath: null });
    readMock.mockResolvedValue(null);
    getConfigMock.mockImplementation(async (key: string) => {
      if (key === "local_ai_configured") return true;
      if (key === "local_ai_provider") return "ollama";
      if (key === "local_ai_model") return "ollama/qwen3:8b";
      return undefined;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
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

    // No clock advance: nothing FAILED here, the enable simply could not read
    // the key, so the very next read must be allowed to repair it.
    registered({ baseUrl: "http://127.0.0.1/setup-api/local-ai/ollama/v1", models: null });
    await reconcileLocalAiWithHermes();
    expect(sets()).toContain(`providers.${HERMES_LOCAL_PROVIDER}.models=qwen3:8b`);
  });

  it("does not re-ask on every request while the CLI keeps failing", async () => {
    // Unlatching is what stops an update from skipping the repair; this is what
    // stops it becoming a Python start per request. The route awaits this and
    // the ClawBox AI repair before it serves anything, each read carrying a 15 s
    // timeout, so an unbounded retry lands on every chat-header load.
    cliMock.mockResolvedValue({ code: 127, stdout: "", stderr: "" });
    await reconcileLocalAiWithHermes();
    const afterFirst = cliMock.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    vi.advanceTimersByTime(30_000);
    await reconcileLocalAiWithHermes();
    await reconcileLocalAiWithHermes();
    expect(cliMock.mock.calls.length).toBe(afterFirst);

    vi.advanceTimersByTime(30_001);
    await reconcileLocalAiWithHermes();
    expect(cliMock.mock.calls.length).toBeGreaterThan(afterFirst);
  });

  it("refreshes a declared id this module wrote and no longer matches", async () => {
    // "scalar" is the shape THIS module writes, so a scalar naming a model the
    // box no longer runs is our own stale value — the picker would go on
    // offering it. The enable path has always updated it; the repair only ever
    // wrote a MISSING key, so a box whose model changed while the CLI was
    // unreadable kept the old id for the life of that config.
    readMock.mockResolvedValue("qwen3:4b");
    registered({ baseUrl: "http://127.0.0.1/setup-api/local-ai/ollama/v1", models: "qwen3:4b" });
    await reconcileLocalAiWithHermes();
    expect(sets()).toContain(`providers.${HERMES_LOCAL_PROVIDER}.models=qwen3:8b`);
  });

  it("leaves a declared id that already names the configured model", async () => {
    readMock.mockResolvedValue("qwen3:8b");
    registered({ baseUrl: "http://127.0.0.1/setup-api/local-ai/ollama/v1", models: "qwen3:8b" });
    await reconcileLocalAiWithHermes();
    expect(patchMock).not.toHaveBeenCalled();
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
