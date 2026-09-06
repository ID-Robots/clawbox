import { EventEmitter } from "events";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import { parseHermesVersion } from "@/lib/version-utils";

/**
 * TASK-613 — ClawBox's own `hermes --version` pays for an update check nobody
 * asked for, and on a cache miss it pays for it with the whole probe.
 *
 * `hermes --version` is the ONLY non-interactive hermes call that runs the
 * agent's passive update check: in 0.20.5 `banner.check_for_updates()` has
 * exactly two call sites — `_startup_fast.py:238`, inside
 * `print_fast_version_info`, and `banner.py:646`, the interactive welcome
 * banner. Every `config` / `skills` / `plugins` / `approvals` call ClawBox
 * makes is already silent, which is why the silence is asked for at ONE call
 * site rather than blanket-applied.
 *
 * What that one call costs, measured on the Hermes box (read-only):
 *  - it appends `Update available: 7669 commits behind — run 'hermes update'`
 *    to the banner ClawBox parses — advice that is wrong twice over on a
 *    device pinned to a commit whose update path is not `hermes update`;
 *  - the answer is cached for six hours, and every miss synchronously runs
 *    `git fetch origin main --depth 1` (10 s ceiling, `banner.py:339-347`) and
 *    an unauthenticated GitHub compare (10 s ceiling, `banner.py:196-231`) —
 *    inside the 10 s `runHermesCli` budget `readHermesVersion` gives the WHOLE
 *    call. The probe then rejects with "hermes timed out", `readHermesVersion`
 *    catches it and answers null, and the About screen reports no Hermes
 *    version on a box whose agent is running fine. A plain `git ls-remote`
 *    from that box took 43.1 s on its first GitHub contact.
 *
 * The switch already exists upstream — `print_fast_version_info(*,
 * check_updates: bool = True)` returns early at `_startup_fast.py:228-229` —
 * but all five of its call sites hard-code True, `banner.py` reads only
 * `HERMES_REVISION`, and there is no `updates.check` config key, so the CLI
 * cannot be asked for it (NousResearch/hermes-agent#104275). Until it can,
 * ClawBox asks the agent's own printer directly, through the interpreter the
 * `hermes` shim execs.
 *
 * Pinned here:
 *  - the silence goes through the ONE spawn seam, and is asked for by the
 *    version probe;
 *  - it FAILS OPEN — an interpreter that cannot answer leaves the plain
 *    `hermes --version` call, and the banner parser still reads the version
 *    off the noisy output (the false-failure guard);
 *  - it never turns one deadline into two.
 */

vi.mock("child_process", () => ({ spawn: vi.fn() }));
vi.mock("@/lib/harness", () => ({ HERMES_BIN: "/home/clawbox/.local/bin/hermes" }));

import { spawn } from "child_process";
import { runHermesCli } from "@/lib/hermes-cli";

const mockSpawn = vi.mocked(spawn);

const HERMES_BIN = "/home/clawbox/.local/bin/hermes";
const HOME = process.env.HOME || "/home/clawbox";
const AGENT_DIR = path.join(HOME, ".hermes", "hermes-agent");
const VENV_PYTHON = path.join(AGENT_DIR, "venv", "bin", "python");

/** The banner a silenced probe gets, verbatim from the Hermes box. */
const SILENT_BANNER = [
  "Hermes Agent v0.20.5 (2026.8.19) · upstream 089bb328 · local fcbd1076 (+24396 carried commits)",
  "Install directory: /home/clawbox/.hermes/hermes-agent",
  "Install method: git",
  "Python: 3.11.15",
  "OpenAI SDK: 2.24.0",
].join("\n");

/** The same banner with the nag the update check appends. */
const NOISY_BANNER = `${SILENT_BANNER}\nUpdate available: 7669 commits behind — run 'hermes update'`;

type FakeChild = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };

function fakeChild(act?: (c: FakeChild) => void): FakeChild {
  const c = new EventEmitter() as FakeChild;
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.kill = vi.fn();
  if (act) setImmediate(() => act(c));
  return c;
}

/** Answers `stdout` and exits `code`. */
const answers = (stdout: string, code = 0) =>
  fakeChild((c) => {
    if (stdout) c.stdout.emit("data", Buffer.from(stdout));
    c.emit("close", code);
  });

