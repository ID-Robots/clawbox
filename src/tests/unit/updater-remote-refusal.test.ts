import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as childProcess from "child_process";
import * as fs from "fs/promises";

/**
 * GitHub refuses anonymous `git-upload-pack` POSTs from an address that has
 * used up its anonymous allowance — with `HTTP 401` and a body reading
 * "Repository not found.", for a PUBLIC repository. git surfaces that as
 * `fatal: could not read Username for 'https://github.com'`, which names
 * CREDENTIALS while the cause is an anonymous-access refusal.
 *
 * Every ClawBox fetches anonymously and a customer box has no credential to
 * offer, so the three things this file pins are the three ways that refusal
 * currently reaches the owner as something else:
 *
 *  - FALSE SUCCESS: /update/versions swallows the failed fetch, compares HEAD
 *    against a STALE `origin/<branch>` and answers "You're up to date".
 *  - NO RETRY: one refused attempt ends the check, though the refusal is
 *    intermittent (measured ~1 in 3 getting through, TASK-655).
 *  - FALSE FAILURE: the `restart` step re-fetches refs step 0 already
 *    fetched and hard-reset the tree to, so a refusal there paints
 *    "Update failed" over a tree that is already at the target.
 */

vi.mock("child_process", () => ({
  exec: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
  realpath: vi.fn(),
  rm: vi.fn(),
  // collectBuildIdentity stats the build tree before the sync. It is caught
  // and warned about, but leaving it off the mock makes every case in this
  // file log a mock error that has nothing to do with what it asks.
  stat: vi.fn(async () => {
    throw new Error("ENOENT");
  }),
}));

vi.mock("@/lib/config-store", () => ({
  get: vi.fn(),
  set: vi.fn(),
  setMany: vi.fn(),
}));

vi.mock("@/lib/port-probe", async (orig) => ({
  ...(await orig<typeof import("@/lib/port-probe")>()),
  waitForPortOpen: vi.fn(),
}));

const { mockRunHermesCli } = vi.hoisted(() => ({ mockRunHermesCli: vi.fn() }));
vi.mock("@/lib/hermes-cli", () => ({ runHermesCli: mockRunHermesCli }));

import { saveEnv } from "@/tests/helpers/env";
import { get, set, setMany } from "@/lib/config-store";
import { waitForPortOpen } from "@/lib/port-probe";

const mockExec = vi.mocked(childProcess.exec);
const mockExecFile = vi.mocked(childProcess.execFile);
const mockReadFile = vi.mocked(fs.readFile);
const mockRealpath = vi.mocked(fs.realpath);
const mockRm = vi.mocked(fs.rm);

/** git's own words for GitHub's 401 on an anonymous upload-pack POST. */
const ANON_REFUSAL = "fatal: could not read Username for 'https://github.com': No such device or address";

const SHA = "1111111111111111111111111111111111111111";

type Result = { stdout: string; stderr: string } | Error;
/** A sequence answers successive calls in order, then repeats its last entry. */
type Answer = Result | Result[];

/** Every `execFile` argv this run issued, joined for matching. */
let argvLog: string[] = [];

function install(results: Record<string, Answer>): void {
  // Sequences are consumed by `shift`, so each `install()` gets its OWN copy.
  // Sharing one array with the caller's literal would hand a second `install()`
  // in the same case an already-drained queue that then silently repeats its
  // last entry — a passing test measuring a scenario other than the one it reads
  // as. Every fixture helper in this file is a candidate for exactly that.
  const queues = new Map<string, Result[]>();
  for (const [k, v] of Object.entries(results)) if (Array.isArray(v)) queues.set(k, [...v]);
  const answer = (key: string): Result | undefined => {
    for (const k of Object.keys(results)) {
      if (!key.includes(k)) continue;
      const value = queues.get(k) ?? results[k];
      if (!Array.isArray(value)) return value;
      return value.length > 1 ? value.shift() : value[0];
    }
    return undefined;
  };

  const settle = (result: Result | undefined) => {
    const obj = {
      then: (resolve: (v: { stdout: string; stderr: string }) => void, reject: (e: Error) => void) => {
        if (result instanceof Error) reject(result);
        else resolve(result ?? { stdout: "", stderr: "" });
        return obj;
      },
      catch: (reject: (e: Error) => void) => {
        if (result instanceof Error) reject(result);
        return obj;
      },
    };
    return obj;
  };

  mockExecFile.mockImplementation(((
    cmd: string,
    args: string[],
    optsOrCb?: unknown,
    maybeCb?: unknown,
  ) => {
    const key = `${cmd} ${args.join(" ")}`;
    argvLog.push(key);
    const result = answer(key);
    const cb = (typeof optsOrCb === "function" ? optsOrCb : maybeCb) as
      | ((e: Error | null, r: { stdout: string; stderr: string }) => void)
      | undefined;
    if (cb) {
      if (result instanceof Error) cb(result, { stdout: "", stderr: "" });
      else cb(null, result ?? { stdout: "", stderr: "" });
    }
    return settle(result) as unknown as ReturnType<typeof childProcess.execFile>;
  }) as unknown as typeof childProcess.execFile);

  mockExec.mockImplementation(((cmd: string, optsOrCb?: unknown, maybeCb?: unknown) => {
    argvLog.push(cmd);
    const result = answer(cmd);
    const cb = (typeof optsOrCb === "function" ? optsOrCb : maybeCb) as
      | ((e: Error | null, r: { stdout: string; stderr: string }) => void)
      | undefined;
    if (cb) {
      if (result instanceof Error) cb(result, { stdout: "", stderr: "" });
      else cb(null, result ?? { stdout: "", stderr: "" });
    }
    return settle(result) as unknown as ReturnType<typeof childProcess.exec>;
  }) as unknown as typeof childProcess.exec);
}

