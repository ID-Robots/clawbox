import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * These run the SHIPPED script — scripts/clawbox-identity-sync.sh — against a
 * fake systemd, because the bug is not in what it does but in what it REPORTS.
 *
 * For OpenClaw the gateway restart IS the sync: the canonical SOUL/USER/MEMORY
 * files are copied into ~/.openclaw/workspace, and the gateway scanned and
 * cached that directory when it started, so until it restarts OpenClaw keeps
 * answering as whoever it was before. The restart line used to end in
 * `|| true`, so a box where it did not happen printed "[identity-sync] done"
 * and exited 0 — and /setup-api/harness/select, which refuses to complete a
 * switch when this script fails, could never fire.
 */

/**
 * Each case spawns a real bash and two fake binaries. That is milliseconds on
 * Linux and seconds on a Windows dev box, so the budget is generous — nothing
 * here is timing-dependent, only process-spawn-bound.
 */
const SHELL_TIMEOUT_MS = 30_000;

const REPO = process.cwd();
const SCRIPT = path.join(REPO, "scripts", "clawbox-identity-sync.sh");

let home: string;
let binDir: string;

/** A stand-in for one command on PATH, with the exit status we want from it. */
function installFake(name: string, exitCode: number): void {
  writeFileSync(
    path.join(binDir, name),
    ["#!/usr/bin/env bash", `exit ${exitCode}`].join("\n"),
    { mode: 0o755 },
  );
}

function runSync(target = "openclaw"): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("bash", [SCRIPT, target], {
    encoding: "utf-8",
    cwd: REPO,
    env: {
      ...process.env,
      // binDir goes FIRST, and every test installs a fake for both `sudo` and
      // `systemctl`, so the host's real ones are unreachable whatever else is
      // on the inherited PATH.
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      HOME: home,
    } as unknown as NodeJS.ProcessEnv,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "clawbox-identity-"));
  binDir = path.join(home, "bin");
  mkdirSync(binDir, { recursive: true });

  // The canonical identity, and an OpenClaw workspace to copy it into.
  const canon = path.join(home, ".clawbox", "agent-identity");
  mkdirSync(canon, { recursive: true });
  mkdirSync(path.join(home, ".openclaw", "workspace"), { recursive: true });
  for (const f of ["SOUL", "USER", "MEMORY"]) {
    writeFileSync(path.join(canon, `${f}.md`), `# ${f}\n`, "utf-8");
  }
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("clawbox-identity-sync.sh — the OpenClaw gateway refresh", () => {
  it("succeeds when the gateway restart worked", () => {
    installFake("sudo", 0);
    installFake("systemctl", 0);

    const run = runSync();
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("[identity-sync] done");
  }, SHELL_TIMEOUT_MS);

  it("FAILS when neither systemctl form could restart the gateway", () => {
    // Both the system unit (via sudo) and the user unit refuse. The files on
    // disk changed and the running agent did not, which is the one outcome
    // that must not be reported as a completed sync.
    installFake("sudo", 1);
    installFake("systemctl", 1);

    const run = runSync();
    expect(run.status).not.toBe(0);
    expect(run.stdout).not.toContain("[identity-sync] done");
    expect(run.stderr).toMatch(/could not restart clawbox-gateway/);
  }, SHELL_TIMEOUT_MS);

  it("falls back to the user unit when sudo is refused", () => {
    installFake("sudo", 1);
    installFake("systemctl", 0);

    const run = runSync();
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("[identity-sync] done");
  }, SHELL_TIMEOUT_MS);

  it("does not refresh — or fail — when the target harness is Hermes", () => {
    // Bouncing the gateway on a switch AWAY from OpenClaw is the harmful case
    // the target argument exists to prevent, so a dead systemctl is irrelevant
    // here and must not fail the switch.
    installFake("sudo", 1);
    installFake("systemctl", 1);

    const run = runSync("hermes");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("[identity-sync] done");
  }, SHELL_TIMEOUT_MS);
});
