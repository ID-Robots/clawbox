import { EventEmitter } from "node:events";
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
 * `EXIT_ENCRYPTION_FAILED=10`, `EXIT_UNKNOWN=99`; `daemon.py`: 64 for a bad
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

const TEST_ROOT = path.join(os.tmpdir(), `clawbox-clawkeep-exits-${process.pid}-${Date.now()}`);
const DATA_DIR = path.join(TEST_ROOT, "clawkeep");
const TOKEN_PATH = path.join(DATA_DIR, "token");

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
    for (const exitCode of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 64, 65, 99, 124, 127]) {
      daemon.exitCode = exitCode;
      daemon.stderr = `daemon said something about ${exitCode}`;
      const res = await backupPOST(post({}));
      const body = (await res.json()) as Record<string, unknown>;
      expect({ exitCode, status: res.status, ok: res.ok }).toEqual({
        exitCode,
        status: res.status,
        ok: false,
      });
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
      65: { status: 409, code: "not_paired" },
      124: { status: 504, code: "timed_out" },
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
