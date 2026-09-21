import { EventEmitter } from "node:events";
import fs from "fs/promises";
import os from "os";
import path from "path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The snapshot LIST must say why it could not list.
 *
 * Found by the device feature sweep on a box whose ClawKeep account is over
 * quota: `GET /setup-api/clawkeep/snapshots` answered
 * `502 {"error":"Could not list cloud backups"}` while `clawkeep snapshots`
 * run by hand said `Cloud backup quota reached. Upgrade your plan or remove
 * old snapshots.` The reason was lost twice on its way out — `cli.py`'s error
 * envelope printed no `kind`, so `api.ApiError`'s own `quota_full`
 * classification never crossed the process boundary, and `mapSnapshotsError`
 * had no branch to receive it if it had. The owner was told to remove old
 * snapshots by a box that would not say what was wrong.
 *
 * The status and code are deliberately the ones the BACKUP path has always
 * answered for the same condition (`backupExitError`, EXIT_QUOTA_FULL → 507
 * `quota_full`): one account-full sentence for the whole feature, whichever
 * half of it the owner touched.
 *
 * NOT fixed here, and not this test's subject: the list is refused at all.
 * `snapshots` mints credentials before it lists, and the portal answers 402 to
 * the mint while the account is over quota — a read refused over a limit a
 * read cannot exceed. That is portal-side.
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

const TEST_ROOT = path.join(os.tmpdir(), `clawbox-clawkeep-snaps-${process.pid}-${Date.now()}`);
const DATA_DIR = path.join(TEST_ROOT, "clawkeep");
const TOKEN_PATH = path.join(DATA_DIR, "token");

/** The daemon's own words for the quota case, verbatim from the live box. */
const QUOTA_MESSAGE = "Cloud backup quota reached. Upgrade your plan or remove old snapshots.";

let snapshotsGET: typeof import("@/app/setup-api/clawkeep/snapshots/route").GET;

beforeAll(async () => {
  process.env.CLAWKEEP_DATA_DIR = DATA_DIR;
  process.env.CLAWKEEP_CONFIG_PATH = path.join(DATA_DIR, "config.toml");
  process.env.CLAWKEEP_BIN = "/bin/true";
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  snapshotsGET = (await import("@/app/setup-api/clawkeep/snapshots/route")).GET;
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
  await fs.writeFile(TOKEN_PATH, "claw_testtoken", { mode: 0o600 });
});

describe("GET /setup-api/clawkeep/snapshots classifies the daemon's failure", () => {
  it("answers 507 quota_full — with the remedy, not 'could not list'", async () => {
    daemon.exitCode = 1;
    daemon.stdout = JSON.stringify({ ok: false, kind: "quota_full", error: QUOTA_MESSAGE });

    const res = await snapshotsGET();
    const body = (await res.json()) as Record<string, unknown>;

    expect(daemon.spawns).toHaveLength(1);
    expect(res.status).toBe(507);
    expect(body.code).toBe("quota_full");
    expect(String(body.error)).toContain("out of space");
    // The status the backup path answers for the same condition. Not 502, and
    // above all not the unclassified sentence that hid the reason.
    expect(String(body.error)).not.toContain("Could not list cloud backups");
  });

  it("answers 402 tier_limit for the plan refusal, the other kind that had nowhere to land", async () => {
    daemon.exitCode = 1;
    daemon.stdout = JSON.stringify({ ok: false, kind: "tier", error: "plan does not allow this" });

    const res = await snapshotsGET();
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(402);
    expect(body.code).toBe("tier_limit");
  });

  it("keeps the kinds it already mapped, and never repeats the daemon's own words", async () => {
    const expected: Record<string, number> = {
      auth: 401,
      network: 504,
      server: 502,
      quota_full: 507,
      tier: 402,
    };
    for (const [kind, status] of Object.entries(expected)) {
      daemon.exitCode = 1;
      daemon.stdout = JSON.stringify({ ok: false, kind, error: `daemon said ${kind} at /home/clawbox/secret` });
      const res = await snapshotsGET();
      const body = (await res.json()) as Record<string, unknown>;
      expect({ kind, status: res.status }).toEqual({ kind, status });
      // The daemon's string can be a traceback or carry device paths.
      expect(JSON.stringify(body)).not.toContain("daemon said");
      expect(JSON.stringify(body)).not.toContain("/home/clawbox/secret");
    }
  });

  it("still falls back to 502 for a failure the daemon did not classify", async () => {
    daemon.exitCode = 1;
    daemon.stdout = JSON.stringify({ ok: false, error: "boto3 is not installed" });

    const res = await snapshotsGET();
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(502);
    expect(String(body.error)).toBe("Could not list cloud backups");
  });

  it("still lists the snapshots when the daemon answers", async () => {
    daemon.stdout = JSON.stringify({
      ok: true,
      snapshots: [{ name: "a.tar.gz.enc", size_bytes: 10, last_modified_ms: 5 }],
    });

    const res = await snapshotsGET();
    const body = (await res.json()) as { snapshots: { name: string }[] };

    expect(res.status).toBe(200);
    expect(body.snapshots.map((s) => s.name)).toEqual(["a.tar.gz.enc"]);
  });
});
