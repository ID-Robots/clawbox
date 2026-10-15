import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as childProcess from "child_process";
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";

/**
 * OpenClaw's "undergoing offline maintenance; retry when it finishes" (F4,
 * 2026-10-15). The pinned core (2026.10.3) refuses every command that reads
 * its config while a gateway start's own CLI bootstrap or a doctor run holds
 * the state, and its config read turns the refusal into "config could not be
 * read". Measured in an isolated home with `doctor --fix` holding the state:
 * `config set` exits 1 with the sentence on stderr and the value unwritten.
 * ClawBox reported that as a failed save; the core's own instruction is to ask
 * again, and the refusal comes before the command acts.
 */

vi.mock("child_process", () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("fs", () => ({
  default: {
    statSync: vi.fn(() => {
      throw new Error("no edition file");
    }),
    readFileSync: vi.fn(() => {
      throw new Error("no edition file");
    }),
    existsSync: vi.fn(() => true),
    readdirSync: vi.fn(() => {
      throw new Error("no nvm dir");
    }),
  },
}));

const mockSpawn = vi.mocked(childProcess.spawn);

/** The core's own refusal, as `config get` printed it on 2026.10.3 (paths shortened). */
const REFUSAL = [
  "OpenClaw config could not be read: ~/.openclaw/openclaw.json",
  "- <root>: read failed at ~/.openclaw/openclaw.json: Error: OpenClaw state at ~/.openclaw/state/openclaw.sqlite is undergoing offline maintenance; retry when it finishes.",
  "Resolve the read error shown above, then retry.",
].join("\n");

/** A child that prints `stderr` (and `stdout`) and exits `code` on the next tick. */
function child(code: number, out: { stderr?: string; stdout?: string } = {}): ChildProcess {
  const proc = new EventEmitter() as ChildProcess;
  proc.stdout = new EventEmitter() as unknown as ChildProcess["stdout"];
  proc.stderr = new EventEmitter() as unknown as ChildProcess["stderr"];
  proc.kill = vi.fn(() => true) as unknown as ChildProcess["kill"];
  setTimeout(() => {
    if (out.stdout) proc.stdout?.emit("data", Buffer.from(out.stdout));
    if (out.stderr) proc.stderr?.emit("data", Buffer.from(out.stderr));
    proc.emit("close", code);
  }, 0);
  return proc;
}

async function load() {
  vi.resetModules();
  process.env.CLAWBOX_EDITION_FILE = "/nonexistent/edition.env";
  process.env.CLAWBOX_EDITION = "openclaw";
  return import("@/lib/openclaw-config");
}

describe("spawnOpenclawCli and the core's maintenance refusal", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.CLAWBOX_EDITION;
    delete process.env.CLAWBOX_EDITION_FILE;
  });

  it("asks again while the core says to, and answers what the next ask returns", async () => {
    const { spawnOpenclawCli } = await load();
    mockSpawn
      .mockImplementationOnce(() => child(1, { stderr: REFUSAL }))
      .mockImplementationOnce(() => child(0, { stdout: "{\"profiles\":[]}" }));
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => {});
    const asked = spawnOpenclawCli(["models", "auth", "list", "--json"], { captureStdout: true, timeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(asked).resolves.toBe("{\"profiles\":[]}");
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    quiet.mockRestore();
  });

  it("gives up inside the window with an owner-sized sentence, not 'config could not be read'", async () => {
    const { spawnOpenclawCli } = await load();
    const { OpenclawStateMaintenanceError } = await import("@/lib/openclaw-maintenance");
    mockSpawn.mockImplementation(() => child(1, { stderr: REFUSAL }));
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => {});
    const asked = spawnOpenclawCli(["config", "set", "agents.defaults.userTimezone", "Europe/Sofia"], {
      timeoutMs: 60_000,
    });
    asked.catch(() => {});
    await vi.advanceTimersByTimeAsync(40_000);
    const err = await asked.then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(OpenclawStateMaintenanceError);
    expect((err as Error).message).toMatch(/finishing maintenance/);
    expect((err as Error).message).not.toMatch(/could not be read|invalid/);
    // Bounded: about a window's worth of asks, never one per millisecond.
    expect(mockSpawn.mock.calls.length).toBeGreaterThan(2);
    expect(mockSpawn.mock.calls.length).toBeLessThanOrEqual(18);
    quiet.mockRestore();
  });

  it("never outlives the caller's own timeout", async () => {
    const { spawnOpenclawCli } = await load();
    mockSpawn.mockImplementation(() => child(1, { stderr: REFUSAL }));
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => {});
    const asked = spawnOpenclawCli(["config", "get", "gateway.port"], { timeoutMs: 4_000 });
    asked.catch(() => {});
    await vi.advanceTimersByTimeAsync(4_000);
    const err = await asked.then(() => null, (e: unknown) => e);
    expect((err as Error).name).toBe("OpenclawStateMaintenanceError");
    expect(mockSpawn.mock.calls.length).toBeLessThanOrEqual(3);
    quiet.mockRestore();
  });

  it("rethrows any other refusal at once, untouched", async () => {
    const { spawnOpenclawCli } = await load();
    mockSpawn.mockImplementation(() => child(1, { stderr: "Error: Config validation failed: gateway.port: Expected number" }));
    const asked = spawnOpenclawCli(["config", "set", "gateway.port", "x"], { timeoutMs: 30_000 });
    asked.catch(() => {});
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(asked).rejects.toThrow(/Config validation failed/);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });
});

describe("isOpenclawMaintenanceRefusal", () => {
  it("reads an execFile failure's own stderr and stdout, both of the core's wordings", async () => {
    const { isOpenclawMaintenanceRefusal } = await import("@/lib/openclaw-maintenance");
    expect(isOpenclawMaintenanceRefusal(Object.assign(new Error("Command failed: openclaw config validate --json"), {
      stdout: "{\"valid\":false,\"issues\":[{\"path\":\"<root>\",\"message\":\"read failed: undergoing offline maintenance; retry when it finishes.\"}]}",
    }))).toBe(true);
    expect(isOpenclawMaintenanceRefusal(
      "OpenClaw state owner could not be verified; retry after maintenance finishes.",
    )).toBe(true);
    expect(isOpenclawMaintenanceRefusal(new Error("Config validation failed"))).toBe(false);
  });
});
