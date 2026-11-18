import { beforeEach, describe, expect, it, vi } from "vitest";

// TASK-2649: on a box running Hermes, a spoken reply goes through Hermes' own
// speech route, which runs the box's voice (clawbox-tts.sh) as its
// `clawbox-local` command. When Kokoro's memory guard refuses, Hermes answers
// 400 with the script's stderr in `detail`; that is the box short of memory
// (`local_memory`, with the guard's numbers), not a cloud voice refusing.

const locked = vi.hoisted(() => ({ value: false }));
vi.mock("@/lib/feature-engine", () => ({ cloudAiLockOn: async () => locked.value }));
const hermesConfig = vi.hoisted(() => ({ values: {} as Record<string, string | undefined> }));
vi.mock("@/lib/hermes-cli", () => ({ runHermesCli: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })) }));
vi.mock("@/lib/hermes-config-cache", () => ({
  hermesConfigGet: async (key: string) => hermesConfig.values[key],
  hermesConfigGetMany: async (keys: string[]) => Object.fromEntries(keys.map((k) => [k, hermesConfig.values[k]])),
  hermesConfigReadPending: () => false,
}));
const dashboardFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hermes-dashboard-auth", () => ({ dashboardFetch: (...a: unknown[]) => dashboardFetch(...a) }));
vi.mock("@/lib/harness/credentials", () => ({ CLAWBOX_AI_PROXY_URL: "https://clawbox.com/api/ai" }));
vi.mock("@/lib/hermes-voice-standdown", () => ({
  rememberHermesVoiceStanddown: vi.fn(async () => {}),
  rememberHermesVoiceLock: vi.fn(async () => {}),
}));

// Hermes' answer, as a lab board gave it with 2.6 GB free (2026-11-17).
const GUARD_DETAIL =
  "TTS chunk 1 failed (clawbox-local): TTS generation failed (clawbox-local): TTS provider 'clawbox-local' exited with code 1: "
  + "stderr: clawbox-tts: Kokoro could not speak this text (voice 'af_heart') — no on-device fallback, the gateway's cloud voice takes over.\n"
  + "  - kokoro: skipped, 2600MB available and the CUDA path peaks at ~2.6GB (need >=3000MB)\n"
  + "  Check the Kokoro install with: sudo bash /home/clawbox/clawbox/install.sh --step openclaw_tts";

const answer = (status: number, body: string) => new Response(body, { status });

let lib: typeof import("@/lib/hermes-tts");

beforeEach(async () => {
  vi.resetModules();
  locked.value = false;
  hermesConfig.values = {
    "tts.provider": "clawbox-local",
    "tts.providers.clawbox-local.type": "command",
    "tts.providers.clawbox-local.command": "/home/clawbox/clawbox/scripts/openclaw/clawbox-tts.sh --text-file={input_path} -- {output_path}",
  };
  dashboardFetch.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  lib = await import("@/lib/hermes-tts");
});

describe("kokoroMemoryShortfall", () => {
  it("reads the guard's numbers out of Hermes' wrapping, as gigabytes", async () => {
    const { kokoroMemoryShortfall } = await import("@/lib/kokoro-memory-guard");
    expect(kokoroMemoryShortfall(GUARD_DETAIL)).toEqual({ available: "2.6", needed: "3" });
    expect(kokoroMemoryShortfall("kokoro: skipped, 2412MB available and the CUDA path peaks at ~2.6GB (need >=3000MB)"))
      .toEqual({ available: "2.4", needed: "3" });
  });

  it("is null for any other reason the script gives", async () => {
    const { kokoroMemoryShortfall } = await import("@/lib/kokoro-memory-guard");
    expect(kokoroMemoryShortfall("  - kokoro: cold start produced no audio")).toBeNull();
    expect(kokoroMemoryShortfall("TTS provider 'edge' failed: network unreachable")).toBeNull();
    expect(kokoroMemoryShortfall("")).toBeNull();
  });
});

describe("speakWithHermes on a refusal from Hermes' speech route", () => {
  it("names Kokoro's memory guard local_memory, with its numbers, not cloud_refused", async () => {
    dashboardFetch.mockResolvedValue(answer(400, JSON.stringify({ detail: GUARD_DETAIL })));
    expect(await lib.speakWithHermes("hello")).toEqual({
      ok: false,
      code: "local_memory",
      status: 502,
      shortfall: { available: "2.6", needed: "3" },
    });
  });

  it("reads the guard from a body that is not JSON too", async () => {
    dashboardFetch.mockResolvedValue(answer(500, `Internal error: ${GUARD_DETAIL}`));
    expect(await lib.speakWithHermes("hello")).toMatchObject({ ok: false, code: "local_memory", shortfall: { available: "2.6", needed: "3" } });
  });

  it("keeps cloud_refused for any other refusal", async () => {
    dashboardFetch.mockResolvedValue(answer(400, JSON.stringify({ detail: "TTS provider 'edge' failed: network unreachable" })));
    expect(await lib.speakWithHermes("hello")).toEqual({ ok: false, code: "cloud_refused", status: 502 });
  });

  it("keeps cannot_change for a 401, whatever its body says", async () => {
    dashboardFetch.mockResolvedValue(answer(401, JSON.stringify({ detail: GUARD_DETAIL })));
    expect(await lib.speakWithHermes("hello")).toEqual({ ok: false, code: "cannot_change", status: 502 });
  });

  it("keeps cloud_refused, without throwing, when the refusal's body cannot be read", async () => {
    const used = answer(400, JSON.stringify({ detail: GUARD_DETAIL }));
    await used.text();
    dashboardFetch.mockResolvedValue(used);
    expect(await lib.speakWithHermes("hello")).toEqual({ ok: false, code: "cloud_refused", status: 502 });
    const locked = answer(400, JSON.stringify({ detail: GUARD_DETAIL }));
    locked.body?.getReader();
    dashboardFetch.mockResolvedValue(locked);
    expect(await lib.speakWithHermes("hello")).toEqual({ ok: false, code: "cloud_refused", status: 502 });
  });

  it("does not read a refusal body past its bound", async () => {
    dashboardFetch.mockResolvedValue(answer(400, `${"x".repeat(70 * 1024)}${GUARD_DETAIL}`));
    expect(await lib.speakWithHermes("hello")).toEqual({ ok: false, code: "cloud_refused", status: 502 });
  });
});
