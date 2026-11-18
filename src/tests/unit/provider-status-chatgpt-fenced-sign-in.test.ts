import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { GatewayAuthProfileRead } from "@/lib/openclaw-auth-store";

/**
 * A ChatGPT sign-in the gateway will never use must not read "Connected"
 * (SUP-1023) — the Claude rule (provider-status-claude-fenced-sign-in.test.ts)
 * asked of the `openai` row's OAuth profile.
 *
 * A re-sign-in that was rolled back, or a renewal that could not reach the
 * token endpoint, leaves `openai:chatgpt` in the gateway's store as core's
 * refresh FENCE (`expires: 1`, access and refresh swapped for markers) while
 * openclaw.json still says a sign-in was filed. The OpenAI card then read
 * Connected over a credential every turn died on, next to the red error the
 * rolled-back sign-in had just shown.
 *
 *  1. A DEAD FENCE IS NOT A SIGN-IN: the OpenAI row says needs-reauth.
 *  2. POSITIVE EVIDENCE ONLY: no store, an unreadable one, no profile there, a
 *     healthy or merely renewing profile keep the answer the strip gave before.
 *  3. ONLY WHEN THE SIGN-IN IS ALL THERE IS: an OpenAI API key of the owner's,
 *     in any of its forms, keeps the row connected and the store unopened —
 *     but ClawBox AI's `claw_` token, which rides in the `openai` provider slot
 *     for images and voice, is not one.
 *  4. NOTHING CHANGES ELSEWHERE: a box with no ChatGPT sign-in never asks, and
 *     the Claude row is its own question.
 */

const storeRead = vi.hoisted(() => vi.fn());

vi.mock("@/lib/openclaw-auth-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/openclaw-auth-store")>()),
  readGatewayAuthProfile: storeRead,
}));
vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn() }));
vi.mock("@/lib/harness/credentials", () => ({ hasClawaiToken: vi.fn() }));
vi.mock("@/lib/clawbox-ai-portal-tier", () => ({ clawaiTokenRejectedByPortal: vi.fn(() => false) }));
vi.mock("@/lib/openclaw-config", () => ({ readConfig: vi.fn() }));
vi.mock("@/lib/hermes-model-options", () => ({ getModelOptions: vi.fn(), probeStillOwed: vi.fn(async () => false) }));
vi.mock("@/lib/hermes-cli", () => ({ runHermesCli: vi.fn(async () => ({ code: 1, stdout: "", stderr: "" })) }));
vi.mock("@/lib/plugin-repair", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/plugin-repair")>()),
  readPluginRepairs: vi.fn(async () => ({})),
}));
vi.mock("@/lib/provider-runnable", () => ({ readProviderRunnable: vi.fn(async () => new Map()) }));
vi.mock("@/lib/config-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config-store")>()),
  get: vi.fn(async () => null),
}));

const ID = "openai:chatgpt";
const NOW = 1_791_640_000_000;
const SECOND = 1_000;
const MINUTE = 60 * SECOND;

/** What core leaves when a refresh failed: markers, `expires: 1`, made terminal. */
const FENCED: GatewayAuthProfileRead = {
  kind: "present", store: "shared", type: "oauth", fingerprint: null, refreshFingerprint: null, expires: 1, fenced: true,
  fence: "failed", storeUpdatedAtMs: NOW - 24 * 60 * MINUTE,
};
const pending = (ago: number): GatewayAuthProfileRead => ({ ...FENCED, fence: "pending", storeUpdatedAtMs: NOW - ago });
const HEALTHY: GatewayAuthProfileRead = {
  kind: "present", store: "shared", type: "oauth", fingerprint: "0011223344556677", refreshFingerprint: "8899aabbccddeeff",
  expires: 1_900_000_000_000, fenced: false, fence: null, storeUpdatedAtMs: NOW - 60 * MINUTE,
};

/** A ChatGPT SUBSCRIPTION box as the configure route leaves openclaw.json: the profile's metadata, no provider definition. */
function subscriptionConfig(patch: Record<string, unknown> = {}) {
  return {
    auth: { profiles: { [ID]: { provider: "openai", mode: "oauth" } } },
    agents: { defaults: { model: { primary: "deepseek/deepseek-v4-flash" } } },
    ...patch,
  };
}

let readProviderStatus: typeof import("@/lib/provider-status").readProviderStatus;
let chatgptSignInFenced: typeof import("@/lib/provider-status").chatgptSignInFenced;
let getActiveHarness: Mock;
let readConfig: Mock;
let getModelOptions: Mock;

beforeEach(async () => {
  vi.resetModules();
  storeRead.mockReset();
  ({ getActiveHarness } = (await import("@/lib/harness")) as unknown as { getActiveHarness: Mock });
  ({ readConfig } = (await import("@/lib/openclaw-config")) as unknown as { readConfig: Mock });
  ({ getModelOptions } = (await import("@/lib/hermes-model-options")) as unknown as { getModelOptions: Mock });
  const credentials = (await import("@/lib/harness/credentials")) as unknown as { hasClawaiToken: Mock };
  credentials.hasClawaiToken.mockResolvedValue(false);
  getActiveHarness.mockResolvedValue("openclaw");
  readConfig.mockResolvedValue(subscriptionConfig());
  storeRead.mockReturnValue(FENCED);
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  ({ readProviderStatus, chatgptSignInFenced } = await import("@/lib/provider-status"));
});

async function openaiRow() {
  const summary = await readProviderStatus();
  expect(summary.degraded).toBe(false);
  const row = summary.providers.find((r) => r.id === "openai");
  expect(row).toBeDefined();
  return row!;
}

