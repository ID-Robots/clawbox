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
  vi.resetModules();
  lib = await import("@/lib/stt-preference");
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

describe("the stored primary", () => {
  it("is the cloud until the owner says otherwise", async () => {
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

  it("only knows the two engines", () => {
    expect(lib.isSttEngine("cloud")).toBe(true);
    expect(lib.isSttEngine("local")).toBe(true);
    expect(lib.isSttEngine("Cloud")).toBe(false);
    expect(lib.isSttEngine(undefined)).toBe(false);
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
