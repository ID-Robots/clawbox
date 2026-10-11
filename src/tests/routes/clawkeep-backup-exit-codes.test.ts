import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import fs from "fs/promises";
import os from "os";
import path from "path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { NextRequest } from "next/server";

/**
 * TASK-672 — a failed backup must stop answering HTTP 200.
 *
 * `clawkeepd` publishes a complete, deliberate failure taxonomy
 * (`clawkeep/clawkeep/runner.py`: `EXIT_BACKUP_FAILED=1`, `EXIT_QUOTA_FULL=2`,
 * `EXIT_AUTH_REVOKED=3`, `EXIT_TIER=4`, `EXIT_SERVER=5`, `EXIT_NETWORK=6`,
 * `EXIT_OPENCLAW=7`, `EXIT_UPLOAD=8`, `EXIT_NEED_PASSPHRASE=9`,
 * `EXIT_ENCRYPTION_FAILED=10`, since TASK-1000 `EXIT_ARCHIVE_BUSY=11`,
 * `EXIT_ARCHIVE_DB_DAMAGED=12`, `EXIT_ARCHIVE_CONFLICT=13`, `EXIT_UNKNOWN=99`; `daemon.py`: 64 for a bad
 * config and 65 for a token error, both before the run begins) and the TS
 * bridge consumed NONE of it — `grep` found no `EXIT_` reader anywhere in
 * `src/` or `mcp/`. The route built its body as `ok: result.exitCode === 0`
 * inside a 2xx, so every failure arrived as a success whose only explanation
 * was `stderrTail`, the daemon's raw log line, printed verbatim by the panel.
 *
 * The case that matters most is a pairing revoked AT THE PORTAL rather than
 * locally: the token file stays on disk, so F-35's pre-flight passes,
 * `clawkeepd` reaches `api.mint_credentials`, gets a 401 and exits 3. No local
 * check can see that — classifying the exit code is the only thing that does.
 */

const daemon = vi.hoisted(() => ({
  spawns: [] as { bin: string; args: string[] }[],
  exitCode: 0,
  stdout: "",
  stderr: "",
  /** What the daemon does to its data dir before it exits — it writes
   * state.json DURING the run, so a fixture seeded beforehand would not be
   * the run's own. */
  beforeExit: null as null | (() => void),
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
      daemon.beforeExit?.();
      if (daemon.stdout) child.stdout.emit("data", Buffer.from(daemon.stdout));
      if (daemon.stderr) child.stderr.emit("data", Buffer.from(daemon.stderr));
      child.emit("close", daemon.exitCode);
    });
    return child;
  };
  return { ...actual, spawn, default: { ...actual, spawn } };
});

const TEST_ROOT = path.join(os.tmpdir(), `clawbox-clawkeep-exits-${process.pid}-${Date.now()}`);
const DATA_DIR = path.join(TEST_ROOT, "clawkeep");
const TOKEN_PATH = path.join(DATA_DIR, "token");
const STATE_PATH = path.join(DATA_DIR, "state.json");

const GB = 1024 ** 3;

/** Have the daemon record a refusal the way `runner._note_refusal` does:
 * during the run, stamped with the time it refused. */
function daemonRefuses(
  kind: string,
  sizes: { needed: number; used: number; quota: number },
  atMs?: number,
): void {
  daemon.beforeExit = () => {
    writeFileSync(STATE_PATH, JSON.stringify({
      last_heartbeat_status: "error",
      last_refusal: kind,
      last_refusal_at_ms: atMs ?? Date.now(),
      last_refusal_needed_bytes: sizes.needed,
      last_refusal_used_bytes: sizes.used,
      last_refusal_quota_bytes: sizes.quota,
    }));
  };
}

/** The daemon's own line for a revoked pairing, as it reaches stderr. */
const REVOKED_TAIL =
  `auth failed for ${TOKEN_PATH}: token may be revoked, run 'clawkeep pair' again`;

let backupPOST: typeof import("@/app/setup-api/clawkeep/backup/route").POST;

