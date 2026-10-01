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
//
// The on-box engine is mocked at its module boundary and reports "not
// installed" unless a test says otherwise, so every test above the fallback
// section exercises exactly the single-engine behaviour the route always had.
// It has to be a mock: the real probe looks at HOME, and on a box that has
// whisper installed a cloud failure would otherwise spawn python mid-test.

const localStt = vi.hoisted(() => ({ installed: vi.fn(), transcribe: vi.fn() }));
vi.mock("@/lib/stt-local", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stt-local")>();
  return {
    ...actual,
    localSttInstalled: (...a: unknown[]) => localStt.installed(...a),
    transcribeLocally: (...a: unknown[]) => localStt.transcribe(...a),
  };
});

// The cloud leg's remux (src/lib/stt-remux.ts, TASK-1214) is mocked at its
// boundary for the same reason: these fixtures are not real WebM and the real
// remux would leave them alone anyway, but a test here must never depend on
// whether the machine running it has ffmpeg. It passes the recording through
// untouched unless a test says otherwise.
// src/tests/routes/chat-transcribe-webm.test.ts runs the real remux end to end.
const remux = vi.hoisted(() => ({ audioForCloud: vi.fn() }));
vi.mock("@/lib/stt-remux", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stt-remux")>();
  return { ...actual, audioForCloud: (...a: unknown[]) => remux.audioForCloud(...a) };
});

let tmpHome: string;
let openclawHome: string;
let originalHome: string | undefined;
let originalOpenclawHome: string | undefined;
let originalClawboxRoot: string | undefined;
let POST: (req: NextRequest) => Promise<Response>;
let TRANSCRIBE_MODEL: string;
let fetchMock: ReturnType<typeof vi.fn>;

const AUDIO = Buffer.from("fake-opus-bytes-that-stand-in-for-a-recording");

function writeConfig(config: unknown): void {
  fs.writeFileSync(path.join(openclawHome, "openclaw.json"), JSON.stringify(config, null, 2));
}

/**
 * Put a token in the OTHER store — the app's own `data/config.json`, which is
 * where the Hermes flow persists the same device credential.
 *
 * A Hermes SKU has no `~/.openclaw` tree at all, so this is the only place the
 * route can find anything, and reaching it is exactly what turned the
 * microphone on for that edition.
 */
function writeHermesToken(token: string | null): void {
  const dataDir = path.join(tmpHome, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "config.json"),
    JSON.stringify(token === null ? {} : { clawai_token: token }, null, 2),
  );
}

/** The owner's engine order, in the same store (the token stays in openclaw.json). */
function writePrimary(primary: "cloud" | "local"): void {
  const dataDir = path.join(tmpHome, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ stt_primary: primary }, null, 2));
}

