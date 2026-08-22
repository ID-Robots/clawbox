import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLAWBOX_AI_PROVIDER } from "@/lib/clawbox-ai-models";

/**
 * One credential, two homes.
 *
 * Voice input was dark on Hermes for exactly one reason: the transcribe route
 * looked in `openclaw.json` and nowhere else, while the Hermes flow persists
 * the SAME device token through the app's own config store. Nothing about
 * transcription is edition-specific — the lookup was. These cases are the four
 * shapes a real box can be in.
 */

const readConfig = vi.fn();
const configStoreGet = vi.fn();

vi.mock("@/lib/openclaw-config", () => ({ readConfig: () => readConfig() }));
vi.mock("@/lib/config-store", () => ({
  get: (key: string) => configStoreGet(key),
  // Pulled in by the proxy-URL re-export chain; never called here.
  setMany: vi.fn(),
}));

const OPENCLAW_TOKEN = "tok-from-openclaw-store";
const HERMES_TOKEN = "tok-from-hermes-store";

function openclawConfigWith(apiKey: unknown) {
  // `deepseek` is the provider slot ClawBox AI occupies in openclaw.json
  // (CLAWBOX_AI_PROVIDER) — the proxy serves DeepSeek models under the device
  // token, so that is the key the gateway config writes.
  return { models: { providers: { [CLAWBOX_AI_PROVIDER]: { apiKey } } } };
}

async function resolve() {
  const mod = await import("@/lib/harness/credentials");
  return mod.resolveClawaiToken();
}

describe("resolveClawaiToken", () => {
  beforeEach(() => {
    vi.resetModules();
    readConfig.mockReset();
    configStoreGet.mockReset();
  });

  it("reads the OpenClaw store when that is where the token lives", async () => {
    readConfig.mockResolvedValue(openclawConfigWith(OPENCLAW_TOKEN));
    configStoreGet.mockResolvedValue(null);
    expect(await resolve()).toBe(OPENCLAW_TOKEN);
    // The fallback is not consulted when the first store answers.
    expect(configStoreGet).not.toHaveBeenCalled();
  });

  it("falls back to the Hermes store — the case that lit up voice input", async () => {
    readConfig.mockResolvedValue({});
    configStoreGet.mockResolvedValue(HERMES_TOKEN);
    expect(await resolve()).toBe(HERMES_TOKEN);
    expect(configStoreGet).toHaveBeenCalledWith("clawai_token");
  });

  it("still answers when there is no OpenClaw config to read at all", async () => {
    // A Hermes SKU has no `~/.openclaw` tree. A throw here is not a failure,
    // it is the whole reason there is a second place to look.
    readConfig.mockRejectedValue(new Error("ENOENT"));
    configStoreGet.mockResolvedValue(HERMES_TOKEN);
    expect(await resolve()).toBe(HERMES_TOKEN);
  });

  it("prefers the OpenClaw store on a dual box, where both hold the same token", async () => {
    readConfig.mockResolvedValue(openclawConfigWith(OPENCLAW_TOKEN));
    configStoreGet.mockResolvedValue(HERMES_TOKEN);
    expect(await resolve()).toBe(OPENCLAW_TOKEN);
  });

  it("reports nothing rather than an empty string when the box is unlinked", async () => {
    readConfig.mockResolvedValue(openclawConfigWith("   "));
    configStoreGet.mockResolvedValue("");
    expect(await resolve()).toBeNull();
    const { hasClawaiToken } = await import("@/lib/harness/credentials");
    expect(await hasClawaiToken()).toBe(false);
  });

  it("refuses a non-string the store somehow held", async () => {
    readConfig.mockResolvedValue(openclawConfigWith({ nested: "object" }));
    configStoreGet.mockResolvedValue(42);
    expect(await resolve()).toBeNull();
  });

  it("trims, so a token pasted with whitespace still works", async () => {
    readConfig.mockResolvedValue({});
    configStoreGet.mockResolvedValue(`  ${HERMES_TOKEN}\n`);
    expect(await resolve()).toBe(HERMES_TOKEN);
  });

  it("re-reads on every call, because the portal can re-mint at any time", async () => {
    readConfig.mockResolvedValueOnce(openclawConfigWith("first"));
    readConfig.mockResolvedValueOnce(openclawConfigWith("second"));
    const { resolveClawaiToken } = await import("@/lib/harness/credentials");
    expect(await resolveClawaiToken()).toBe("first");
    expect(await resolveClawaiToken()).toBe("second");
  });
});