const post = (body: Record<string, unknown>) =>
  new Request("http://localhost/setup-api/clawkeep/backup", {
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
  daemon.beforeExit = null;
  await fs.rm(STATE_PATH, { force: true });
  // Paired: the token is on disk, which is all the pre-flight looks at.
  await fs.writeFile(TOKEN_PATH, "claw_testtoken", { mode: 0o600 });
});

describe("POST /setup-api/clawkeep/backup maps the daemon's EXIT_* taxonomy", () => {
  it("answers 401 pairing_revoked for EXIT_AUTH_REVOKED, without the daemon's tail", async () => {
    daemon.exitCode = 3;
    daemon.stderr = REVOKED_TAIL;

    const res = await backupPOST(post({}));
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(401);
    expect(body.code).toBe("pairing_revoked");
    expect(typeof body.error).toBe("string");
    // One owner-facing sentence, never the daemon's log line — which names the
    // token's absolute path on the device.
    expect(JSON.stringify(body)).not.toContain(TOKEN_PATH);
    expect(JSON.stringify(body)).not.toContain("clawkeep pair");
  });

  it("never answers 2xx for any non-zero exit the daemon can produce", async () => {
    // The whole taxonomy, plus the two the bridge synthesises itself: 124 for
    // its own kill timer and 127 for a daemon that could not be started.
    for (const exitCode of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 64, 65, 99, 124, 127]) {
      daemon.exitCode = exitCode;
      daemon.stderr = `daemon said something about ${exitCode}`;
      daemon.spawns.length = 0;
      const res = await backupPOST(post({}));
      const body = (await res.json()) as Record<string, unknown>;
      // The daemon really ran — the route did not short-circuit before it and
      // answer for some other reason.
      expect(daemon.spawns).toHaveLength(1);
      expect({ exitCode, ok: res.ok }).toEqual({ exitCode, ok: false });
      expect(res.status).toBeGreaterThanOrEqual(400);
      // Every one carries a stable code a caller can branch on, and none of
      // them carries the raw daemon output.
      expect(typeof body.code).toBe("string");
      expect(JSON.stringify(body)).not.toContain("daemon said something");
    }
  });

  it("gives the cases with a distinct remedy their own status and code", async () => {
    const expected: Record<number, { status: number; code: string }> = {
      2: { status: 507, code: "quota_full" },
      6: { status: 504, code: "offline" },
      9: { status: 409, code: "needs_passphrase" },
      65: { status: 409, code: "token_unreadable" },
      124: { status: 504, code: "timed_out" },
      // TASK-1000: the archive failures with a remedy of their own.
      11: { status: 503, code: "archive_busy" },
      12: { status: 500, code: "database_damaged" },
      13: { status: 500, code: "archive_conflict" },
      // The daemon's run lock: one is already in flight. Not a 5xx — nothing
      // failed — and not the catch-all a crash (exit 1) lands on.
      14: { status: 409, code: "already_running" },
    };
    for (const [exit, want] of Object.entries(expected)) {
      daemon.exitCode = Number(exit);
      const res = await backupPOST(post({}));
      const body = (await res.json()) as Record<string, unknown>;
      expect({ exit, status: res.status, code: body.code }).toEqual({
        exit,
        status: want.status,
        code: want.code,
      });
    }
  });

  it("still answers 200 for a backup that worked", async () => {
    daemon.exitCode = 0;
    daemon.stdout = "uploaded 1 snapshot";

    const res = await backupPOST(post({}));
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.exitCode).toBe(0);
  });
});

