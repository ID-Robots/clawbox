import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelBackgroundTask,
  getBackgroundTask,
  resetBackgroundTasksForTests,
  setBackgroundTaskQueueMeasureForTests,
} from "@/lib/background-tasks";

/**
 * Settings → Local AI with two Install presses on two rows (TASK-2128): Kokoro,
 * then Whisper while Kokoro installs. Neither press is refused. The two are
 * root steps that pip-install into one user site and write the agent's config,
 * so Whisper waits its turn — queued, its own task, its own Cancel — and starts
 * by itself when Kokoro's install ends.
 */

vi.mock("@/lib/owner-session", () => ({ hasPersonSession: async () => true }));
vi.mock("@/lib/route-auth", () => ({ requireSession: async () => null }));

/** One pending root step per call, finished by the test. */
type Run = { step: string; finish: (outcome: { ok: boolean; error?: string }) => void };
const runs: Run[] = [];
vi.mock("@/lib/root-step-follow", () => ({
  followRootStep: (step: string) => new Promise((resolve) => { runs.push({ step, finish: resolve }); }),
}));

const disk = { free: 100 * 1024 ** 3 };
vi.mock("@/lib/project-import", () => ({ freeBytes: async () => disk.free }));

// The Kokoro route's neighbours.
vi.mock("@/lib/kokoro-uninstall", () => ({ uninstallKokoro: async () => ({ ok: true, freedBytes: 0 }) }));
vi.mock("@/app/setup-api/tts/route", () => ({ POST: async () => new Response("{}") }));
vi.mock("@/lib/voice-output-store", () => ({ readVoiceState: async () => ({ choice: "auto" }), writeVoiceState: async () => {} }));
vi.mock("@/lib/clawai-cloud-choice", () => ({ clearOwnerChoice: async () => {} }));
// The Whisper route's.
vi.mock("@/lib/stt-channel", () => ({ syncChannelAudio: async () => false, reconcileChannelAudio: async () => true }));
vi.mock("@/lib/openclaw-config", async () => ({
  ...(await vi.importActual<typeof import("@/lib/openclaw-config")>("@/lib/openclaw-config")),
  openclawIsAbsent: () => false,
  restartGateway: async () => {},
}));
vi.mock("@/lib/whisper-models", () => ({
  readWhisperState: async () => ({ installed: false, running: false, active: null, sizes: [] }),
  setActiveWhisperSize: async () => ({ ok: true }),
  restartWhisper: async () => ({ ok: true }),
  removeWhisperSize: async () => ({ ok: true }),
  uninstallWhisperEngine: async () => ({ ok: true, freedBytes: 0 }),
  whisperCacheDir: (size: string) => `/tmp/whisper-${size}`,
  whisperFetchScript: () => "/tmp/fetch-whisper-model.py",
}));

const post = (url: string, body: unknown) => new Request(`http://localhost${url}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/** The first line only, leaving the rest of the stream to a later read. */
async function firstLine(res: Response): Promise<{ line: Record<string, unknown>; rest: Promise<Record<string, unknown>[]> }> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  const [head, ...tail] = text.split("\n");
  const rest = (async () => {
    let more = tail.join("\n");
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      more += decoder.decode(value, { stream: true });
    }
    return more.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  })();
  return { line: JSON.parse(head), rest };
}

async function load() {
  vi.resetModules();
  const tts = await import("@/app/setup-api/tts/install/route");
  const whisper = await import("@/app/setup-api/whisper/route");
  return { installKokoro: () => tts.POST(post("/setup-api/tts/install", {})), installWhisper: () => whisper.POST(post("/setup-api/whisper", { action: "install-engine" })) };
}

beforeEach(() => {
  resetBackgroundTasksForTests();
  setBackgroundTaskQueueMeasureForTests({ availableMemory: () => 6 * 1024 ** 3, freeDisk: () => 100 * 1024 ** 3 });
  runs.length = 0;
  disk.free = 100 * 1024 ** 3;
});

describe("Install on Kokoro, then on Whisper while Kokoro installs", () => {
  it("accepts both — no 'already running' refusal — and starts Whisper by itself when Kokoro is done", async () => {
    const { installKokoro, installWhisper } = await load();
    const kokoro = await installKokoro();
    expect(kokoro.status).toBe(200);
    const k = await firstLine(kokoro);
    await vi.waitFor(() => expect(runs.map((r) => r.step)).toEqual(["voice_kokoro_install"]));

    const whisper = await installWhisper();
    expect(whisper.status).toBe(200);
    const w = await firstLine(whisper);
    expect(w.line).toMatchObject({
      kind: "whisper-engine-install",
      status: "Queued — starts after Kokoro",
      queued: true,
      behind: { kind: "voice-kokoro-install", label: "Kokoro" },
    });
    expect(getBackgroundTask(w.line.taskId as string)?.state).toBe("queued");
    // Never two root steps pip-installing into one user site at once.
    await new Promise((r) => setTimeout(r, 20));
    expect(runs).toHaveLength(1);

    // A second press on the Whisper row shows the same queued install.
    const again = await installWhisper();
    const a = await firstLine(again);
    expect(a.line.taskId).toBe(w.line.taskId);

    runs[0].finish({ ok: true });
    expect((await k.rest).at(-1)).toMatchObject({ success: true, status: "The voice on this box is installed." });
    await vi.waitFor(() => expect(runs.map((r) => r.step)).toEqual(["voice_kokoro_install", "voice_whisper_install"]));
    runs[1].finish({ ok: true });

    const rest = await w.rest;
    expect(rest).toContainEqual({ status: "Installing speech on this box (faster-whisper)…", queued: false });
    expect(rest.at(-1)).toMatchObject({ success: true, status: "Speech on this box is installed." });
    expect((await a.rest).at(-1)).toMatchObject({ success: true });
  });

  it("drops a queued Whisper install on Cancel: it never runs, and nothing else is touched", async () => {
    const { installKokoro, installWhisper } = await load();
    const k = await firstLine(await installKokoro());
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    const w = await firstLine(await installWhisper());

    expect(cancelBackgroundTask(w.line.taskId as string).ok).toBe(true);
    expect((await w.rest).at(-1)).toMatchObject({ cancelled: true, code: "cancelled" });
    expect(getBackgroundTask(k.line.taskId as string)?.state).toBe("running");

    runs[0].finish({ ok: true });
    await k.rest;
    await new Promise((r) => setTimeout(r, 20));
    expect(runs.map((r) => r.step)).toEqual(["voice_kokoro_install"]);
  });

  it("still says a real failure on the row: a queued install that finds the disk spent when its turn comes", async () => {
    const { installKokoro, installWhisper } = await load();
    await firstLine(await installKokoro());
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    const w = await firstLine(await installWhisper());
    // Kokoro spends the room the Whisper press measured as free.
    disk.free = 1024 ** 3;
    runs[0].finish({ ok: true });

    const last = (await w.rest).at(-1)!;
    expect(last).toMatchObject({ error: "There is not enough room on this box for that download.", code: "disk_full" });
    expect(runs.map((r) => r.step)).toEqual(["voice_kokoro_install"]);
  });

  it("still refuses a click that cannot fit at all, up front, with its figures", async () => {
    disk.free = 1024 ** 3;
    const { installWhisper } = await load();
    const res = await installWhisper();
    expect(res.status).toBe(507);
    expect(await res.json()).toMatchObject({ code: "disk_full" });
  });
});