function boxHasWhisper(): void {
  localStt.installed.mockResolvedValue({ installed: true, detail: "faster-whisper, kept warm by whisper-server." });
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

/**
 * Fully serialize a FormData fixture that the route is expected to reject
 * before reading it all.
 *
 * Passing FormData directly to NextRequest starts Node's bundled undici
 * serializer on an unobserved async producer. These rejection tests correctly
 * cancel the unread request tail, but under V8 coverage that producer can then
 * enqueue into the closed stream (`ERR_INVALID_STATE`). A real network sender
 * receives the cancellation instead; supplying its already-encoded wire bytes
 * keeps the route behavior under test without leaving a fixture task behind.
 */
async function serializedFormRequest(form: FormData): Promise<NextRequest> {
  const serialized = new Response(form);
  const body = Buffer.from(await serialized.arrayBuffer());
  return new NextRequest("http://localhost/setup-api/chat/transcribe", {
    method: "POST",
    headers: { "content-type": serialized.headers.get("content-type") ?? "" },
    body,
  } as unknown as ConstructorParameters<typeof NextRequest>[1]);
}

/** A fully serialized file upload for early-rejection cases. */
async function serializedAudioRequest(bytes: Buffer, name = "recording.webm"): Promise<NextRequest> {
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(bytes)], { type: "audio/webm" }), name);
  return serializedFormRequest(form);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("/setup-api/chat/transcribe", () => {
  beforeEach(async () => {
    originalHome = process.env.HOME;
    originalOpenclawHome = process.env.OPENCLAW_HOME;
    originalClawboxRoot = process.env.CLAWBOX_ROOT;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-stt-"));
    openclawHome = path.join(tmpHome, ".openclaw");
    fs.mkdirSync(openclawHome, { recursive: true });
    process.env.HOME = tmpHome;
    process.env.OPENCLAW_HOME = openclawHome;
    // The route now consults BOTH edition stores, so the second one has to be
    // pointed at the sandbox too — otherwise these tests would read the real
    // device's config.json and pass or fail on whether THAT box is linked.
    process.env.CLAWBOX_ROOT = tmpHome;
    writeConfig(linkedConfig());
    writeHermesToken(null);
    localStt.installed.mockResolvedValue({ installed: false, detail: "The on-box transcriber is not installed." });
    localStt.transcribe.mockResolvedValue({ ok: false, error: "not installed" });
    remux.audioForCloud.mockImplementation(async (audio: { file: Blob; name: string }) => ({ ...audio, prepared: "as-is" }));
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
    if (originalClawboxRoot === undefined) delete process.env.CLAWBOX_ROOT;
    else process.env.CLAWBOX_ROOT = originalClawboxRoot;
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
    writeHermesToken(null);
    const res = await POST(audioRequest());

    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain("not linked");
    // Nothing should have been sent anywhere without a credential.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("transcribes on a box that keeps its token in the OTHER edition's store", async () => {
    // The Hermes case, and the whole reason voice input was dark there: this
    // route used to read openclaw.json and nothing else, so a device holding
    // the same credential somewhere else could only ever be told it was not
    // linked. Nothing about transcription is edition-specific — the lookup was.
    writeConfig({ models: { providers: {} } });
    writeHermesToken("claw_token_from_the_hermes_store");
    fetchMock.mockResolvedValue(jsonResponse({ text: "It works on this edition too." }));

    const res = await POST(audioRequest());

    expect(res.status).toBe(200);
    expect((await res.json()).text).toBe("It works on this edition too.");
    expect(fetchMock.mock.calls[0][1].headers.Authorization)
      .toBe("Bearer claw_token_from_the_hermes_store");
  });

  it("still prefers the OpenClaw store on a box that has both", async () => {
    // A dual box holds the same credential in both places — they are written by
    // the same portal hand-off — so the order only decides which read answers
    // first, never which token goes on the wire.
    writeConfig(linkedConfig("claw_token_from_openclaw"));
    writeHermesToken("claw_token_from_hermes");
    fetchMock.mockResolvedValue(jsonResponse({ text: "ok" }));

    await POST(audioRequest());

    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer claw_token_from_openclaw");
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
    const res = await POST(await serializedFormRequest(form));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("file");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects field-count amplification before materialising a FormData object", async () => {
    const form = new FormData();
    for (let i = 0; i < 100; i++) form.append(`tiny-${i}`, "x");
    form.append("file", new Blob([new Uint8Array(AUDIO)], { type: "audio/webm" }), "recording.webm");
    const res = await POST(await serializedFormRequest(form));

    expect(res.status).toBe(400);
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
    const res = await POST(await serializedAudioRequest(Buffer.alloc(MAX_AUDIO_BYTES + 1, 0x41)));

    expect(res.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts a recording exactly at the documented size limit", async () => {
    const { MAX_AUDIO_BYTES } = await import("@/app/setup-api/chat/transcribe/route");
    fetchMock.mockResolvedValue(jsonResponse({ text: "exactly bounded" }));

    const res = await POST(audioRequest(Buffer.alloc(MAX_AUDIO_BYTES, 0x41)));

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sent = fetchMock.mock.calls[0][1].body as FormData;
    expect((sent.get("file") as File).size).toBe(MAX_AUDIO_BYTES);
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
    // stops around 10 MB — the 9 MB request cap plus whatever the parser had
    // already asked for — so the bound here is loose enough not to count
    // chunks and tight enough that the whole 40 MB cannot slip under it.
    //
    // Note this calls POST in-process: the Next server's own 10 MB body cut
    // (experimental.proxyClientMaxBodySize) is not in the path here, which is
    // exactly why the route's cap has to sit under it — a test at this level
    // cannot see the platform truncate what the meters were meant to refuse.
    expect(pulled).toBeLessThan(16 * 1024 * 1024);
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

  it("aborts the upstream transcription when the browser disconnects", async () => {
    const caller = new AbortController();
    let upstreamSignal: AbortSignal | undefined;
    fetchMock.mockImplementation((_url: unknown, init: RequestInit) => {
      upstreamSignal = init.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        upstreamSignal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
        caller.abort();
      });
    });
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(AUDIO)], { type: "audio/webm" }), "recording.webm");

    await POST(new NextRequest("http://localhost/setup-api/chat/transcribe", {
      method: "POST",
      body: form,
      signal: caller.signal,
    }));

    expect(upstreamSignal?.aborted).toBe(true);
  });

  it("does not hand the recording to the box's engine once the caller has gone", async () => {
    // The cloud call comes back as a failure when the browser disconnects,
    // and a failure is what the fall-through runs the next engine on. That
    // next engine is a two-minute whisper run on the box — for nobody.
    boxHasWhisper();
    const caller = new AbortController();
    fetchMock.mockImplementation((_url: unknown, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        caller.abort();
      }));
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(AUDIO)], { type: "audio/webm" }), "recording.webm");

    const res = await POST(new NextRequest("http://localhost/setup-api/chat/transcribe", {
      method: "POST",
      body: form,
      signal: caller.signal,
    }));

    expect(localStt.transcribe).not.toHaveBeenCalled();
    expect(res.status).toBe(499);
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

  describe("with an engine on the box as well", () => {
    it("says which engine answered", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ text: "from the cloud" }));
      const body = await (await POST(audioRequest())).json();
      expect(body).toEqual({ ok: true, text: "from the cloud", engine: "cloud" });
    });

    it("falls back to the box when the cloud fails", async () => {
      boxHasWhisper();
      fetchMock.mockResolvedValue(jsonResponse({ error: "upstream down" }, 500));
      localStt.transcribe.mockResolvedValue({ ok: true, text: "from the box" });

      const res = await POST(audioRequest(AUDIO, "voice-note.webm"));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, text: "from the box", engine: "local" });
      // The box got the same bytes and the same container hint the cloud would have.
      const [bytes, name] = localStt.transcribe.mock.calls[0];
      expect(Buffer.from(bytes).equals(AUDIO)).toBe(true);
      expect(name).toBe("voice-note.webm");
    });

    it("tries the box first when the owner put it first, and never calls out", async () => {
      boxHasWhisper();
      writePrimary("local");
      localStt.transcribe.mockResolvedValue({ ok: true, text: "heard on the box" });

      const body = await (await POST(audioRequest())).json();

      expect(body).toEqual({ ok: true, text: "heard on the box", engine: "local" });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("falls back to the cloud when the box was first and failed", async () => {
      boxHasWhisper();
      writePrimary("local");
      localStt.transcribe.mockResolvedValue({ ok: false, error: "decoder crashed" });
      fetchMock.mockResolvedValue(jsonResponse({ text: "from the cloud" }));

      const body = await (await POST(audioRequest())).json();

      expect(body).toEqual({ ok: true, text: "from the cloud", engine: "cloud" });
    });

    it("reports the primary's failure when both fail — the cloud's here", async () => {
      boxHasWhisper();
      fetchMock.mockResolvedValue(new Response("boom", { status: 500 }));
      localStt.transcribe.mockResolvedValue({ ok: false, error: "decoder crashed" });

      const res = await POST(audioRequest());

      // Byte-for-byte what a cloud-only box answered: the engine the owner
      // chose is the one whose message names their next step.
      expect(res.status).toBe(502);
      expect((await res.json()).error).toBe("Transcription failed (upstream 500).");
      expect(localStt.transcribe).toHaveBeenCalledTimes(1);
    });

    it("reports the box's failure when the box was first, without its stderr", async () => {
      boxHasWhisper();
      writePrimary("local");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      localStt.transcribe.mockResolvedValue({ ok: false, error: "Traceback in /tmp/clawbox-stt-abc/recording.webm" });
      fetchMock.mockResolvedValue(new Response("boom", { status: 500 }));

      const res = await POST(audioRequest());

      expect(res.status).toBe(500);
      const text = await res.text();
      expect(JSON.parse(text).error).toBe("Transcription failed on this box.");
      // The path and the traceback belong in the log, not on a status line.
      expect(text).not.toContain("/tmp/");
      expect(warn).toHaveBeenCalled();
    });

    it("skips a box with no engine without counting it as a failure", async () => {
      // "Not installed" is a fact about the box, not about this recording:
      // the cloud is simply the only engine, exactly as before.
      writePrimary("local");
      fetchMock.mockResolvedValue(jsonResponse({ text: "cloud only" }));

      const body = await (await POST(audioRequest())).json();

      expect(body).toEqual({ ok: true, text: "cloud only", engine: "cloud" });
      expect(localStt.transcribe).not.toHaveBeenCalled();
    });

    it("still names the missing link when the box has no engine and no token", async () => {
      writeConfig({ models: { providers: {} } });
      writePrimary("local");

      const res = await POST(audioRequest());

      expect(res.status).toBe(503);
      expect((await res.json()).error).toContain("not linked");
    });
  });

  // TASK-1214. Chrome's MediaRecorder WebM carries no duration, and the proxy
  // refused every such recording with the 400 below (reproduced from a
  // customer box 2026-09-25 with the device's own token). Meanwhile the box's
  // own engine, which decodes that file fine, was never asked.
  describe("a MediaRecorder recording the proxy cannot read (TASK-1214)", () => {
    /** The proxy's answer to a duration-less WebM, byte for byte. */
    const UNSUPPORTED_AUDIO = {
      error: {
        message: "Could not read the audio duration. Supported formats: wav, mp3, m4a, mp4, ogg, opus, flac, webm.",
        type: "invalid_request_error",
        code: "unsupported_audio",
      },
    };
    /** A live.webm's first bytes: the EBML magic MediaRecorder output starts with. */
    const LIVE_WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from("no-duration-in-this-header")]);
    const REMUXED_WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from("same-audio-with-a-duration")]);

    function remuxes(): void {
      remux.audioForCloud.mockImplementation(async (audio: { file: Blob; name: string }) => ({
        file: new Blob([new Uint8Array(REMUXED_WEBM)], { type: "audio/webm" }),
        name: audio.name,
        prepared: "remuxed",
      }));
    }

    it("uploads the remuxed recording, in the request shape the proxy answered 200 to", async () => {
      remuxes();
      fetchMock.mockResolvedValue(jsonResponse({ text: "Guten Tag, das ist ein Test.", usage: { seconds: 3 } }));

      const res = await POST(audioRequest(LIVE_WEBM, "recording.webm"));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, text: "Guten Tag, das ist ein Test.", engine: "cloud" });
      // What the report's working curl sent: POST, bearer, model, file.
      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).toBe("https://clawbox.com/api/ai/audio/transcriptions");
      expect(init.method).toBe("POST");
      expect(init.headers.Authorization).toBe("Bearer claw_testtoken0000000000000000000");
      const form = init.body as FormData;
      expect(form.get("model")).toBe("gpt-4o-mini-transcribe");
      const sent = form.get("file") as File;
      expect(sent.name).toBe("recording.webm");
      expect(Buffer.from(await sent.arrayBuffer()).equals(REMUXED_WEBM)).toBe(true);
      // The remux was handed exactly what the browser posted, and the
      // request's signal, so it starts no ffmpeg for a caller who has left.
      const [given, signal] = remux.audioForCloud.mock.calls[0];
      expect(Buffer.from(await given.file.arrayBuffer()).equals(LIVE_WEBM)).toBe(true);
      expect(signal).toBeInstanceOf(AbortSignal);
    });

    it("falls back to the box on the exact 400 unsupported_audio, and logs why", async () => {
      boxHasWhisper();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      fetchMock.mockResolvedValue(jsonResponse(UNSUPPORTED_AUDIO, 400));
      localStt.transcribe.mockResolvedValue({ ok: true, text: "Guten Tag vom Kasten." });

      const res = await POST(audioRequest(LIVE_WEBM, "recording.webm"));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, text: "Guten Tag vom Kasten.", engine: "local" });
      // The box's engine gets the browser's own bytes: faster-whisper reads a
      // duration-less WebM, so it needs no remux.
      const [bytes, name] = localStt.transcribe.mock.calls[0];
      expect(Buffer.from(bytes).equals(LIVE_WEBM)).toBe(true);
      expect(name).toBe("recording.webm");
      const logged = warn.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).toContain("cloud engine failed (400: upstream 400 unsupported_audio");
      expect(logged).toContain("trying the other engine");
    });

    it.each([
      ["a 400 with no body", () => new Response(null, { status: 400 })],
      ["a 404", () => jsonResponse({ error: { code: "not_found" } }, 404)],
      ["a 413 for a long recording", () => jsonResponse({ error: { code: "payload_too_large" } }, 413)],
      ["a 422", () => jsonResponse({ error: { code: "unprocessable" } }, 422)],
      ["a 429 rate limit", () => jsonResponse({ error: { code: "rate_limited" } }, 429)],
      ["a 500", () => new Response("boom", { status: 500 })],
      ["a 502 from the edge", () => new Response("<html>bad gateway</html>", { status: 502 })],
      ["a 503", () => jsonResponse({ error: { code: "overloaded" } }, 503)],
      ["a 401 that is an edge rule, not the proxy's verdict", () => jsonResponse({ error: "blocked" }, 401)],
    ])("falls back to the box on %s from the cloud", async (_label, respond) => {
      boxHasWhisper();
      vi.spyOn(console, "warn").mockImplementation(() => {});
      fetchMock.mockImplementation(async () => respond());
      localStt.transcribe.mockResolvedValue({ ok: true, text: "from the box" });

      const res = await POST(audioRequest(LIVE_WEBM));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, text: "from the box", engine: "local" });
      expect(localStt.transcribe).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["the network is down", () => new TypeError("fetch failed")],
      ["the upload timed out", () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })],
    ])("falls back to the box when %s", async (_label, error) => {
      boxHasWhisper();
      vi.spyOn(console, "warn").mockImplementation(() => {});
      fetchMock.mockRejectedValue(error());
      localStt.transcribe.mockResolvedValue({ ok: true, text: "offline dictation" });

      const res = await POST(audioRequest(LIVE_WEBM));

      expect(await res.json()).toEqual({ ok: true, text: "offline dictation", engine: "local" });
    });

    it("falls back to the box when the credential was refused before, without uploading", async () => {
      boxHasWhisper();
      vi.spyOn(console, "warn").mockImplementation(() => {});
      fetchMock.mockResolvedValue(jsonResponse({ error: { code: "invalid_token", message: "bad token" } }, 401));
      localStt.transcribe.mockResolvedValue({ ok: true, text: "from the box" });

      // The first refusal is the proxy's own verdict and is remembered...
      expect((await (await POST(audioRequest(LIVE_WEBM))).json()).engine).toBe("local");
      // ...so the second never uploads, and the box still answers.
      fetchMock.mockClear();
      expect((await (await POST(audioRequest(LIVE_WEBM))).json()).engine).toBe("local");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("falls back to the box when the cloud leg throws instead of answering", async () => {
      // Anything under the cloud leg can throw. It used to escape the engine
      // loop as a bare 500, and the box's engine was never asked.
      boxHasWhisper();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      remux.audioForCloud.mockRejectedValue(new Error("claw_testtoken0000000000000000000 in a message"));
      localStt.transcribe.mockResolvedValue({ ok: true, text: "still heard" });

      const res = await POST(audioRequest(LIVE_WEBM));

      expect(await res.json()).toEqual({ ok: true, text: "still heard", engine: "local" });
      expect(fetchMock).not.toHaveBeenCalled();
      // Only the error's name reaches the journal from the cloud leg.
      const logged = warn.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).toContain("cloud leg threw Error");
      expect(logged).not.toContain("claw_testtoken");
    });

    it("answers with a status, not a crash, when the cloud leg throws and there is no box engine", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      remux.audioForCloud.mockRejectedValue(new Error("boom"));

      const res = await POST(audioRequest(LIVE_WEBM));

      expect(res.status).toBe(502);
      expect((await res.json()).error).toBe("Transcription failed.");
    });

    it("falls back to the cloud when the box's leg throws, with the box first", async () => {
      boxHasWhisper();
      writePrimary("local");
      vi.spyOn(console, "warn").mockImplementation(() => {});
      localStt.transcribe.mockRejectedValue(new Error("EMFILE: too many open files"));
      fetchMock.mockResolvedValue(jsonResponse({ text: "from the cloud" }));

      const body = await (await POST(audioRequest(LIVE_WEBM))).json();

      expect(body).toEqual({ ok: true, text: "from the cloud", engine: "cloud" });
    });

    it("still tells the caller the cloud's answer when the box has no engine, and logs that nothing was there", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      fetchMock.mockResolvedValue(jsonResponse(UNSUPPORTED_AUDIO, 400));

      const res = await POST(audioRequest(LIVE_WEBM));

      expect(res.status).toBe(400);
      const text = await res.text();
      expect(JSON.parse(text).error).toBe("Transcription failed (upstream 400).");
      // The proxy's wording stays out of the response: only the status crosses.
      expect(text).not.toContain("duration");
      const logged = warn.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).toContain("no local engine to fall back to: The on-box transcriber is not installed.");
    });

    it("logs the proxy's error code but nothing else of an upstream body", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      fetchMock.mockResolvedValue(jsonResponse({
        error: { code: "unsupported_audio", message: "request had Authorization: Bearer claw_testtoken0000000000000000000" },
      }, 400));

      await POST(audioRequest(LIVE_WEBM));

      const logged = warn.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).toContain("unsupported_audio");
      expect(logged).not.toContain("claw_testtoken");
    });

    it("does not log a code that is not a short identifier, or an oversized body", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: { code: "Bearer claw_testtoken0000000000000000000" } }, 400));
      await POST(audioRequest(LIVE_WEBM));
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: { code: "unsupported_audio" }, pad: "x".repeat(8192) }, 400));
      await POST(audioRequest(LIVE_WEBM));

      const logged = warn.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).not.toContain("claw_testtoken");
      expect(logged).not.toContain("unsupported_audio");
      expect(logged).toContain("upstream 400, recording sent as-is");
    });

    it("does not remux for a box that is not going to upload", async () => {
      writeConfig({ models: { providers: {} } });
      await POST(audioRequest(LIVE_WEBM));
      expect(remux.audioForCloud).not.toHaveBeenCalled();
    });

    it("does not remux for the box's own engine", async () => {
      boxHasWhisper();
      writePrimary("local");
      localStt.transcribe.mockResolvedValue({ ok: true, text: "heard on the box" });

      await POST(audioRequest(LIVE_WEBM));

      expect(remux.audioForCloud).not.toHaveBeenCalled();
    });
  });
});