describe("a backup the daemon refused before uploading says why, with sizes a person reads", () => {
  it("says what the backup needs and what is free when it does not fit", async () => {
    daemon.exitCode = 2;
    daemonRefuses("quota_full", { needed: 1_288_490_189, used: 5_046_586_573, quota: 5 * GB });

    const res = await backupPOST(post({}));
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(507);
    expect(body.code).toBe("quota_full");
    expect(body.error).toMatch(/needs 1\.2 GB, but only 307 MB of the 5\.0 GB/);
    expect(body.error).toMatch(/nothing was uploaded and earlier backups are untouched/);
    expect(body.error).toMatch(/Delete snapshots you no longer need or upgrade the plan/);
    // Readable units only — the byte counts are data, never the sentence.
    expect(body.error).not.toMatch(/\d{7,}/);
    expect(body.refusal).toMatchObject({
      kind: "quota_full",
      neededBytes: 1_288_490_189,
      usedBytes: 5_046_586_573,
      quotaBytes: 5 * GB,
    });
  });

  it("does not tell the owner to delete snapshots for a backup larger than the whole plan", async () => {
    daemon.exitCode = 2;
    daemonRefuses("quota_full", { needed: 6 * GB, used: 2 * GB, quota: 5 * GB });

    const body = (await (await backupPOST(post({}))).json()) as Record<string, string>;

    expect(body.code).toBe("quota_full");
    expect(body.error).toMatch(/is 6\.0 GB, more than the whole ClawKeep plan holds \(5\.0 GB\)/);
    expect(body.error).toMatch(/Deleting snapshots will not make room for it; upgrade the plan/);
    expect(body.error).not.toMatch(/you no longer need/);
  });

  it("reads a quota of zero as a plan that holds nothing, not as a missing figure", async () => {
    daemon.exitCode = 2;
    daemonRefuses("quota_full", { needed: 2048, used: 0, quota: 0 });

    const body = (await (await backupPOST(post({}))).json()) as Record<string, string>;

    expect(body.error).toMatch(/is 2\.0 KB, more than the whole ClawKeep plan holds \(0 B\)/);
  });

  it("keeps the portal's own quota refusal as it was — it knows no sizes", async () => {
    // 402 at the credentials mint: the daemon exits 2 before it builds anything
    // and records no refusal.
    daemon.exitCode = 2;

    const res = await backupPOST(post({}));
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(507);
    expect(body.code).toBe("quota_full");
    expect(body.error).toBe("The ClawKeep account is out of space — free some snapshots or upgrade the plan");
    expect(body).not.toHaveProperty("refusal");
  });

  it("does not read the last run's sizes out as this run's", async () => {
    // A record from before this run started is another run's: a daemon killed
    // before its first save leaves the old file exactly as it was.
    daemon.exitCode = 2;
    daemonRefuses("quota_full", { needed: 9 * GB, used: 0, quota: 5 * GB }, Date.now() - 60_000);

    const body = (await (await backupPOST(post({}))).json()) as Record<string, unknown>;

    expect(body.error).toBe("The ClawKeep account is out of space — free some snapshots or upgrade the plan");
    expect(body).not.toHaveProperty("refusal");
  });

  it("says usage could not be checked, instead of blaming the portal's reachability", async () => {
    daemon.exitCode = 6;
    daemonRefuses("usage_unverified", { needed: 3 * GB, used: 0, quota: 5 * GB });

    const res = await backupPOST(post({}));
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(503);
    expect(body.code).toBe("usage_unverified");
    expect(body.error).toMatch(/could not check how much cloud storage is in use/);
    expect(body.error).toMatch(/earlier backups are untouched/);
    expect(body.error).not.toMatch(/portal/i);
    expect(body.refusal).toMatchObject({ kind: "usage_unverified", neededBytes: 3 * GB });
  });

  it("still says the portal is unreachable when that is what exit 6 meant", async () => {
    daemon.exitCode = 6;

    const res = await backupPOST(post({}));
    const body = (await res.json()) as Record<string, unknown>;

    expect({ status: res.status, code: body.code }).toEqual({ status: 504, code: "offline" });
    expect(body).not.toHaveProperty("refusal");
  });

  it("only takes a refusal of the kind its exit code can mean", async () => {
    daemon.exitCode = 6;
    daemonRefuses("quota_full", { needed: GB, used: 0, quota: GB });
    const offline = (await (await backupPOST(post({}))).json()) as Record<string, unknown>;
    expect(offline.code).toBe("offline");
    expect(offline).not.toHaveProperty("refusal");

    daemon.exitCode = 8; // EXIT_UPLOAD — never a refusal, whatever the file says
    daemonRefuses("quota_full", { needed: GB, used: 0, quota: GB });
    const upload = (await (await backupPOST(post({}))).json()) as Record<string, unknown>;
    expect(upload.code).toBe("upload_failed");
    expect(upload).not.toHaveProperty("refusal");

    // A kind a newer daemon might add has no sentence here, so it is none.
    daemon.exitCode = 2;
    daemonRefuses("something_new", { needed: GB, used: 0, quota: GB });
    const unknown = (await (await backupPOST(post({}))).json()) as Record<string, unknown>;
    expect(unknown).not.toHaveProperty("refusal");
  });

  it("an idle ping reports no refusal — it uploads nothing to refuse", async () => {
    daemon.exitCode = 6;
    daemonRefuses("usage_unverified", { needed: GB, used: 0, quota: 5 * GB });

    const body = (await (await backupPOST(post({ idle: true }))).json()) as Record<string, unknown>;

    expect(body.code).toBe("offline");
    expect(body).not.toHaveProperty("refusal");
  });

  it("answers a run turned away by another with its own sentence, not a failure's", async () => {
    daemon.exitCode = 14;
    daemon.stderr = "another backup is already running on this device";

    const res = await backupPOST(post({}));
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(409);
    expect(body.code).toBe("already_running");
    expect(body.error).toBe("Another backup is already running — wait for it to finish, then try again");

    // … and a crash, which exits 1, is still "did not finish".
    daemon.exitCode = 1;
    const crashed = (await (await backupPOST(post({}))).json()) as Record<string, unknown>;
    expect(crashed.code).toBe("backup_failed");
  });
});

