import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TASK-434 — /setup-api/tts.
 *
 * The route's job beyond reporting is to REFUSE. A ClawBox carries a `claw_`
 * portal token in `models.providers.openai` and ClawBox AI serves no speech, so
 * "ClawBox cloud" is an option the box cannot honour today; writing it into
 * `messages.tts.provider` anyway would leave a customer with a voice setting
 * that silently never speaks. That has to hold at the API, not only in the UI.
 */

const readConfigMock = vi.fn();
const configSetMock = vi.fn();
const ttsInventoryMock = vi.fn();
const accessMock = vi.fn();
/** `access` decides which paths this fake box HAS; `stat` only says what kind
 *  they are, because `executable()` refuses a directory that answers X_OK. */
const statMock = vi.fn();
const readStateMock = vi.fn();
const writeStateMock = vi.fn();
const preferenceMock = vi.fn();

vi.mock("@/lib/openclaw-config", () => ({
  readConfig: (...a: unknown[]) => readConfigMock(...a),
  runOpenclawConfigSet: (...a: unknown[]) => configSetMock(...a),
  openclawIsAbsent: () => false,
}));

const ffmpegMock = vi.fn();
vi.mock("@/lib/local-models", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/local-models")>();
  return {
    ...actual,
    buildTtsInventory: (...a: unknown[]) => ttsInventoryMock(...a),
    // Stubbed rather than measured: the real probe walks the PATH of whatever
    // machine runs the suite, which is not the subject of these tests.
    ffmpegPresent: (...a: unknown[]) => ffmpegMock(...a),
  };
});

vi.mock("@/lib/voice-output-store", () => ({
  readVoiceState: (...a: unknown[]) => readStateMock(...a),
  writeVoiceState: (...a: unknown[]) => writeStateMock(...a),
  readLocalVoice: async () => null,
  writeLocalVoice: vi.fn(async () => {}),
}));

const choiceSourceMock = vi.fn();
vi.mock("@/lib/config-store", () => ({
  get: (...a: unknown[]) => preferenceMock(...a),
  // The route records WHO chose the voice (src/lib/clawai-cloud-choice.ts), so
  // the automatic ClawBox AI cloud default never moves an owner's pin.
  set: (...a: unknown[]) => choiceSourceMock(...a),
}));

const wireMock = vi.fn();
vi.mock("@/lib/voice-local-wiring", () => ({
  wireLocalVoice: (...a: unknown[]) => wireMock(...a),
}));

const autoReplyMock = vi.fn();
const setAutoReplyMock = vi.fn();
const autoPlayAllMock = vi.fn();
const setAutoPlayAllMock = vi.fn();
const shortSpokenMock = vi.fn();
const setShortSpokenMock = vi.fn();
vi.mock("@/lib/voice-reply", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/voice-reply")>();
  return {
    ...actual,
    getVoiceAutoReply: (...a: unknown[]) => autoReplyMock(...a),
    setVoiceAutoReply: (...a: unknown[]) => setAutoReplyMock(...a),
    getVoiceAutoPlayAll: (...a: unknown[]) => autoPlayAllMock(...a),
    setVoiceAutoPlayAll: (...a: unknown[]) => setAutoPlayAllMock(...a),
    getVoiceShortSpoken: (...a: unknown[]) => shortSpokenMock(...a),
    setVoiceShortSpoken: (...a: unknown[]) => setShortSpokenMock(...a),
  };
});

const ownerMock = vi.fn();
vi.mock("@/lib/owner-session", () => ({ hasPersonSession: (...a: unknown[]) => ownerMock(...a) }));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      access: (...a: unknown[]) => accessMock(...a),
      stat: (...a: unknown[]) => statMock(...a),
    },
  };
});

const LOCAL = "tts-local-cli";

function config(over: Record<string, unknown> = {}) {
  return {
    // The v2 home: OpenClaw 2 keeps the speech block at top-level tts, and
    // the route writes to whichever home holds the providers.
    tts: { provider: LOCAL, providers: { [LOCAL]: { command: "/opt/clawbox-tts.sh" } } },
    models: { providers: { openai: { apiKey: "claw_84d065b" } } },
    ...over,
  };
}

const piperInstalled = [{
  id: "piper", name: "Piper", kind: "tts", runtime: "On-demand binary",
  installed: true, enabled: null, running: "on-demand", diskBytes: 1, memoryBytes: null,
  control: "none", detail: "Speaks on demand.",
}];

async function route() {
  return await import("@/app/setup-api/tts/route");
}

