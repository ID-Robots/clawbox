/**
 * ClawKeep's "is this binary installed" probe (`which` in src/lib/clawkeep.ts).
 *
 * The desktop shelf's shield asks GET /setup-api/clawkeep every 5 s, and every
 * answer probes for `clawkeepd` — and, on a box whose `openclaw` is not at a
 * managed path, for `openclaw` too. The negative answer is never cached (the
 * card must see an install at the next poll), so a box without the daemon
 * spawned `which` — a shell script — every five seconds, around the clock. The
 * probe is now the same question asked of the filesystem: these pin that it
 * answers what `which` answered, and starts no process doing it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn };
});
vi.mock("@/lib/harness", () => ({ getEdition: vi.fn(() => "hermes") }));

const ROOT = path.join(os.tmpdir(), `clawbox-clawkeep-which-${process.pid}-${Date.now()}`);
const FIRST = path.join(ROOT, "first");
const SECOND = path.join(ROOT, "second");
const saved = { PATH: process.env.PATH, HOME: process.env.HOME, CLAWKEEP_BIN: process.env.CLAWKEEP_BIN };

let clawkeep: typeof import("@/lib/clawkeep");
let openclawAtManagedPath: boolean;

beforeAll(async () => {
  await fs.mkdir(FIRST, { recursive: true });
  await fs.mkdir(SECOND, { recursive: true });
  process.env.CLAWKEEP_DATA_DIR = path.join(ROOT, "data");
  // A home with no ~/.local/bin/clawkeepd, and a PATH of two empty folders:
  // whatever this machine has installed is out of the picture.
  process.env.HOME = path.join(ROOT, "home");
  process.env.PATH = `${FIRST}:${SECOND}`;
  delete process.env.CLAWKEEP_BIN;
  clawkeep = await import("@/lib/clawkeep");
  const { findOpenclawBin } = await import("@/lib/openclaw-config");
  openclawAtManagedPath = findOpenclawBin() !== "openclaw";
});

afterAll(async () => {
  delete process.env.CLAWKEEP_DATA_DIR;
  process.env.PATH = saved.PATH;
  process.env.HOME = saved.HOME;
  if (saved.CLAWKEEP_BIN !== undefined) process.env.CLAWKEEP_BIN = saved.CLAWKEEP_BIN;
  await fs.rm(ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  // The real spawn, counted (the suite config resets every mock between
  // tests): anything getStatus does start still runs.
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  spawn.mockReset();
  spawn.mockImplementation(actual.spawn);
});

function whichSpawns(): number {
  return spawn.mock.calls.filter(([cmd]) => cmd === "which").length;
}

describe("clawkeep getStatus — finding the binaries on PATH", () => {
  it("answers not installed for a binary on no PATH folder, and spawns nothing to find out", async () => {
    const status = await clawkeep.getStatus();
    expect(status.daemonInstalled).toBe(false);
    if (!openclawAtManagedPath) expect(status.openclawInstalled).toBe(false);
    expect(whichSpawns()).toBe(0);
  }, 30_000);

  it("does not count a folder, or a file nobody may run, as the binary", async () => {
    // `which` tests -f (a regular file, through a link) AND -x.
    await fs.mkdir(path.join(FIRST, "clawkeepd"));
    await fs.writeFile(path.join(SECOND, "clawkeepd"), "#!/bin/sh\n", { mode: 0o644 });
    expect((await clawkeep.getStatus()).daemonInstalled).toBe(false);
    expect(whichSpawns()).toBe(0);
  }, 30_000);

  it("finds an install at the next poll — the negative answer is never kept", async () => {
    await fs.chmod(path.join(SECOND, "clawkeepd"), 0o755);
    await fs.writeFile(path.join(FIRST, "openclaw"), "#!/bin/sh\n", { mode: 0o755 });
    const status = await clawkeep.getStatus();
    expect(status.daemonInstalled).toBe(true);
    expect(status.openclawInstalled).toBe(true);
    expect(whichSpawns()).toBe(0);
  }, 30_000);

  it("follows a symlink to an executable, as `which` does", async () => {
    await fs.writeFile(path.join(ROOT, "real-openclaw"), "#!/bin/sh\n", { mode: 0o755 });
    await fs.rm(path.join(FIRST, "openclaw"));
    await fs.symlink(path.join(ROOT, "real-openclaw"), path.join(SECOND, "openclaw"));
    expect((await clawkeep.getStatus()).openclawInstalled).toBe(true);
    // ...and not to a missing target.
    await fs.rm(path.join(ROOT, "real-openclaw"));
    if (!openclawAtManagedPath) expect((await clawkeep.getStatus()).openclawInstalled).toBe(false);
  }, 30_000);
});
