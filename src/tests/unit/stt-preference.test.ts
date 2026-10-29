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
// Whether the box has an engine of its own is the other half of the default:
// with nothing stored, that engine goes first.
const local = vi.hoisted(() => ({ installed: false }));
vi.mock("@/lib/stt-local", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stt-local")>()),
  localSttInstalled: async () => ({ installed: local.installed, detail: "" }),
}));

type Lib = typeof import("@/lib/stt-preference");
let lib: Lib;
let originalHome: string | undefined;

const HOME = "/home/testbox";
// The cloud row names the ClawBox AI auth profile: the transcription credential
// no longer rides on the openai provider entry (it shadowed the ChatGPT sign-in).
const CLOUD = { provider: "openai", model: "gpt-4o-mini-transcribe", profile: "deepseek:default", capabilities: ["audio"] };
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
  local.installed = false;
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

  /**
   * A box with Whisper installed and no stored pick put the cloud first, so a
   * cloud leg that could not answer cost every recording a refused round trip
   * before the engine that could — and on a channel, where the cloud row had
   * lost its credential, no transcript at all.
   */
  it("puts the box's own engine first when nothing is stored and it is installed", async () => {
    local.installed = true;
    expect(await lib.getSttPrimary()).toBe("local");
  });

  it("still honours a stored cloud pick on a box with its own engine", async () => {
    local.installed = true;
    store.set("stt_primary", "cloud");
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
    for (const localInstalled of [false, true]) {
      expect(lib.resolveSttPrimary("cloud", true, localInstalled)).toBe("cloud");
      expect(lib.resolveSttPrimary("local", true, localInstalled)).toBe("local");
    }
  });

  it("with nothing stored, is the box's engine when it has one and the cloud when it has not", () => {
    expect(lib.resolveSttPrimary(undefined, true, true)).toBe("local");
    expect(lib.resolveSttPrimary("fastest", true, true)).toBe("local");
    expect(lib.resolveSttPrimary(undefined, true, false)).toBe("cloud");
    expect(lib.resolveSttPrimary("fastest", true, false)).toBe("cloud");
  });

  it("is the box itself with no credential, whatever the store says", () => {
    for (const localInstalled of [false, true]) {
      expect(lib.resolveSttPrimary("cloud", false, localInstalled)).toBe("local");
      expect(lib.resolveSttPrimary("local", false, localInstalled)).toBe("local");
      expect(lib.resolveSttPrimary(undefined, false, localInstalled)).toBe("local");
    }
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
    expect(lib.buildAudioModels(["cloud", "local"], false, true)).toEqual([CLOUD]);
    expect(lib.buildAudioModels(["local", "cloud"], false, true)).toEqual([CLOUD]);
  });

  it("puts the on-box CLI row where the preference puts it", () => {
    expect(lib.buildAudioModels(["cloud", "local"], true, true)).toEqual([CLOUD, LOCAL]);
    expect(lib.buildAudioModels(["local", "cloud"], true, true)).toEqual([LOCAL, CLOUD]);
  });

  /**
   * A cloud row whose credential is gone is not a fallback: the core resolves
   * the openai provider's own credential for it, and a ChatGPT sign-in there
   * is refused the proxy endpoint on every voice note, ahead of the engine on
   * the box. So it is left out, in either order.
   */
  it("leaves the cloud row out when no ClawBox AI credential backs it", () => {
    expect(lib.buildAudioModels(["cloud", "local"], true, false)).toEqual([LOCAL]);
    expect(lib.buildAudioModels(["local", "cloud"], true, false)).toEqual([LOCAL]);
    expect(lib.buildAudioModels(["cloud", "local"], false, false)).toEqual([]);
  });

  it("hands out fresh objects each time, so a caller editing one cannot change the next", () => {
    const a = lib.buildAudioModels(["cloud", "local"], true, true);
    (a[1].args as string[]).push("--tainted");
    expect(lib.buildAudioModels(["cloud", "local"], true, true)[1]).toEqual(LOCAL);
  });
});

/**
 * The credential half of the cloud row's rule, shared by the channel list
 * (stt-channel.ts) and the chat microphone, and mirrored by
 * gateway-pre-start.sh. A ClawBox AI sign-in records `deepseek:default` in
 * openclaw.json as a key; a release that signed in by subscription recorded
 * it as OAuth, and the core then refused our endpoint on every voice note.
 */
describe("transcribeProfileProblem", () => {
  const record = (mode?: string) => ({ "deepseek:default": { provider: "deepseek", ...(mode === undefined ? {} : { mode }) } });

  it("accepts the profile only when it is recorded as a key", () => {
    expect(lib.transcribeProfileProblem(record("api_key"))).toBeNull();
    expect(lib.transcribeProfileProblem(record("api-key"))).toBeNull();
    expect(lib.transcribeProfileProblem(record("token"))).toBeNull();
  });

  it("refuses a stale OAuth row, and a row with no mode", () => {
    expect(lib.transcribeProfileProblem(record("oauth"))).toBe("profile_not_api_key");
    expect(lib.transcribeProfileProblem(record())).toBe("profile_not_api_key");
  });

  it("refuses a box that records no such profile", () => {
    expect(lib.transcribeProfileProblem(undefined)).toBe("profile_missing");
    expect(lib.transcribeProfileProblem({ "openai:default": { provider: "openai", mode: "api_key" } })).toBe("profile_missing");
  });

  it("leaves the cloud row out of a box with Whisper and a stale OAuth profile — the on-box engine alone, first", () => {
    const primary = lib.resolveSttPrimary(undefined, true, true);
    const backed = lib.transcribeProfileProblem(record("oauth")) === null;
    expect(lib.buildAudioModels(lib.sttEngineOrder(primary), true, backed)).toEqual([LOCAL]);
  });
});

describe("cloudTranscribeProblem — the chat microphone's half", () => {
  const TOKEN = "claw_test";
  const config = (mode: string | null, apiKey: string = TOKEN) => ({
    models: { providers: { deepseek: { apiKey } } },
    ...(mode === null ? {} : { auth: { profiles: { "deepseek:default": { provider: "deepseek", mode } } } }),
  });

  it("uses a ClawBox AI sign-in recorded as a key", () => {
    expect(lib.cloudTranscribeProblem(TOKEN, config("api_key"))).toBeNull();
  });

  it("refuses the sign-in left over as OAuth, as the channel row does", () => {
    expect(lib.cloudTranscribeProblem(TOKEN, config("oauth"))).toBe("profile_not_api_key");
    expect(lib.cloudTranscribeProblem(TOKEN, config(null))).toBe("profile_missing");
  });

  it("never sends an owner's own DeepSeek key to the proxy", () => {
    expect(lib.cloudTranscribeProblem("sk-owner-deepseek-key", config("api_key", "sk-owner-deepseek-key"))).toBe("not_linked");
    expect(lib.cloudTranscribeProblem(null, config("api_key"))).toBe("not_linked");
  });

  it("asks nothing of openclaw.json for a token the Hermes store holds", () => {
    expect(lib.cloudTranscribeProblem(TOKEN, null)).toBeNull();
    // A dual box whose openclaw.json holds no ClawBox AI token of its own.
    expect(lib.cloudTranscribeProblem(TOKEN, { auth: { profiles: {} } })).toBeNull();
  });
});
