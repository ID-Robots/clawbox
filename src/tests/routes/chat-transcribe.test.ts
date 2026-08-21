import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import fs from "fs";
import os from "os";
import path from "path";

// POST /setup-api/chat/transcribe — voice input for device chat.
//
// The composer records with MediaRecorder and posts the blob here; the box
// forwards it to the ClawBox AI proxy and hands back the transcript. The device
// proxies rather than letting the browser call out because the ClawBox AI token
// is the device's credential — in the browser it would sit in every devtools
// network panel. TASK-381.

let tmpHome: string;
let openclawHome: string;
let originalHome: string | undefined;
let originalOpenclawHome: string | undefined;
let POST: (req: NextRequest) => Promise<Response>;
let TRANSCRIBE_MODEL: string;
let fetchMock: ReturnType<typeof vi.fn>;

const AUDIO = Buffer.from("fake-opus-bytes-that-stand-in-for-a-recording");

function writeConfig(config: unknown): void {
  fs.writeFileSync(path.join(openclawHome, "openclaw.json"), JSON.stringify(config, null, 2));
}

/** A config with the device linked to ClawBox AI, which is the normal state. */
function linkedConfig(token = "claw_testtoken0000000000000000000") {
  return { models: { providers: { deepseek: { baseUrl: "https://clawbox.com/api/ai", apiKey: token } } } };
}

function request(body: BodyInit | null, contentType?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (contentType) headers["content-type"] = contentType;
  return new NextRequest("http://localhost/setup-api/chat/transcribe", {
    method: "POST",
    headers,
    body,
  } as unknown as ConstructorParameters<typeof NextRequest>[1]);
}

