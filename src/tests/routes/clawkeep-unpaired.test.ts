import { EventEmitter } from "node:events";
import fs from "fs/promises";
import os from "os";
import path from "path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { NextRequest } from "next/server";

/**
 * F-35 — what a box that was never paired answers when the owner presses
 * "Back up now".
 *
 * `clawkeepd` loads the portal bearer token before it does anything else
 * (clawkeep/clawkeep/daemon.py: `token.read_token()` → exit 65, "token error:
 * No token at <path>; run 'clawkeep pair' first"). The bridge spawned it
 * anyway and handed that back as HTTP 200 `{ ok:false, stderrTail:… }`, so a
 * backup that never started arrived as a success whose only explanation was a
 * raw daemon log line naming a path on the device.
 *
 * The daemon's own pairing signal is that token file, and the bridge already
 * reads it — `readToken()` backs `getStatus().paired`, and the snapshots path
 * has always fail-fasted on it with 409 "ClawKeep is not paired with an
 * account". These tests hold every route that spawns the daemon to that one
 * sentence, with a `code` the caller can branch on instead of parsing English.
 */

const daemon = vi.hoisted(() => ({
  spawns: [] as { bin: string; args: string[] }[],
  exitCode: 0,
  stdout: "",
  stderr: "",
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const spawn = (bin: string, args: string[]) => {
    daemon.spawns.push({ bin, args });
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      if (daemon.stdout) child.stdout.emit("data", Buffer.from(daemon.stdout));
      if (daemon.stderr) child.stderr.emit("data", Buffer.from(daemon.stderr));
      child.emit("close", daemon.exitCode);
    });
    return child;
  };
  return { ...actual, spawn, default: { ...actual, spawn } };
});

const TEST_ROOT = path.join(os.tmpdir(), `clawbox-clawkeep-unpaired-${process.pid}-${Date.now()}`);
const DATA_DIR = path.join(TEST_ROOT, "clawkeep");
const TOKEN_PATH = path.join(DATA_DIR, "token");
const RESTORING_FLAG = path.join(DATA_DIR, "restoring.flag");
const SNAPSHOT = "2026-08-28T00-00-00.000Z-openclaw-backup.tar.gz";

const NOT_PAIRED = { error: "ClawKeep is not paired with an account", code: "not_paired" };

let backupPOST: typeof import("@/app/setup-api/clawkeep/backup/route").POST;
let restorePOST: typeof import("@/app/setup-api/clawkeep/restore/route").POST;
let snapshotsGET: typeof import("@/app/setup-api/clawkeep/snapshots/route").GET;
let labelPOST: typeof import("@/app/setup-api/clawkeep/snapshots/label/route").POST;
let lockPOST: typeof import("@/app/setup-api/clawkeep/snapshots/lock/route").POST;
let deletePOST: typeof import("@/app/setup-api/clawkeep/snapshots/delete/route").POST;

const post = (route: string, body: Record<string, unknown>) =>
  new Request(`http://localhost/setup-api/clawkeep/${route}`, {
    method: "POST",
    body: JSON.stringify(body),
  }) as unknown as NextRequest;

beforeAll(async () => {
  process.env.CLAWKEEP_DATA_DIR = DATA_DIR;
  process.env.CLAWKEEP_CONFIG_PATH = path.join(DATA_DIR, "config.toml");
  // Resolve the daemon binary without a PATH probe — which() spawns `which`,
  // and every spawn these tests record has to be a daemon invocation.
  process.env.CLAWKEEP_BIN = "/bin/true";
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  backupPOST = (await import("@/app/setup-api/clawkeep/backup/route")).POST;
  restorePOST = (await import("@/app/setup-api/clawkeep/restore/route")).POST;
  snapshotsGET = (await import("@/app/setup-api/clawkeep/snapshots/route")).GET;
  labelPOST = (await import("@/app/setup-api/clawkeep/snapshots/label/route")).POST;
  lockPOST = (await import("@/app/setup-api/clawkeep/snapshots/lock/route")).POST;
  deletePOST = (await import("@/app/setup-api/clawkeep/snapshots/delete/route")).POST;
});

afterAll(async () => {
  delete process.env.CLAWKEEP_DATA_DIR;
  delete process.env.CLAWKEEP_CONFIG_PATH;
  delete process.env.CLAWKEEP_BIN;
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  daemon.spawns.length = 0;
  daemon.exitCode = 0;
  daemon.stdout = "";
  daemon.stderr = "";
  await fs.rm(TOKEN_PATH, { force: true });
  await fs.rm(RESTORING_FLAG, { force: true });
});

describe("ClawKeep on an unpaired box", () => {
  it("answers POST /clawkeep/backup 409 not_paired and never starts the daemon", async () => {
    const res = await backupPOST(post("backup", {}));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(NOT_PAIRED);
    expect(daemon.spawns).toEqual([]);
  });

  it("answers POST /clawkeep/restore 409 not_paired without arming the restore flag", async () => {
    const res = await restorePOST(post("restore", { name: SNAPSHOT }));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(NOT_PAIRED);
    expect(daemon.spawns).toEqual([]);
    // The shelf shield pulses off this marker. A restore that never ran must
    // not leave it behind for the half-hour staleness window.
    await expect(fs.access(RESTORING_FLAG)).rejects.toThrow();
  });

  it("rejects a scheduled run instead of firing a doomed daemon", async () => {
    const { runBackup } = await import("@/lib/clawkeep");

    // clawkeep-scheduler.ts `fireBackup()` is the other caller of runBackup, so
    // an unpaired box used to run a doomed daemon every night. This covers only
    // the rejection; a run the daemon RESOLVES with a non-zero exit is the
    // scheduler's own branch, held in src/tests/unit/clawkeep-schedule.test.ts.
    await expect(runBackup({ idle: false })).rejects.toMatchObject({
      status: 409,
      code: "not_paired",
      message: NOT_PAIRED.error,
    });
    expect(daemon.spawns).toEqual([]);
  });

  it("answers GET /clawkeep/snapshots with the same sentence and code", async () => {
    const res = await snapshotsGET();

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(NOT_PAIRED);
    expect(daemon.spawns).toEqual([]);
  });

  // label / lock / delete were spawning the daemon unguarded too — a 502
  // quoting "No token at <path>". They share pairedDaemonBin() with the routes
  // above, but they are separate handlers with their own catch blocks, so the
  // shared envelope is asserted per route rather than inferred.
  const MUTATIONS: [string, () => Promise<Response>][] = [
    ["snapshots/label", () => labelPOST(post("snapshots/label", { name: SNAPSHOT, label: "x" }))],
    ["snapshots/lock", () => lockPOST(post("snapshots/lock", { name: SNAPSHOT, locked: true }))],
    ["snapshots/delete", () => deletePOST(post("snapshots/delete", { name: SNAPSHOT }))],
  ];

  it.each(MUTATIONS)("answers POST /clawkeep/%s the same way", async (_route, call) => {
    const res = await call();

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(NOT_PAIRED);
    expect(daemon.spawns).toEqual([]);
  });
});

describe("ClawKeep on a paired box", () => {
  beforeEach(async () => {
    await fs.writeFile(TOKEN_PATH, "claw_test-token", { mode: 0o600 });
  });

  it("still runs the daemon for POST /clawkeep/backup", async () => {
    const res = await backupPOST(post("backup", { label: "before update" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, exitCode: 0 });
    expect(daemon.spawns).toHaveLength(1);
    expect(daemon.spawns[0].bin).toBe("/bin/true");
    expect(daemon.spawns[0].args).toContain("--label");
  });
});