describe("the bridge and the daemon agree on the taxonomy", () => {
  it("gives every EXIT_* the daemon defines a code of its own", async () => {
    // TASK-1000 added three; a fourth added to runner.py and not here would
    // reach the owner as the catch-all "did not finish" — this is the tripwire.
    const { backupExitError } = await import("@/lib/clawkeep");
    const runner = await fs.readFile(
      path.join(process.cwd(), "clawkeep", "clawkeep", "runner.py"),
      "utf8",
    );
    const codes = [...runner.matchAll(/^(EXIT_[A-Z_]+)\s*=\s*(\d+)/gm)].map(
      ([, name, value]) => ({ name, value: Number(value) }),
    );
    expect(codes.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        "EXIT_ARCHIVE_BUSY",
        "EXIT_ARCHIVE_DB_DAMAGED",
        "EXIT_ARCHIVE_CONFLICT",
        "EXIT_ALREADY_RUNNING",
      ]),
    );
    expect(codes.find((c) => c.name === "EXIT_ALREADY_RUNNING")?.value).toBe(14);
    // OK is not a failure; BACKUP_FAILED and UNKNOWN ARE the catch-all.
    const specific = codes.filter(
      (c) => !["EXIT_OK", "EXIT_BACKUP_FAILED", "EXIT_UNKNOWN"].includes(c.name),
    );
    for (const { name, value } of specific) {
      expect({ name, code: backupExitError(value)?.code }).not.toEqual({
        name,
        code: "backup_failed",
      });
    }
  });

  it("knows the refusal kinds the daemon writes, by the names it writes them under", async () => {
    // The two sides share state.json and nothing else: a kind renamed in
    // state.py would simply stop being shown, with no error anywhere.
    const state = await fs.readFile(
      path.join(process.cwd(), "clawkeep", "clawkeep", "state.py"),
      "utf8",
    );
    const kinds = [...state.matchAll(/^REFUSAL_[A-Z_]+\s*=\s*"([a-z_]+)"/gm)].map(([, kind]) => kind);
    expect(kinds.sort()).toEqual(["quota_full", "usage_unverified"]);
    for (const field of ["last_refusal", "last_refusal_at_ms", "last_refusal_needed_bytes",
      "last_refusal_used_bytes", "last_refusal_quota_bytes"]) {
      expect(state).toMatch(new RegExp(`^    ${field}: `, "m"));
    }
  });
});
