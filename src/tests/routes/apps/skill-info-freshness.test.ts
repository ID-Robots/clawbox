/**
 * How often an installed app's settings window is allowed to pay for
 * `openclaw skills list --json`.
 *
 * The scan is a full CLI boot — measured on an Orin Nano at 4.2-5.3 s, and the
 * call carries a 30 s timeout for the times it is worse — and
 * `InstalledAppSettings` fetches /setup-api/apps/skill-info on EVERY mount. A
 * 30 s freshness window meant nearly every open of a settings window kicked one
 * off behind the answer, which is the cost this file pins down.
 *
 * The other half is what must NOT go stale for ten minutes: the enable switch.
 * A skill OpenClaw has disabled is never `eligible` (measured on the box: 31 of
 * 59 skills disabled, 0 of them eligible), so a toggle changes the very field
 * the "Ready / Needs setup" badge is drawn from. The switch itself is read back
 * from openclaw.json, but the badge beside it comes from this list, and without
 * an invalidation the two would disagree for ten minutes.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("child_process", () => ({ execFile: vi.fn() }));

vi.mock("util", () => ({ promisify: vi.fn().mockReturnValue(vi.fn()) }));

vi.mock("fs/promises", () => ({
  default: {
    stat: vi.fn().mockRejectedValue(new Error("ENOENT")),
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/lib/openclaw-config", () => ({
  findOpenclawBin: vi.fn(() => "/usr/local/bin/openclaw"),
  getSkillsDir: vi.fn(() => "/home/clawbox/.openclaw/workspace"),
  openclawIsAbsent: vi.fn(() => false),
  readSkillEnabled: vi.fn(async () => true),
  setSkillEnabled: vi.fn(async () => undefined),
}));

/** `eligible` follows the switch — a disabled skill is never eligible. */
function listing(enabled: boolean) {
  return {
    stdout: JSON.stringify({
      skills: [{ name: "test-skill", description: "Test", eligible: enabled, source: "builtin" }],
    }),
  };
}

const MINUTE = 60_000;

