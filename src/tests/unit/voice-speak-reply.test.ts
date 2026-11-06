/**
 * `speakReply` — how this box actually speaks a reply.
 *
 * It used to be the body of POST /setup-api/tts/speak and moved into
 * src/lib/voice-speak.ts when a second caller needed exactly it: the coding
 * agent's `generate_audio`, which writes a clip into a run's project. That is
 * the whole point of the extraction, so what is pinned here is that the two
 * callers cannot drift — the engines the status card judges usable, tried in
 * the order the Voice tab set, on whichever harness this box runs.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const readConfigMock = vi.hoisted(() => vi.fn());
const inventoryMock = vi.hoisted(() => vi.fn());
const stateMock = vi.hoisted(() => vi.fn());
const harnessMock = vi.hoisted(() => vi.fn());
const hermesSpeakMock = vi.hoisted(() => vi.fn());
const compressMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/openclaw-config", () => ({
  openclawIsAbsent: () => false,
  readConfig: (...a: unknown[]) => readConfigMock(...a),
}));
vi.mock("@/lib/local-models", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/local-models")>();
  return { ...actual, buildTtsInventory: (...a: unknown[]) => inventoryMock(...a) };
});
vi.mock("@/lib/voice-output-store", () => ({
  readVoiceState: (...a: unknown[]) => stateMock(...a),
  readLocalVoice: async () => null,
}));
vi.mock("@/lib/harness", () => ({ getActiveHarness: (...a: unknown[]) => harnessMock(...a) }));
vi.mock("@/lib/hermes-tts", () => ({ speakWithHermes: (...a: unknown[]) => hermesSpeakMock(...a) }));
vi.mock("@/lib/tts-compress", () => ({ compressSpeech: (...a: unknown[]) => compressMock(...a) }));
// data/config.json — only the ClawBox AI plan on record is read through it here.
const storeMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/config-store", () => ({ get: (...a: unknown[]) => storeMock(...a), set: vi.fn() }));
// The local engine's script is "present" as far as the probe can tell.
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, promises: { ...actual.promises, access: async () => undefined } };
});

import { speakReply } from "@/lib/voice-speak";

const LOCAL = "tts-local-cli";

function config() {
  return {
    tts: { provider: "openai", providers: { [LOCAL]: { command: "/opt/clawbox-tts.sh" }, openai: { model: "gpt-4o-mini-tts" } } },
    models: { providers: { openai: { apiKey: "sk-live-abc" } } },
  };
}

/** A speaker that answers audio, and remembers that it was asked. */
function speaks(id: string, order: string[]) {
  return async () => {
    order.push(id);
    return new Response(new Uint8Array(4096), { headers: { "Content-Type": "audio/wav" } });
  };
}

/** A speaker that cannot, so the chain falls through to the other one. */
function cannot(id: string, order: string[]) {
  return async () => {
    order.push(id);
    return new Response(JSON.stringify({ error: "no", code: "local_failed" }), { status: 502 });
  };
}

beforeEach(() => {
  readConfigMock.mockReset().mockResolvedValue(config());
  inventoryMock.mockReset().mockResolvedValue([{ id: "kokoro", name: "Kokoro", kind: "tts", installed: true }]);
  stateMock.mockReset().mockResolvedValue({ choice: "auto" });
  harnessMock.mockReset().mockResolvedValue("openclaw");
  hermesSpeakMock.mockReset();
  compressMock.mockReset();
  storeMock.mockReset().mockResolvedValue(undefined);
});