function countArgv(fragment: string): number {
  return argvLog.filter((line) => line.includes(fragment)).length;
}

/** Restores every knob below to what it was, rather than deleting it. */
let restoreEnv: () => void = () => {};

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  argvLog = [];
  restoreEnv = saveEnv(
    "CLAWBOX_EDITION",
    "GATEWAY_HEALTH_WAIT_MS",
    "GATEWAY_RECOVERY_WAIT_MS",
    "GATEWAY_WAIT_INTERVAL_MS",
    "UPDATER_REMOTE_RETRY_DELAY_MS",
    "UPDATER_REMOTE_CHECK_RETRY_DELAY_MS",
  );
  process.env.CLAWBOX_EDITION = "openclaw";
  process.env.GATEWAY_HEALTH_WAIT_MS = "1";
  process.env.GATEWAY_RECOVERY_WAIT_MS = "1";
  process.env.GATEWAY_WAIT_INTERVAL_MS = "1";
  // The retry backoff must not turn a unit test into a wall-clock wait. BOTH
  // knobs: the version-check delay defaults to 1200 ms and two of these cases
  // sleep on it twice, which spent over half of vitest's 5 s default before any
  // test work — the flake class src/tests/unit/test-timeout-hygiene.test.ts
  // exists to prevent, and which it cannot see here because this file mocks
  // child_process instead of spawning one.
  process.env.UPDATER_REMOTE_RETRY_DELAY_MS = "1";
  process.env.UPDATER_REMOTE_CHECK_RETRY_DELAY_MS = "1";
  vi.mocked(get).mockResolvedValue(undefined);
  vi.mocked(set).mockResolvedValue();
  vi.mocked(setMany).mockResolvedValue();
  vi.mocked(waitForPortOpen).mockResolvedValue(true);
  mockRealpath.mockImplementation((async (p: unknown) => String(p)) as never);
  mockRm.mockResolvedValue(undefined);
  mockReadFile.mockImplementation(async (file) => {
    const p = String(file);
    if (p.endsWith(".update-branch")) return "beta\n";
    if (p.endsWith("BUILD_ID")) return "rebuilt-build-id\n";
    if (p.endsWith("package.json")) return JSON.stringify({ version: "1.0.0" });
    throw new Error("ENOENT");
  });
});

afterEach(() => {
  // Restored, not deleted: vitest reuses a worker across files, so a `delete`
  // takes the variable away from every file that runs after this one in the
  // same worker. See src/tests/helpers/env.ts.
  restoreEnv();
});

