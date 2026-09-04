import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs, { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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
const SETUP = path.join(REPO, "scripts", "setup-shared-identity.sh");

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

/**
 * A fake systemctl that answers `is-system-running` per SCOPE, and every other
 * verb with one status — because the script has to tell those apart, and
 * because it tries the system unit and the `--user` unit in turn.
 *
 * @param scopes what `is-system-running` PRINTS for each scope. `"offline"` —
 *   or `""`, no answer at all — is a manager that is not there; `"degraded"` is
 *   a real, running systemd that happens to exit non-zero, an ordinary state on
 *   these devices and the reason the script reads the word rather than the
 *   status.
 * @param verbExit what every other verb returns.
 */
function installSystemctl(
  scopes: { system: string; user?: string },
  verbExit: number,
): void {
  const user = scopes.user ?? scopes.system;
  const answer = (state: string) => [
    state ? `  echo ${state}` : '  echo "Failed to connect to bus" >&2',
    // `running` is the only state systemd itself exits 0 for.
    state === "running" ? "  exit 0" : "  exit 1",
  ];
  writeFileSync(
    path.join(binDir, "systemctl"),
    [
      "#!/usr/bin/env bash",
      'if [ "$1" = "--user" ] && [ "$2" = "is-system-running" ]; then',
      ...answer(user),
      "fi",
      'if [ "$1" = "is-system-running" ]; then',
      ...answer(scopes.system),
      "fi",
      `exit ${verbExit}`,
    ].join("\n"),
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

/** The sibling that establishes the bridge — install-time on a dual box. */
function runSetup(): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("bash", [SETUP], {
    encoding: "utf-8",
    cwd: REPO,
    env: {
      ...process.env,
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
    installSystemctl({ system: "running" }, 0);

    const run = runSync();
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("[identity-sync] done");
  }, SHELL_TIMEOUT_MS);

  it("FAILS when neither systemctl form could restart the gateway", () => {
    // Both the system unit (via sudo) and the user unit refuse. The files on
    // disk changed and the running agent did not, which is the one outcome
    // that must not be reported as a completed sync.
    installFake("sudo", 1);
    installSystemctl({ system: "running" }, 1);

    const run = runSync();
    expect(run.status).not.toBe(0);
    expect(run.stdout).not.toContain("[identity-sync] done");
    expect(run.stderr).toMatch(/could not restart clawbox-gateway/);
  }, SHELL_TIMEOUT_MS);

  it("falls back to the user unit when sudo is refused", () => {
    installFake("sudo", 1);
    installSystemctl({ system: "running" }, 0);

    const run = runSync();
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("[identity-sync] done");
  }, SHELL_TIMEOUT_MS);

  it("skips, rather than fails, when systemctl exists but no manager does", () => {
    // A container ships /usr/bin/systemctl with nothing behind it. Failing here
    // would 502 the harness switch on a host that has no running gateway to
    // refresh at all - the false-FAILURE twin of the bug this file fixes.
    installFake("sudo", 1);
    installSystemctl({ system: "offline", user: "offline" }, 1);

    const run = runSync();
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("no systemd manager on this host");
    expect(run.stdout).toContain("[identity-sync] done");
  }, SHELL_TIMEOUT_MS);

  it("treats a systemctl that cannot reach the bus at all as no manager", () => {
    installFake("sudo", 1);
    installSystemctl({ system: "", user: "" }, 1);

    const run = runSync();
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("no systemd manager on this host");
  }, SHELL_TIMEOUT_MS);

  it("FAILS when the system manager is offline but a live USER manager refused", () => {
    // restart_openclaw_gateway tries the system unit AND the --user unit, so
    // "no manager" has to mean neither. A reachable user manager that rejected
    // the unit has REFUSED the refresh, not skipped it, and calling that a skip
    // would put the silence back one level up.
    installFake("sudo", 1);
    installSystemctl({ system: "offline", user: "running" }, 1);

    const run = runSync();
    expect(run.status).not.toBe(0);
    expect(run.stdout).not.toContain("no systemd manager on this host");
    expect(run.stderr).toMatch(/could not restart clawbox-gateway/);
  }, SHELL_TIMEOUT_MS);

  it("still FAILS on a DEGRADED systemd whose restart was refused", () => {
    // `is-system-running` exits non-zero for `degraded`, which is an everyday
    // state on these devices with a real manager running. Reading the exit
    // status instead of the word would route every degraded box into the skip
    // above and hand back the exact silence this change removes.
    installFake("sudo", 1);
    installSystemctl({ system: "degraded" }, 1);

    const run = runSync();
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/could not restart clawbox-gateway/);
  }, SHELL_TIMEOUT_MS);

  it("does not refresh — or fail — when the target harness is Hermes", () => {
    // Bouncing the gateway on a switch AWAY from OpenClaw is the harmful case
    // the target argument exists to prevent, so a dead systemctl is irrelevant
    // here and must not fail the switch.
    installFake("sudo", 1);
    installSystemctl({ system: "running" }, 1);

    const run = runSync("hermes");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("[identity-sync] done");
  }, SHELL_TIMEOUT_MS);
});

/**
 * What happens to the identity OpenClaw's first-conversation ritual writes.
 *
 * The bridge is one-way by design: canonical is authoritative and the OpenClaw
 * workspace gets real copies of it, because OpenClaw's scanner ignores
 * symlinks. On a dual box setup-shared-identity.sh runs at INSTALL time
 * (scripts/setup-hermes-edition.sh), which is before the agent has ever
 * replied — so what it seeds into canonical is a bare "# USER" and "# SOUL",
 * not an identity.
 *
 * Then the owner says hello, the ritual runs, and the agent writes the owner's
 * name into the workspace USER.md and its own vibe into SOUL.md. The very next
 * sync — a harness switch is enough — used to copy those placeholders straight
 * back over both files. Before this batch that copy destroyed nothing, because
 * the same bridge was one of the things suppressing the ritual; now the ritual
 * runs, and the copy would throw its answers away.
 */
describe("the shared-identity bridge and the first-conversation ritual", () => {
  const canon = () => path.join(home, ".clawbox", "agent-identity");
  const ws = () => path.join(home, ".openclaw", "workspace");
  const provisional = () => path.join(canon(), ".provisional");
  const read = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, "utf-8") : null);

  /** The name and the vibe the ritual records, in the two files it writes. */
  const RITUAL_USER = "# USER.md - About Your Human\n\n## Directives\n\n- Always address the user as Maya.\n";
  const RITUAL_SOUL = "# SOUL.md - Who You Are\n\nQuiet, precise, and a little dry. \u{1F980}\n";

  /** An install on a box whose agent has not been introduced yet. */
  function installBeforeFirstHello() {
    // The bridge does not exist at install time; the beforeEach above builds a
    // box that has already been through this.
    rmSync(canon(), { recursive: true, force: true });
    const run = runSetup();
    expect(run.status, run.stderr).toBe(0);
    return run;
  }

  /** The agent working through BOOTSTRAP.md and deleting it at the end. */
  function ritualRuns() {
    writeFileSync(path.join(ws(), "USER.md"), RITUAL_USER, "utf-8");
    writeFileSync(path.join(ws(), "SOUL.md"), RITUAL_SOUL, "utf-8");
  }

  beforeEach(() => {
    // Every case here reaches the gateway refresh, which must not be the thing
    // that fails.
    installFake("sudo", 0);
    installSystemctl({ system: "running" }, 0);
  });

  it("marks an identity seeded before the introduction as provisional", () => {
    installBeforeFirstHello();
    expect(read(path.join(canon(), "USER.md"))).toBe("# USER\n");
    expect(fs.existsSync(provisional())).toBe(true);
  }, SHELL_TIMEOUT_MS);

  it("marks nothing when it seeds from a workspace that has been introduced", () => {
    // An upgraded box: canonical is seeded from real files, so it holds the
    // identity from the first moment and the bridge is one-way as documented.
    ritualRuns();
    installBeforeFirstHello();
    expect(read(path.join(canon(), "USER.md"))).toBe(RITUAL_USER);
    expect(fs.existsSync(provisional())).toBe(false);
  }, SHELL_TIMEOUT_MS);

  it("does not copy the placeholders in while the workspace is still fresh", () => {
    installBeforeFirstHello();
    expect(fs.existsSync(path.join(ws(), "USER.md"))).toBe(false);
    expect(fs.existsSync(path.join(ws(), "MEMORY.md"))).toBe(false);
  }, SHELL_TIMEOUT_MS);

  it("keeps the name and the vibe the ritual recorded, on the next harness switch", () => {
    // The defect, end to end: install, hello, switch.
    installBeforeFirstHello();
    ritualRuns();

    const run = runSync();
    expect(run.status, run.stderr).toBe(0);
    expect(read(path.join(ws(), "USER.md"))).toBe(RITUAL_USER);
    expect(read(path.join(ws(), "SOUL.md"))).toBe(RITUAL_SOUL);
  }, SHELL_TIMEOUT_MS);

  it("promotes them into canonical, so Hermes reads the same agent", () => {
    // Hermes' identity files are symlinks INTO canonical, so leaving the
    // ritual's answers only in the OpenClaw workspace would give the dual box
    // two different agents.
    installBeforeFirstHello();
    ritualRuns();

    const run = runSync();
    expect(run.stdout).toContain("promoted the introduced OpenClaw identity into canonical");
    expect(read(path.join(canon(), "USER.md"))).toBe(RITUAL_USER);
    expect(read(path.join(canon(), "SOUL.md"))).toBe(RITUAL_SOUL);
    expect(fs.existsSync(provisional())).toBe(false);
  }, SHELL_TIMEOUT_MS);

  it("promotes exactly once, and canonical is authoritative from then on", () => {
    installBeforeFirstHello();
    ritualRuns();
    expect(runSync().status).toBe(0);

    // An owner editing canonical is the documented way to change the identity.
    // With the marker gone, the bridge is one-way again and that edit lands.
    writeFileSync(path.join(canon(), "USER.md"), "# USER\n\n- Always address the user as Sam.\n", "utf-8");
    const second = runSync();
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).not.toContain("promoted the introduced");
    expect(read(path.join(ws(), "USER.md"))).toContain("Sam");
  }, SHELL_TIMEOUT_MS);

  it("promotes from setup-shared-identity.sh too, whichever runs first", () => {
    // The install-time script runs again on a re-install and on the sync's own
    // self-heal path, and it carries the same downward copy.
    installBeforeFirstHello();
    ritualRuns();

    const run = runSetup();
    expect(run.status, run.stderr).toBe(0);
    expect(read(path.join(ws(), "USER.md"))).toBe(RITUAL_USER);
    expect(read(path.join(canon(), "USER.md"))).toBe(RITUAL_USER);
    expect(fs.existsSync(provisional())).toBe(false);
  }, SHELL_TIMEOUT_MS);

  it("leaves the workspace alone rather than promoting over an unwritable canonical", () => {
    // The one thing worse than not promoting is promoting halfway and then
    // copying the placeholders down anyway.
    installBeforeFirstHello();
    ritualRuns();
    const files = ["SOUL", "USER", "MEMORY"].map((f) => path.join(canon(), `${f}.md`));
    for (const f of files) fs.chmodSync(f, 0o444);
    fs.chmodSync(canon(), 0o500);
    try {
      const run = runSync();
      // Still a completed sync — the gateway refresh is what this script
      // reports on — but the workspace keeps the ritual's answers.
      expect(run.status, run.stderr).toBe(0);
      expect(run.stderr).toMatch(/could not promote the introduced identity/);
      expect(read(path.join(ws(), "USER.md"))).toBe(RITUAL_USER);
      expect(read(path.join(ws(), "SOUL.md"))).toBe(RITUAL_SOUL);
      expect(fs.existsSync(provisional())).toBe(true);
    } finally {
      fs.chmodSync(canon(), 0o700);
      for (const f of files) fs.chmodSync(f, 0o644);
    }
  }, SHELL_TIMEOUT_MS);
});
