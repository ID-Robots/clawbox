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
