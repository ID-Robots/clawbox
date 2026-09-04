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

vi.mock("@/lib/config-store", () => ({
  get: (...a: unknown[]) => preferenceMock(...a),
}));

const wireMock = vi.fn();
vi.mock("@/lib/voice-local-wiring", () => ({
  wireLocalVoice: (...a: unknown[]) => wireMock(...a),
}));

const autoReplyMock = vi.fn();
const setAutoReplyMock = vi.fn();
vi.mock("@/lib/voice-reply", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/voice-reply")>();
  return {
    ...actual,
    getVoiceAutoReply: (...a: unknown[]) => autoReplyMock(...a),
    setVoiceAutoReply: (...a: unknown[]) => setAutoReplyMock(...a),
  };
});

const ownerMock = vi.fn();
vi.mock("@/lib/owner-session", () => ({ hasOwnerSession: (...a: unknown[]) => ownerMock(...a) }));

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

function post(body: unknown) {
  return new Request("http://box/setup-api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
  wireMock.mockReset().mockResolvedValue({ ok: true, provider: {} });
  autoReplyMock.mockReset().mockResolvedValue(true);
  setAutoReplyMock.mockReset().mockResolvedValue(undefined);
  ownerMock.mockReset().mockResolvedValue(true);
});

describe("spoken replies", () => {
  it("reports the switch with the status, on by default", async () => {
    const { GET } = await route();
    expect((await (await GET()).json()).autoReply).toBe(true);
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
