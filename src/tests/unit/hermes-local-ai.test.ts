import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Enabling Gemma 4 on a Hermes box left Settings saying "configured" while the
 * chat's provider picker had never heard of it. Everything the configure route
 * wrote went into OpenClaw's config; Hermes keeps its own `providers:` block,
 * so the model was running and unreachable. These cover the registration that
 * closes that gap.
 */
const cliMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hermes-cli", () => ({ runHermesCli: cliMock }));
vi.mock("@/lib/hermes-model-options", () => ({ invalidateModelOptions: vi.fn() }));
vi.mock("@/lib/local-ai-token", () => ({ getLocalAiToken: () => "local-token-xyz" }));
vi.mock("@/lib/local-ai-runtime", () => ({
  getLocalAiProxyBaseUrl: (p: string) => `http://127.0.0.1/setup-api/local-ai/${p}/v1`,
}));

import {
  HERMES_LOCAL_PROVIDER,
  HermesLocalApplyError,
  applyLocalAiToHermes,
  removeLocalAiFromHermes,
} from "@/lib/hermes-local-ai";

/** The args of every `config set`, as "key=value". */
function sets(): string[] {
  return cliMock.mock.calls
    .map((c) => c[0] as string[])
    .filter((a) => a[1] === "set")
    .map((a) => `${a[2]}=${a[3]}`);
}

describe("registering the local model with Hermes", () => {
  beforeEach(() => {
    cliMock.mockReset();
    cliMock.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
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
    expect(cliMock).not.toHaveBeenCalled();
  });

  it("surfaces a failed write rather than reporting success", async () => {
    cliMock.mockResolvedValueOnce({ code: 1, stdout: "", stderr: "nope" });
    await expect(
      applyLocalAiToHermes({ provider: "llamacpp", model: "gemma4-e2b-it-q4_0" }),
    ).rejects.toThrow(/nope/);
  });

  it("unregisters on disable so the picker stops offering a stopped model", async () => {
    await removeLocalAiFromHermes();
    const unset = cliMock.mock.calls
      .map((c) => (c[0] as string[]))
      .filter((a) => a[1] === "unset")
      .map((a) => a[2]);
    expect(unset).toEqual([
      `providers.${HERMES_LOCAL_PROVIDER}.base_url`,
      `providers.${HERMES_LOCAL_PROVIDER}.api_key`,
      `providers.${HERMES_LOCAL_PROVIDER}.api_mode`,
    ]);
  });
});
