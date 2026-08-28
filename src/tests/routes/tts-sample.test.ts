import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /setup-api/tts/sample — the Voice tab's Play button.
 *
 * Pinned: the audio comes from the ONE engine asked for, with the voice asked
 * for (the gateway's fall-through chain is deliberately not used — an audition
 * of the cloud voice that quietly played Kokoro would be the wrong answer);
 * the local engine is the same script the gateway runs; the cloud engine is
 * the same speech route with the same credential; and nothing about the text
 * is kept.
 */

const readConfigMock = vi.fn();
const runChildMock = vi.fn();
const readFileMock = vi.fn();
const unlinkMock = vi.fn();
const readLocalVoiceMock = vi.fn();

vi.mock("@/lib/openclaw-config", () => ({
  readConfig: (...a: unknown[]) => readConfigMock(...a),
  openclawIsAbsent: () => false,
}));

vi.mock("@/lib/voice-output-store", () => ({
  readLocalVoice: (...a: unknown[]) => readLocalVoiceMock(...a),
}));

vi.mock("@/lib/child-run", () => ({
  runChild: (...a: unknown[]) => runChildMock(...a),
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readFile: (...a: unknown[]) => readFileMock(...a),
      unlink: (...a: unknown[]) => unlinkMock(...a),
    },
  };
});

const LOCAL = "tts-local-cli";

function config(over: Record<string, unknown> = {}) {
  return {
    messages: {
      tts: {
        provider: "openai",
        providers: {
          [LOCAL]: { command: "/opt/clawbox-tts.sh" },
          openai: { apiKey: "claw_84d065b", baseUrl: "https://clawbox.com/api/ai", model: "gpt-4o-mini-tts", voice: "nova" },
        },
      },
    },
    models: { providers: { openai: { apiKey: "claw_84d065b" } } },
    ...over,
  };
}

/** The gateway's script, exiting `code`; the route reads the file it "wrote". */
function scriptExits(code: number) {
  return async () => ({ code, stdout: "", stderr: "", signal: null, timedOut: false, notStarted: false });
}

async function route() {
  return await import("@/app/setup-api/tts/sample/route");
}

function post(body: unknown) {
  return new Request("http://box/setup-api/tts/sample", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetModules();
  readConfigMock.mockReset().mockResolvedValue(config());
  runChildMock.mockReset().mockImplementation(scriptExits(0));
  readFileMock.mockReset().mockResolvedValue(Buffer.alloc(4096, 1));
  unlinkMock.mockReset().mockResolvedValue(undefined);
  readLocalVoiceMock.mockReset().mockResolvedValue("af_heart");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /setup-api/tts/sample — this box", () => {
  it("runs the gateway's own script with the voice asked for and answers with the audio", async () => {
    const { POST } = await route();
    const res = await POST(post({ text: "Hello there.", engine: "local", voice: "bm_george" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/wav");
    expect((await res.arrayBuffer()).byteLength).toBe(4096);
    const [command, args, opts] = runChildMock.mock.calls[0] as [string, string[], { timeoutMs: number }];
    expect(command).toBe("/opt/clawbox-tts.sh");
    expect(args.slice(0, 4)).toEqual(["--voice", "bm_george", "--", "Hello there."]);
    expect(opts.timeoutMs).toBeGreaterThan(0);
    // The clip is not kept.
    expect(unlinkMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the saved local voice when none is asked for, and never to an unknown one", async () => {
    const { POST } = await route();
    await POST(post({ text: "Hi", engine: "local", voice: "not-a-voice" }));
    const [, args] = runChildMock.mock.calls[0] as [string, string[]];
    expect(args.slice(0, 2)).toEqual(["--voice", "af_heart"]);
  });

  it("reports a script that produced no audio instead of playing a header", async () => {
    readFileMock.mockResolvedValue(Buffer.alloc(44));
    const { POST } = await route();
    const res = await POST(post({ text: "Hi", engine: "local" }));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/could not speak/i);
  });

  it("refuses when no local voice is wired in", async () => {
    readConfigMock.mockResolvedValue(config({ messages: { tts: { provider: "openai", providers: { openai: { apiKey: "k", baseUrl: "https://clawbox.com/api/ai" } } } } }));
    const { POST } = await route();
    const res = await POST(post({ text: "Hi", engine: "local" }));
    expect(res.status).toBe(409);
    expect(runChildMock).not.toHaveBeenCalled();
  });
});

describe("POST /setup-api/tts/sample — the cloud", () => {
  it("posts to the same speech route with the same credential, model and voice", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array(3000), { status: 200, headers: { "content-type": "audio/mpeg" } }));
    vi.stubGlobal("fetch", fetchMock);
    const { POST } = await route();
    const res = await POST(post({ text: "Hello from the cloud.", engine: "cloud" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://clawbox.com/api/ai/audio/speech");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer claw_84d065b");
    // The configured cloud voice is the default when none is asked for.
    // WAV, like the on-device engine: no browser can decline to decode PCM,
    // and an audition lost to a codec is the bug this pins.
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "gpt-4o-mini-tts", input: "Hello from the cloud.", voice: "nova", response_format: "wav",
    });
    expect(runChildMock).not.toHaveBeenCalled();
  });

  it("refuses a cloud voice this box cannot call, before sending anything", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    // A claw_ token with no speech route behind it: the credential is unusable.
    readConfigMock.mockResolvedValue({
      messages: { tts: { provider: LOCAL, providers: { [LOCAL]: { command: "/opt/clawbox-tts.sh" } } } },
      models: { providers: { openai: { apiKey: "claw_84d065b" } } },
    });
    const { POST } = await route();
    const res = await POST(post({ text: "Hi", engine: "cloud" }));
    expect(res.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("turns a refusal from the cloud into a message, not a stack", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 402 })));
    const { POST } = await route();
    const res = await POST(post({ text: "Hi", engine: "cloud" }));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/402/);
  });
});

describe("POST /setup-api/tts/sample — input", () => {
  it("rejects empty, oversized and control-laden text, and an unknown engine", async () => {
    const { POST } = await route();
    expect((await POST(post({ text: "   ", engine: "local" }))).status).toBe(400);
    expect((await POST(post({ text: "x".repeat(401), engine: "local" }))).status).toBe(400);
    expect((await POST(post({ text: "Hi", engine: "phone" }))).status).toBe(400);
    await POST(post({ text: "Hi\u0007there!", engine: "local" }));
    const [, args] = runChildMock.mock.calls[0] as [string, string[]];
    expect(args[3]).toBe("Hi there!");
  });
});