/** A multipart request carrying one `file` part, built the way the browser does. */
function audioRequest(bytes: Buffer = AUDIO, name = "recording.webm"): NextRequest {
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(bytes)], { type: "audio/webm" }), name);
  return new NextRequest("http://localhost/setup-api/chat/transcribe", {
    method: "POST",
    body: form,
  } as unknown as ConstructorParameters<typeof NextRequest>[1]);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("/setup-api/chat/transcribe", () => {
  beforeEach(async () => {
    originalHome = process.env.HOME;
    originalOpenclawHome = process.env.OPENCLAW_HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-stt-"));
    openclawHome = path.join(tmpHome, ".openclaw");
    fs.mkdirSync(openclawHome, { recursive: true });
    process.env.HOME = tmpHome;
    process.env.OPENCLAW_HOME = openclawHome;
    writeConfig(linkedConfig());
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.resetModules();
    const mod = await import("@/app/setup-api/chat/transcribe/route");
    POST = mod.POST;
    TRANSCRIBE_MODEL = mod.TRANSCRIBE_MODEL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalOpenclawHome === undefined) delete process.env.OPENCLAW_HOME;
    else process.env.OPENCLAW_HOME = originalOpenclawHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("hands back the transcript for a recording", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ text: "The harbour lantern turns amber at quarter past four." }));
    const res = await POST(audioRequest());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.text).toBe("The harbour lantern turns amber at quarter past four.");
  });

  it("sends the recording to the ClawBox AI transcription endpoint with the cheap model", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ text: "hello" }));
    await POST(audioRequest(AUDIO, "voice-note.webm"));

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://clawbox.com/api/ai/audio/transcriptions");
    expect(init.method).toBe("POST");
    // gpt-4o-mini-transcribe is half the price of Whisper; sending no model at
    // all would leave the proxy's default deciding what a minute costs.
    expect(TRANSCRIBE_MODEL).toBe("gpt-4o-mini-transcribe");
    const form = init.body as FormData;
    expect(form.get("model")).toBe(TRANSCRIBE_MODEL);
    const sent = form.get("file") as File;
    expect(sent).toBeTruthy();
    expect(sent.size).toBe(AUDIO.length);
    // The upstream filename carries the container hint the proxy sniffs.
    expect(sent.name).toBe("voice-note.webm");
  });

  it("authenticates with the device token from the config, and never returns it", async () => {
    writeConfig(linkedConfig("claw_secret_should_never_be_echoed"));
    fetchMock.mockResolvedValue(jsonResponse({ text: "hi" }));
    const res = await POST(audioRequest());

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer claw_secret_should_never_be_echoed");
    // The token is the device's credential. It goes up to the proxy and it
    // does not come back down into a browser that could log it.
    expect(await res.text()).not.toContain("claw_secret_should_never_be_echoed");
  });

  it("re-reads the token per request, so re-linking a device does not need a reboot", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ text: "hi" }));
    await POST(audioRequest());
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer claw_testtoken0000000000000000000");

    // The portal mints a new token and the gateway rewrites openclaw.json.
    writeConfig(linkedConfig("claw_rotated_token"));
    await POST(audioRequest());
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer claw_rotated_token");
  });

  it("says the device is not linked rather than failing obscurely", async () => {
    writeConfig({ models: { providers: {} } });
    const res = await POST(audioRequest());

    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain("not linked");
    // Nothing should have been sent anywhere without a credential.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a request that is not multipart", async () => {
    const res = await POST(request(JSON.stringify({ hi: true }), "application/json"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("multipart");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a multipart body with no file part", async () => {
    const form = new FormData();
    form.set("note", "no audio here");
    const res = await POST(new NextRequest("http://localhost/setup-api/chat/transcribe", {
      method: "POST", body: form,
    } as unknown as ConstructorParameters<typeof NextRequest>[1]));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("file");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("names an empty recording as such instead of forwarding silence", async () => {
    // What a denied microphone, or stop pressed before the first chunk, looks
    // like. Forwarding it would spend a proxy call to be told there is no
    // speech, and the user would be none the wiser about why.
    const res = await POST(audioRequest(Buffer.alloc(0)));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("empty");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a recording over the size limit without sending it", async () => {
    const { MAX_AUDIO_BYTES } = await import("@/app/setup-api/chat/transcribe/route");
    const res = await POST(audioRequest(Buffer.alloc(MAX_AUDIO_BYTES + 1, 0x41)));

    expect(res.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never relays an upstream error body, which can echo the bearer token back", async () => {
    // Proxies commonly quote the failing request. That request carried the
    // device credential, so only the status may cross back to the browser.
    fetchMock.mockResolvedValue(new Response(
      "upstream said: Authorization: Bearer claw_testtoken0000000000000000000 is malformed",
      { status: 500 },
    ));
    const res = await POST(audioRequest());

    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain("claw_testtoken0000000000000000000");
    expect(text).toContain("upstream 500");
  });

  it("turns a rejected credential into an actionable re-link message", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "invalid token" }, 401));
    const res = await POST(audioRequest());

    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain("Re-link");
  });

  it("reports a bad request upstream as a client error, not a box fault", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "unsupported format" }, 400));
    const res = await POST(audioRequest());
    expect(res.status).toBe(400);
  });

  it("tells the user the network failed rather than blaming their recording", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const res = await POST(audioRequest());

    expect(res.status).toBe(504);
    expect((await res.json()).error).toContain("Could not reach ClawBox AI");
  });

  it("distinguishes a timeout, because the user's next step is different", async () => {
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    fetchMock.mockRejectedValue(timeout);
    const res = await POST(audioRequest());

    expect(res.status).toBe(504);
    expect((await res.json()).error).toContain("timed out");
  });

  it("bounds how long a wedged upstream can hold the recording UI", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ text: "hi" }));
    await POST(audioRequest());
    // Without a signal, "transcribing…" could sit there until the user gives
    // up and reloads the page.
    expect(fetchMock.mock.calls[0][1].signal).toBeTruthy();
  });

  it("reports an unreadable upstream response as a server-side fault", async () => {
    fetchMock.mockResolvedValue(new Response("<html>gateway</html>", { status: 200 }));
    const res = await POST(audioRequest());
    expect(res.status).toBe(502);
  });

  it("reports a response with no text field rather than answering with undefined", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ usage: { total_tokens: 3 } }));
    const res = await POST(audioRequest());
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain("no text");
  });

  it("treats a silent recording as success with nothing said, not as an error", async () => {
    // The call worked; the room was quiet. The composer says so. Reporting it
    // as a failure would have the user re-recording to fix a working feature.
    fetchMock.mockResolvedValue(jsonResponse({ text: "   " }));
    const res = await POST(audioRequest());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.text).toBe("");
  });
});
