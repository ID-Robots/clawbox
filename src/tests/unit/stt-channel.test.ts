import { beforeEach, describe, expect, it, vi } from "vitest";
import { tokenFingerprint } from "@/lib/anthropic-gateway-auth";

/**
 * src/lib/stt-channel.ts — the audio list a channel voice note walks.
 *
 * Found on a real box: the owner had moved to a ChatGPT sign-in, the list still
 * held the ClawBox AI cloud row bound to `deepseek:default` with our proxy as
 * the endpoint, and every Telegram voice note was refused ("OpenAI OAuth audio
 * transcription requires the official endpoint without custom request
 * overrides") — while Whisper, installed on the same box, was never in the
 * list at all.
 */

const config = vi.hoisted(() => ({
  read: vi.fn(),
  /** The strict reader; answers what `read` does unless a test says otherwise. */
  strict: vi.fn(),
  batch: vi.fn(),
  unset: vi.fn(),
  absent: vi.fn(),
}));
vi.mock("@/lib/openclaw-config", () => ({
  readConfig: (...a: unknown[]) => config.read(...a),
  readConfigStrict: (...a: unknown[]) => config.strict(...a),
  runOpenclawConfigSetBatch: (...a: unknown[]) => config.batch(...a),
  runOpenclawConfigUnset: (...a: unknown[]) => config.unset(...a),
  openclawIsAbsent: () => config.absent(),
}));
const token = vi.hoisted(() => ({ value: "claw_token" as string | null }));
vi.mock("@/lib/harness/credentials", () => ({
  CLAWBOX_AI_PROXY_URL: "https://clawbox.com/api/ai",
  resolveClawaiToken: async () => token.value,
}));
const auth = vi.hoisted(() => ({ bound: vi.fn(), openai: vi.fn() }));
vi.mock("@/lib/openclaw-auth-store", () => ({
  readGatewayAuthProfile: (...a: unknown[]) => auth.bound(...a),
  readGatewayProviderAuth: (...a: unknown[]) => auth.openai(...a),
}));
const local = vi.hoisted(() => ({ installed: true, forget: vi.fn() }));
vi.mock("@/lib/stt-local", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stt-local")>()),
  localSttInstalled: async () => ({ installed: local.installed, detail: "" }),
  forgetLocalSttProbe: () => local.forget(),
}));
const store = vi.hoisted(() => new Map<string, unknown>());
vi.mock("@/lib/config-store", () => ({
  get: async (key: string) => store.get(key),
  set: async (key: string, value: unknown) => { store.set(key, value); },
}));

type Lib = typeof import("@/lib/stt-channel");
let lib: Lib;

const PROXY = "https://clawbox.com/api/ai";
const CLOUD = { provider: "openai", model: "gpt-4o-mini-transcribe", profile: "deepseek:default", capabilities: ["audio"] };
const isLocal = (row: unknown) => (row as { type?: string }).type === "cli";

const BACKED = {
  kind: "present" as const,
  store: "shared" as const,
  type: "api_key",
  fingerprint: tokenFingerprint("claw_token"),
  refreshFingerprint: null,
  expires: null,
  fenced: false,
  fence: null,
  storeUpdatedAtMs: null,
};
const NO_OPENAI = { kind: "present" as const, profiles: [], order: null, failures: {} };
const CHATGPT = {
  kind: "present" as const,
  profiles: [{ ...BACKED, type: "oauth", fingerprint: "f00dfeedf00dfeed", profileId: "openai:chatgpt" }],
  order: null,
  failures: {},
};

function facts(over: Partial<Parameters<Lib["decideCloudSttBacking"]>[0]> = {}) {
  return { token: "claw_token", bound: BACKED, openai: NO_OPENAI, profiles: undefined, ...over };
}

/** Every key the writes touched, in order: sets by path, unsets as `-path`. */
function written(): string[] {
  const order: { at: number; key: string }[] = [];
  config.batch.mock.calls.forEach(([ops], i) => {
    for (const [key] of ops as string[][]) order.push({ at: config.batch.mock.invocationCallOrder[i], key });
  });
  config.unset.mock.calls.forEach(([key], i) => order.push({ at: config.unset.mock.invocationCallOrder[i], key: `-${key}` }));
  return order.sort((a, b) => a.at - b.at).map((entry) => entry.key);
}

