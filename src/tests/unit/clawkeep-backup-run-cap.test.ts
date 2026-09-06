import { EventEmitter } from "node:events";
import fs from "fs/promises";
import os from "os";
import path from "path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TASK-675 — a large ClawKeep backup is killed by the box while it is working.
 *
 * The customer case is a 12 GB archive. PR #607 (multipart chunking) and the
 * portal's credential-TTL fix together made that run finish — and the board
 * records the validated 12 GiB run finishing in ~86 minutes. `runBackup()`
 * SIGKILLs the daemon at `BACKUP_RUN_CAP_MS`, which was 60 minutes, so the box
 * destroys the upload around 70% and answers `exitCode: 124`, "backup timed
 * out", over a transfer that was healthy. A false failure delivered onto the
 * one operation whose whole point is that it is long — and the run it kills is
 * precisely the one the rest of TASK-675 went to work to make possible.
 *
 * The bound is not something ClawBox has to invent. ClawKeep ships its own
 * service unit for exactly this binary and declares `TimeoutStartSec` there —
 * the daemon's own answer to "how long may one backup take". The bridge that
 * spawns it must not be stricter than the unit written to run it, so the two
 * are pinned together here rather than left as two magic numbers free to
 * drift apart.
 */

const daemon = vi.hoisted(() => ({
  spawned: false,
  killed: [] as (string | undefined)[],
  /** Ends the run the way the daemon exiting would. Replaced at each spawn. */
  finish: (() => {}) as (code?: number) => void,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const spawn = () => {
    daemon.spawned = true;
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: (signal?: string) => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let done = false;
    const close = (code: number | null) => {
      if (done) return;
      done = true;
      child.emit("close", code);
    };
    child.kill = (signal?: string) => {
      daemon.killed.push(signal);
      setImmediate(() => close(null));
    };
    // The daemon works until the test says it has finished. A long upload is
    // silent on both pipes — `clawkeepd` logs at phase boundaries and
    // publishes its per-250 ms progress into state.json, not onto stderr — so
    // nothing on this side can tell a working run from a wedged one except
    // the cap, which is why the cap has to be the daemon's own.
    daemon.finish = (code = 0) => close(code);
    return child;
  };
  return { ...actual, spawn, default: { ...actual, spawn } };
});

const TEST_ROOT = path.join(os.tmpdir(), `clawbox-clawkeep-cap-${process.pid}-${Date.now()}`);
const DATA_DIR = path.join(TEST_ROOT, "clawkeep");

let clawkeep: typeof import("@/lib/clawkeep");
let protection: typeof import("@/lib/clawkeep-protection");

beforeAll(async () => {
  process.env.CLAWKEEP_DATA_DIR = DATA_DIR;
  process.env.CLAWKEEP_CONFIG_PATH = path.join(DATA_DIR, "config.toml");
  await fs.mkdir(DATA_DIR, { recursive: true });
  // `pairedDaemonBin()` refuses an unpaired box before it spawns anything.
  await fs.writeFile(path.join(DATA_DIR, "token"), "claw_test", { mode: 0o600 });
  // Point the daemon lookup at a real executable so `getDaemonBin()` takes its
  // override branch: the PATH probe shells out, and that spawn would come
  // through the mock below and be mistaken for the backup run.
  const bin = path.join(TEST_ROOT, "clawkeepd");
  await fs.writeFile(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  process.env.CLAWKEEP_BIN = bin;
  clawkeep = await import("@/lib/clawkeep");
  protection = await import("@/lib/clawkeep-protection");
});

afterAll(async () => {
  delete process.env.CLAWKEEP_DATA_DIR;
  delete process.env.CLAWKEEP_CONFIG_PATH;
  delete process.env.CLAWKEEP_BIN;
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  daemon.spawned = false;
  daemon.killed = [];
  daemon.finish = () => {};
});

const MINUTE = 60_000;
/** The board's measured duration of the validated 12 GiB run. */
const MEASURED_12GIB_RUN_MS = 86 * MINUTE;

/** What `clawkeepd.service` — ClawKeep's own unit for this binary — allows. */
async function declaredDaemonTimeoutMs(): Promise<number> {
  const unit = await fs.readFile(
    path.join(process.cwd(), "clawkeep/systemd/clawkeepd.service"),
    "utf8",
  );
  const declared = /^TimeoutStartSec=(\d+)([smh])$/m.exec(unit);
  expect(declared, "clawkeepd.service must declare TimeoutStartSec").not.toBeNull();
  const [, value, unitLetter] = declared!;
  const scale = unitLetter === "h" ? 3_600_000 : unitLetter === "m" ? 60_000 : 1_000;
  return Number(value) * scale;
}

describe("the cap a ClawKeep backup run is given", () => {
  it("is not stricter than the one ClawKeep's own service unit declares", async () => {
    // The bridge spawns the very binary this unit was written for. Being
    // stricter than it means the box kills runs the daemon considers normal —
    // and it is the box, not the daemon, the owner hears from.
    expect(protection.BACKUP_RUN_CAP_MS).toBeGreaterThanOrEqual(await declaredDaemonTimeoutMs());
  });

  it("outlasts the 12 GB backup this task exists to make work", () => {
    expect(protection.BACKUP_RUN_CAP_MS).toBeGreaterThan(MEASURED_12GIB_RUN_MS);
  });

  it("gives a restore at least as long as the backup that produced the archive", () => {
    // The sibling of the same defect: `runRestore` downloads, decrypts,
    // extracts and verifies the very bytes the backup uploaded, and had HALF
    // the time to do it in. A restore killed part-way is worse than a backup
    // killed part-way, because what it was rewriting is the box's own state.
    expect(protection.RESTORE_RUN_CAP_MS).toBeGreaterThanOrEqual(protection.BACKUP_RUN_CAP_MS);
    expect(protection.RESTORE_RUN_CAP_MS).toBeGreaterThan(MEASURED_12GIB_RUN_MS);
  });

  it("is not undercut by the daemon's own per-step caps on the OpenClaw edition", async () => {
    // The bridge cap is the only ceiling CLAWBOX imposes; it is not the only
    // one that exists. `agent.create_archive()` / `agent.verify_archive()`
    // pass no timeout, so `openclaw.py`'s defaults bind the archive and the
    // verify steps first — they were 30 and 5 minutes, so on OpenClaw a 12 GB
    // backup died half an hour in and never reached the bridge's timer at all.
    // Read out of the Python rather than restated here, so raising one and
    // forgetting the other reddens this.
    const py = await fs.readFile(
      path.join(process.cwd(), "clawkeep/clawkeep/openclaw.py"),
      "utf8",
    );
    const declared = /^SUBPROCESS_TIMEOUT_S = (.+)$/m.exec(py);
    expect(declared, "openclaw.py must declare SUBPROCESS_TIMEOUT_S").not.toBeNull();
    // The expression is a product of integer literals (`4 * 60 * 60`).
    expect(declared![1]).toMatch(/^[\d\s*]+$/);
    const seconds = declared![1].split("*").reduce((a, b) => a * Number(b.trim()), 1);

    expect(seconds * 1000).toBeGreaterThanOrEqual(protection.BACKUP_RUN_CAP_MS);
    expect(seconds * 1000).toBeGreaterThanOrEqual(protection.RESTORE_RUN_CAP_MS);

    // Both step functions must take that default, not a tighter literal.
    for (const fn of ["create_archive", "verify_archive"]) {
      const body = py.slice(py.indexOf(`def ${fn}(`), py.indexOf(`def ${fn}(`) + 400);
      expect(body, `${fn} must use SUBPROCESS_TIMEOUT_S`).toContain(
        "timeout: float = SUBPROCESS_TIMEOUT_S",
      );
    }
  });

  it("gives the restoring flag the same window as the restore it marks", () => {
    // `isRestoring()` DELETES a flag it judges stale, and `restoring` is the
    // only signal that survives a page reload, so a window shorter than the
    // restore's own cap drops the shelf's orange shield back to a calm green
    // verdict while the box's state is still being replaced.
    expect(protection.RESTORE_RUN_CAP_MS).toBeGreaterThan(MEASURED_12GIB_RUN_MS);
  });
});
