/**
 * What one 3 s tick of the System panel is allowed to cost.
 *
 * `/setup-api/system/stats` spawned `df`, `ps aux --sort=-%cpu` and `uname -r`
 * on EVERY request, and two pollers ask for it every 3 s while the panel is
 * open (Settings > System in `SettingsApp.tsx` and the System app in
 * `SystemApp.tsx`). On an Orin Nano that measured 2.8 / 28.5 / 2.0 ms per run:
 * six spawns every three seconds, one of them (`uname -r`) for a string
 * `os.release()` already holds.
 *
 * These are spawn-budget assertions, not timing ones: they count calls into
 * child_process, so they mean the same thing on a laptop and on a loaded CI
 * runner.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import os from "os";
import { promisify } from "util";

const h = vi.hoisted(() => {
  const calls: string[] = [];
  const failing = new Set<string>();
  const outputs: Record<string, string> = {
    df: [
      "Filesystem      Size  Used Avail Use% Mounted on",
      "/dev/sda1       128G   64G   64G  50% /",
    ].join("\n"),
    ps: [
      "USER  PID %CPU %MEM    VSZ   RSS TTY STAT START TIME COMMAND",
      "root    1  0.1  0.2  10000  5000 ?   Ss   09:00 0:01 /sbin/init",
    ].join("\n"),
  };
  const run = vi.fn(async (file: string) => {
    calls.push(file);
    if (failing.has(file)) throw new Error(`${file}: boom`);
    return { stdout: outputs[file] ?? "", stderr: "" };
  });
  return { calls, failing, outputs, run };
});

vi.mock("child_process", () => {
  // `promisify(execFile)` follows util.promisify.custom, which is how the real
  // execFile resolves to `{ stdout, stderr }` rather than a bare stdout.
  const execFile = Object.assign(vi.fn(), { [promisify.custom]: h.run });
  // Every spawn entry point, so a process started anywhere in this route's
  // module graph shows up as an unmocked-call failure rather than as silence.
  return {
    execFile,
    exec: vi.fn(),
    execSync: vi.fn(),
    execFileSync: vi.fn(),
    spawn: vi.fn(),
    spawnSync: vi.fn(),
    fork: vi.fn(),
  };
});

function countOf(file: string): number {
  return h.calls.filter((c) => c === file).length;
}

describe("GET /setup-api/system/stats spawn budget", () => {
  let GET: () => Promise<Response>;
  let startedAt: number;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    startedAt = new Date("2026-09-05T10:00:00Z").getTime();
    vi.setSystemTime(startedAt);
    h.calls.length = 0;
    h.failing.clear();
    h.run.mockClear();
    GET = (await import("@/app/setup-api/system/stats/route")).GET;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Absolute, never `Date.now() + n` — offsets from "now" compound. */
  function at(msFromStart: number) {
    vi.setSystemTime(startedAt + msFromStart);
  }

  it("spawns nothing for the kernel release", async () => {
    const body = await (await GET()).json();
    // `uname -r` and os.release() are the same utsname field; the route reads
    // os.release() two lines above for `overview.os` anyway.
    expect(h.calls).not.toContain("uname");
    expect(body.overview.kernel).toBe(os.release());
    expect(body.overview.os).toContain(os.release());
  });

  it("does not respawn df and ps for every 3 s tick", async () => {
    // Both pollers, four ticks: eight requests, which used to be 24 spawns.
    for (const ms of [0, 3_000, 6_000, 9_000]) {
      at(ms);
      await Promise.all([GET(), GET()]);
    }

    // The 5 s window means a 3 s poll pays for each command every other tick,
    // and the two pollers share the one spawn rather than racing for two.
    expect(countOf("df"), "df over four ticks").toBe(2);
    expect(countOf("ps"), "ps over four ticks").toBe(2);
    expect(h.calls.length, "eight requests").toBe(4);
  });

  it("serves the two concurrent pollers from one spawn each", async () => {
    const [a, b] = await Promise.all([GET(), GET()]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(countOf("df")).toBe(1);
    expect(countOf("ps")).toBe(1);
  });

  it("re-reads once the window is up", async () => {
    await GET();
    at(4_000);
    await GET();
    expect(countOf("df")).toBe(1);
    expect(countOf("ps")).toBe(1);

    at(5_001);
    await GET();
    expect(countOf("df")).toBe(2);
    expect(countOf("ps")).toBe(2);
  });

  it("does not spawn once per request while a command keeps failing", async () => {
    // A `fork` refused under memory pressure is exactly when the box can least
    // afford to be asked again on every tick, so a failure is remembered too —
    // just for less time than a success.
    h.failing.add("df");
    expect((await (await GET()).json()).storage).toEqual([]);
    at(1_500);
    expect((await (await GET()).json()).storage).toEqual([]);
    expect(countOf("df"), "inside the failure window").toBe(1);

    h.failing.delete("df");
    at(3_500);
    const body = await (await GET()).json();
    expect(countOf("df"), "past it").toBe(2);
    expect(body.storage).toHaveLength(1);
  });

  it("still answers with real values, not an empty shell", async () => {
    const body = await (await GET()).json();
    expect(body.storage).toHaveLength(1);
    expect(body.storage[0].mountpoint).toBe("/");
    expect(body.processes).toHaveLength(1);
    expect(body.processes[0].pid).toBe("1");
  });
});