describe("a refused anonymous fetch is not 'up to date'", () => {
  /**
   * The field state the box was in on 2026-09-02: the fetch's POST to
   * /git-upload-pack is refused while `ls-remote`'s GET to /info/refs answers —
   * so the refs on disk are whatever the last successful fetch left, and HEAD
   * equals the STALE origin/beta.
   *
   * The GET answering is what the card measured that day, NOT a property of the
   * endpoint: it is refused too, which is why it is retried and why
   * "still says the remote is unreachable when every ls-remote is refused"
   * exists below.
   */
  function boxWithRefusedFetch(): void {
    install({
      "fetch --quiet origin beta": new Error(ANON_REFUSAL),
      "fetch --quiet --tags origin": new Error(ANON_REFUSAL),
      "ls-remote": { stdout: "abc123\trefs/tags/v1.0.0\n", stderr: "" },
      "rev-parse HEAD": { stdout: `${SHA}\n`, stderr: "" },
      "rev-parse origin/beta": { stdout: `${SHA}\n`, stderr: "" },
      openclaw: { stdout: "1.0.0", stderr: "" },
    });
  }

  it("says the update remote could not be reached instead of reporting no update", async () => {
    boxWithRefusedFetch();
    const updater = await import("@/lib/updater");

    const info = await updater.getVersionInfo();

    // The lie today: `updateAvailable: false` with nothing anywhere in the
    // payload saying the device never managed to ask.
    expect(info.clawbox.updateAvailable).toBe(false);
    expect(info.remote).toBeDefined();
    expect(info.remote?.reachable).toBe(false);
    expect(info.remote?.refusedAnonymously).toBe(true);
  });

  it("retries the refused fetch instead of giving up on the first attempt", async () => {
    boxWithRefusedFetch();
    const updater = await import("@/lib/updater");

    await updater.getVersionInfo();

    expect(countArgv("fetch --quiet origin beta")).toBeGreaterThan(1);
  });

  it("reports a reachable remote on a box whose fetch succeeds", async () => {
    install({
      "fetch --quiet origin beta": { stdout: "", stderr: "" },
      "fetch --quiet --tags origin": { stdout: "", stderr: "" },
      "ls-remote": { stdout: "abc123\trefs/tags/v1.0.0\n", stderr: "" },
      "rev-parse HEAD": { stdout: `${SHA}\n`, stderr: "" },
      "rev-parse origin/beta": { stdout: `${SHA}\n`, stderr: "" },
      openclaw: { stdout: "1.0.0", stderr: "" },
    });
    const updater = await import("@/lib/updater");

    const info = await updater.getVersionInfo();

    expect(info.remote?.reachable).toBe(true);
    expect(countArgv("fetch --quiet origin beta")).toBe(1);
  });
});

describe("a retry delay an operator got wrong", () => {
  it("is replaced with the default, and said out loud", async () => {
    // `Number("soon")` is NaN and a negative value stays negative; `setTimeout`
    // treats both as 0, so the retries would still run — back to back, removing
    // the spacing the policy depends on and sending the anonymous requests in a
    // burst, which is the condition the refusal is caused by. The shell knobs
    // are clamped the same way in install.sh and scripts/force-update.sh.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.UPDATER_REMOTE_CHECK_RETRY_DELAY_MS = "soon";
    process.env.UPDATER_REMOTE_RETRY_DELAY_MS = "-1";

    await import("@/lib/updater");
    const said = warn.mock.calls.map((c) => c.join(" ")).join("\n");

    expect(said).toMatch(/UPDATER_REMOTE_CHECK_RETRY_DELAY_MS="soon".*using 1200/);
    expect(said).toMatch(/UPDATER_REMOTE_RETRY_DELAY_MS="-1".*using 4000/);
    warn.mockRestore();
  });

  it("refuses a blank value, which Number() reads as zero", async () => {
    // `Number(" ")` is 0, not NaN — so whitespace slipped past a plain
    // finite/negative check and became exactly the no-delay burst the guard
    // exists to prevent.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.UPDATER_REMOTE_CHECK_RETRY_DELAY_MS = "  ";

    await import("@/lib/updater");

    expect(warn.mock.calls.map((c) => c.join(" ")).join("\n"))
      .toMatch(/UPDATER_REMOTE_CHECK_RETRY_DELAY_MS.*using 1200/);
    warn.mockRestore();
  });

  it("refuses a value so large the timer would invert it into no delay", async () => {
    // `setTimeout` above 2^31-1 ms does not wait longer, it fires on the next
    // tick with a TimeoutOverflowWarning — and reachOrigin multiplies by the
    // attempt number on top, so the ceiling has to leave room for that.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.UPDATER_REMOTE_RETRY_DELAY_MS = "800000000";

    await import("@/lib/updater");

    expect(warn.mock.calls.map((c) => c.join(" ")).join("\n"))
      .toMatch(/UPDATER_REMOTE_RETRY_DELAY_MS="800000000".*using 4000/);
    warn.mockRestore();
  });

  it("keeps a deliberate override", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.UPDATER_REMOTE_CHECK_RETRY_DELAY_MS = "0";

    await import("@/lib/updater");

    expect(warn.mock.calls.map((c) => c.join(" ")).join("\n"))
      .not.toMatch(/UPDATER_REMOTE_CHECK_RETRY_DELAY_MS/);
    warn.mockRestore();
  });
});

