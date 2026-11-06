import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /setup-api/tts/speak — the desktop chat's spoken reply.
 *
 * Pinned here: the owner's switch gates it, the Markdown is lifted off the
 * text before anything speaks, and the engine that spoke is named on the
 * answer. HOW the box speaks — which engines are usable and in which order —
 * moved into `speakReply` when the coding agent needed the same assembly, and
 * is pinned in src/tests/unit/voice-speak-reply.test.ts.
 */

const readConfigMock = vi.fn();
const inventoryMock = vi.fn();
const stateMock = vi.fn();
const autoReplyMock = vi.fn();
const speakReplyMock = vi.fn();

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
vi.mock("@/lib/voice-reply", () => ({ getVoiceAutoReply: (...a: unknown[]) => autoReplyMock(...a) }));
vi.mock("@/lib/voice-speak", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/voice-speak")>();
  return { ...actual, speakReply: (...a: unknown[]) => speakReplyMock(...a) };
});
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, promises: { ...actual.promises, access: async () => undefined } };
});
// An OpenClaw box, so the real `speakReply` (below) walks the engine chain
// rather than handing the words to Hermes.
vi.mock("@/lib/harness", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/harness")>();
  return { ...actual, getActiveHarness: async () => "openclaw" };
});

const LOCAL = "tts-local-cli";
const kokoro = [{ id: "kokoro", name: "Kokoro", kind: "tts", installed: true }];

function config() {
  return {
    tts: { provider: "openai", providers: { [LOCAL]: { command: "/opt/clawbox-tts.sh" }, openai: { model: "gpt-4o-mini-tts" } } },
    models: { providers: { openai: { apiKey: "sk-live-abc" } } },
  };
}

const audio = () => new Response(new Uint8Array(4096), { status: 200, headers: { "Content-Type": "audio/wav", "X-ClawBox-Voice-Engine": "cloud" } });

async function route() {
  return await import("@/app/setup-api/tts/speak/route");
}

