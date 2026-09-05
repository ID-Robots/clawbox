/**
 * What one 3 s tick of the System panel is allowed to cost.
 *
 * `/setup-api/system/stats` spawned `df`, `ps aux --sort=-%cpu` and `uname -r`
 * on EVERY request, and two pollers ask for it every 3 s while the panel is
 * open (Settings > System at SettingsApp.tsx and the System app at
 * SystemApp.tsx). On a Jetson that is three process spawns per poller per tick
 * for two answers that barely move and one — the kernel release — that cannot
 * change without a reboot.
 *
 * These are spawn-budget assertions, not timing ones: they count calls into
 * child_process, so they mean the same thing on a laptop and on a loaded CI
 * runner.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
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
    uname: "5.15.148-tegra",
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
  return { execFile, execFileSync: vi.fn(), execSync: vi.fn(), spawn: vi.fn() };
});

function countOf(file: string): number {
  return h.calls.filter((c) => c === file).length;
}

describe("GET /setup-api/system/stats spawn budget", () => {
  let GET: () => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    h.calls.length = 0;
    h.failing.clear();
    h.outputs.uname = "5.15.148-tegra";
    h.run.mockClear();
    GET = (await import("@/app/setup-api/system/stats/route")).GET;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not respawn df, ps and uname for every 3 s tick", async () => {
    // Both pollers, three ticks: six requests, which used to be eighteen
    // spawns.
    let res: Response | undefined;
    for (const offset of [0, 3_000, 6_000]) {
      vi.setSystemTime(Date.now() + offset);
      [, res] = await Promise.all([GET(), GET()]);
    }

    expect(res?.status).toBe(200);
    expect(countOf("uname"), "uname -r is a constant for the life of the process").toBe(1);
    expect(countOf("df"), "disk usage over three ticks").toBe(1);
    // The 5 s window means a 3 s poll pays for `ps` every OTHER tick.
    expect(countOf("ps"), "top processes over three ticks").toBe(2);
    expect(h.calls.length, "six requests, three ticks").toBe(4);
  });

  it("serves the two concurrent pollers from one spawn each", async () => {
    // Settings > System and the System app poll the same route independently.
    const [a, b] = await Promise.all([GET(), GET()]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(countOf("df")).toBe(1);
    expect(countOf("ps")).toBe(1);
    expect(countOf("uname")).toBe(1);
  });

  it("still refreshes what can actually change, once its window is up", async () => {
    await GET();
    // Past the processes window but inside the disk one.
    vi.setSystemTime(Date.now() + 6_000);
    await GET();
    expect(countOf("ps")).toBe(2);
    expect(countOf("df")).toBe(1);

    vi.setSystemTime(Date.now() + 31_000);
    await GET();
    expect(countOf("df")).toBe(2);
    expect(countOf("uname"), "the kernel cannot change without a reboot").toBe(1);
  });

  it("does not pin a failed uname for the life of the process", async () => {
    // Probe-once: caching the FALLBACK forever would leave a box reporting
    // os.release() until the next restart because one spawn lost a race.
    h.failing.add("uname");
    const first = await (await GET()).json();
    expect(first.overview.kernel).toBeTruthy();

    h.failing.delete("uname");
    vi.setSystemTime(Date.now() + 3_000);
    const second = await (await GET()).json();
    expect(second.overview.kernel).toBe("5.15.148-tegra");
  });

  it("still answers with real values, not an empty shell", async () => {
    const body = await (await GET()).json();
    expect(body.overview.kernel).toBe("5.15.148-tegra");
    expect(body.storage).toHaveLength(1);
    expect(body.storage[0].mountpoint).toBe("/");
    expect(body.processes).toHaveLength(1);
    expect(body.processes[0].pid).toBe("1");
  });
});