describe("skill-info freshness", () => {
  let GET: (req: NextRequest) => Promise<Response>;
  let POST: (req: Request) => Promise<Response>;
  let exec: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T10:00:00Z"));
    const { promisify } = await import("util");
    exec = vi.fn().mockResolvedValue(listing(true));
    vi.mocked(promisify).mockReturnValue(exec as never);
    const fsMod = await import("fs/promises");
    vi.mocked(fsMod.default.stat).mockRejectedValue(new Error("ENOENT"));
    GET = (await import("@/app/setup-api/apps/skill-info/route")).GET;
    POST = (await import("@/app/setup-api/apps/settings/route")).POST;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function get(query = "") {
    return new NextRequest(new URL(`http://localhost/setup-api/apps/skill-info${query}`));
  }

  function advance(ms: number) {
    vi.setSystemTime(Date.now() + ms);
  }

  it("does not re-scan for every settings window opened within ten minutes", async () => {
    await GET(get());
    expect(exec).toHaveBeenCalledTimes(1);

    for (const minutes of [1, 3, 6, 9]) {
      vi.setSystemTime(new Date("2026-09-05T10:00:00Z").getTime() + minutes * MINUTE);
      await GET(get());
      expect(exec, `${minutes} min after the scan`).toHaveBeenCalledTimes(1);
    }
  });

  it("still refreshes behind the caller once the window is up", async () => {
    await GET(get());
    expect(exec).toHaveBeenCalledTimes(1);

    advance(10 * MINUTE + 1_000);
    const res = await GET(get());
    // Served from the cache at once — the refresh runs behind it.
    expect(await res.json()).toHaveLength(1);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("re-scans when the skill switch is flipped, not ten minutes later", async () => {
    expect((await (await GET(get("?appId=test-skill"))).json()).eligible).toBe(true);
    expect(exec).toHaveBeenCalledTimes(1);

    exec.mockResolvedValue(listing(false));
    const res = await POST(new Request("http://localhost/setup-api/apps/settings", {
      method: "POST",
      body: JSON.stringify({ appId: "test-skill", settings: { _setEnabled: false } }),
    }));
    expect(res.status).toBe(200);

    const { setSkillEnabled } = await import("@/lib/openclaw-config");
    expect(setSkillEnabled).toHaveBeenCalledWith("test-skill", false);
    // The rescan is kicked off by the toggle and does not block its answer.
    await vi.advanceTimersByTimeAsync(0);
    expect(exec).toHaveBeenCalledTimes(2);

    // Two minutes later — well inside the ten-minute window — the badge the
    // window draws already agrees with the switch beside it.
    advance(2 * MINUTE);
    expect((await (await GET(get("?appId=test-skill"))).json()).eligible).toBe(false);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("replaces a scan started before the toggle rather than just discarding it", async () => {
    await GET(get());
    expect(exec).toHaveBeenCalledTimes(1);

    // Past the window: the cached list is served and a refresh runs behind it.
    advance(11 * MINUTE);
    const pending: Array<(v: unknown) => void> = [];
    exec.mockImplementation(() => new Promise((resolve) => { pending.push(resolve); }));
    await GET(get());
    expect(exec).toHaveBeenCalledTimes(2);

    // The switch is flipped while that scan is still out. Joining it would
    // discard the answer AND start nothing, leaving the box with the
    // pre-toggle list and no scan running.
    await POST(new Request("http://localhost/setup-api/apps/settings", {
      method: "POST",
      body: JSON.stringify({ appId: "test-skill", settings: { _setEnabled: false } }),
    }));
    expect(exec, "the invalidation starts its own scan").toHaveBeenCalledTimes(3);

    // The abandoned scan lands first, describing the box before the flip. It
    // must neither be stored nor evict the scan that replaced it.
    pending[0](listing(true));
    await vi.advanceTimersByTimeAsync(0);
    pending[1](listing(false));
    await vi.advanceTimersByTimeAsync(0);

    expect((await (await GET(get("?appId=test-skill"))).json()).eligible).toBe(false);
    expect(exec, "and no fourth scan was needed").toHaveBeenCalledTimes(3);
  });

  it("does not re-run a failing scan on every request when NOTHING is cached", async () => {
    // The cold-start case: a box whose CLI is broken from boot has no cached
    // list for the freshness stamp to belong to, so without a remembered
    // failure every request started another scan — each with a 30 s timeout,
    // for as long as the box stayed broken.
    exec.mockRejectedValue(new Error("openclaw: command not found"));
    expect((await GET(get())).status).toBe(503);
    await vi.advanceTimersByTimeAsync(0);
    expect(exec).toHaveBeenCalledTimes(1);

    advance(5_000);
    expect((await GET(get())).status, "still answered, still 503").toBe(503);
    await vi.advanceTimersByTimeAsync(0);
    expect(exec, "inside the failure window").toHaveBeenCalledTimes(1);

    advance(31_000);
    expect((await GET(get())).status).toBe(503);
    await vi.advanceTimersByTimeAsync(0);
    expect(exec, "past the failure window").toHaveBeenCalledTimes(2);

    // An install or a toggle is a reason to look again now, not in 30 s.
    exec.mockResolvedValue(listing(true));
    await POST(new Request("http://localhost/setup-api/apps/settings", {
      method: "POST",
      body: JSON.stringify({ appId: "test-skill", settings: { _setEnabled: true } }),
    }));
    await vi.advanceTimersByTimeAsync(0);
    expect(exec).toHaveBeenCalledTimes(3);
    expect((await (await GET(get())).json())).toHaveLength(1);
  });

  it("does not re-run a failing scan on every single request", async () => {
    await GET(get());
    expect(exec).toHaveBeenCalledTimes(1);

    advance(11 * MINUTE);
    exec.mockRejectedValue(new Error("openclaw: command not found"));
    await GET(get());
    await vi.advanceTimersByTimeAsync(0);
    expect(exec).toHaveBeenCalledTimes(2);

    // A failure used to leave the timestamp untouched, so every later request
    // started another scan — each with a 30 s timeout — for as long as the CLI
    // stayed broken.
    advance(5_000);
    await GET(get());
    await vi.advanceTimersByTimeAsync(0);
    expect(exec, "inside the failure window").toHaveBeenCalledTimes(2);

    // But it is re-asked sooner than a good answer would be.
    advance(31_000);
    await GET(get());
    await vi.advanceTimersByTimeAsync(0);
    expect(exec, "past the failure window").toHaveBeenCalledTimes(3);
  });

});