function post(body: unknown) {
  return new Request("http://box/setup-api/tts/speak", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

beforeEach(() => {
  vi.resetModules();
  readConfigMock.mockReset().mockResolvedValue(config());
  inventoryMock.mockReset().mockResolvedValue(kokoro);
  stateMock.mockReset().mockResolvedValue({ choice: "auto" });
  autoReplyMock.mockReset().mockResolvedValue(true);
  speakReplyMock.mockReset().mockImplementation(async () => audio());
});

describe("POST /setup-api/tts/speak", () => {
  it("speaks the words of the reply, not its Markdown, and names the engine that spoke", async () => {
    const { POST } = await route();
    const res = await POST(post({ text: "**Done.** See [docs](https://x.y)." }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-clawbox-voice-engine")).toBe("cloud");
    expect(speakReplyMock).toHaveBeenCalledTimes(1);
    expect(speakReplyMock.mock.calls[0][0]).toBe("Done. See docs.");
  });

  it("is refused while the owner's switch is off", async () => {
    autoReplyMock.mockResolvedValue(false);
    const { POST } = await route();
    const res = await POST(post({ text: "hello" }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("switched_off");
    expect(speakReplyMock).not.toHaveBeenCalled();
  });

  it("speaks Opus for a browser that said it plays Opus", async () => {
    const { POST } = await route();
    await POST(post({ text: "hello", formats: ["opus", "mp3"] }));
    expect(speakReplyMock.mock.calls[0][2]).toEqual({ format: "opus" });
  });

  it("speaks MP3 to a browser that did not list Opus, and to a request that stated nothing", async () => {
    const { POST } = await route();
    await POST(post({ text: "hello", formats: ["mp3"] }));
    await POST(post({ text: "hello" }));
    await POST(post({ text: "hello", formats: "opus" }));
    expect(speakReplyMock.mock.calls.map((c) => c[2])).toEqual([{ format: "mp3" }, { format: "mp3" }, { format: "mp3" }]);
  });

  it("relays the Content-Type of what was spoken", async () => {
    speakReplyMock.mockImplementation(async () => new Response(new Uint8Array(4096), { headers: { "Content-Type": "audio/mpeg" } }));
    const { POST } = await route();
    const res = await POST(post({ text: "hello", formats: ["mp3"] }));
    expect(res.headers.get("Content-Type")).toBe("audio/mpeg");
  });

  it("has nothing to say for a reply that is only markup", async () => {
    const { POST } = await route();
    const res = await POST(post({ text: "MEDIA: /a.png" }));
    expect(res.status).toBe(400);
    expect(speakReplyMock).not.toHaveBeenCalled();
  });
});

/**
 * The cloud voice hanging, end to end: the real `speakReply` and the real
 * `speakInCloud`, with only the speech server stubbed. A box whose one voice
 * is the cloud's used to answer the chat after a silent minute with nothing;
 * now it answers within the first-byte budget × 2 with the refusal shape the
 * chat reads (`error` + `code`), and the chat turns that into a line under the
 * reply instead of silence.
 */
describe("POST /setup-api/tts/speak when the cloud voice hangs", () => {
  const cloudOnly = () => ({
    tts: { provider: "openai", providers: { openai: { baseUrl: "https://speech.example/v1", model: "gpt-4o-mini-tts", apiKey: "sk-test" } } },
    models: { providers: { openai: { apiKey: "sk-test" } } },
  });
  /** A server that took the connection and says nothing — until the request is called off. */
  const hangs = (_url: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  });
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.useFakeTimers();
    readConfigMock.mockResolvedValue(cloudOnly());
    inventoryMock.mockResolvedValue([]);
    stateMock.mockResolvedValue({ choice: "cloud" });
    const actual = await vi.importActual<typeof import("@/lib/voice-speak")>("@/lib/voice-speak");
    speakReplyMock.mockImplementation((...a: Parameters<typeof actual.speakReply>) => actual.speakReply(...a));
    fetchMock = vi.fn(hangs);
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("answers with the cloud_no_answer refusal after one retry, not a silent minute", async () => {
    const { CLOUD_FIRST_BYTE_TIMEOUT_MS } = await vi.importActual<typeof import("@/lib/voice-speak")>("@/lib/voice-speak");
    const { POST } = await route();
    let res: Response | null = null;
    void POST(post({ text: "hello" })).then((r) => { res = r; });

    await vi.advanceTimersByTimeAsync(2 * CLOUD_FIRST_BYTE_TIMEOUT_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res).not.toBeNull();
    const answered = res as unknown as Response;
    expect(answered.status).toBe(502);
    expect(answered.headers.get("Cache-Control")).toBe("no-store");
    expect(await answered.json()).toEqual({ error: "The cloud voice did not answer.", code: "cloud_no_answer" });
  });

  it("speaks the reply when the cloud hangs once and then answers", async () => {
    const { CLOUD_FIRST_BYTE_TIMEOUT_MS } = await vi.importActual<typeof import("@/lib/voice-speak")>("@/lib/voice-speak");
    const mp3 = new Uint8Array(Buffer.concat([Buffer.from("ID3\x04\0"), Buffer.alloc(3000, 2)]));
    fetchMock.mockImplementationOnce(hangs).mockResolvedValueOnce(new Response(mp3, { headers: { "Content-Type": "audio/mpeg" } }));
    const { POST } = await route();
    let res: Response | null = null;
    void POST(post({ text: "hello" })).then((r) => { res = r; });

    await vi.advanceTimersByTimeAsync(CLOUD_FIRST_BYTE_TIMEOUT_MS);
    expect(res).not.toBeNull();
    const answered = res as unknown as Response;
    expect(answered.status).toBe(200);
    expect(answered.headers.get("X-ClawBox-Voice-Engine")).toBe("cloud");
    expect(answered.headers.get("Content-Type")).toBe("audio/mpeg");
  });
});
