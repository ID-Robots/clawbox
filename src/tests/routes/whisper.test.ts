import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /setup-api/whisper — the speech-model size picker.
 *
 * The device work is `src/lib/whisper-models.ts` and has its own suite; this
 * pins what the ROUTE decides: who may ask, whether the download fits, that
 * the unit is only pointed at a size whose weights actually arrived, and that
 * a failed fetch leaves the box transcribing with what it had.
 */

const owner = { value: true };
vi.mock("@/lib/owner-session", () => ({ hasOwnerSession: async () => owner.value }));
vi.mock("@/lib/route-auth", () => ({ requireSession: async () => null }));

/** The root-step follower behind `{action:"install-engine"}`; its real module reaches systemd. */
const followMock = vi.fn();
vi.mock("@/lib/root-step-follow", () => ({ followRootStep: (...a: unknown[]) => followMock(...a) }));

const disk = { free: 100 * 1024 * 1024 * 1024 as number | null };
vi.mock("@/lib/project-import", () => ({ freeBytes: async () => disk.free }));

const state = {
  installed: true,
  running: true,
  active: "base",
  sizes: [
    { id: "tiny", bytes: 78 * 1024 * 1024, cached: false },
    { id: "base", bytes: 150 * 1024 * 1024, cached: true },
    { id: "small", bytes: 500 * 1024 * 1024, cached: false },
    { id: "medium", bytes: 1600 * 1024 * 1024, cached: false },
  ],
};
const pointed = vi.fn(async () => ({ ok: true as boolean, error: undefined as string | undefined }));
const restarted = vi.fn(async () => ({ ok: true as boolean }));
const removed = vi.fn(async () => ({ ok: true as boolean, error: undefined as string | undefined, code: undefined as string | undefined }));
const uninstalled = vi.fn(async () => ({ ok: true as boolean, freedBytes: 228 * 1024 * 1024 as number | null, error: undefined as string | undefined, code: undefined as string | undefined }));

/** What the engine uninstall releases once the engine is gone. */
const sync = vi.fn(async (..._a: unknown[]) => false);
const primary = { value: "cloud" as string };
const setPrimary = vi.fn(async (..._a: unknown[]) => {});
const cleared = vi.fn(async (..._a: unknown[]) => {});
const gatewayRestart = vi.fn(async () => {});
vi.mock("@/lib/stt-channel", () => ({ syncChannelAudio: (...a: unknown[]) => sync(...a) }));
vi.mock("@/lib/stt-preference", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stt-preference")>()),
  getSttPrimary: async () => primary.value,
  setSttPrimary: (...a: unknown[]) => setPrimary(...a),
}));
vi.mock("@/lib/clawai-cloud-choice", () => ({ clearOwnerChoice: (...a: unknown[]) => cleared(...a) }));
// A partial mock over importActual, so GatewayNotReadyError is the real class
// the route narrows on (openclaw-config-mock-completeness.test.ts).
vi.mock("@/lib/openclaw-config", async () => ({
  ...(await vi.importActual<typeof import("@/lib/openclaw-config")>("@/lib/openclaw-config")),
  openclawIsAbsent: () => false,
  restartGateway: () => gatewayRestart(),
}));

vi.mock("@/lib/whisper-models", () => ({
  readWhisperState: async () => structuredClone(state),
  setActiveWhisperSize: (...a: unknown[]) => pointed(...(a as [])),
  restartWhisper: () => restarted(),
  removeWhisperSize: (...a: unknown[]) => removed(...(a as [])),
  uninstallWhisperEngine: () => uninstalled(),
  whisperCacheDir: (size: string) => `/tmp/whisper-${size}`,
  whisperFetchScript: () => "/tmp/fetch-whisper-model.py",
}));

/**
 * The fetcher child, standing in for `scripts/fetch-whisper-model.py`.
 *
 * `leavesWeights` is what makes "exited 0 with an incomplete cache" testable:
 * the route re-measures rather than trusting the exit code, so the fake has to
 * be able to exit 0 and leave nothing behind.
 */