describe("Settings → Providers and a ChatGPT sign-in the gateway cannot use", () => {
  it("says needs-reauth when the gateway's store holds a refresh fence where the sign-in was", async () => {
    const row = await openaiRow();

    expect(row.state).toBe("needs-reauth");
    expect(row.isDefault).toBe(false);
    expect(storeRead).toHaveBeenCalledTimes(1);
    expect(storeRead).toHaveBeenCalledWith(ID);
  });

  it("says it of the DEFAULT provider too", async () => {
    readConfig.mockResolvedValue(subscriptionConfig({
      agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
    }));

    const row = await openaiRow();

    expect(row.isDefault).toBe(true);
    expect(row.state).toBe("needs-reauth");
  });

  it("leaves every other row exactly as it was", async () => {
    const fenced = await readProviderStatus();
    storeRead.mockReturnValue(HEALTHY);
    const healthy = await readProviderStatus();

    const others = (summary: typeof fenced) => summary.providers.filter((r) => r.id !== "openai");
    expect(others(fenced)).toEqual(others(healthy));
  });

  it.each<[string, GatewayAuthProfileRead]>([
    ["a healthy sign-in", HEALTHY],
    ["a store with no profile at that id", { kind: "absent", store: "shared" }],
    ["no store at all (a v1 box, a fresh home)", { kind: "no-store" }],
    ["a store that could not be read", { kind: "unreadable" }],
    ["an expired sign-in that is not a fence", { ...HEALTHY, expires: 1 }],
    ["a renewal in flight", pending(2 * SECOND)],
    ["a pending fence exactly at the margin", pending(150 * SECOND)],
  ])("keeps Connected over %s", async (_name, answer) => {
    storeRead.mockReturnValue(answer);

    expect((await openaiRow()).state).toBe("connected");
    expect(storeRead).toHaveBeenCalledTimes(1);
  });

  it("says needs-reauth over a pending fence nobody has settled", async () => {
    storeRead.mockReturnValue(pending(5 * MINUTE));

    expect((await openaiRow()).state).toBe("needs-reauth");
  });

  it.each<[string, Record<string, unknown>]>([
    ["an OpenAI API key under the provider definition", {
      models: { providers: { openai: { apiKey: "sk-proj-FAKE-a-pasted-key", baseUrl: "https://api.openai.com/v1" } } },
    }],
    ["a SecretRef where the provider definition's key goes", {
      models: { providers: { openai: { apiKey: { source: "env", provider: "default", id: "MY_OPENAI_KEY" } } } },
    }],
    ["an api_key profile beside it", {
      auth: { profiles: { [ID]: { provider: "openai", mode: "oauth" }, "openai:default": { provider: "openai", mode: "api_key" } } },
    }],
  ])("stays Connected, and does not open the store, when the box also holds %s", async (_name, patch) => {
    readConfig.mockResolvedValue(subscriptionConfig(patch));

    expect((await openaiRow()).state).toBe("connected");
    expect(storeRead).not.toHaveBeenCalled();
  });

  it("does not take ClawBox AI's token in the openai slot for a key of the owner's", async () => {
    readConfig.mockResolvedValue(subscriptionConfig({
      models: { providers: { openai: { apiKey: "claw_FAKE0123456789abcdef0123456789abcdef", baseUrl: "https://clawbox.com/api/ai" } } },
    }));

    expect((await openaiRow()).state).toBe("needs-reauth");
    expect(storeRead).toHaveBeenCalledWith(ID);
  });

  it("needs EVERY ChatGPT sign-in fenced when the box holds more than one", async () => {
    readConfig.mockResolvedValue(subscriptionConfig({
      auth: { profiles: { [ID]: { provider: "openai", mode: "oauth" }, "openai:chatgpt-work": { provider: "openai", mode: "oauth" } } },
    }));

    storeRead.mockImplementation((id: string) => (id === ID ? FENCED : HEALTHY));
    expect((await openaiRow()).state).toBe("connected");

    storeRead.mockReturnValue(FENCED);
    expect((await openaiRow()).state).toBe("needs-reauth");
  });

  it("does not open the store on a box with no ChatGPT sign-in", async () => {
    readConfig.mockResolvedValue({
      auth: { profiles: { "anthropic:default": { provider: "anthropic", mode: "oauth" } } },
      agents: { defaults: { model: { primary: "anthropic/claude-sonnet-5" } } },
    });

    const summary = await readProviderStatus();

    expect(summary.providers.find((r) => r.id === "openai")?.state).toBe("disconnected");
    // The Claude row asks about ITS profile, never about an OpenAI one.
    expect(storeRead.mock.calls.map(([id]) => id)).not.toContain(ID);
  });

  it("does not open the store on Hermes, whose rows come from its own dashboard", async () => {
    getActiveHarness.mockResolvedValue("hermes");
    getModelOptions.mockResolvedValue({
      stale: false,
      current: { provider: "openai-codex", model: "gpt-5.5" },
      providers: [{ id: "openai-codex", name: "OpenAI Codex", authenticated: true, isUserDefined: false, source: "d", total: 3, models: [] }],
    });

    const summary = await readProviderStatus();

    expect(summary.harness).toBe("hermes");
    expect(storeRead).not.toHaveBeenCalled();
  });

  it("answers false, without throwing, for a config that is not shaped like one", () => {
    for (const config of [{}, { auth: null }, { auth: { profiles: { [ID]: null } } }, { auth: { profiles: { [ID]: { provider: 7, mode: 7 } } } }]) {
      expect(chatgptSignInFenced(config as never)).toBe(false);
    }
  });
});