describe("the call the answer depends on is the one that is retried", () => {
  /**
   * `ls-remote` is the AUTHORITATIVE half of the version check: the tag list is
   * read from origin's answer, not from the local refs the tag fetch updates.
   * It got one attempt while the advisory fetch above it got two, so a single
   * refused `ls-remote` made every surface say "couldn't reach the update
   * server" — and `TARGET_VERSION_CACHE_TTL` kept that answer for 60 s.
   */
  it("retries a refused ls-remote instead of reporting no target version", async () => {
    install({
      "fetch --quiet origin beta": { stdout: "", stderr: "" },
      "fetch --quiet --tags origin": { stdout: "", stderr: "" },
      "ls-remote": [new Error(ANON_REFUSAL), { stdout: `${SHA}\trefs/tags/v1.2.3\n`, stderr: "" }],
      "rev-parse HEAD": { stdout: `${SHA}\n`, stderr: "" },
      "rev-parse origin/beta": { stdout: `${SHA}\n`, stderr: "" },
      openclaw: { stdout: "1.0.0", stderr: "" },
    });
    const updater = await import("@/lib/updater");

    const target = await updater.getTargetVersion();

    expect(target).toBe("v1.2.3");
    expect(countArgv("ls-remote")).toBe(2);
  });

  it("spends the retry on ls-remote rather than on the advisory tag fetch", async () => {
    // The anonymous allowance is what is being refused, so the budget stays
    // where it was: the discarded call asks once, the one the answer is read
    // from asks twice.
    install({
      "fetch --quiet origin beta": { stdout: "", stderr: "" },
      "fetch --quiet --tags origin": new Error(ANON_REFUSAL),
      "ls-remote": { stdout: `${SHA}\trefs/tags/v1.2.3\n`, stderr: "" },
      "rev-parse HEAD": { stdout: `${SHA}\n`, stderr: "" },
      "rev-parse origin/beta": { stdout: `${SHA}\n`, stderr: "" },
      openclaw: { stdout: "1.0.0", stderr: "" },
    });
    const updater = await import("@/lib/updater");

    const target = await updater.getTargetVersion();

    expect(target).toBe("v1.2.3");
    expect(countArgv("fetch --quiet --tags origin")).toBe(1);
    expect(countArgv("ls-remote")).toBe(1);
  });

  it("still says the remote is unreachable when every ls-remote is refused", async () => {
    install({
      "fetch --quiet origin beta": { stdout: "", stderr: "" },
      "fetch --quiet --tags origin": { stdout: "", stderr: "" },
      "ls-remote": new Error(ANON_REFUSAL),
      "rev-parse HEAD": { stdout: `${SHA}\n`, stderr: "" },
      "rev-parse origin/beta": { stdout: `${SHA}\n`, stderr: "" },
      openclaw: { stdout: "1.0.0", stderr: "" },
    });
    const updater = await import("@/lib/updater");

    const info = await updater.getVersionInfo();

    expect(await updater.getTargetVersion()).toBeNull();
    expect(info.remote?.reachable).toBe(false);
    expect(info.remote?.refusedAnonymously).toBe(true);
    expect(countArgv("ls-remote")).toBe(2);
  });
});

