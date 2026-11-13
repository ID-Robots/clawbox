import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import fs from "fs";
import os from "os";
import path from "path";
import { CLAWBOX_AI_PROVIDER } from "@/lib/clawbox-ai-models";

// POST /setup-api/chat/transcribe — the owner's own speech server as an engine,
// and the local-only AI lock (TASK-2501 PR-D).
//
// Under the lock the route FAILS CLOSED: the chosen local engine alone, never
// the cloud, and its failure is the answer. Without the lock a box that never
// saved a server walks exactly the chain it always did (chat-transcribe.test.ts
// pins that chain; one case here pins that a saved server does not change it).

const localStt = vi.hoisted(() => ({ installed: vi.fn(), transcribe: vi.fn() }));
vi.mock("@/lib/stt-local", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stt-local")>();
  return {
    ...actual,
    localSttInstalled: (...a: unknown[]) => localStt.installed(...a),
    transcribeLocally: (...a: unknown[]) => localStt.transcribe(...a),
  };
});
const remux = vi.hoisted(() => ({ audioForCloud: vi.fn() }));
vi.mock("@/lib/stt-remux", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stt-remux")>();
  return { ...actual, audioForCloud: (...a: unknown[]) => remux.audioForCloud(...a) };
});

const PROXY_TRANSCRIBE = "https://clawbox.com/api/ai/audio/transcriptions";
const ENDPOINT = "http://127.0.0.1:18999/v1";
const TOKEN = "claw_testtoken0000000000000000000";

let tmpHome: string;
let saved: Record<string, string | undefined>;
let POST: (req: NextRequest) => Promise<Response>;
let fetchMock: ReturnType<typeof vi.fn>;

function writeStore(store: Record<string, unknown>): void {
  fs.mkdirSync(path.join(tmpHome, "data"), { recursive: true });
  fs.writeFileSync(path.join(tmpHome, "data", "config.json"), JSON.stringify(store, null, 2));
}

function audioRequest(): NextRequest {
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(Buffer.from("a recording"))], { type: "audio/webm" }), "recording.webm");
  return new NextRequest("http://localhost/setup-api/chat/transcribe", {
    method: "POST",
    body: form,
  } as unknown as ConstructorParameters<typeof NextRequest>[1]);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const urls = () => fetchMock.mock.calls.map((c) => String(c[0]));

