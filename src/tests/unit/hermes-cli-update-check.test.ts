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
 *  - it never shortens the supported call it falls back to.
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
    // is no pip dist to import), refusing an inherited PYTHONHOME, which would
    // send the interpreter at a different stdlib, and keeping the CWD off
    // `sys.path[0]` — `-c` puts it there and the shim never does, so a
    // stdlib-shadowing file in $HOME would break a probe the shim runs fine.
    process.env.PYTHONHOME = "/somewhere/else";
    try {
      mockSpawn.mockImplementation(() => answers(SILENT_BANNER) as never);

      await runHermesCli(["--version"], { timeoutMs: 10_000, silenceUpdateCheck: true });

      expect(spawnedEnv(0).PYTHONPATH).toBe(AGENT_DIR);
      expect(spawnedEnv(0).PYTHONSAFEPATH).toBe("1");
      expect(spawnedEnv(0)).not.toHaveProperty("PYTHONHOME");
      // …and the three variables every hermes child is promised are still there.
      expect(spawnedEnv(0).HOME).toBe(HOME);
      expect(spawnedEnv(0).COLUMNS).toBe("400");
    } finally {
      delete process.env.PYTHONHOME;
    }
  });

  it("follows the install the fallback would run, not a hard-coded one", async () => {
    // Both halves have to read the SAME install: if the silent probe answered
    // for `~/.hermes` while the shim ran an install `HERMES_HOME` moved, the
    // About screen would show a version belonging to a different agent — and
    // both paths exist, so nothing would look wrong. Same overrides the rest of
    // the repo honours (hermesHome() in hermes-env.ts).
    process.env.HERMES_HOME = "/opt/hermes-home";
    try {
      mockSpawn.mockImplementation(() => answers(SILENT_BANNER) as never);

      await runHermesCli(["--version"], { silenceUpdateCheck: true });

      expect(mockSpawn.mock.calls[0][0]).toBe(
        path.join("/opt/hermes-home", "hermes-agent", "venv", "bin", "python"),
      );
      expect(spawnedEnv(0).PYTHONPATH).toBe(path.join("/opt/hermes-home", "hermes-agent"));
    } finally {
      delete process.env.HERMES_HOME;
    }
  });

  it("falls open when the printer answers something that is not a banner", async () => {
    // `parseHermesVersion` SHOWS an unrecognised first line rather than
    // reporting nothing, so a sitecustomize notice (or a future upstream line)
    // on stdout would become "the Hermes version" on the About screen and the
    // supported call that prints the real one would never be made.
    mockSpawn
      .mockImplementationOnce(() => answers("Note: running under a virtualenv") as never)
      .mockImplementationOnce(() => answers(NOISY_BANNER) as never);

    const result = await runHermesCli(["--version"], { silenceUpdateCheck: true });

    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(mockSpawn.mock.calls[1][0]).toBe(HERMES_BIN);
    expect(parseHermesVersion(result.stdout)).toBe("v0.20.5");
  });

  it("does not ask the same question twice when the child said far too much", async () => {
    // Every other failure means the child could not be STARTED, and the
    // supported call is the answer. A runaway child is not that: retrying it
    // would overflow the same buffer, so the caller hears the real reason.
    mockSpawn.mockImplementation(
      () =>
        fakeChild((c) => {
          c.stdout.emit("data", Buffer.alloc(1_000_001, 0x61));
        }) as never,
    );

    const err = await runHermesCli(["--version"], { silenceUpdateCheck: true }).then(
      () => new Error("expected a rejection"),
      (e: Error) => e,
    );

    expect(err.message).toMatch(/exceeded the size limit/);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
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

describe("the silence never shortens the supported call", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("caps itself and hands the fallback the caller's WHOLE budget", () => {
    // Splitting the caller's budget in half was the first shape of this, and
    // it made the fix worse than the defect on the hardware it targets: a cold,
    // loaded Orin where `hermes --version` answers in eight seconds would get
    // five, time out, and report no version — a NEW false failure introduced by
    // a change whose whole purpose is removing one. So the silent attempt has
    // its own ceiling and the supported call keeps every millisecond it had.
    mockSpawn.mockImplementation(() => hangs() as never);

    const settled = runHermesCli(["--version"], {
      timeoutMs: 10_000,
      silenceUpdateCheck: true,
    }).then(
      () => "resolved",
      (e: Error) => e.message,
    );

    return (async () => {
      // The silent attempt's own 5 s ceiling, not a slice of the 10 s.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(mockSpawn).toHaveBeenCalledTimes(2);
      expect(mockSpawn.mock.calls[1][0]).toBe(HERMES_BIN);
      expect(mockSpawn.mock.calls[1][1]).toEqual(["--version"]);

      // …and the fallback then gets the full 10 s the caller asked for: at
      // 9_999 ms into it nothing has settled.
      await vi.advanceTimersByTimeAsync(9_999);
      await expect(Promise.race([settled, Promise.resolve("pending")])).resolves.toBe("pending");

      await vi.advanceTimersByTimeAsync(1);
      await expect(settled).resolves.toMatch(/timed out/);
    })();
  });

  it("never gives the silent attempt more than the caller allowed", () => {
    // A caller with a budget under the ceiling still bounds the whole call.
    mockSpawn.mockImplementation(() => hangs() as never);

    const settled = runHermesCli(["--version"], {
      timeoutMs: 2_000,
      silenceUpdateCheck: true,
    }).then(
      () => "resolved",
      (e: Error) => e.message,
    );

    return (async () => {
      await vi.advanceTimersByTimeAsync(2_000);
      expect(mockSpawn).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(settled).resolves.toMatch(/timed out/);
    })();
  });
});

/**
 * install.sh probes the agent twice — once to decide whether Hermes is
 * installed at all, once to verify the install it just ran. Both throw the
 * answer away with `head -1`, and on a fresh box BOTH are cache misses, so the
 * step paid the fetch and the GitHub compare twice for a line nobody reads.
 *
 * The invariant the silence must NOT take with it is the one the step exists
 * for: runnability is the SHIM's to prove. Importing `hermes_cli` says the
 * package is on disk; it does not say `~/.local/bin/hermes` works, and a box
 * where it does not is exactly the box this step has to repair. Driven for
 * real in install-hermes-install-guard.test.ts ("a broken shim over an
 * importable package is still 'not installed'"); pinned as text here because
 * the four things that make the silent probe work are invisible to a
 * behavioural harness whose fake interpreter ignores its argv.
 */
describe("install.sh's own probes carry the same silence", () => {
  const REPO = path.resolve(__dirname, "../../..");
  const INSTALL_SH = fs.readFileSync(path.join(REPO, "install.sh"), "utf-8");
  const NL = String.fromCharCode(10);

  /** The step's code with comments dropped and continuations joined. */
  const LINES = (() => {
    const start = INSTALL_SH.indexOf("step_hermes_install() {");
    if (start < 0) throw new Error("step_hermes_install not found in install.sh");
    const end = INSTALL_SH.indexOf(`${NL}}`, start);
    return INSTALL_SH.slice(start, end)
      .split(NL)
      .filter((l) => !l.trim().startsWith("#"))
      .join(NL)
      .replace(new RegExp("\\\\" + NL + "\\s*", "g"), " ")
      .split(NL);
  })();

  const silentProbes = () => LINES.filter((l) => l.includes("check_updates=False"));

  it("tries the silent printer at both probes", () => {
    expect(silentProbes()).toHaveLength(2);
    for (const line of silentProbes()) {
      // Same two rules every hermes invocation in this step already follows:
      // never as root (a root-run probe writes root-owned __pycache__ into a
      // clawbox-owned tree, which is what made the factory reset abort
      // mid-wipe), and HOME explicitly (hermes resolves ~/.hermes from it, and
      // install.sh's own HOME is /root).
      expect(line, `must not run the agent as root: ${line}`).toContain('runuser -u "$CLAWBOX_USER"');
      expect(line, `must pass HOME: ${line}`).toContain('HOME="$CLAWBOX_HOME"');
      // The package IS the checkout — there is no pip dist — so without this
      // the import fails on every box and the silence is dead code.
      expect(line, `must put the checkout on the path: ${line}`).toContain(
        'PYTHONPATH="$agent_dir"',
      );
      // An inherited PYTHONHOME aims the interpreter at a different stdlib;
      // the shim unsets it for exactly this reason.
      expect(line, `must not inherit a Python home: ${line}`).toContain("env -u PYTHONHOME");
      // `-c` puts the CWD on sys.path[0] and the shim never does.
      expect(line, `must keep the CWD off sys.path: ${line}`).toContain("PYTHONSAFEPATH=1");
      // A traceback on stderr must not reach the log, and — under
      // `set -euo pipefail` — the assignment must not inherit the probe's
      // status: that is what kills `install.sh --step hermes_install` outright.
      expect(line, `must not print a traceback: ${line}`).toContain("2>/dev/null");
      expect(line, `must not let errexit kill the step: ${line}`).toContain('|| installed=""');
    }
  });

  it("lets the SHIM decide whether Hermes runs, before either version read", () => {
    // The whole point of the step: "require the interpreter to exist AND the
    // agent to actually answer". `--help` runs the same shim → entry script →
    // hermes_cli.main path `--version` does and no update check with it.
    const gates = LINES.map((l, i) => ({ l, i })).filter(
      ({ l }) => l.includes("$shim") && l.includes("--help"),
    );
    expect(gates).toHaveLength(2);
    for (const { l, i } of gates) {
      expect(l, `the gate must run as the clawbox user with HOME: ${l}`).toContain(
        'runuser -u "$CLAWBOX_USER"',
      );
      expect(l).toContain('HOME="$CLAWBOX_HOME"');
      // …and it gates the version reads rather than sitting beside them.
      expect(l.trimStart(), `the gate must be a condition: ${l}`).toMatch(/^if runuser/);
      const after = LINES.slice(i);
      expect(after.findIndex((x) => x.includes("check_updates=False"))).toBeGreaterThan(-1);
    }
  });

  it("pairs each silent probe with the `--version` fallback that follows it", () => {
    // Fail OPEN: an interpreter that cannot answer must leave the supported
    // probe behind it, and it must be the NEXT statement rather than one
    // somewhere later in the step.
    for (const line of silentProbes()) {
      const next = LINES[LINES.indexOf(line) + 1];
      expect(next, `no fallback after: ${line}`).toBeDefined();
      expect(next, `the fallback must be guarded on an empty result: ${next}`).toContain(
        '[ -n "$installed" ] ||',
      );
      expect(next).toContain('"$shim" --version');
      expect(next).toContain('|| installed=""');
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
