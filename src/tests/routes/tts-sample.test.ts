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
    const body = await res.json();
    expect(body.error).toMatch(/could not speak/i);
    expect(body.code).toBe("local_failed");
  });

  it("names the memory guard as the reason, with the numbers, instead of blaming the text", async () => {
    // The script's own refusal on an 8 GB board with a model loaded. The old
    // answer was the generic "could not speak that", which read as a problem
    // with the sentence; the owner's next step is to wait, and the numbers say
    // how far off the box is.
    runChildMock.mockImplementation(async () => ({
      code: 1, stdout: "", signal: null, timedOut: false, notStarted: false,
      stderr: [
        "clawbox-tts: Kokoro could not speak this text (voice 'af_heart') — no on-device fallback, the gateway's cloud voice takes over.",
        "  - kokoro: skipped, 2412MB available and the CUDA path peaks at ~2.6GB (need >=3000MB)",
        "  Check the Kokoro install with: sudo bash /home/clawbox/clawbox/install.sh --step openclaw_tts",
      ].join("\n"),
    }));
    const { POST } = await route();
    const res = await POST(post({ text: "Hi", engine: "local" }));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.code).toBe("local_memory");
    expect(body).toMatchObject({ available: "2.4", needed: "3" });
    expect(body.error).toMatch(/short of memory/);
    expect(body.error).toContain("2.4 GB free, needs 3 GB");
    expect(body.error).not.toContain("/home");
  });

  it("passes the script's stated reason through, and never the install hint's path", async () => {
    runChildMock.mockImplementation(async () => ({
      code: 1, stdout: "", signal: null, timedOut: false, notStarted: false,
      stderr: [
        "clawbox-tts: Kokoro could not speak this text (voice 'af_heart') — no on-device fallback, the gateway's cloud voice takes over.",
        "  - kokoro: 'kokoro' failed (CUDA unavailable, allocation refused, or model missing)",
        "  Check the Kokoro install with: sudo bash /home/clawbox/clawbox/install.sh --step openclaw_tts",
      ].join("\n"),
    }));
    const { POST } = await route();
    const body = await (await POST(post({ text: "Hi", engine: "local" }))).json();
    expect(body.code).toBe("local_failed");
    expect(body.reason).toBe("kokoro: 'kokoro' failed (CUDA unavailable, allocation refused, or model missing)");
    expect(body.error).toMatch(/could not speak that\. \(kokoro: 'kokoro' failed/);
    expect(JSON.stringify(body)).not.toContain("install.sh");
  });

  it("keeps a reason that names a path off the owner's screen", async () => {
    runChildMock.mockImplementation(async () => ({
      code: 1, stdout: "", signal: null, timedOut: false, notStarted: false,
      stderr: "  - kokoro: persistent server at /tmp/kokoro-server.sock refused the request\n",
    }));
    const { POST } = await route();
    const body = await (await POST(post({ text: "Hi", engine: "local" }))).json();
    expect(body).toEqual({ error: "The voice on this box could not speak that.", code: "local_failed" });
  });

  it("says a timeout is a timeout", async () => {
    runChildMock.mockImplementation(async () => ({ code: null, stdout: "", stderr: "", signal: "SIGKILL", timedOut: true, notStarted: false }));
    const { POST } = await route();
    const body = await (await POST(post({ text: "Hi", engine: "local" }))).json();
    expect(body.code).toBe("local_timeout");
    expect(body.error).toMatch(/too long/);
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

  it("refuses a voice the configured model does not have, before sending anything", async () => {
    // An audition is of ONE voice: a `ballad` that tts-1 cannot speak must
    // not be quietly swapped for the configured voice and played as if it
    // were the one asked for.
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    readConfigMock.mockResolvedValue(config({
      messages: { tts: { provider: "openai", providers: { [LOCAL]: { command: "/opt/clawbox-tts.sh" }, openai: { apiKey: "claw_84d065b", baseUrl: "https://clawbox.com/api/ai", model: "tts-1", voice: "nova" } } } },
    }));
    const { POST } = await route();
    const res = await POST(post({ text: "Hi", engine: "cloud", voice: "ballad" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/tts-1/);
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
