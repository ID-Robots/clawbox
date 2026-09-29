import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CLAWBOX_AI_PROVIDER } from "@/lib/clawbox-ai-models";

// Starts a real process (ffmpeg / ffprobe): vitest's 5 s test and 10 s hook
// defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// POST /setup-api/chat/transcribe with a real MediaRecorder-shaped WebM, the
// real ffmpeg remux, and a stand-in for the ClawBox AI proxy that behaves as
// the proxy was measured to on 2026-09-25 (TASK-1214):
//
//   a WebM with no duration  -> HTTP 400 {"error":{…,"code":"unsupported_audio"}}
//   the same audio, remuxed  -> HTTP 200 {"text":"…","usage":{…}}
//
// The stand-in decides the way the proxy does, by asking ffprobe for the
// duration of the file it was sent. The first test proves the stand-in refuses
// the browser's own recording, so the second one passing means the route fixed
// the recording and not the fixture.
//
// Skipped where ffmpeg (with libopus, to make the recording) or ffprobe is
// missing. src/tests/routes/chat-transcribe.test.ts covers the route's logic
// with the remux mocked.

function output(bin: string, args: string[]): string | null {
  const r = spawnSync(bin, args, { encoding: "utf8" });
  return r.status === 0 ? r.stdout : null;
}
const canRun = /\blibopus\b/.test(output("ffmpeg", ["-hide_banner", "-encoders"]) ?? "")
  && output("ffprobe", ["-version"]) !== null;

// The engine on the box is mocked out as "not installed", so a pass here can
// only be the cloud's.
vi.mock("@/lib/stt-local", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stt-local")>();
  return {
    ...actual,
    localSttInstalled: async () => ({ installed: false, detail: "The on-box transcriber is not installed." }),
    transcribeLocally: async () => ({ ok: false, error: "not installed" }),
  };
});

const TOKEN = "claw_testtoken0000000000000000000";
const UNSUPPORTED_AUDIO = {
  error: {
    message: "Could not read the audio duration. Supported formats: wav, mp3, m4a, mp4, ogg, opus, flac, webm.",
    type: "invalid_request_error",
    code: "unsupported_audio",
  },
};

describe.skipIf(!canRun)("/setup-api/chat/transcribe with a MediaRecorder WebM (TASK-1214)", () => {
  let fixtures: string;
  let live: Buffer;
  let tmpHome: string;
  let saved: Record<string, string | undefined>;
  let POST: (req: NextRequest) => Promise<Response>;
  let uploads: { url: string; auth: string | undefined; model: unknown; name: string; duration: string }[];

  /** The proxy, as measured: it reads the duration first and refuses without one. */
  async function proxy(url: unknown, init: RequestInit): Promise<Response> {
    const form = init.body as FormData;
    const file = form.get("file") as File;
    const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-probe-"));
    try {
      const received = path.join(probeDir, file.name);
      fs.writeFileSync(received, Buffer.from(await file.arrayBuffer()));
      const duration = execFileSync("ffprobe", [
        "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1", received,
      ], { encoding: "utf8" }).trim();
      uploads.push({
        url: String(url),
        auth: (init.headers as Record<string, string>).Authorization,
        model: form.get("model"),
        name: file.name,
        duration,
      });
      if (duration === "duration=N/A") {
        return new Response(JSON.stringify(UNSUPPORTED_AUDIO), { status: 400, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ text: "Guten Tag, das ist ein Test.", usage: { seconds: 3 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } finally {
      fs.rmSync(probeDir, { recursive: true, force: true });
    }
  }

  function audioRequest(bytes: Buffer): NextRequest {
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(bytes)], { type: "audio/webm;codecs=opus" }), "recording.webm");
    return new NextRequest("http://localhost/setup-api/chat/transcribe", {
      method: "POST",
      body: form,
    } as unknown as ConstructorParameters<typeof NextRequest>[1]);
  }

  beforeAll(() => {
    fixtures = fs.mkdtempSync(path.join(os.tmpdir(), "chat-transcribe-webm-"));
    // Opus in WebM, written as a stream: no seeking back, so no duration.
    // That is what MediaRecorder hands the composer.
    live = execFileSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin",
      "-f", "lavfi", "-i", "sine=frequency=330:duration=2",
      "-ac", "1", "-c:a", "libopus", "-b:a", "32k",
      "-f", "webm", "pipe:1",
    ]);
  });

  afterAll(() => {
    fs.rmSync(fixtures, { recursive: true, force: true });
  });

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, OPENCLAW_HOME: process.env.OPENCLAW_HOME, CLAWBOX_ROOT: process.env.CLAWBOX_ROOT };
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-stt-webm-"));
    const openclawHome = path.join(tmpHome, ".openclaw");
    fs.mkdirSync(openclawHome, { recursive: true });
    fs.writeFileSync(path.join(openclawHome, "openclaw.json"), JSON.stringify({
      models: { providers: { [CLAWBOX_AI_PROVIDER]: { baseUrl: "https://clawbox.com/api/ai", apiKey: TOKEN } } },
    }));
    process.env.HOME = tmpHome;
    process.env.OPENCLAW_HOME = openclawHome;
    process.env.CLAWBOX_ROOT = tmpHome;
    uploads = [];
    vi.stubGlobal("fetch", vi.fn(proxy));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.resetModules();
    POST = (await import("@/app/setup-api/chat/transcribe/route")).POST;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("the stand-in proxy refuses the browser's own recording, as the real one did", async () => {
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(live)], { type: "audio/webm" }), "live.webm");
    form.set("model", "gpt-4o-mini-transcribe");

    const res = await proxy("https://clawbox.com/api/ai/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: form,
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(UNSUPPORTED_AUDIO);
  });

  it("transcribes that recording in the cloud, because the box remuxes it first", async () => {
    const res = await POST(audioRequest(live));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, text: "Guten Tag, das ist ein Test.", engine: "cloud" });
    expect(uploads).toHaveLength(1);
    const [sent] = uploads;
    expect(sent.url).toBe("https://clawbox.com/api/ai/audio/transcriptions");
    expect(sent.auth).toBe(`Bearer ${TOKEN}`);
    expect(sent.model).toBe("gpt-4o-mini-transcribe");
    expect(sent.name).toBe("recording.webm");
    expect(sent.duration).toMatch(/^duration=\d+\.\d+$/);
  });
});
