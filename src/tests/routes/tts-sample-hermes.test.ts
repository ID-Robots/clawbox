import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The "Hear it" audition on a box running Hermes.
 *
 * Hermes' `POST /api/audio/speak` takes no per-request engine or voice: it
 * speaks with whatever `tts.provider` names and that provider's persisted
 * voice. So the one thing this route must not do is accept an audition of
 * something the box is not set to — the owner would press play beside "This
 * box", or beside `af_bella`, and hear something else under a 200. An audition
 * that plays a different voice than the control it sits next to is worse than
 * a refusal, because the owner has no way to tell.
 */

let hermesConfig: Record<string, string> = {};
let localVoice: string | null = null;
const speakMock = vi.fn();

vi.mock("@/lib/harness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/harness")>()),
  getActiveHarness: async () => "hermes" as const,
}));

vi.mock("@/lib/hermes-config-cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hermes-config-cache")>()),
  hermesConfigGetMany: async (keys: string[]) =>
    Object.fromEntries(keys.map((k) => [k, hermesConfig[k] ?? ""])),
  hermesConfigGet: async (k: string) => hermesConfig[k] ?? "",
}));

vi.mock("@/lib/hermes-tts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hermes-tts")>()),
  speakWithHermes: (...a: unknown[]) => speakMock(...a),
}));

vi.mock("@/lib/voice-output-store", () => ({
  readLocalVoice: async () => localVoice,
}));

vi.mock("@/lib/openclaw-config", () => ({
  openclawIsAbsent: () => true,
  readConfig: async () => ({}),
}));

function post(body: unknown) {
  return new Request("http://box/setup-api/tts/sample", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function route() {
  return await import("@/app/setup-api/tts/sample/route");
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  // A box speaking with its own Kokoro, on af_heart.
  hermesConfig = {
    "tts.provider": "clawbox-local",
    "tts.providers.clawbox-local.type": "command",
    "tts.providers.clawbox-local.command": "/opt/clawbox-tts.sh",
  };
  localVoice = "af_heart";
  speakMock.mockResolvedValue({
    ok: true,
    audio: Uint8Array.from(Buffer.alloc(4096, 1)),
    mime: "audio/wav",
  });
});

describe("POST /setup-api/tts/sample on a Hermes box", () => {
  it("speaks when the audition matches what the box is set to", async () => {
    const { POST } = await route();
    const res = await POST(post({ text: "parity check", engine: "local", voice: "af_heart" }));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("audio/wav");
    expect(speakMock).toHaveBeenCalled();
  });

  it("refuses an engine the box is not set to, rather than speaking the other one", async () => {
    const { POST } = await route();
    const res = await POST(post({ text: "parity check", engine: "cloud", voice: "alloy" }));

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("not_available");
    // And nothing was spoken: a refusal, not a wrong clip.
    expect(speakMock).not.toHaveBeenCalled();
  });

  it("refuses a VOICE the box is not set to", async () => {
    // The engine matches; the voice does not. `/api/audio/speak` would have
    // spoken af_heart and returned 200 under a control reading af_bella.
    const { POST } = await route();
    const res = await POST(post({ text: "parity check", engine: "local", voice: "af_bella" }));

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("not_available");
    expect(speakMock).not.toHaveBeenCalled();
  });

  it("says a local failure in local words, not as a cloud refusal", async () => {
    // The transport carries both engines, so its codes are the transport's.
    // Rendered unmapped, a Kokoro failure read as "The ClawBox cloud voice
    // refused" on a box with no cloud voice at all.
    speakMock.mockResolvedValue({ ok: false, code: "cloud_refused", status: 502 });
    const { POST } = await route();
    const res = await POST(post({ text: "parity check", engine: "local", voice: "af_heart" }));

    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe("local_failed");
  });
});