function writtenModels(): unknown[] {
  for (const [ops] of config.batch.mock.calls) {
    const op = (ops as string[][]).find(([key]) => key === "tools.media.models");
    if (op) return JSON.parse(op[1]);
  }
  throw new Error("no tools.media.models write");
}

beforeEach(async () => {
  vi.resetModules();
  config.read.mockReset().mockResolvedValue({});
  config.strict.mockReset().mockImplementation((...a: unknown[]) => config.read(...a));
  config.batch.mockReset().mockResolvedValue(undefined);
  config.unset.mockReset().mockResolvedValue(undefined);
  config.absent.mockReset().mockReturnValue(false);
  auth.bound.mockReset().mockReturnValue(BACKED);
  auth.openai.mockReset().mockReturnValue(NO_OPENAI);
  token.value = "claw_token";
  local.installed = true;
  local.forget.mockReset();
  store.clear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  lib = await import("@/lib/stt-channel");
});

describe("decideCloudSttBacking — does a ClawBox AI credential back the cloud row?", () => {
  it("does when the bound profile is this box's token as an API key and openai is not a sign-in", () => {
    expect(lib.decideCloudSttBacking(facts())).toEqual({ usable: true, reason: null });
  });

  it("does not on a box with no ClawBox AI token — never linked, or signed out", () => {
    expect(lib.decideCloudSttBacking(facts({ token: null }))).toEqual({ usable: false, reason: "not_linked" });
  });

  it("does not send an owner's own DeepSeek key to the proxy", () => {
    expect(lib.decideCloudSttBacking(facts({ token: "sk-owner-deepseek" })).reason).toBe("not_linked");
  });

  it("does not once the bound profile is gone from the gateway's store", () => {
    expect(lib.decideCloudSttBacking(facts({ bound: { kind: "absent", store: "shared" } })).reason).toBe("profile_missing");
  });

  it("does not when the bound profile is an OAuth bundle or a dead refresh fence", () => {
    expect(lib.decideCloudSttBacking(facts({ bound: { ...BACKED, type: "oauth" } })).reason).toBe("profile_not_api_key");
    expect(lib.decideCloudSttBacking(facts({ bound: { ...BACKED, fenced: true, fence: "failed" } })).reason)
      .toBe("profile_not_api_key");
  });

  it("does not when the bound profile holds some other key than this box's token", () => {
    expect(lib.decideCloudSttBacking(facts({ bound: { ...BACKED, fingerprint: "0123456789abcdef" } })).reason)
      .toBe("profile_stale");
  });

  it("takes a key it cannot fingerprint (a SecretRef) on trust", () => {
    expect(lib.decideCloudSttBacking(facts({ bound: { ...BACKED, fingerprint: null } })).usable).toBe(true);
  });

  it("never pairs the openai row and our endpoint with a ChatGPT sign-in, in the store or the config", () => {
    expect(lib.decideCloudSttBacking(facts({ openai: CHATGPT })).reason).toBe("openai_oauth");
    expect(
      lib.decideCloudSttBacking(facts({ profiles: { "openai:chatgpt": { provider: "openai", mode: "oauth" } } })).reason,
    ).toBe("openai_oauth");
  });

  it("is not put off by the owner's own OpenAI API key", () => {
    const own = { ...NO_OPENAI, profiles: [{ ...BACKED, fingerprint: "aaaaaaaaaaaaaaaa", profileId: "openai:default" }] };
    expect(lib.decideCloudSttBacking(facts({ openai: own })).usable).toBe(true);
  });

  it("reads openclaw.json's record of the profile when the store cannot be read", () => {
    const unreadable = { kind: "unreadable" as const };
    // A transient read failure must not drop a working row...
    expect(
      lib.decideCloudSttBacking(facts({ bound: unreadable, profiles: { "deepseek:default": { provider: "deepseek", mode: "api_key" } } })),
    ).toEqual({ usable: true, reason: null });
    // ...but a profile nothing ever recorded is not there.
    expect(lib.decideCloudSttBacking(facts({ bound: { kind: "no-store" } })).reason).toBe("profile_missing");
    expect(
      lib.decideCloudSttBacking(facts({ bound: unreadable, profiles: { "deepseek:default": { provider: "deepseek", mode: "oauth" } } })).reason,
    ).toBe("profile_not_api_key");
  });
});

