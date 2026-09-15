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
vi.mock("child_process", () => ({
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
});
