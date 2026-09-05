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

/** Every `execFile` argv this run issued, joined for matching. */
let argvLog: string[] = [];

function install(results: Record<string, Result>): void {
  const answer = (key: string): Result | undefined => {
    for (const k of Object.keys(results)) if (key.includes(k)) return results[k];
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

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  argvLog = [];
  process.env.CLAWBOX_EDITION = "openclaw";
  process.env.GATEWAY_HEALTH_WAIT_MS = "1";
  process.env.GATEWAY_RECOVERY_WAIT_MS = "1";
  process.env.GATEWAY_WAIT_INTERVAL_MS = "1";
  // The retry backoff must not turn a unit test into a wall-clock wait.
  process.env.UPDATER_REMOTE_RETRY_DELAY_MS = "1";
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
  delete process.env.CLAWBOX_EDITION;
  delete process.env.GATEWAY_HEALTH_WAIT_MS;
  delete process.env.GATEWAY_RECOVERY_WAIT_MS;
  delete process.env.GATEWAY_WAIT_INTERVAL_MS;
  delete process.env.UPDATER_REMOTE_RETRY_DELAY_MS;
});

describe("a refused anonymous fetch is not 'up to date'", () => {
  /**
   * The exact field state the box was in on 2026-09-02: `git ls-remote`'s GET
   * to /info/refs still answers (the card measured that it "always succeeds"),
   * while the fetch's POST is refused — so the refs on disk are whatever the
   * last successful fetch left, and HEAD equals the STALE origin/beta.
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

describe("the restart step does not fail an update over a redundant fetch", () => {
  /**
   * By the time the `restart` step runs, step 0 (`bootstrap_updater` →
   * install.sh `sync_repo_to_update_target`) has already fetched origin and
   * hard-reset the tree to it. Its own `git fetch origin` is the THIRD
   * anonymous fetch of one update and the heaviest (all refs); a refusal
   * there ends the run on a box whose tree is already at the target.
   */
  it("hard-resets to the upstream refs already on disk when the fetch is refused", async () => {
    install({
      // Ends the run right after the tree work, so the case does not sit in
      // waitForRebuildToTakeOver's 15-minute window.
      "clawbox-run-root-step.sh rebuild_reboot": new Error("rebuild not launched"),
      "fetch origin": new Error(ANON_REFUSAL),
      "rev-parse --verify origin/beta": { stdout: `${SHA}\n`, stderr: "" },
      "rev-parse HEAD": { stdout: `${SHA}\n`, stderr: "" },
      "symbolic-ref": { stdout: "beta\n", stderr: "" },
      openclaw: { stdout: "1.0.0", stderr: "" },
    });
    const updater = await import("@/lib/updater");

    updater.resetUpdateState();
    updater.startUpdate();

    await vi.waitFor(
      () => {
        expect(countArgv("reset --hard origin/beta")).toBe(1);
      },
      { timeout: 15_000, interval: 20 },
    );
  }, 20_000);
});
