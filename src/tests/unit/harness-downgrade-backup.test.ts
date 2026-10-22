import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The override's backup (src/lib/harness-downgrade-backup.ts): ClawKeep when the
 * box is paired, else each harness's own backup command — and for OpenClaw, run
 * in the environment the updater pins every `openclaw` child to, so the verified
 * archive is of the tree this box runs and not of some other, empty one.
 */

vi.mock("child_process", () => ({ execFile: vi.fn() }));
vi.mock("@/lib/openclaw-config", () => ({ findOpenclawBin: () => "/opt/core/bin/openclaw" }));
vi.mock("@/lib/hermes-cli", () => ({ runHermesCli: vi.fn() }));
vi.mock("@/lib/clawkeep", () => ({ readToken: vi.fn(), runBackup: vi.fn() }));

import * as childProcess from "child_process";
import { readToken, runBackup } from "@/lib/clawkeep";
import { backUpBeforeDowngrade } from "@/lib/harness-downgrade-backup";

const DOWNGRADE = [{ harness: "openclaw" as const, installed: "2026.10.6", target: "2026.10.3" }];
const NOW = new Date("2026-10-23T08:00:00Z");
/** What the updater's openclawChildEnv() hands over. */
const PINNED_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  PATH: "/usr/bin",
  HOME: "/srv/box",
  OPENCLAW_STATE_DIR: "/srv/box/.openclaw",
  OPENCLAW_CONFIG_PATH: "/srv/box/.openclaw/openclaw.json",
};

let home: string;
const originalHome = process.env.HOME;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "clawbox-downgrade-backup-"));
  process.env.HOME = home;
  vi.mocked(readToken).mockResolvedValue(null);
});

afterEach(() => {
  process.env.HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
  vi.mocked(childProcess.execFile).mockReset();
  vi.mocked(runBackup).mockReset();
});

function execFileAnswers(fail?: { stderr: string }) {
  vi.mocked(childProcess.execFile).mockImplementation(((_cmd: string, _args: string[], ...rest: unknown[]) => {
    const cb = rest[rest.length - 1] as (err: Error | null, out?: unknown) => void;
    if (fail) return cb(Object.assign(new Error("Command failed"), { stderr: fail.stderr, stdout: "" }));
    return cb(null, { stdout: "{}", stderr: "" });
  }) as never);
}

describe("backUpBeforeDowngrade, on a box not paired with ClawKeep", () => {
  it("runs the core's own verified backup in the environment the updater pins", async () => {
    execFileAnswers();

    const result = await backUpBeforeDowngrade(DOWNGRADE, PINNED_ENV, NOW);

    const dir = path.join(home, "clawbox-harness-backups", "20261023T080000Z");
    expect(result).toMatchObject({ ok: true, kind: "local", dir });
    const [cmd, args, opts] = vi.mocked(childProcess.execFile).mock.calls[0] as unknown as [string, string[], { env?: unknown }];
    expect(cmd).toBe("/opt/core/bin/openclaw");
    expect(args).toEqual(["backup", "create", "--verify", "--no-include-workspace", "--output", path.join(dir, "openclaw"), "--json"]);
    expect(opts.env).toBe(PINNED_ENV);
    expect(readFileSync(path.join(dir, "README.txt"), "utf-8")).toContain("OpenClaw 2026.10.6 -> 2026.10.3");
  });

  it("answers a failed backup with the command's own words, never a success", async () => {
    execFileAnswers({ stderr: "Error: not enough free disk space to write the archive" });

    const result = await backUpBeforeDowngrade(DOWNGRADE, PINNED_ENV, NOW);

    expect(result).toEqual({
      ok: false,
      reason: "openclaw backup create failed: Error: not enough free disk space to write the archive",
    });
  });
});

describe("backUpBeforeDowngrade, on a box paired with ClawKeep", () => {
  it("backs up with ClawKeep first and runs no local backup", async () => {
    vi.mocked(readToken).mockResolvedValue("claw_token");
    vi.mocked(runBackup).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    execFileAnswers();

    const result = await backUpBeforeDowngrade(DOWNGRADE, PINNED_ENV, NOW);

    expect(result).toMatchObject({ ok: true, kind: "clawkeep" });
    expect(childProcess.execFile).not.toHaveBeenCalled();
  });
});
