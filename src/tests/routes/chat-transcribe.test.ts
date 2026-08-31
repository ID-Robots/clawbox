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
    const res = await POST(new NextRequest("http://localhost/setup-api/chat/transcribe", {
      method: "POST", body: form,
    } as unknown as ConstructorParameters<typeof NextRequest>[1]));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("file");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects field-count amplification before materialising a FormData object", async () => {
    const form = new FormData();
    for (let i = 0; i < 100; i++) form.append(`tiny-${i}`, "x");
    form.append("file", new Blob([new Uint8Array(AUDIO)], { type: "audio/webm" }), "recording.webm");
    const res = await POST(new NextRequest("http://localhost/setup-api/chat/transcribe", {
      method: "POST",
      body: form,
    }));

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
    const res = await POST(audioRequest(Buffer.alloc(MAX_AUDIO_BYTES + 1, 0x41)));

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
});