describe("speakReply", () => {
  it("tries the engine the Voice tab put first, and names it on the answer", async () => {
    stateMock.mockResolvedValue({ choice: "local" });
    const order: string[] = [];
    const res = await speakReply("Hello", { local: speaks("local", order), cloud: speaks("cloud", order) });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-ClawBox-Voice-Engine")).toBe("local");
    expect(order).toEqual(["local"]);
  });

  it("falls through to the other engine, so a cold Kokoro still answers", async () => {
    stateMock.mockResolvedValue({ choice: "local" });
    const order: string[] = [];
    const res = await speakReply("Hello", { local: cannot("local", order), cloud: speaks("cloud", order) });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-ClawBox-Voice-Engine")).toBe("cloud");
    expect(order).toEqual(["local", "cloud"]);
  });

  it("puts the cloud first under Auto — both engines are configured on this box", async () => {
    const order: string[] = [];
    await speakReply("Hello", { local: speaks("local", order), cloud: speaks("cloud", order) });
    expect(order).toEqual(["cloud"]);
  });

  it("speaks from the box once a plan without the cloud voice is on record, before the gateway has withdrawn it", async () => {
    // What gateway-pre-start.sh wrote while the plan was Max.
    readConfigMock.mockResolvedValue({
      tts: {
        provider: "openai",
        providers: {
          [LOCAL]: { command: "/opt/clawbox-tts.sh" },
          openai: { apiKey: "claw_example_not_a_real_token", baseUrl: "https://clawbox.com/api/ai", model: "gpt-4o-mini-tts", clawboxManaged: true },
        },
      },
      models: { providers: { deepseek: { apiKey: "claw_example_not_a_real_token" } } },
    });
    let order: string[] = [];
    await speakReply("Hello", { local: speaks("local", order), cloud: speaks("cloud", order) });
    expect(order).toEqual(["cloud"]);
    storeMock.mockImplementation(async (key: string) => (key === "clawai_plan_tier" ? "free" : undefined));
    order = [];
    const res = await speakReply("Hello", { local: speaks("local", order), cloud: speaks("cloud", order) });
    expect(res.headers.get("X-ClawBox-Voice-Engine")).toBe("local");
    expect(order).toEqual(["local"]);
  });

  it("hands a Hermes box to its own speech route, whatever it answers with", async () => {
    // Hermes resolves the same tts.provider the Voice tab wrote, and its reply
    // is not necessarily a WAV — so the mime it names is the one relayed.
    harnessMock.mockResolvedValue("hermes");
    hermesSpeakMock.mockResolvedValue({ ok: true, audio: new Uint8Array(2048), mime: "audio/mpeg" });
    const res = await speakReply("Hello");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(hermesSpeakMock).toHaveBeenCalledWith("Hello");
  });

  it("relays a Hermes refusal with its own code, rather than inventing one", async () => {
    harnessMock.mockResolvedValue("hermes");
    hermesSpeakMock.mockResolvedValue({ ok: false, code: "local_memory", status: 502, reason: "short of memory" });
    const res = await speakReply("Hello");
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.code).toBe("local_memory");
    expect(body.reason).toBe("short of memory");
  });

  it("answers a refusal rather than throwing when the box cannot be read at all", async () => {
    // Its callers are a route and a file write; neither may see an exception.
    readConfigMock.mockRejectedValue(new Error("config gone"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await speakReply("Hello");
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe("failed");
    warn.mockRestore();
  });
});

/**
 * The chat's spoken reply is COMPRESSED (`tts/speak` passes the format the
 * browser can play); the coding agent's `generate_audio` names no format and
 * gets what the engine made, exactly as before — it checks the bytes against
 * the extension the run asked for.
 */
describe("speakReply in the reply's format", () => {
  const WAV = new Uint8Array(Buffer.concat([Buffer.from("RIFF\0\0\0\0WAVEfmt "), Buffer.alloc(4096, 1)]));
  const MP3 = new Uint8Array(Buffer.concat([Buffer.from("ID3\x04\0"), Buffer.alloc(3000, 2)]));
  const wavFrom = (order: string[], id: string) => async (_c: unknown, _v: unknown, _t: string, format?: string) => {
    order.push(`${id}:${format}`);
    return new Response(new Uint8Array(WAV), { headers: { "Content-Type": "audio/wav" } });
  };

  it("compresses Kokoro's WAV into MP3 and names the engine that spoke", async () => {
    stateMock.mockResolvedValue({ choice: "local" });
    compressMock.mockResolvedValue(MP3);
    const order: string[] = [];
    const res = await speakReply("Hello", { local: wavFrom(order, "local"), cloud: wavFrom(order, "cloud") }, { format: "mp3" });
    expect(order).toEqual(["local:mp3"]);
    expect(compressMock).toHaveBeenCalledWith(expect.any(Uint8Array), "mp3");
    expect(res.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(res.headers.get("X-ClawBox-Voice-Engine")).toBe("local");
  });

  it("answers the WAV when the box has no ffmpeg — a bigger reply, not a lost one", async () => {
    stateMock.mockResolvedValue({ choice: "local" });
    compressMock.mockResolvedValue(null);
    const res = await speakReply("Hello", { local: wavFrom([], "local"), cloud: wavFrom([], "cloud") }, { format: "opus" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("audio/wav");
    expect((await res.arrayBuffer()).byteLength).toBe(WAV.byteLength);
  });

  it("compresses a Hermes WAV too", async () => {
    harnessMock.mockResolvedValue("hermes");
    hermesSpeakMock.mockResolvedValue({ ok: true, audio: WAV, mime: "audio/wav" });
    compressMock.mockResolvedValue(MP3);
    const res = await speakReply("Hello", undefined, { format: "mp3" });
    expect(res.headers.get("Content-Type")).toBe("audio/mpeg");
  });

  it("leaves the engines' own output alone for a caller that names no format (generate_audio)", async () => {
    stateMock.mockResolvedValue({ choice: "local" });
    const order: string[] = [];
    const res = await speakReply("Hello", { local: wavFrom(order, "local"), cloud: wavFrom(order, "cloud") });
    expect(order).toEqual(["local:wav"]);
    expect(compressMock).not.toHaveBeenCalled();
    expect(res.headers.get("Content-Type")).toBe("audio/wav");
  });
});