describe("the restart step spends no anonymous fetch of its own", () => {
  /**
   * By the time the `restart` step runs, step 0 (`bootstrap_updater` →
   * install.sh `sync_repo_to_update_target`) has already fetched origin and
   * hard-reset the tree to it — and step 0 is `failFast`, so a run that reaches
   * here is a run where that happened. Its own `git fetch origin` was therefore
   * the THIRD anonymous fetch of one update and the heaviest (all refs), and it
   * could only ever cost the run: an attempt on 2026-09-02 got through the
   * first two, ran steps 1-8, and died on this one.
   */
  function boxAtTheRestartStep(overrides: Record<string, Result> = {}): void {
    install({
      // Ends the run right after the tree work, so the case does not sit in
      // waitForRebuildToTakeOver's 15-minute window.
      "clawbox-run-root-step.sh rebuild_reboot": new Error("rebuild not launched"),
      // The rebuild unit reports a failure, so waitForRebuildToTakeOver breaks
      // on its first poll instead of holding the case for fifteen minutes.
      "show clawbox-root-update@rebuild_reboot.service": { stdout: "failed\n", stderr: "" },
      "rev-parse --verify origin/beta": { stdout: `${SHA}\n`, stderr: "" },
      "rev-parse HEAD": { stdout: `${SHA}\n`, stderr: "" },
      "symbolic-ref": { stdout: "beta\n", stderr: "" },
      openclaw: { stdout: "1.0.0", stderr: "" },
      ...overrides,
    });
  }

  it("resets to the refs step 1 already fetched, without asking GitHub again", async () => {
    boxAtTheRestartStep();
    const updater = await import("@/lib/updater");

    updater.resetUpdateState();
    updater.startUpdate();

    await vi.waitFor(
      () => {
        expect(countArgv("reset --hard origin/beta")).toBe(1);
      },
      { timeout: 15_000, interval: 20 },
    );
    // The whole point: no third anonymous fetch. `fetch --quiet …` belongs to
    // the version check, which this run does not perform.
    expect(argvLog.filter((l) => /\bfetch origin\b/.test(l))).toEqual([]);
  }, 20_000);

  it("names the missing ref instead of printing a git command line", async () => {
    // Dropping the fetch without asking whether the ref is here would be a
    // false success: `reset --hard` to a ref nobody fetched fails with Node's
    // `Command failed: git -c safe.directory=…`, which explains nothing.
    boxAtTheRestartStep({
      "rev-parse --verify origin/beta": new Error(
        "Command failed: git -c safe.directory=/home/clawbox/clawbox -C /home/clawbox/clawbox rev-parse --verify origin/beta^{commit}",
      ),
    });
    const updater = await import("@/lib/updater");

    updater.resetUpdateState();
    updater.startUpdate();

    await vi.waitFor(
      () => {
        const step = updater.getUpdateState().steps.find((s) => s.id === "restart");
        expect(step?.status).toBe("failed");
        expect(step?.error).toContain("no local copy of origin/beta");
        expect(step?.error).not.toContain("safe.directory");
      },
      { timeout: 15_000, interval: 20 },
    );
  }, 20_000);
});

describe("what the refusal is called", () => {
  /**
   * "Could not reach GitHub" is the wrong sentence for two of these, and a
   * wrong sentence sends the owner to the router or to a password field.
   */
  const cases: [string, string, RegExp][] = [
    [
      "a deleted update branch",
      "fatal: couldn't find remote ref fix/gone",
      /branch this ClawBox is pinned to/i,
    ],
    ["no network at all", "fatal: unable to access 'https://github.com/': Could not resolve host: github.com", /look up github\.com/i],
  ];

  for (const [name, gitSays, expected] of cases) {
    it(`calls ${name} what it is`, async () => {
      install({
        "fetch --quiet origin beta": new Error(gitSays),
        "fetch --quiet --tags origin": new Error(gitSays),
        "ls-remote": new Error(gitSays),
        "rev-parse HEAD": { stdout: `${SHA}\n`, stderr: "" },
        "rev-parse origin/beta": { stdout: `${SHA}\n`, stderr: "" },
        openclaw: { stdout: "1.0.0", stderr: "" },
      });
      const updater = await import("@/lib/updater");

      const info = await updater.getVersionInfo();

      expect(info.remote?.reachable).toBe(false);
      expect(info.remote?.refusedAnonymously).toBeFalsy();
      expect(info.remote?.reason).toMatch(expected);
    });
  }

  it("asks only once when there is no network to ask over", async () => {
    // Retrying "there is no DNS" spends the owner's time on a question already
    // answered — and the refusal this retry exists for is caused by an address
    // making too many anonymous requests, so a blanket retry feeds it.
    install({
      "fetch --quiet origin beta": new Error("fatal: unable to access 'https://github.com/': Could not resolve host: github.com"),
      "fetch --quiet --tags origin": new Error("fatal: unable to access 'https://github.com/': Could not resolve host: github.com"),
      "ls-remote": new Error("Could not resolve host: github.com"),
      "rev-parse HEAD": { stdout: `${SHA}\n`, stderr: "" },
      "rev-parse origin/beta": { stdout: `${SHA}\n`, stderr: "" },
      openclaw: { stdout: "1.0.0", stderr: "" },
    });
    const updater = await import("@/lib/updater");

    await updater.getVersionInfo();

    expect(countArgv("fetch --quiet origin beta")).toBe(1);
    expect(countArgv("ls-remote")).toBe(1);
  });
});
