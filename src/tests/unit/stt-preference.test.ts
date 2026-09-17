import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * src/lib/stt-preference.ts — the one preference that orders both
 * transcription surfaces: the chat microphone's engine walk and the gateway's
 * `tools.media.audio.models[]`.
 */

const store = vi.hoisted(() => new Map<string, unknown>());
vi.mock("@/lib/config-store", () => ({
  get: async (key: string) => store.get(key),
  set: async (key: string, value: unknown) => { store.set(key, value); },
}));

// Whether this box holds a ClawBox AI credential is half of what decides the
// engine tried first, so it is a fact these tests set rather than one they
// inherit from whatever tree HOME happens to point at.
const token = vi.hoisted(() => ({ value: "claw_test" as string | null }));
vi.mock("@/lib/harness/credentials", () => ({
  CLAWBOX_AI_PROXY_URL: "https://clawbox.test/api/ai",
  resolveClawaiToken: async () => token.value,
}));

type Lib = typeof import("@/lib/stt-preference");
let lib: Lib;
let originalHome: string | undefined;

const HOME = "/home/testbox";
const CLOUD = { provider: "openai", model: "gpt-4o-mini-transcribe", capabilities: ["audio"] };
const LOCAL = {
  type: "cli",
  command: "/usr/bin/python3",
  args: [`${HOME}/.openclaw/workspace/scripts/stt-client.py`, "{{MediaPath}}"],
  timeoutSeconds: 120,
  capabilities: ["audio"],
};

beforeEach(async () => {
  originalHome = process.env.HOME;
  process.env.HOME = HOME;
  store.clear();
  token.value = "claw_test";
  vi.resetModules();
  lib = await import("@/lib/stt-preference");
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

describe("the stored primary", () => {
  it("is the cloud on a linked box until the owner says otherwise", async () => {
    expect(await lib.getSttPrimary()).toBe("cloud");
  });

  it("round-trips through the config store", async () => {
    await lib.setSttPrimary("local");
    expect(store.get("stt_primary")).toBe("local");
    expect(await lib.getSttPrimary()).toBe("local");
  });

  it("falls back to the cloud on a value it does not recognise", async () => {
    store.set("stt_primary", "fastest");
    expect(await lib.getSttPrimary()).toBe("cloud");
  });

  /**
   * TASK-860. The cloud engine is not a thing a box can be pointed at without a
   * subscription, and `stt_primary` defaulting to `cloud` regardless meant an
   * unlinked box reported "ClawBox cloud" as the engine that hears it first
   * beside `engines.cloud.configured: false` — while the cloud-defaults card
   * said the target for that same box was the engine on the box, reason
   * `not_linked`. Transcription still worked, because the chain drops an engine
   * that cannot run; what was wrong was the box's account of itself.
   */
  it("is the box itself on a box with no ClawBox AI credential", async () => {
    token.value = null;
    expect(await lib.getSttPrimary()).toBe("local");
  });

  it("does not sit on the cloud after the credential is gone, whatever is stored", async () => {
    token.value = null;
    store.set("stt_primary", "cloud");
    expect(await lib.getSttPrimary()).toBe("local");
  });

  it("gives the cloud back the moment a subscription is connected", async () => {
    token.value = null;
    expect(await lib.getSttPrimary()).toBe("local");
    token.value = "claw_test";
    expect(await lib.getSttPrimary()).toBe("cloud");
  });

  it("only knows the two engines", () => {
    expect(lib.isSttEngine("cloud")).toBe(true);
    expect(lib.isSttEngine("local")).toBe(true);
    expect(lib.isSttEngine("Cloud")).toBe(false);
    expect(lib.isSttEngine(undefined)).toBe(false);
  });
});

describe("resolveSttPrimary", () => {
  it("is the stored pick while the box has a cloud credential", () => {
    expect(lib.resolveSttPrimary("cloud", true)).toBe("cloud");
    expect(lib.resolveSttPrimary("local", true)).toBe("local");
    expect(lib.resolveSttPrimary(undefined, true)).toBe("cloud");
    expect(lib.resolveSttPrimary("fastest", true)).toBe("cloud");
  });

  it("is the box itself with no credential, whatever the store says", () => {
    expect(lib.resolveSttPrimary("cloud", false)).toBe("local");
    expect(lib.resolveSttPrimary("local", false)).toBe("local");
    expect(lib.resolveSttPrimary(undefined, false)).toBe("local");
  });
});

describe("sttEngineOrder", () => {
  it("is the primary followed by the other engine", () => {
    expect(lib.sttEngineOrder("cloud")).toEqual(["cloud", "local"]);
    expect(lib.sttEngineOrder("local")).toEqual(["local", "cloud"]);
  });
});

describe("buildAudioModels", () => {
  it("pins the same model the chat microphone bills against", () => {
    expect(lib.TRANSCRIBE_MODEL).toBe("gpt-4o-mini-transcribe");
  });

  it("is the cloud row alone when the box has no engine of its own", () => {
    expect(lib.buildAudioModels(["cloud", "local"], false)).toEqual([CLOUD]);
    expect(lib.buildAudioModels(["local", "cloud"], false)).toEqual([CLOUD]);
  });

  it("puts the on-box CLI row where the preference puts it", () => {
    expect(lib.buildAudioModels(["cloud", "local"], true)).toEqual([CLOUD, LOCAL]);
    expect(lib.buildAudioModels(["local", "cloud"], true)).toEqual([LOCAL, CLOUD]);
  });

  it("hands out fresh objects each time, so a caller editing one cannot change the next", () => {
    const a = lib.buildAudioModels(["cloud", "local"], true);
    (a[1].args as string[]).push("--tainted");
    expect(lib.buildAudioModels(["cloud", "local"], true)[1]).toEqual(LOCAL);
  });
});
