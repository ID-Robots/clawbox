import { beforeEach, describe, expect, it, vi } from "vitest";

// hermes-tts.ts under the local-only AI lock (TASK-2501 PR-D): the cloud voice
// is never written or selected, and a spoken reply moves Hermes off any other
// voice — the factory `edge` is Microsoft's cloud — onto the box's own
// (Kokoro) before Hermes is asked to speak.

const locked = vi.hoisted(() => ({ value: true }));
vi.mock("@/lib/feature-engine", () => ({ cloudAiLockOn: async () => locked.value }));

const hermesConfig = vi.hoisted(() => ({ values: {} as Record<string, string | undefined> }));
const cliMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hermes-cli", () => ({ runHermesCli: (...a: unknown[]) => cliMock(...a) }));
vi.mock("@/lib/hermes-config-cache", () => ({
  hermesConfigGet: async (key: string) => hermesConfig.values[key],
  hermesConfigGetMany: async (keys: string[]) => Object.fromEntries(keys.map((k) => [k, hermesConfig.values[k]])),
  hermesConfigReadPending: () => false,
}));
const dashboardFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hermes-dashboard-auth", () => ({ dashboardFetch: (...a: unknown[]) => dashboardFetch(...a) }));
vi.mock("@/lib/harness/credentials", () => ({ CLAWBOX_AI_PROXY_URL: "https://clawbox.com/api/ai" }));
const markers = vi.hoisted(() => ({ standdown: vi.fn(async () => {}), lock: vi.fn(async () => {}) }));
vi.mock("@/lib/hermes-voice-standdown", () => ({
  rememberHermesVoiceStanddown: (...a: unknown[]) => markers.standdown(...(a as [])),
  rememberHermesVoiceLock: (...a: unknown[]) => markers.lock(...(a as [])),
}));

const LOCAL = {
  "tts.providers.clawbox-local.type": "command",
  "tts.providers.clawbox-local.command": "/home/clawbox/clawbox/scripts/openclaw/clawbox-tts.sh --text-file={input_path} -- {output_path}",
};
const WAV = Buffer.alloc(4096, 1).toString("base64");

let lib: typeof import("@/lib/hermes-tts");

beforeEach(async () => {
  vi.resetModules();
  locked.value = true;
  hermesConfig.values = { ...LOCAL, "tts.provider": "edge" };
  cliMock.mockReset().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
  dashboardFetch.mockReset().mockImplementation(async () =>
    new Response(JSON.stringify({ ok: true, data_url: `data:audio/wav;base64,${WAV}`, mime_type: "audio/wav" }), { status: 200 }),
  );
  vi.spyOn(console, "warn").mockImplementation(() => {});
  markers.standdown.mockClear();
  markers.lock.mockClear();
  lib = await import("@/lib/hermes-tts");
});

const sets = () => cliMock.mock.calls.map((c) => (c[0] as string[]).join(" "));

describe("the cloud voice under the lock", () => {
  it("is never written: no proxy, no token reaches Hermes' config", async () => {
    await expect(lib.writeHermesCloudTarget("claw_token")).rejects.toThrow(/Local-only AI is on/);
    await expect(lib.selectHermesEngine("cloud", "claw_token")).rejects.toThrow(/Local-only AI is on/);
    await expect(lib.selectHermesProvider("cloud")).rejects.toThrow(/Local-only AI is on/);
    expect(cliMock).not.toHaveBeenCalled();
  });

  it("is written as before without the lock", async () => {
    locked.value = false;
    await lib.writeHermesCloudTarget("claw_token");
    expect(sets()).toContain("config set tts.openai.api_key claw_token");
  });

  it("still lets the box's own voice be selected", async () => {
    await lib.selectHermesProvider("local");
    expect(sets()).toEqual(["config set tts.provider clawbox-local"]);
  });
});

describe("speakWithHermes under the lock", () => {
  it("moves Hermes off `edge` onto the box's own voice before speaking", async () => {
    const spoken = await lib.speakWithHermes("hello");
    expect(spoken.ok).toBe(true);
    expect(sets()).toEqual(["config set tts.provider clawbox-local"]);
    expect(cliMock.mock.invocationCallOrder[0]).toBeLessThan(dashboardFetch.mock.invocationCallOrder[0]);
  });

  it("moves an owner's cloud pick off too, and speaks as it is when already local", async () => {
    hermesConfig.values["tts.provider"] = "openai";
    await lib.speakWithHermes("hello");
    expect(sets()).toEqual(["config set tts.provider clawbox-local"]);
    cliMock.mockClear();
    hermesConfig.values["tts.provider"] = "clawbox-local";
    expect((await lib.speakWithHermes("hello")).ok).toBe(true);
    expect(cliMock).not.toHaveBeenCalled();
  });

  it("speaks nothing, and sends the text nowhere, without an on-box voice", async () => {
    hermesConfig.values = { "tts.provider": "edge" };
    const spoken = await lib.speakWithHermes("hello");
    expect(spoken).toMatchObject({ ok: false, code: "cloud_ai_locked", status: 409 });
    expect(dashboardFetch).not.toHaveBeenCalled();
  });

  it("does not speak when the move onto the box's voice fails", async () => {
    cliMock.mockResolvedValue({ code: 1, stdout: "", stderr: "no" });
    const spoken = await lib.speakWithHermes("hello");
    expect(spoken).toMatchObject({ ok: false, code: "cloud_ai_locked" });
    expect(dashboardFetch).not.toHaveBeenCalled();
  });

  it("leaves the selection alone without the lock", async () => {
    locked.value = false;
    expect((await lib.speakWithHermes("hello")).ok).toBe(true);
    expect(cliMock).not.toHaveBeenCalled();
  });
});

describe("what the move remembers, so lifting the lock gives it back", () => {
  it("remembers ClawBox AI's own cloud voice through the plan's stand-down", async () => {
    hermesConfig.values = {
      ...LOCAL,
      "tts.provider": "openai",
      "tts.openai.base_url": "https://clawbox.com/api/ai",
      "tts.openai.api_key": "claw_token",
      "tts.openai.voice": "nova",
    };
    await lib.speakWithHermes("hello");
    expect(markers.standdown).toHaveBeenCalledWith("nova");
    expect(markers.lock).not.toHaveBeenCalled();
    expect(markers.standdown.mock.invocationCallOrder[0]).toBeLessThan(cliMock.mock.invocationCallOrder[0]);
  });

  it("remembers an owner's own pick by name, and nothing for the factory edge", async () => {
    hermesConfig.values = { ...LOCAL, "tts.provider": "elevenlabs" };
    await lib.speakWithHermes("hello");
    expect(markers.lock).toHaveBeenCalledWith("elevenlabs");
    markers.lock.mockClear();
    hermesConfig.values = { ...LOCAL, "tts.provider": "openai", "tts.openai.base_url": "http://192.168.7.9:8880/v1", "tts.openai.api_key": "sk-own" }; // public-hygiene: allow a private-range address the test needs to exercise the local-only rule
    await lib.speakWithHermes("hello");
    expect(markers.lock).toHaveBeenCalledWith("openai");
    expect(markers.standdown).not.toHaveBeenCalled();
    markers.lock.mockClear();
    hermesConfig.values = { ...LOCAL, "tts.provider": "edge" };
    await lib.speakWithHermes("hello");
    expect(markers.lock).not.toHaveBeenCalled();
    expect(markers.standdown).not.toHaveBeenCalled();
  });
});