const child = { code: 0, stdout: ["Fetching the small model..."], stderr: "", leavesWeights: true };
vi.mock("child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("child_process")>()),
  spawn: () => {
    const handlers: Record<string, ((...a: unknown[]) => void)[]> = {};
    const outHandlers: ((chunk: string) => void)[] = [];
    const errHandlers: ((chunk: string) => void)[] = [];
    const fake = {
      pid: 4242,
      stdout: { setEncoding() {}, on(_e: string, fn: (c: string) => void) { outHandlers.push(fn); } },
      stderr: { setEncoding() {}, on(_e: string, fn: (c: string) => void) { errHandlers.push(fn); } },
      on(event: string, fn: (...a: unknown[]) => void) {
        (handlers[event] ??= []).push(fn);
        return fake;
      },
    };
    setTimeout(() => {
      for (const line of child.stdout) for (const fn of outHandlers) fn(`${line}\n`);
      if (child.stderr) for (const fn of errHandlers) fn(child.stderr);
      if (child.code === 0 && child.leavesWeights) {
        for (const size of state.sizes) if (!size.cached) size.cached = true;
      }
      for (const fn of handlers.close ?? []) fn(child.code);
    }, 0);
    return fake;
  },
}));

async function load() {
  vi.resetModules();
  return import("@/app/setup-api/whisper/route");
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/setup-api/whisper", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function readStream(res: Response): Promise<Record<string, unknown>[]> {
  const text = await res.text();
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

beforeEach(() => {
  owner.value = true;
  disk.free = 100 * 1024 * 1024 * 1024;
  state.installed = true;
  state.active = "base";
  for (const size of state.sizes) size.cached = size.id === "base";
  child.code = 0;
  child.stdout = ["Fetching the small model..."];
  child.stderr = "";
  child.leavesWeights = true;
  pointed.mockClear().mockResolvedValue({ ok: true, error: undefined });
  restarted.mockClear().mockResolvedValue({ ok: true });
  removed.mockClear().mockResolvedValue({ ok: true, error: undefined, code: undefined });
  uninstalled.mockClear().mockResolvedValue({ ok: true, freedBytes: 228 * 1024 * 1024, error: undefined, code: undefined });
  sync.mockReset().mockResolvedValue(false);
  primary.value = "cloud";
  setPrimary.mockReset().mockResolvedValue(undefined);
  cleared.mockReset().mockResolvedValue(undefined);
  gatewayRestart.mockReset().mockResolvedValue(undefined);
});

afterEach(() => vi.restoreAllMocks());

describe("GET /setup-api/whisper", () => {
  it("answers the picker's facts: the sizes, which is in use, and the free disk", async () => {
    const { GET } = await load();
    const body = await (await GET(new Request("http://localhost/setup-api/whisper"))).json();

    expect(body.active).toBe("base");
    expect(body.sizes.map((s: { id: string }) => s.id)).toEqual(["tiny", "base", "small", "medium"]);
    expect(body.freeBytes).toBe(100 * 1024 * 1024 * 1024);
    expect(body.reserveBytes).toBeGreaterThan(0);
  });
});

describe("POST /setup-api/whisper", () => {
  it("refuses the MCP bearer and any other site's page", async () => {
    const { POST } = await load();

    owner.value = false;
    const notOwner = await POST(post({ size: "small" }));
    expect(notOwner.status).toBe(403);
    expect((await notOwner.json()).code).toBe("owner_only");

    owner.value = true;
    const elsewhere = await POST(post({ size: "small" }, { Origin: "http://evil.example" }));
    expect(elsewhere.status).toBe(403);
    expect((await elsewhere.json()).code).toBe("cross_origin");
  });

  it("refuses a size it does not offer", async () => {
    const { POST } = await load();
    const res = await POST(post({ size: "large-v3" }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid");
  });

  it("refuses when speech itself is not installed", async () => {
    state.installed = false;
    const { POST } = await load();
    const res = await POST(post({ size: "small" }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("not_installed");
  });

  it("refuses a download that would not fit, before a byte is fetched", async () => {
    disk.free = 600 * 1024 * 1024; // 500 MB model, 512 MiB reserve
    const { POST } = await load();
    const res = await POST(post({ size: "small" }));
    const body = await res.json();

    expect(res.status).toBe(507);
    expect(body.code).toBe("disk_full");
    expect(body.requiredBytes).toBe(500 * 1024 * 1024);
    expect(body.freeBytes).toBe(600 * 1024 * 1024);
    expect(pointed).not.toHaveBeenCalled();
  });

  it("fetches, then points the unit, then restarts — in that order", async () => {
    // The order is the promise the card makes: the microphone keeps using the
    // size that is here until the new one has actually arrived.
    const { POST } = await load();
    const lines = await readStream(await POST(post({ size: "small" })));

    expect(pointed).toHaveBeenCalledWith("small");
    expect(restarted).toHaveBeenCalled();
    expect(lines.at(-1)).toMatchObject({ success: true, size: "small", restarted: true });
  });

  it("leaves the unit alone when the download fails, and says why", async () => {
    child.code = 1;
    child.stderr = "Download failed: connection reset\n";
    const { POST } = await load();
    const lines = await readStream(await POST(post({ size: "small" })));

    expect(pointed).not.toHaveBeenCalled();
    expect(lines.at(-1)).toMatchObject({ error: "Download failed: connection reset" });
  });

  it("refuses to switch when the download exits 0 with an incomplete cache", async () => {
    // `whisper_model_cached`'s own judgement, applied to the route's outcome.
    child.leavesWeights = false;
    const { POST } = await load();
    const lines = await readStream(await POST(post({ size: "small" })));

    expect(pointed).not.toHaveBeenCalled();
    expect(String(lines.at(-1)?.error)).toContain("not complete");
  });

  it("switches a size already on the box without downloading anything", async () => {
    state.sizes[2].cached = true;
    const { POST } = await load();
    const lines = await readStream(await POST(post({ size: "small" })));

    expect(pointed).toHaveBeenCalledWith("small");
    expect(lines.some((l) => typeof l.status === "string" && String(l.status).includes("Fetching"))).toBe(false);
    expect(lines.at(-1)).toMatchObject({ success: true });
  });

  it("calls a change that landed a success even when the restart did not", async () => {
    // The weights are here and the unit names them; the engine picks them up on
    // its next start. Saying "failed" would send the owner to repeat it.
    state.sizes[2].cached = true;
    restarted.mockResolvedValue({ ok: false });
    const { POST } = await load();
    const lines = await readStream(await POST(post({ size: "small" })));

    expect(lines.at(-1)).toMatchObject({ success: true, restarted: false });
    expect(String(lines.at(-1)?.status)).toContain("after the next restart");
  });
});

describe("POST /setup-api/whisper {action:\"install-engine\"}", () => {
  beforeEach(() => {
    followMock.mockReset();
    state.installed = false;
  });

  it("refuses the MCP bearer, like every write here", async () => {
    const { POST } = await load();
    owner.value = false;
    const res = await POST(post({ action: "install-engine" }));
    expect(res.status).toBe(403);
    expect(followMock).not.toHaveBeenCalled();
  });

  it("runs the voice_whisper_install root step and streams its lines, then a closing success", async () => {
    // The engine is the owner's click since 2026-09-15: no install or update
    // puts faster-whisper on a box, so this step is the only path to it.
    followMock.mockImplementation(async (step: string, opts: { onStatus: (line: string) => void }) => {
      opts.onStatus("=== On-device speech-to-text (faster-whisper) ===");
      opts.onStatus("  faster-whisper ready");
      return { ok: true };
    });
    const { POST } = await load();
    const res = await POST(post({ action: "install-engine" }));
    expect(res.status).toBe(200);
    expect(followMock.mock.calls[0][0]).toBe("voice_whisper_install");
    const out = await readStream(res);
    expect(out.map((l) => l.status)).toContain("  faster-whisper ready");
    expect(out[out.length - 1]).toMatchObject({ success: true });
    // Nothing of the size picker ran: no fetch, no unit write, no restart.
    expect(pointed).not.toHaveBeenCalled();
    expect(restarted).not.toHaveBeenCalled();
  });

  it("closes with the step's error when it failed", async () => {
    followMock.mockResolvedValue({ ok: false, error: "faster-whisper does not apply to this board (no CUDA toolkit)" });
    const { POST } = await load();
    const out = await readStream(await POST(post({ action: "install-engine" })));
    expect(out[out.length - 1]).toEqual({ error: "faster-whisper does not apply to this board (no CUDA toolkit)" });
  });

  it("refuses an engine install that would not fit before anything starts, and a later one with room proceeds", async () => {
    disk.free = 1024 * 1024 * 1024;
    const { POST } = await load();
    const res = await POST(post({ action: "install-engine" }));
    const body = await res.json();
    expect(res.status).toBe(507);
    expect(body.code).toBe("disk_full");
    expect(body.requiredBytes).toBe(3 * 1024 * 1024 * 1024);
    expect(followMock).not.toHaveBeenCalled();

    // The refusal left no install marked as running.
    disk.free = 100 * 1024 * 1024 * 1024;
    followMock.mockResolvedValue({ ok: true });
    const next = await POST(post({ action: "install-engine" }));
    expect(next.status).toBe(200);
    await readStream(next);
    expect(followMock).toHaveBeenCalledTimes(1);
  });

  it("refuses when the engine is already installed — the sizes are the picker's job", async () => {
    state.installed = true;
    const { POST } = await load();
    const res = await POST(post({ action: "install-engine" }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("already_installed");
    expect(followMock).not.toHaveBeenCalled();
  });
});

describe("DELETE /setup-api/whisper", () => {
  function del(size: string, headers: Record<string, string> = {}): Request {
    return new Request(`http://localhost/setup-api/whisper?size=${size}`, { method: "DELETE", headers });
  }

  it("refuses anyone but the owner on this box's own pages", async () => {
    const { DELETE } = await load();

    owner.value = false;
    expect((await DELETE(del("small"))).status).toBe(403);

    owner.value = true;
    expect((await DELETE(del("small", { Origin: "http://evil.example" }))).status).toBe(403);
  });

  it("removes a size and says how much came back", async () => {
    const { DELETE } = await load();
    const res = await DELETE(del("small"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(removed).toHaveBeenCalledWith("small");
    expect(body.sizes).toHaveLength(4);
  });

  it("passes the in-use refusal through as a 409", async () => {
    removed.mockResolvedValue({ ok: false, error: "still in use", code: "in_use" });
    const { DELETE } = await load();
    const res = await DELETE(del("base"));

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("in_use");
  });

  it("refuses a size it does not offer before anything is touched", async () => {
    const { DELETE } = await load();
    const res = await DELETE(del(encodeURIComponent("../../etc")));

    expect(res.status).toBe(400);
    expect(removed).not.toHaveBeenCalled();
  });
});

/**
 * `?scope=engine` — Settings → Local AI's Uninstall on the Whisper row: every
 * size, the stamp and the unit, in one request.
 */
describe("DELETE /setup-api/whisper?scope=engine", () => {
  function del(headers: Record<string, string> = {}): Request {
    return new Request("http://localhost/setup-api/whisper?scope=engine", { method: "DELETE", headers });
  }

  it("refuses the MCP bearer and any other site's page before anything is touched", async () => {
    const { DELETE } = await load();

    owner.value = false;
    const notOwner = await DELETE(del());
    expect(notOwner.status).toBe(403);
    expect((await notOwner.json()).code).toBe("owner_only");

    owner.value = true;
    const elsewhere = await DELETE(del({ Origin: "http://evil.example" }));
    expect(elsewhere.status).toBe(403);
    expect((await elsewhere.json()).code).toBe("cross_origin");
    expect(uninstalled).not.toHaveBeenCalled();
  });

  it("takes the engine off and answers what came back beside the re-read state", async () => {
    state.installed = false;
    const { DELETE } = await load();
    const res = await DELETE(del());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(uninstalled).toHaveBeenCalledTimes(1);
    expect(body).toMatchObject({ ok: true, freedBytes: 228 * 1024 * 1024, installed: false });
    expect(removed).not.toHaveBeenCalled();
  });

  it("passes the device's refusal through with its code", async () => {
    uninstalled.mockResolvedValue({ ok: false, freedBytes: null, error: "Could not remove the service file.", code: "remove_failed" });
    const { DELETE } = await load();
    const res = await DELETE(del());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Could not remove the service file.", code: "remove_failed" });
  });

  it("refuses while a size is being fetched, so the fetcher cannot write into a cache being deleted", async () => {
    const { POST, DELETE } = await load();
    const fetching = await POST(post({ size: "small" }));
    const res = await DELETE(del());

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("busy");
    expect(uninstalled).not.toHaveBeenCalled();
    await readStream(fetching);
  });

  it("refuses while the ENGINE is being installed — its own pre-download writes into the same cache", async () => {
    state.installed = false;
    let finish: () => void = () => {};
    followMock.mockImplementation(() => new Promise<{ ok: boolean }>((resolve) => { finish = () => resolve({ ok: true }); }));
    const { POST, DELETE } = await load();
    const installing = await POST(post({ action: "install-engine" }));
    const res = await DELETE(del());

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("busy");
    expect(uninstalled).not.toHaveBeenCalled();
    finish();
    await readStream(installing);
  });

  it("takes its row out of the channel audio list, settles transcription on the cloud and says a local pick fell back", async () => {
    primary.value = "local";
    sync.mockResolvedValue(true);
    state.installed = false;
    const { DELETE } = await load();
    const res = await DELETE(del());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(sync).toHaveBeenCalledWith(["cloud", "local"], false);
    expect(setPrimary).toHaveBeenCalledWith("cloud");
    expect(cleared).toHaveBeenCalledWith("stt");
    expect(gatewayRestart).toHaveBeenCalledTimes(1);
    expect(body.fallback).toEqual({ requested: "local", reason: "not_installed" });
    expect(body.warning).toBeUndefined();
  });

  it("restarts nothing when the list named no local row, and claims no fallback over a cloud pick", async () => {
    const { DELETE } = await load();
    const res = await DELETE(del());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(gatewayRestart).not.toHaveBeenCalled();
    expect(body.fallback).toBeUndefined();
  });

  it("keeps a landed uninstall a success when the gateway restart fails, and says so", async () => {
    sync.mockResolvedValue(true);
    gatewayRestart.mockRejectedValue(new Error("nothing listening"));
    const { DELETE } = await load();
    const res = await DELETE(del());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(typeof body.warning).toBe("string");
  });

  it("says the gateway is still coming back, not that its restart failed, when it has not finished restarting", async () => {
    sync.mockResolvedValue(true);
    const { DELETE } = await load();
    // After the load: it resets the module registry, and the route narrows on
    // the class from THAT registry.
    const { GatewayNotReadyError } = await import("@/lib/openclaw-config");
    gatewayRestart.mockRejectedValue(new GatewayNotReadyError());
    const res = await DELETE(del());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.warning).toMatch(/has not finished restarting/);
  });

  it("touches no transcription setting when the device refused the removal", async () => {
    uninstalled.mockResolvedValue({ ok: false, freedBytes: null, error: "Could not remove the service file.", code: "remove_failed" });
    const { DELETE } = await load();
    const res = await DELETE(del());

    expect(res.status).toBe(500);
    expect(sync).not.toHaveBeenCalled();
    expect(setPrimary).not.toHaveBeenCalled();
  });
});
