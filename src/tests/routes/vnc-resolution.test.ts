import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /setup-api/vnc/resolution — the remote-desktop resolution. The config store,
 * the env-file writer and systemctl are faked; what this pins is the ordering:
 * a failed save leaves the preference and the env file as they were, and a
 * value whose restart failed is restarted again on retry and reported non-2xx.
 */

const PREF_KEY = "pref:desktop_vnc_resolution";

const h = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  envFile: null as string | null,
  envWrites: [] as string[],
  envWriteFails: false,
  prefSetFails: false,
  mainPid: "4242",
}));

vi.mock("@/lib/route-auth", () => ({ requireSession: async () => null }));
vi.mock("@/lib/config-store", () => ({
  get: async (key: string) => h.store.get(key),
  set: async (key: string, value: unknown) => {
    h.store.set(key, value);
  },
  setMany: async (entries: Record<string, unknown>) => {
    if (h.prefSetFails && "pref:desktop_vnc_resolution" in entries) throw new Error("disk full");
    for (const [key, value] of Object.entries(entries)) h.store.set(key, value);
  },
}));
vi.mock("@/lib/vnc-resolution-server", () => ({
  writeVncResolutionEnv: async (value: string) => {
    h.envWrites.push(value);
    if (h.envWriteFails) throw new Error("EACCES");
    h.envFile = value;
  },
}));
vi.mock("child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("child_process")>()),
  execFile: (_file: string, _args: string[], _opts: unknown, cb: (err: Error | null, out?: unknown) => void) => {
    cb(null, { stdout: `${h.mainPid}\n`, stderr: "" });
  },
}));

import { GET, POST } from "@/app/setup-api/vnc/resolution/route";

let kill: ReturnType<typeof vi.spyOn>;

function post(resolution: unknown): Request {
  return new Request("http://localhost/setup-api/vnc/resolution", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resolution }),
  });
}

beforeEach(() => {
  h.store.clear();
  h.envFile = null;
  h.envWrites.length = 0;
  h.envWriteFails = false;
  h.prefSetFails = false;
  h.mainPid = "4242";
  kill = vi.spyOn(process, "kill").mockImplementation(() => true);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("GET /setup-api/vnc/resolution", () => {
  it("answers the saved preset, falling back to the default", async () => {
    expect(await (await GET(new Request("http://localhost/x"))).json()).toMatchObject({ resolution: "1280x720", default: "1280x720" });
    h.store.set(PREF_KEY, "1920x1080");
    expect(await (await GET(new Request("http://localhost/x"))).json()).toMatchObject({ resolution: "1920x1080" });
  });
});

describe("POST /setup-api/vnc/resolution", () => {
  it("rejects anything off the preset list without touching either store", async () => {
    const res = await POST(post("3840x2160"));
    expect(res.status).toBe(400);
    expect(h.envWrites).toEqual([]);
    expect(h.store.has(PREF_KEY)).toBe(false);
  });

  it("saves, writes the env file and restarts the desktop on a change", async () => {
    const res = await POST(post("1600x900"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ resolution: "1600x900", restarted: true });
    expect(h.envFile).toBe("1600x900");
    expect(h.store.get(PREF_KEY)).toBe("1600x900");
    expect(kill).toHaveBeenCalledWith(4242, "SIGKILL");
  });

  it("leaves the preference unchanged when the env file cannot be written", async () => {
    h.store.set(PREF_KEY, "1280x720");
    h.envWriteFails = true;
    const res = await POST(post("1920x1080"));
    expect(res.status).toBe(500);
    expect(h.store.get(PREF_KEY)).toBe("1280x720");
    expect(kill).not.toHaveBeenCalled();
  });

  it("puts the env file back when the preference cannot be saved", async () => {
    h.store.set(PREF_KEY, "1600x900");
    h.envFile = "1600x900";
    h.prefSetFails = true;
    const res = await POST(post("1920x1080"));
    expect(res.status).toBe(500);
    expect(h.envWrites).toEqual(["1920x1080", "1600x900"]);
    expect(h.envFile).toBe("1600x900");
    expect(h.store.get(PREF_KEY)).toBe("1600x900");
    expect(kill).not.toHaveBeenCalled();
  });

  it("does not restart for a value the desktop already runs at", async () => {
    h.store.set(PREF_KEY, "1600x900");
    const res = await POST(post("1600x900"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ resolution: "1600x900", restarted: false });
    expect(kill).not.toHaveBeenCalled();
  });

  it("answers non-2xx when the restart fails, and retries it for the same value", async () => {
    h.mainPid = "0"; // clawbox-vnc not running
    const failed = await POST(post("1920x1080"));
    expect(failed.status).toBe(500);
    expect(await failed.json()).toMatchObject({ resolution: "1920x1080", restartFailed: true });
    expect(h.store.get(PREF_KEY)).toBe("1920x1080");
    expect(kill).not.toHaveBeenCalled();

    // Same value again: not applied yet, so the restart is attempted again.
    h.mainPid = "4242";
    const retried = await POST(post("1920x1080"));
    expect(retried.status).toBe(200);
    expect(await retried.json()).toEqual({ resolution: "1920x1080", restarted: true });
    expect(kill).toHaveBeenCalledTimes(1);

    // Now applied: a further save of the same value restarts nothing.
    const again = await POST(post("1920x1080"));
    expect(await again.json()).toEqual({ resolution: "1920x1080", restarted: false });
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("does not restart when going back to the size a failed change never left", async () => {
    h.store.set(PREF_KEY, "1280x720");
    h.mainPid = "0";
    expect((await POST(post("1600x900"))).status).toBe(500);
    h.mainPid = "4242";
    const back = await POST(post("1280x720"));
    expect(await back.json()).toEqual({ resolution: "1280x720", restarted: false });
    expect(kill).not.toHaveBeenCalled();
  });
});