describe("syncChannelAudio", () => {
  it("writes the endpoint and the list together while the cloud row is backed", async () => {
    expect(await lib.syncChannelAudio(["local", "cloud"], true)).toBe(true);
    expect(written()).toEqual(["tools.media.audio.baseUrl", "tools.media.models"]);
    const models = writtenModels();
    expect(isLocal(models[0])).toBe(true);
    expect(models[1]).toEqual(CLOUD);
  });

  /** The box this was found on, as its openclaw.json read. */
  it("takes the cloud row and our endpoint off a box signed in with ChatGPT, and puts Whisper in", async () => {
    auth.openai.mockReturnValue(CHATGPT);
    config.read.mockResolvedValue({
      auth: { profiles: { "openai:chatgpt": { provider: "openai", mode: "oauth" } } },
      tools: { media: { audio: { baseUrl: PROXY }, models: [CLOUD] } },
    });
    expect(await lib.syncChannelAudio(["cloud", "local"], true)).toBe(true);
    // The list first, then the endpoint; never the endpoint written back.
    expect(written()).toEqual(["tools.media.models", "-tools.media.audio.baseUrl"]);
    const models = writtenModels();
    expect(models).toHaveLength(1);
    expect(isLocal(models[0])).toBe(true);
  });

  it("leaves an endpoint that is not ours where it is", async () => {
    token.value = null;
    config.read.mockResolvedValue({ tools: { media: { audio: { baseUrl: "https://whisper.lan/v1" }, models: [CLOUD] } } });
    await lib.syncChannelAudio(["local", "cloud"], true);
    expect(config.unset).not.toHaveBeenCalled();
  });

  it("writes nothing once the list and the endpoint already say it", async () => {
    token.value = null;
    config.read.mockResolvedValue({ tools: { media: { models: [] } } });
    expect(await lib.syncChannelAudio(["local", "cloud"], false)).toBe(false);
    expect(config.batch).not.toHaveBeenCalled();
    expect(config.unset).not.toHaveBeenCalled();
  });

  it("only takes our endpoint away when the list is already right", async () => {
    token.value = null;
    config.read.mockResolvedValue({ tools: { media: { audio: { baseUrl: `${PROXY}/` }, models: [] } } });
    expect(await lib.syncChannelAudio(["cloud", "local"], false)).toBe(true);
    expect(written()).toEqual(["-tools.media.audio.baseUrl"]);
  });

  it("keeps rows that are not audio rows", async () => {
    auth.bound.mockReturnValue({ kind: "absent", store: "shared" });
    const vision = { provider: "openai", model: "gpt-6-astra", capabilities: ["image"] };
    config.read.mockResolvedValue({ tools: { media: { models: [vision, CLOUD] } } });
    await lib.syncChannelAudio(["cloud", "local"], true);
    const models = writtenModels();
    expect(models[0]).toEqual(vision);
    expect(models.slice(1).every(isLocal)).toBe(true);
  });

  it("serialises its writers, so two at once cannot both read the same old list", async () => {
    let release!: () => void;
    config.batch.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const first = lib.syncChannelAudio(["local", "cloud"], true);
    const second = lib.syncChannelAudio(["cloud", "local"], true);
    await vi.waitFor(() => expect(config.batch).toHaveBeenCalledTimes(1));
    expect(config.read).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
    expect(config.read).toHaveBeenCalledTimes(2);
  });
});