// A ClawBox AI plan change still being followed (src/lib/clawai-plan-follow.ts).
const planFollow = vi.hoisted(() => ({ pending: false, onRecord: vi.fn(async () => {}) }));
vi.mock("@/lib/clawai-plan-follow", () => ({
  clawaiPlanFollowPending: () => planFollow.pending,
  followClawaiPlanOnRecord: planFollow.onRecord,
}));

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://box/setup-api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetModules();
  readConfigMock.mockReset().mockResolvedValue(config());
  configSetMock.mockReset().mockResolvedValue(undefined);
  ttsInventoryMock.mockReset().mockResolvedValue(piperInstalled);
  ffmpegMock.mockReset().mockResolvedValue(true);
  accessMock.mockReset().mockResolvedValue(undefined);
  statMock.mockReset().mockResolvedValue({ isFile: () => true });
  readStateMock.mockReset().mockResolvedValue({ choice: "auto" });
  writeStateMock.mockReset().mockResolvedValue(undefined);
  preferenceMock.mockReset().mockResolvedValue(undefined);
  choiceSourceMock.mockReset().mockResolvedValue(undefined);
  wireMock.mockReset().mockResolvedValue({ ok: true, provider: {} });
  autoReplyMock.mockReset().mockResolvedValue(false);
  setAutoReplyMock.mockReset().mockResolvedValue(undefined);
  autoPlayAllMock.mockReset().mockResolvedValue(false);
  setAutoPlayAllMock.mockReset().mockResolvedValue(undefined);
  shortSpokenMock.mockReset().mockResolvedValue(false);
  setShortSpokenMock.mockReset().mockResolvedValue(undefined);
  ownerMock.mockReset().mockResolvedValue(true);
});

describe("spoken replies", () => {
  it("reports the switch with the status", async () => {
    const { GET } = await route();
    expect((await (await GET()).json()).autoReply).toBe(false);
    autoReplyMock.mockResolvedValue(true);
    expect((await (await GET()).json()).autoReply).toBe(true);
  });

  it("answers autoReply:false for a fresh box, through the real reader", async () => {
    // Not the mock's word for it: the module's own reader over a config store
    // that holds no `voice_auto_reply` at all (the owner's ruling of
    // 2026-09-15 — spoken replies are off until the owner turns them on).
    const real = await vi.importActual<typeof import("@/lib/voice-reply")>("@/lib/voice-reply");
    autoReplyMock.mockImplementation(real.getVoiceAutoReply);
    preferenceMock.mockResolvedValue(undefined);
    const { GET } = await route();
    expect((await (await GET()).json()).autoReply).toBe(false);
    expect(preferenceMock).toHaveBeenCalledWith(real.VOICE_AUTO_REPLY_KEY);
  });

  it("writes the gateway's inbound mode and the store when switched on, off when off", async () => {
    const { POST } = await route();
    let res = await POST(post({ action: "autoReply", enabled: false }));
    expect(res.status).toBe(200);
    expect(configSetMock).toHaveBeenCalledWith(["tts.auto", "off"]);
    expect(setAutoReplyMock).toHaveBeenCalledWith(false);
    configSetMock.mockClear();
    res = await POST(post({ action: "autoReply", enabled: true }));
    expect(res.status).toBe(200);
    expect(configSetMock).toHaveBeenCalledWith(["tts.auto", "inbound"]);
    expect(setAutoReplyMock).toHaveBeenCalledWith(true);
  });

  it("refuses the switch to the MCP bearer, and leaves the picker to anyone", async () => {
    ownerMock.mockResolvedValue(false);
    const { POST } = await route();
    const res = await POST(post({ action: "autoReply", enabled: false }));
    expect(res.status).toBe(403);
    expect(setAutoReplyMock).not.toHaveBeenCalled();
    expect((await POST(post({ action: "language", language: "de" }))).status).toBe(200);
  });

  it("keeps the store describing what the box does when the CLI write failed", async () => {
    configSetMock.mockRejectedValue(new Error("ConfigMutationConflictError"));
    const { POST } = await route();
    const res = await POST(post({ action: "autoReply", enabled: false }));
    expect(res.status).toBe(500);
    expect(setAutoReplyMock).not.toHaveBeenCalled();
  });
});

/**
 * "Auto-play every spoken reply": the switch under spoken replies that has the
 * desktop chat play a TYPED question's reply by itself too. The chat's alone —
 * nothing reaches the gateway — and the owner's alone, behind the same gate
 * as the switch it sits under.
 */
