import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import fs from "fs";
import os from "os";
import path from "path";
import { CLAWBOX_AI_PROVIDER } from "@/lib/clawbox-ai-models";

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

/**
 * A config with the device linked to ClawBox AI, which is the normal state.
 *
 * The provider key comes from the same constant the route resolves the
 * credential through. Hardcoding "deepseek" here would mean a rename of that
 * constant leaves every test in this file failing as "device not linked",
 * which points at the fixture rather than at the rename that caused it.
 */
function linkedConfig(token = "claw_testtoken0000000000000000000") {
  return { models: { providers: { [CLAWBOX_AI_PROVIDER]: { baseUrl: "https://clawbox.com/api/ai", apiKey: token } } } };
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

  it("does not put the multipart parser's own words on the user's screen", async () => {
    // A truncated upload is ordinary on a flaky uplink. What the runtime says
    // about it — "Failed to parse body as FormData." — carries no path, URL or
    // token, so the composer's shape-based filter passes it straight through to
    // the status line, untranslated and meaningless to whoever is reading it.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await POST(request(
      "------b\r\nContent-Disposition: form-dat",
      "multipart/form-data; boundary=----b",
    ));

    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error).toBe("Could not read the recording.");
    expect(error).not.toMatch(/FormData|parse/i);
    expect(fetchMock).not.toHaveBeenCalled();
    // The detail is worth keeping, just not on a user's screen.
    expect(warn).toHaveBeenCalled();
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

  it("refuses a body that declares itself oversized before reading it", async () => {
    // The cheap half of the guard: a client that announces its size honestly
    // is turned away before a byte of it is read. The upstream is armed so
    // that a route which forwards this anyway fails on the status, not on a
    // mock that returned nothing.
    fetchMock.mockResolvedValue(jsonResponse({ text: "hi" }));
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(AUDIO)], { type: "audio/webm" }), "recording.webm");
    const serialised = new Response(form);
    const body = Buffer.from(await serialised.arrayBuffer());
    const res = await POST(new NextRequest("http://localhost/setup-api/chat/transcribe", {
      method: "POST",
      headers: {
        "content-type": serialised.headers.get("content-type") ?? "",
        "content-length": "999999999",
      },
      body,
    } as unknown as ConstructorParameters<typeof NextRequest>[1]));

    expect(res.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops reading an oversized chunked body instead of buffering all of it", async () => {
    // The half that matters: a chunked upload declares no length, so the
    // header check above never sees it and the bytes have to be counted as
    // they arrive. Nothing in front of this route would stop them — the box
    // has no reverse proxy trimming request bodies.
    const boundary = "----clawbox-oversized";
    const CHUNK = 1024 * 1024;
    const CHUNKS = 40;
    let pulled = 0;
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent === 0) {
          controller.enqueue(new Uint8Array(Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="r.webm"\r\n`
            + "Content-Type: audio/webm\r\n\r\n",
          )));
        } else if (sent <= CHUNKS) {
          pulled += CHUNK;
          controller.enqueue(new Uint8Array(CHUNK));
        } else {
          controller.enqueue(new Uint8Array(Buffer.from(`\r\n--${boundary}--\r\n`)));
          controller.close();
        }
        sent += 1;
      },
    });
    const res = await POST(new NextRequest("http://localhost/setup-api/chat/transcribe", {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body,
      duplex: "half",
    } as unknown as ConstructorParameters<typeof NextRequest>[1]));

    expect(res.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
    // The status is 413 whether the body was cut off or swallowed whole, so it
    // proves nothing on its own. The byte count is the assertion that does: on
    // a device with a couple of gigabytes free, reading all 40 MB and then
    // refusing them is the failure this test exists to catch. A cut-off read
    // stops around 27 MB — the 26 MB cap plus whatever the parser had already
    // asked for — so the bound here is loose enough not to count chunks and
    // tight enough that the whole 40 MB cannot slip under it.
    expect(pulled).toBeLessThan(32 * 1024 * 1024);
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