/** Cannot be started at all — the interpreter is not there. */
const unstartable = (errno: string) =>
  fakeChild((c) => {
    const e = new Error(`spawn ${errno}`) as NodeJS.ErrnoException;
    e.code = errno;
    c.emit("error", e);
  });

/** Started, and never says anything. */
const hangs = () => fakeChild();

const spawnedEnv = (call: number) =>
  (mockSpawn.mock.calls[call][2] as { env: Record<string, string> }).env;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("runHermesCli({ silenceUpdateCheck }) — the version probe stops paying for the update check", () => {
  it("asks the agent's own printer for the banner with the check off", async () => {
    mockSpawn.mockImplementation(() => answers(SILENT_BANNER) as never);

    const result = await runHermesCli(["--version"], {
      timeoutMs: 10_000,
      silenceUpdateCheck: true,
    });

    // ONE spawn: the noisy `hermes --version` is not run at all.
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [bin, argv] = mockSpawn.mock.calls[0];
    // The interpreter the shim execs, not the shim — the shim has no way to
    // pass the flag through.
    expect(bin).toBe(VENV_PYTHON);
    expect(argv).toEqual(["-c", expect.stringContaining("check_updates=False")]);
    expect(result.stdout).not.toMatch(/Update available/);
    expect(parseHermesVersion(result.stdout)).toBe("v0.20.5");
  });

  it("makes the checkout importable the way the shim does, and inherits no Python home", async () => {
    // The shim is four lines: unset PYTHONPATH, unset PYTHONHOME, exec the
    // venv interpreter on `<agent_dir>/hermes`. Running `-c` instead means
    // pointing PYTHONPATH at the checkout (the package IS the checkout — there
    // is no pip dist to import) while still refusing an inherited PYTHONHOME,
    // which would send the interpreter at a different stdlib.
    process.env.PYTHONHOME = "/somewhere/else";
    try {
      mockSpawn.mockImplementation(() => answers(SILENT_BANNER) as never);

      await runHermesCli(["--version"], { timeoutMs: 10_000, silenceUpdateCheck: true });

      expect(spawnedEnv(0).PYTHONPATH).toBe(AGENT_DIR);
      expect(spawnedEnv(0)).not.toHaveProperty("PYTHONHOME");
    } finally {
      delete process.env.PYTHONHOME;
    }
  });

  it("falls open to `hermes --version` when the interpreter is not there", async () => {
    mockSpawn
      .mockImplementationOnce(() => unstartable("ENOENT") as never)
      .mockImplementationOnce(() => answers(NOISY_BANNER) as never);

    const result = await runHermesCli(["--version"], {
      timeoutMs: 10_000,
      silenceUpdateCheck: true,
    });

    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(mockSpawn.mock.calls[1][0]).toBe(HERMES_BIN);
    expect(mockSpawn.mock.calls[1][1]).toEqual(["--version"]);
    // The false-failure guard: the silence being absent must cost the nag
    // line and NOTHING else — the version still reads out of the banner.
    expect(result.stdout).toContain("Update available");
    expect(parseHermesVersion(result.stdout)).toBe("v0.20.5");
  });

  it("falls open when the printer is there but refuses", async () => {
    // A renamed module or a changed signature: the interpreter starts, the
    // import or the call raises, exit 1. Same outcome as no interpreter.
    mockSpawn
      .mockImplementationOnce(() => answers("", 1) as never)
      .mockImplementationOnce(() => answers(NOISY_BANNER) as never);

    const result = await runHermesCli(["--version"], {
      timeoutMs: 10_000,
      silenceUpdateCheck: true,
    });

    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(mockSpawn.mock.calls[1][0]).toBe(HERMES_BIN);
    expect(parseHermesVersion(result.stdout)).toBe("v0.20.5");
  });

  it("leaves every other hermes call exactly as it was", async () => {
    // `--version` is the only call that runs the check, so the flag must be a
    // no-op everywhere else rather than a second way to spawn the agent.
    mockSpawn.mockImplementation(() => answers("cli") as never);

    await runHermesCli(["config", "get", "display.interface"], { silenceUpdateCheck: true });

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockSpawn.mock.calls[0][0]).toBe(HERMES_BIN);
    expect(mockSpawn.mock.calls[0][1]).toEqual(["config", "get", "display.interface"]);
  });

  it("never silently drops sudo", async () => {
    // Silencing a privileged call by running the interpreter directly would
    // drop the privilege and answer for a different process than the caller
    // asked for. Nothing calls `--version` under sudo today; the guard is what
    // keeps that true.
    mockSpawn.mockImplementation(() => answers(SILENT_BANNER) as never);

    await runHermesCli(["--version"], { silenceUpdateCheck: true, sudo: true });

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockSpawn.mock.calls[0][0]).toBe("/usr/bin/sudo");
    expect(mockSpawn.mock.calls[0][1]).toEqual(["-n", HERMES_BIN, "--version"]);
  });
});