describe("auto-play every spoken reply", () => {
  it("reports autoPlayAll:false for a box that never stored it, through the real reader", async () => {
    const real = await vi.importActual<typeof import("@/lib/voice-reply")>("@/lib/voice-reply");
    autoPlayAllMock.mockImplementation(real.getVoiceAutoPlayAll);
    preferenceMock.mockResolvedValue(undefined);
    const { GET } = await route();
    const body = await (await GET()).json();
    expect(body.autoPlayAll).toBe(false);
    expect(preferenceMock).toHaveBeenCalledWith(real.VOICE_AUTO_PLAY_ALL_KEY);
  });

  it("reports the stored position beside the spoken-replies switch", async () => {
    autoReplyMock.mockResolvedValue(true);
    autoPlayAllMock.mockResolvedValue(true);
    const { GET } = await route();
    const body = await (await GET()).json();
    expect(body).toMatchObject({ autoReply: true, autoPlayAll: true });
  });

  it("stores the owner's answer and answers the new status, writing nothing to the gateway", async () => {
    const { POST } = await route();
    autoPlayAllMock.mockResolvedValue(true);
    let res = await POST(post({ action: "autoPlayAll", enabled: true }));
    expect(res.status).toBe(200);
    expect(setAutoPlayAllMock).toHaveBeenCalledWith(true);
    expect((await res.json()).autoPlayAll).toBe(true);

    autoPlayAllMock.mockResolvedValue(false);
    res = await POST(post({ action: "autoPlayAll", enabled: false }));
    expect(res.status).toBe(200);
    expect(setAutoPlayAllMock).toHaveBeenLastCalledWith(false);
    expect((await res.json()).autoPlayAll).toBe(false);
    // A channel's typed question still gets a typed answer: `tts.auto` and the
    // spoken-replies switch are not this action's to touch.
    expect(configSetMock).not.toHaveBeenCalled();
    expect(setAutoReplyMock).not.toHaveBeenCalled();
  });

  it("refuses a body that does not say on or off", async () => {
    const { POST } = await route();
    for (const enabled of ["true", 1, null, undefined]) {
      const res = await POST(post({ action: "autoPlayAll", enabled }));
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("bad_request");
    }
    expect(setAutoPlayAllMock).not.toHaveBeenCalled();
  });

  it("refuses the switch to the MCP bearer", async () => {
    ownerMock.mockResolvedValue(false);
    const { POST } = await route();
    const res = await POST(post({ action: "autoPlayAll", enabled: true }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("owner_only");
    expect(setAutoPlayAllMock).not.toHaveBeenCalled();
  });

  it.each(["autoReply", "autoPlayAll", "shortSpoken"] as const)("refuses %s from another site's page, even with the owner's cookie", async (action) => {
    const { POST } = await route();
    const res = await POST(post({ action, enabled: true }, { host: "box", origin: "http://evil.example" }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("cross_origin");
    expect(setAutoPlayAllMock).not.toHaveBeenCalled();
    expect(setAutoReplyMock).not.toHaveBeenCalled();
    expect(setShortSpokenMock).not.toHaveBeenCalled();
    expect(configSetMock).not.toHaveBeenCalled();
  });

  it("takes the switch from the box's own page", async () => {
    const { POST } = await route();
    const res = await POST(post({ action: "autoPlayAll", enabled: true }, { host: "box", origin: "http://box" }));
    expect(res.status).toBe(200);
    expect(setAutoPlayAllMock).toHaveBeenCalledWith(true);
  });

  it("answers a store that will not take the write with the route's own refusal", async () => {
    setAutoPlayAllMock.mockRejectedValue(new Error("EROFS"));
    const { POST } = await route();
    const res = await POST(post({ action: "autoPlayAll", enabled: true }));
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe("cannot_change");
  });
});

/**
 * "Short spoken answers": the third switch, which has the desktop chat speak
 * only a reply's short answer while the written reply stays whole. The chat's
 * alone like auto-play — nothing reaches the gateway — and the owner's alone,
 * behind the same gate.
 */
describe("short spoken answers", () => {
  it("reports shortSpoken:false for a box that never stored it, through the real reader", async () => {
    const real = await vi.importActual<typeof import("@/lib/voice-reply")>("@/lib/voice-reply");
    shortSpokenMock.mockImplementation(real.getVoiceShortSpoken);
    preferenceMock.mockResolvedValue(undefined);
    const { GET } = await route();
    const body = await (await GET()).json();
    expect(body.shortSpoken).toBe(false);
    expect(preferenceMock).toHaveBeenCalledWith(real.VOICE_SHORT_SPOKEN_KEY);
    expect(real.VOICE_SHORT_SPOKEN_KEY).toBe("voice_short_spoken");
  });

  it("reads only a stored true as on", async () => {
    const real = await vi.importActual<typeof import("@/lib/voice-reply")>("@/lib/voice-reply");
    shortSpokenMock.mockImplementation(real.getVoiceShortSpoken);
    const { GET } = await route();
    for (const stored of [false, "true", 1, null]) {
      preferenceMock.mockResolvedValue(stored);
      expect((await (await GET()).json()).shortSpoken).toBe(false);
    }
    preferenceMock.mockResolvedValue(true);
    expect((await (await GET()).json()).shortSpoken).toBe(true);
  });

  it("reports the stored position beside the other two switches", async () => {
    autoReplyMock.mockResolvedValue(true);
    autoPlayAllMock.mockResolvedValue(false);
    shortSpokenMock.mockResolvedValue(true);
    const { GET } = await route();
    const body = await (await GET()).json();
    expect(body).toMatchObject({ autoReply: true, autoPlayAll: false, shortSpoken: true });
  });

  it("stores the owner's answer and a later GET reflects it, writing nothing to the gateway", async () => {
    // A store of its own behind the mocked pair, so the GET after the POST
    // reads what the POST wrote rather than what the test says it wrote.
    let stored = false;
    setShortSpokenMock.mockImplementation(async (enabled: boolean) => {
      stored = enabled;
    });
    shortSpokenMock.mockImplementation(async () => stored);
    const { GET, POST } = await route();

    let res = await POST(post({ action: "shortSpoken", enabled: true }));
    expect(res.status).toBe(200);
    expect(setShortSpokenMock).toHaveBeenCalledWith(true);
    expect((await res.json()).shortSpoken).toBe(true);
    expect((await (await GET()).json()).shortSpoken).toBe(true);

    res = await POST(post({ action: "shortSpoken", enabled: false }));
    expect(res.status).toBe(200);
    expect(setShortSpokenMock).toHaveBeenLastCalledWith(false);
    expect((await res.json()).shortSpoken).toBe(false);
    expect((await (await GET()).json()).shortSpoken).toBe(false);
    // A channel's spoken reply is the gateway's: `tts.auto` and the other two
    // switches are not this action's to touch.
    expect(configSetMock).not.toHaveBeenCalled();
    expect(setAutoReplyMock).not.toHaveBeenCalled();
    expect(setAutoPlayAllMock).not.toHaveBeenCalled();
  });

  it("refuses a body that does not say on or off", async () => {
    const { POST } = await route();
    for (const enabled of ["true", 1, null, undefined]) {
      const res = await POST(post({ action: "shortSpoken", enabled }));
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("bad_request");
    }
    expect(setShortSpokenMock).not.toHaveBeenCalled();
  });

  it("refuses the switch to the MCP bearer", async () => {
    ownerMock.mockResolvedValue(false);
    const { POST } = await route();
    const res = await POST(post({ action: "shortSpoken", enabled: true }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("owner_only");
    expect(setShortSpokenMock).not.toHaveBeenCalled();
  });

  it("takes the switch from the box's own page", async () => {
    const { POST } = await route();
    const res = await POST(post({ action: "shortSpoken", enabled: true }, { host: "box", origin: "http://box" }));
    expect(res.status).toBe(200);
    expect(setShortSpokenMock).toHaveBeenCalledWith(true);
  });

  it("answers a store that will not take the write with the route's own refusal", async () => {
    setShortSpokenMock.mockRejectedValue(new Error("EROFS"));
    const { POST } = await route();
    const res = await POST(post({ action: "shortSpoken", enabled: true }));
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe("cannot_change");
  });
});

describe("whether a channel reply can be spoken by the box itself", () => {
  it("says a voice note is ready when the box can encode one", async () => {
    const { GET } = await route();
    expect((await (await GET()).json()).channels).toEqual({ supportedOnEdition: true, voiceNoteReady: true });
  });

  it("says it is not, without claiming the edition has no channels", async () => {
    // The two facts have different fixes: an edition with no gateway can never
    // speak on a channel, while this box only needs ffmpeg. Collapsing them
    // would send the owner looking for the wrong thing — and the state it
    // reports is the one nothing else on the box can see: every Telegram voice
    // note is answered in the CLOUD voice until ffmpeg is there.
    ffmpegMock.mockResolvedValue(false);
    const { GET } = await route();
    const body = await (await GET()).json();
    expect(body.channels.supportedOnEdition).toBe(true);
    expect(body.channels.voiceNoteReady).toBe(false);
    // And it says nothing about the engines: the box's own voice is fine, it
    // simply cannot be packed into a voice note.
    expect(body.engines.some((e: { id: string; configured: boolean }) => e.id === "local" && e.configured)).toBe(true);
  });
});

describe("GET /setup-api/tts", () => {
  it("reports the engines and never caches them", async () => {
    const { GET } = await route();
    const res = await GET();
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.engines.map((e: { id: string }) => e.id)).toEqual(["local", "cloud"]);
    expect(body.activeProviderId).toBe(LOCAL);
  });

  it("never runs the openclaw CLI just to render the panel", async () => {
    const { GET } = await route();
    await GET();
    // The CLI costs 8-12s of cold start on an Orin. A panel that pays it on
    // open reads as a broken box.
    expect(configSetMock).not.toHaveBeenCalled();
  });

  it("calls the local voice unavailable when its command is gone, however healthy the voices look", async () => {
    accessMock.mockRejectedValue(new Error("ENOENT"));
    const { GET } = await route();
    const body = await (await GET()).json();
    expect(body.engines.find((e: { id: string }) => e.id === "local").configured).toBe(false);
  });

  it("shows the sample in the desktop's language until the owner picks one", async () => {
    // A German owner opening the tab should read a German sample, not set the
    // language twice — and the UI language is read, never written into the
    // voice state, so changing it later still moves the sample along.
    preferenceMock.mockResolvedValue("de");
    const { GET } = await route();
    expect((await (await GET()).json()).language).toBe("de");
    expect(preferenceMock).toHaveBeenCalledWith("pref:ui_language");
    expect(writeStateMock).not.toHaveBeenCalled();

    readStateMock.mockResolvedValue({ choice: "auto", language: "fr" });
    expect((await (await GET()).json()).language).toBe("fr");
  });

  it("falls back to English when the desktop's language is not one the sample comes in", async () => {
    preferenceMock.mockResolvedValue("tlh");
    const { GET } = await route();
    expect((await (await GET()).json()).language).toBe("en");
  });
});

describe("POST /setup-api/tts — select", () => {
  it("writes the provider the choice resolves to", async () => {
    readConfigMock.mockResolvedValue(config({
      tts: { provider: "openai", providers: { [LOCAL]: { command: "/opt/clawbox-tts.sh" } } },
    }));
    const { POST } = await route();
    const res = await POST(post({ action: "select", choice: "local" }));
    expect(res.status).toBe(200);
    expect(configSetMock).toHaveBeenCalledWith(["tts.provider", LOCAL]);
    // The choice, and nothing the owner did not pick: no backfilled language.
    expect(writeStateMock.mock.calls[0][0]).toEqual({ choice: "local" });
  });

  it("wires an installed voice the config never named, then selects it", async () => {
    // The shipped state: Kokoro installed (stamp, unit), the cloud voice
    // selected, and NO tts-local-cli entry — install.sh preserved the
    // selection and returned before defining the provider. The pick is the
    // moment to write the entry, not a refusal to read.
    const unwired = config({ tts: { provider: "openai", providers: { openai: { model: "gpt-4o-mini-tts" } } } });
    const wired = config({ tts: { provider: "openai", providers: { openai: {}, [LOCAL]: { command: "/opt/clawbox-tts.sh" } } } });
    readConfigMock
      .mockResolvedValueOnce(unwired)   // the first probe
      .mockResolvedValueOnce(unwired)   // ttsConfigHome() inside the repair
      .mockResolvedValue(wired);        // the re-probe and the answer
    const { POST } = await route();
    const res = await POST(post({ action: "select", choice: "local" }));
    expect(res.status).toBe(200);
    expect(wireMock).toHaveBeenCalledWith("tts");
    expect(configSetMock).toHaveBeenCalledWith(["tts.provider", LOCAL]);
    const body = await res.json();
    expect(body.fallback).toBeUndefined();
    expect(writeStateMock.mock.calls[0][0]).toEqual({ choice: "local" });
  });

  it("settles on the default, and says so, when the box has no voice of its own", async () => {
    // No engine to install or wire from here: the pick cannot be honoured.
    // The owner asked for the default to stay instead of a red error.
    ttsInventoryMock.mockResolvedValue([]);
    readConfigMock.mockResolvedValue(config({
      tts: { provider: "openai", providers: { openai: { model: "gpt-4o-mini-tts" } } },
      models: { providers: { openai: { apiKey: "sk-live-abc" } } },
    }));
    const { POST } = await route();
    const res = await POST(post({ action: "select", choice: "local" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fallback).toEqual({ requested: "local", reason: "not_installed" });
    expect(body.choice).toBe("auto");
    expect(wireMock).not.toHaveBeenCalled();
    // Already on the provider Auto resolves to: nothing to write but the choice.
    expect(configSetMock).not.toHaveBeenCalled();
    expect(writeStateMock.mock.calls[0][0]).toEqual({ choice: "auto" });
  });

  it("names the wiring as the reason when the entry could not be written", async () => {
    wireMock.mockResolvedValue({ ok: false, reason: "write_failed" });
    readConfigMock.mockResolvedValue(config({
      tts: { provider: "openai", providers: { openai: { model: "gpt-4o-mini-tts" } } },
      models: { providers: { openai: { apiKey: "sk-live-abc" } } },
    }));
    const { POST } = await route();
    const res = await POST(post({ action: "select", choice: "local" }));
    expect(res.status).toBe(200);
    expect((await res.json()).fallback).toEqual({ requested: "local", reason: "not_wired" });
  });

  it("refuses a cloud voice the box cannot use, and changes nothing", async () => {
    const { POST } = await route();
    const res = await POST(post({ action: "select", choice: "cloud" }));
    expect(res.status).toBe(409);
    // The sentence for whoever reads the JSON, the code for the panel to translate.
    expect(await res.json()).toEqual({ error: "That voice is not available on this box.", code: "not_available" });
    expect(configSetMock).not.toHaveBeenCalled();
    expect(writeStateMock).not.toHaveBeenCalled();
  });

  it("selects the cloud voice once the box really has one", async () => {
    readConfigMock.mockResolvedValue(config({
      models: { providers: { openai: { apiKey: "sk-live-abc" } } },
    }));
    const { POST } = await route();
    const res = await POST(post({ action: "select", choice: "cloud" }));
    expect(res.status).toBe(200);
    expect(configSetMock).toHaveBeenCalledWith(["tts.provider", "openai"]);
  });

  it("does not rewrite the config when the box is already on that provider", async () => {
    const { POST } = await route();
    await POST(post({ action: "select", choice: "local" }));
    expect(configSetMock).not.toHaveBeenCalled();
    expect(writeStateMock.mock.calls[0][0].choice).toBe("local");
  });

  it("keeps the customer's choice out of the file when the config write failed", async () => {
    configSetMock.mockRejectedValue(new Error("ConfigMutationConflictError"));
    readConfigMock.mockResolvedValue(config({
      tts: { provider: "openai", providers: { [LOCAL]: { command: "/opt/clawbox-tts.sh" } } },
    }));
    const { POST } = await route();
    const res = await POST(post({ action: "select", choice: "local" }));
    expect(res.status).toBe(500);
    expect(writeStateMock).not.toHaveBeenCalled();
  });

  it("does not lose a language picked while the selection's CLI write was running", async () => {
    // Both are read-modify-writes of the same state file. The selection reads
    // the state before its 8-12 s CLI call; unserialised, it would write that
    // stale copy back over the language that landed in the meantime.
    let stored: Record<string, unknown> = { choice: "auto" };
    readStateMock.mockImplementation(async () => ({ ...stored }));
    writeStateMock.mockImplementation(async (next: Record<string, unknown>) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      stored = next;
    });
    readConfigMock.mockResolvedValue(config({
      tts: { provider: "openai", providers: { [LOCAL]: { command: "/opt/clawbox-tts.sh" } } },
    }));
    configSetMock.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 30)));
    const { POST } = await route();
    const [select, language] = await Promise.all([
      POST(post({ action: "select", choice: "local" })),
      POST(post({ action: "language", language: "de" })),
    ]);
    expect(select.status).toBe(200);
    expect(language.status).toBe(200);
    expect(stored).toEqual({ choice: "local", language: "de" });
  });

  it("rejects an invented choice", async () => {
    const { POST } = await route();
    expect((await POST(post({ action: "select", choice: "cheapest" }))).status).toBe(400);
    expect((await POST(post({ action: "teleport" }))).status).toBe(400);
    // The Check button is gone from the panel, and so is the action behind it.
    expect((await POST(post({ action: "check" }))).status).toBe(400);
  });
});

/**
 * WHO DECIDED, and when it is written down.
 *
 * The owner pinning the box's own voice is the only thing that stops the
 * ClawBox AI cloud default from moving it at the next boot. The pin used to be
 * written AFTER the provider transition, by a helper that swallowed its own
 * failure — so on a box whose `tts_choice_source` already read `auto` (anyone
 * who has ever selected Auto or the cloud voice), a successful local pick whose
 * pin did not land came out still reading `auto`. `ownerChoiceFrom("auto", true)`
 * answers false, so the next boot's applier called `promoteTts()` and put the
 * cloud voice back — silently undoing a decision the owner had been told was
 * saved. The stored `local` choice only grandfathers a box whose key is ABSENT,
 * so it does not catch this one.
 *
 * So the pin is part of the selection boundary: written first, undone on every
 * way out that is not a completed selection, and a store that will not take it
 * is a refused selection rather than a quiet one.
 */
describe("POST /setup-api/tts — the owner pin is part of the selection", () => {
  /** A box on the cloud voice, with its own voice installed and wired. */
  function onCloud() {
    readConfigMock.mockResolvedValue(config({
      tts: { provider: "openai", providers: { [LOCAL]: { command: "/opt/clawbox-tts.sh" } } },
    }));
  }

  /** Every `set` this route made, as [key, value] pairs. */
  function writes(): [string, unknown][] {
    return choiceSourceMock.mock.calls as [string, unknown][];
  }

  it("records the pin before it touches the provider", async () => {
    onCloud();
    const { POST } = await route();
    expect((await POST(post({ action: "select", choice: "local" }))).status).toBe(200);
    expect(writes()).toEqual([["tts_choice_source", "owner"]]);
    // Written first, so no failure between here and the end can leave the pick
    // standing without the mark that protects it.
    expect(choiceSourceMock.mock.invocationCallOrder[0])
      .toBeLessThan(configSetMock.mock.invocationCallOrder[0]);
  });

  it("undoes the pin when the provider write failed", async () => {
    onCloud();
    configSetMock.mockRejectedValue(new Error("ConfigMutationConflictError"));
    const { POST } = await route();
    expect((await POST(post({ action: "select", choice: "local" }))).status).toBe(500);
    // Back to absent, which is what the key held before the attempt — NOT
    // `auto`, which is itself a decision.
    expect(writes()).toEqual([["tts_choice_source", "owner"], ["tts_choice_source", undefined]]);
    expect(writeStateMock).not.toHaveBeenCalled();
  });

  it("undoes the pin to exactly what the key held, not to a fresh default", async () => {
    onCloud();
    preferenceMock.mockResolvedValue("auto");
    writeStateMock.mockRejectedValue(new Error("EROFS: read-only file system"));
    const { POST } = await route();
    expect((await POST(post({ action: "select", choice: "local" }))).status).toBe(500);
    expect(writes()).toEqual([["tts_choice_source", "owner"], ["tts_choice_source", "auto"]]);
  });

  it("refuses the selection outright when the pin cannot be stored", async () => {
    onCloud();
    choiceSourceMock.mockRejectedValue(new Error("EROFS: read-only file system"));
    const { POST } = await route();
    const res = await POST(post({ action: "select", choice: "local" }));
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe("cannot_change");
    // A pick the boot applier would undo is not a pick that was saved, so
    // nothing moves rather than reporting a change that will not survive.
    expect(configSetMock).not.toHaveBeenCalled();
    expect(writeStateMock).not.toHaveBeenCalled();
  });

  it("releases the capability to the default only once the cloud selection landed", async () => {
    readConfigMock.mockResolvedValue(config({ models: { providers: { openai: { apiKey: "sk-live-abc" } } } }));
    const { POST } = await route();
    expect((await POST(post({ action: "select", choice: "cloud" }))).status).toBe(200);
    expect(writes()).toEqual([["tts_choice_source", "auto"]]);
    // The opposite order from the pin: a clear that lands over a write that did
    // not is the one that loses a decision.
    expect(choiceSourceMock.mock.invocationCallOrder[0])
      .toBeGreaterThan(configSetMock.mock.invocationCallOrder[0]);
  });

  it("leaves the pin alone when the pick could not be honoured at all", async () => {
    // No engine to select: the box settles on Auto, and Auto is the default's
    // to move — so this records a release, never a pin.
    ttsInventoryMock.mockResolvedValue([]);
    readConfigMock.mockResolvedValue(config({
      tts: { provider: "openai", providers: { openai: { model: "gpt-4o-mini-tts" } } },
      models: { providers: { openai: { apiKey: "sk-live-abc" } } },
    }));
    const { POST } = await route();
    expect((await POST(post({ action: "select", choice: "local" }))).status).toBe(200);
    expect(writes()).toEqual([["tts_choice_source", "auto"]]);
  });
});

describe("POST /setup-api/tts — failure boundary", () => {
  it("answers with a message the panel can show when the box cannot be written to", async () => {
    // A read-only data dir or a full disk must not surface as a framework error
    // page: the panel would fall back to its own generic line and the box would
    // log nothing worth reading.
    writeStateMock.mockRejectedValue(new Error("EROFS: read-only file system"));
    const { POST } = await route();
    const res = await POST(post({ action: "select", choice: "local" }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Could not change the voice on this box.", code: "cannot_change" });
  });
});

describe("POST /setup-api/tts — voice and language", () => {
  it("saves the on-device voice where the local script reads it, and refuses one it does not have", async () => {
    const { writeLocalVoice } = await import("@/lib/voice-output-store");
    const { POST } = await route();
    const ok = await POST(post({ action: "voice", engine: "local", voice: "bm_george" }));
    expect(ok.status).toBe(200);
    expect(writeLocalVoice).toHaveBeenCalledWith("bm_george");
    expect(configSetMock).not.toHaveBeenCalled();
    const bad = await POST(post({ action: "voice", engine: "local", voice: "hal9000" }));
    expect(bad.status).toBe(400);
  });

  it("writes the cloud voice into the provider OpenClaw speaks with", async () => {
    readConfigMock.mockResolvedValue(config({
      tts: { provider: "openai", providers: { [LOCAL]: { command: "/opt/clawbox-tts.sh" }, openai: { apiKey: "claw_84d065b", baseUrl: "https://clawbox.com/api/ai" } } },
    }));
    const { POST } = await route();
    const res = await POST(post({ action: "voice", engine: "cloud", voice: "nova" }));
    expect(res.status).toBe(200);
    expect(configSetMock).toHaveBeenCalledWith(["tts.providers.openai.voice", "nova"]);
  });

  it("refuses a cloud voice the configured model cannot speak, and says which model", async () => {
    // tts-1 has no ballad or verse; saving one would be a voice that never speaks.
    readConfigMock.mockResolvedValue(config({
      tts: { provider: "openai", providers: { [LOCAL]: { command: "/opt/clawbox-tts.sh" }, openai: { apiKey: "claw_84d065b", baseUrl: "https://clawbox.com/api/ai", model: "tts-1" } } },
    }));
    const { POST } = await route();
    const bad = await POST(post({ action: "voice", engine: "cloud", voice: "verse" }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/tts-1/);
    expect(configSetMock).not.toHaveBeenCalled();
    const ok = await POST(post({ action: "voice", engine: "cloud", voice: "nova" }));
    expect(ok.status).toBe(200);
    expect(configSetMock).toHaveBeenCalledWith(["tts.providers.openai.voice", "nova"]);
  });

  it("refuses a cloud voice for a box that has no cloud voice", async () => {
    const { POST } = await route();
    const res = await POST(post({ action: "voice", engine: "cloud", voice: "nova" }));
    expect(res.status).toBe(409);
    expect(configSetMock).not.toHaveBeenCalled();
  });

  it("keeps the sample language beside the choice, and only one it offers", async () => {
    const { POST } = await route();
    const res = await POST(post({ action: "language", language: "de" }));
    expect(res.status).toBe(200);
    expect(writeStateMock).toHaveBeenCalledWith({ choice: "auto", language: "de" });
    expect((await POST(post({ action: "language", language: "tlh" }))).status).toBe(400);
  });

  it("reports the voice each engine speaks with", async () => {
    const { GET } = await route();
    const data = await (await GET()).json();
    expect(data.voice).toEqual({ local: "af_heart", cloud: "alloy" });
    expect(data.language).toBe("en");
  });

  it("reports the cloud model, so the panel offers only the voices that model has", async () => {
    const { GET } = await route();
    expect((await (await GET()).json()).cloudModel).toBeNull();
    readConfigMock.mockResolvedValue(config({
      tts: { provider: LOCAL, providers: { [LOCAL]: { command: "/opt/clawbox-tts.sh" }, openai: { model: "tts-1-hd" } } },
    }));
    expect((await (await GET()).json()).cloudModel).toBe("tts-1-hd");
  });
});

describe("a ClawBox AI plan that moved while the box runs", () => {
  it("says the box is still following it, so the panel says so and looks again", async () => {
    planFollow.pending = true;
    try {
      const { GET } = await route();
      const body = await (await GET()).json();
      expect(body.cloudPending).toBe(true);
      // The fact the panel shows beside it is still the box's own reading.
      expect(body.engines.find((e: { id: string }) => e.id === "cloud").configured).toBe(false);
    } finally {
      planFollow.pending = false;
    }
  });

  it("says nothing when no change is being followed", async () => {
    const { GET } = await route();
    expect((await (await GET()).json()).cloudPending).toBeUndefined();
  });

  it("reads the cloud voice as available the moment the gateway's boot script has armed it — no restart of the web server", async () => {
    const { GET } = await route();
    expect((await (await GET()).json()).engines.find((e: { id: string }) => e.id === "cloud").configured).toBe(false);
    readConfigMock.mockResolvedValue(config({
      tts: {
        provider: LOCAL,
        providers: {
          [LOCAL]: { command: "/opt/clawbox-tts.sh" },
          openai: { apiKey: "claw_84d065b", baseUrl: "https://proxy.example/api/ai", model: "gpt-4o-mini-tts", clawboxManaged: true },
        },
      },
    }));
    expect((await (await GET()).json()).engines.find((e: { id: string }) => e.id === "cloud").configured).toBe(true);
  });

  /** What the boot script wrote while the plan was Max, at the proxy every box shares. */
  const armedAtOurProxy = () => config({
    tts: {
      provider: "openai",
      providers: {
        [LOCAL]: { command: "/opt/clawbox-tts.sh" },
        openai: { apiKey: "claw_84d065b", baseUrl: "https://clawbox.com/api/ai", model: "gpt-4o-mini-tts", clawboxManaged: true },
      },
    },
  });
  const planOnRecord = (plan: string | undefined) =>
    preferenceMock.mockImplementation(async (key: string) => (key === "clawai_plan_tier" ? plan : undefined));
  const cloud = (body: { engines: { id: string; configured: boolean }[] }) => body.engines.find((e) => e.id === "cloud");

  it("takes the cloud voice away the moment a plan without it is on record — before the gateway restarts, and never as 'setting up'", async () => {
    readConfigMock.mockResolvedValue(armedAtOurProxy());
    const { GET } = await route();
    // Not on record yet: not knowing is not a downgrade.
    expect(cloud(await (await GET()).json())?.configured).toBe(true);
    planOnRecord("free");
    const body = await (await GET()).json();
    expect(cloud(body)?.configured).toBe(false);
    expect(body.cloudPending).toBeUndefined();
    // And the gateway's own file is brought round to it.
    expect(planFollow.onRecord).toHaveBeenCalled();
  });

  it("keeps it on a Max plan, and hands it back when the plan on record is Max again", async () => {
    readConfigMock.mockResolvedValue(armedAtOurProxy());
    planOnRecord("flash");
    const { GET } = await route();
    expect(cloud(await (await GET()).json())?.configured).toBe(false);
    planOnRecord("pro");
    expect(cloud(await (await GET()).json())?.configured).toBe(true);
  });

  it("never hides an owner's own cloud voice, whatever the ClawBox AI plan", async () => {
    readConfigMock.mockResolvedValue(config({
      tts: { provider: "openai", providers: { [LOCAL]: { command: "/opt/clawbox-tts.sh" }, openai: { apiKey: "sk-owners-own" } } },
    }));
    planOnRecord("free");
    const { GET } = await route();
    expect(cloud(await (await GET()).json())?.configured).toBe(true);
  });
});