describe("reconcileChannelAudio — boot, a Whisper install, a provider save", () => {
  it("puts the installed engine into the list, first, on a box with no stored pick", async () => {
    config.read.mockResolvedValue({ tools: { media: { audio: { baseUrl: PROXY }, models: [CLOUD] } } });
    expect(await lib.reconcileChannelAudio({ trigger: "whisper-install" })).toBe(true);
    const models = writtenModels();
    expect(isLocal(models[0])).toBe(true);
    expect(models[1]).toEqual(CLOUD);
  });

  it("keeps the order the owner stored", async () => {
    store.set("stt_primary", "cloud");
    await lib.reconcileChannelAudio({ trigger: "boot" });
    const models = writtenModels();
    expect(models[0]).toEqual(CLOUD);
    expect(isLocal(models[1])).toBe(true);
  });

  it("works on a box with no ClawBox AI subscription at all — the box whose engine is all it has", async () => {
    token.value = null;
    store.set("stt_primary", "cloud");
    await lib.reconcileChannelAudio({ trigger: "boot" });
    const models = writtenModels();
    expect(models).toHaveLength(1);
    expect(isLocal(models[0])).toBe(true);
  });

  it("asks python again after an install, rather than trusting the minute-old 'missing'", async () => {
    await lib.reconcileChannelAudio({ trigger: "whisper-install", freshProbe: true });
    expect(local.forget).toHaveBeenCalledTimes(1);
    await lib.reconcileChannelAudio({ trigger: "boot" });
    expect(local.forget).toHaveBeenCalledTimes(1);
  });

  it("does nothing on the edition without an OpenClaw gateway", async () => {
    config.absent.mockReturnValue(true);
    expect(await lib.reconcileChannelAudio({ trigger: "boot" })).toBe(false);
    expect(config.read).not.toHaveBeenCalled();
  });

  /**
   * The pass nobody asked for runs at every boot and after every provider
   * save. An owner who pointed transcription at their own server or service
   * keeps it, as gateway-pre-start.sh has always let them.
   */
  it("leaves an owner's own transcription route alone", async () => {
    const deepgram = { provider: "deepgram", model: "nova-3", capabilities: ["audio"] };
    config.read.mockResolvedValue({ tools: { media: { models: [deepgram] } } });
    expect(await lib.reconcileChannelAudio({ trigger: "boot" })).toBe(false);
    config.read.mockResolvedValue({ tools: { media: { audio: { baseUrl: "https://whisper.lan/v1" }, models: [CLOUD] } } });
    expect(await lib.reconcileChannelAudio({ trigger: "provider" })).toBe(false);
    expect(config.batch).not.toHaveBeenCalled();
    expect(config.unset).not.toHaveBeenCalled();
  });

  it("still takes back a list it wrote, in the older shape without the profile too", async () => {
    const legacy = { provider: "openai", model: "gpt-4o-mini-transcribe", capabilities: ["audio"] };
    config.read.mockResolvedValue({ tools: { media: { audio: { baseUrl: PROXY }, models: [legacy] } } });
    expect(await lib.reconcileChannelAudio({ trigger: "boot" })).toBe(true);
    expect(writtenModels().some(isLocal)).toBe(true);
  });

  it("an owner's own engine pick in Settings still writes over a route that is not ours", async () => {
    const deepgram = { provider: "deepgram", model: "nova-3", capabilities: ["audio"] };
    config.read.mockResolvedValue({ tools: { media: { models: [deepgram] } } });
    expect(await lib.syncChannelAudio(["local", "cloud"], true)).toBe(true);
  });

  it("writes nothing over a config it could not read", async () => {
    // `readConfig` answers `{}` for it, as it does on a box, and a list rebuilt
    // from that drops every row that is not an audio row of ours.
    config.read.mockResolvedValue({});
    config.strict.mockRejectedValue(new Error("Unexpected end of JSON input"));
    await expect(lib.reconcileChannelAudio({ trigger: "boot" })).rejects.toThrow();
    expect(config.batch).not.toHaveBeenCalled();
  });

  it("writes nothing when channels already hear the way the box would", async () => {
    store.set("stt_primary", "local");
    await lib.reconcileChannelAudio({ trigger: "boot" });
    const settled = writtenModels();
    config.read.mockResolvedValue({ tools: { media: { audio: { baseUrl: PROXY }, models: settled } } });
    config.batch.mockClear();
    expect(await lib.reconcileChannelAudio({ trigger: "boot" })).toBe(false);
    expect(config.batch).not.toHaveBeenCalled();
  });
});