beforeEach(async () => {
  saved = { HOME: process.env.HOME, OPENCLAW_HOME: process.env.OPENCLAW_HOME, CLAWBOX_ROOT: process.env.CLAWBOX_ROOT };
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-stt-lock-"));
  const openclawHome = path.join(tmpHome, ".openclaw");
  fs.mkdirSync(openclawHome, { recursive: true });
  process.env.HOME = tmpHome;
  process.env.OPENCLAW_HOME = openclawHome;
  process.env.CLAWBOX_ROOT = tmpHome;
  // A box linked to ClawBox AI: without the lock the cloud is a real engine.
  fs.writeFileSync(path.join(openclawHome, "openclaw.json"), JSON.stringify({
    models: { providers: { [CLAWBOX_AI_PROVIDER]: { baseUrl: "https://clawbox.com/api/ai", apiKey: TOKEN } } },
    auth: { profiles: { [`${CLAWBOX_AI_PROVIDER}:default`]: { provider: CLAWBOX_AI_PROVIDER, mode: "api_key" } } },
  }));
  writeStore({});
  localStt.installed.mockResolvedValue({ installed: false, detail: "The on-box transcriber is not installed." });
  localStt.transcribe.mockResolvedValue({ ok: false, error: "not installed" });
  remux.audioForCloud.mockImplementation(async (audio: { file: Blob; name: string }) => ({ ...audio, prepared: "as-is" }));
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.resetModules();
  POST = (await import("@/app/setup-api/chat/transcribe/route")).POST;
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("the owner's own speech server", () => {
  it("transcribes with it when it is the chosen engine, sending the model and the key", async () => {
    writeStore({ stt_primary: "endpoint", stt_endpoint: { baseUrl: ENDPOINT, model: "asr-small" } });
    fs.writeFileSync(path.join(tmpHome, "data", ".stt-endpoint-key"), "lan-key-1", { mode: 0o600 });
    fetchMock.mockResolvedValue(jsonResponse({ text: " The harbour lantern turns amber. " }));

    const res = await POST(audioRequest());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, text: "The harbour lantern turns amber.", engine: "endpoint" });
    expect(urls()).toEqual([`${ENDPOINT}/audio/transcriptions`]);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer lan-key-1");
    expect(init.redirect).toBe("manual");
    expect((init.body as FormData).get("model")).toBe("asr-small");
  });

  it("without the lock, a failed server falls through to the chain the box always had", async () => {
    writeStore({ stt_primary: "endpoint", stt_endpoint: { baseUrl: ENDPOINT, model: "whisper-1" } });
    fetchMock.mockImplementation(async (url: string) =>
      url.startsWith(ENDPOINT) ? jsonResponse({ error: "busy" }, 503) : jsonResponse({ text: "from the cloud" }));

    const res = await POST(audioRequest());

    expect(res.status).toBe(200);
    expect((await res.json()).engine).toBe("cloud");
    expect(urls()).toEqual([`${ENDPOINT}/audio/transcriptions`, PROXY_TRANSCRIBE]);
  });

  it("never sends a recording to a saved address outside the local network", async () => {
    // Hand-edited into the store: the save path would have refused it.
    writeStore({ ai_cloud_lock: true, stt_primary: "endpoint", stt_endpoint: { baseUrl: "http://8.8.8.8/v1", model: "whisper-1" } });
    const res = await POST(audioRequest());
    // Not a valid record at all, so the lock has no engine: refused, nothing sent.
    expect(res.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("under the local-only AI lock", () => {
  it("errors with the reason when the chosen server is down, and never asks the cloud", async () => {
    writeStore({ ai_cloud_lock: true, stt_primary: "endpoint", stt_endpoint: { baseUrl: ENDPOINT, model: "whisper-1" } });
    // The on-box engine is there too: under the lock it is not a fallback either.
    localStt.installed.mockResolvedValue({ installed: true, detail: "faster-whisper" });
    localStt.transcribe.mockResolvedValue({ ok: true, text: "from whisper" });
    fetchMock.mockRejectedValue(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }));

    const res = await POST(audioRequest());

    expect(res.status).toBe(504);
    const body = await res.json();
    expect(body.code).toBe("cloud_ai_locked");
    expect(body.error).toMatch(/Could not reach the speech server/);
    expect(body.error).toMatch(/not sent to the cloud/);
    expect(urls()).toEqual([`${ENDPOINT}/audio/transcriptions`]);
    expect(urls().some((u) => u.includes("clawbox.com"))).toBe(false);
    expect(localStt.transcribe).not.toHaveBeenCalled();
  });

  it("treats a stored cloud pick as the box's own engine, and its failure as the answer", async () => {
    writeStore({ ai_cloud_lock: true, stt_primary: "cloud" });
    localStt.installed.mockResolvedValue({ installed: true, detail: "faster-whisper" });
    localStt.transcribe.mockResolvedValue({ ok: false, error: "whisper crashed" });

    const res = await POST(audioRequest());

    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe("cloud_ai_locked");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("transcribes on the box when the box's engine answers", async () => {
    writeStore({ ai_cloud_lock: "pinned" });
    localStt.installed.mockResolvedValue({ installed: true, detail: "faster-whisper" });
    localStt.transcribe.mockResolvedValue({ ok: true, text: "on the box" });

    const res = await POST(audioRequest());

    expect(await res.json()).toEqual({ ok: true, text: "on the box", engine: "local" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says what to set up when the box has no engine of its own", async () => {
    writeStore({ ai_cloud_lock: true });
    const res = await POST(audioRequest());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("cloud_ai_locked");
    expect(body.error).toMatch(/no transcription engine of its own/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads an unreadable store as locked: no cloud request", async () => {
    fs.writeFileSync(path.join(tmpHome, "data", "config.json"), "{ torn");
    const res = await POST(audioRequest());
    expect(res.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