describe("the silence spends one deadline, not two", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("hands the fallback what is left of the caller's budget", async () => {
    // Two full timeouts in series would turn a 10 s probe into a 20 s one and
    // make the fix worse than the defect it removes: `getVersionInfo` is what
    // the About screen polls.
    mockSpawn.mockImplementation(() => hangs() as never);

    const call = runHermesCli(["--version"], { timeoutMs: 10_000, silenceUpdateCheck: true });
    const settled = call.then(
      () => "resolved",
      (e: Error) => e.message,
    );

    // Half the budget for the silent form — it does no network at all.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(mockSpawn.mock.calls[1][0]).toBe(HERMES_BIN);

    // …and the other half for the fallback, so the whole call is still bounded
    // by the 10 s the caller asked for.
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(settled).resolves.toMatch(/timed out/);
  });
});

/**
 * install.sh probes the agent twice with `--version` — once to decide whether
 * Hermes is installed at all, once to verify the install it just ran. Both
 * throw the answer away with `head -1`, and on a fresh box BOTH are cache
 * misses, so the step pays the fetch and the GitHub compare twice for a line
 * nobody reads.
 */
describe("install.sh's own probes carry the same silence", () => {
  const REPO = path.resolve(__dirname, "../../..");
  const INSTALL_SH = fs.readFileSync(path.join(REPO, "install.sh"), "utf-8");
  const NL = String.fromCharCode(10);

  /** The step's code with comments dropped and continuations joined. */
  const STEP = (() => {
    const start = INSTALL_SH.indexOf("step_hermes_install() {");
    if (start < 0) throw new Error("step_hermes_install not found in install.sh");
    const end = INSTALL_SH.indexOf(`${NL}}`, start);
    return INSTALL_SH.slice(start, end)
      .split(NL)
      .filter((l) => !l.trim().startsWith("#"))
      .join(NL)
      .replace(new RegExp("\\\\" + NL + "\\s*", "g"), " ");
  })();

  it("tries the silent printer at both probes", () => {
    const silent = STEP.split(NL).filter((l) => l.includes("check_updates=False"));
    expect(silent).toHaveLength(2);
    for (const line of silent) {
      // Same two rules the shim probes already follow.
      expect(line, `must not run the agent as root: ${line}`).toContain('runuser -u "$CLAWBOX_USER"');
      expect(line, `must pass HOME: ${line}`).toContain('HOME="$CLAWBOX_HOME"');
    }
  });

  it("keeps the `--version` probe as the fallback, after the silent one", () => {
    const lines = STEP.split(NL);
    const shimProbes = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => l.includes("--version") && l.includes("$shim"));
    expect(shimProbes).toHaveLength(2);
    for (const { i } of shimProbes) {
      const before = lines.slice(0, i).filter((l) => l.includes("check_updates=False"));
      expect(before.length, "the silent probe must come first").toBeGreaterThan(0);
    }
  });
});

/**
 * This is a workaround for a gap upstream has been asked to close. It has to
 * be findable on the day it can be deleted.
 */
describe("the workaround is marked for removal", () => {
  const REPO = path.resolve(__dirname, "../../..");
  const MARKER = /TASK-613: remove once hermes-agent#104275 lands/;

  it.each(["src/lib/hermes-cli.ts", "src/lib/updater.ts", "install.sh"])(
    "%s carries the revert marker",
    (file) => {
      // `.test()` rather than `toMatch`, so a miss reports the file and not
      // the whole of install.sh.
      const marked = MARKER.test(fs.readFileSync(path.join(REPO, file), "utf-8"));
      expect(marked, `${file} must say when this workaround can be deleted`).toBe(true);
    },
  );
});
