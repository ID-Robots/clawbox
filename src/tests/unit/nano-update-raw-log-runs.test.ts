/**
 * scripts/nano-tests/update-raw-log-runs.sh — how 92-update-raw-log tells this
 * test's update run from an earlier one, by the box's latest-run pointer
 * (data/update-logs/latest) and never by two machines' clocks.
 *
 * `board` is stubbed to run each board script locally with $REPO pointing at a
 * fixture folder, so the cases are the box's files, not a mock of the logic:
 * a completion the loop never saw running (fast completion), a pointer still on
 * the previous run (stale completion), an unfinished new run, and a pointer
 * that cannot be read — which must never become an empty baseline.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Every case starts real bash (and python3) processes: both ceilings, as the
// suite's timeout hygiene asks of any file that does.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const LIB = path.join(process.cwd(), "scripts/nano-tests/update-raw-log-runs.sh");
const canRun = process.platform === "linux"
  && spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0
  && spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
// A pointer made unreadable is still readable to root.
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

let repo = "";
const logs = () => path.join(repo, "data", "update-logs");
const OLD = "20261111T090000000Z-aaaa";
const NEW = "20261111T091500000Z-bbbb";

function pointTo(id: string): void {
  fs.writeFileSync(path.join(logs(), "latest"), `${id}\n`);
}

function run(id: string, finished: boolean): void {
  fs.writeFileSync(path.join(logs(), `${id}.log`), "");
  fs.writeFileSync(path.join(logs(), `${id}.json`), JSON.stringify({ id, finished, size: 0, follows: [] }));
}

/**
 * Runs `script` with the library sourced and `board` running locally.
 * `hop: false` is a hop that failed before the board said anything;
 * `failsAfter` is a hop that failed after the board script had printed all
 * of its answer, for the board scripts whose text contains that word.
 */
function sh(script: string, { hop = true, failsAfter }: { hop?: boolean; failsAfter?: string } = {}): { status: number | null; stdout: string } {
  const board = !hop
    ? "board() { return 255; }"
    : failsAfter
      ? `board() { local s=$1; shift; REPO="$FIXTURE_REPO" bash -c "$s" bash "$@"; case $s in *${failsAfter}*) return 255 ;; esac; }`
      : 'board() { local s=$1; shift; REPO="$FIXTURE_REPO" bash -c "$s" bash "$@"; }';
  const r = spawnSync("bash", ["-c", `set -uo pipefail\n${board}\nsource "${LIB}"\n${script}`], {
    encoding: "utf-8",
    timeout: 20_000,
    killSignal: "SIGKILL",
    env: { ...process.env, FIXTURE_REPO: repo, BASELINE_RETRY_S: "0" },
  });
  return { status: r.status, stdout: r.stdout };
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "nano-raw-log-runs-"));
  fs.mkdirSync(logs(), { recursive: true });
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe.skipIf(!canRun)("the latest-run pointer, as 92-update-raw-log reads it", () => {
  it("reads the run the box started last, and an empty answer only when there is no pointer", () => {
    expect(sh("latest_run")).toEqual({ status: 0, stdout: "" });
    pointTo(OLD);
    expect(sh("latest_run")).toEqual({ status: 0, stdout: OLD });
  });

  it.skipIf(isRoot)("fails, never answers empty, when the pointer is there but cannot be read", () => {
    pointTo(OLD);
    fs.chmodSync(path.join(logs(), "latest"), 0o000);
    expect(sh("latest_run")).toEqual({ status: 1, stdout: "" });
  });

  it("answers empty on a box that has logged no update yet (no log folder)", () => {
    fs.rmSync(logs(), { recursive: true });
    expect(sh("latest_run")).toEqual({ status: 0, stdout: "" });
  });

  it.skipIf(isRoot)("fails, never answers empty, when the log folder cannot be searched", () => {
    pointTo(OLD);
    fs.chmodSync(logs(), 0o000);
    try {
      expect(sh("latest_run")).toEqual({ status: 1, stdout: "" });
      expect(sh('if read_baseline 2; then echo "read <$BEFORE_RUN>"; else echo unread; fi').stdout.trim()).toBe("unread");
    } finally {
      fs.chmodSync(logs(), 0o755);
    }
  });

  it.skipIf(isRoot)("fails when the data folder above it cannot be searched", () => {
    pointTo(OLD);
    const data = path.join(repo, "data");
    fs.chmodSync(data, 0o000);
    try {
      expect(sh("latest_run")).toEqual({ status: 1, stdout: "" });
    } finally {
      fs.chmodSync(data, 0o755);
    }
  });

  it("fails when the hop to the board failed", () => {
    pointTo(OLD);
    expect(sh("latest_run", { hop: false })).toEqual({ status: 1, stdout: "" });
  });

  it("fails when the hop failed after the board had printed a valid pointer", () => {
    pointTo(OLD);
    expect(sh("latest_run", { failsAfter: "POINTER" })).toEqual({ status: 1, stdout: "" });
    expect(sh('if read_baseline 2; then echo "read <$BEFORE_RUN>"; else echo unread; fi', { failsAfter: "POINTER" }).stdout.trim()).toBe("unread");
  });

  it.skipIf(isRoot)("does not start from a baseline it could not read: it retries, then gives up", () => {
    pointTo(OLD);
    fs.chmodSync(path.join(logs(), "latest"), 0o000);
    const r = sh('if read_baseline 3; then echo "read <$BEFORE_RUN>"; else echo "unread <$BEFORE_RUN>"; fi');
    expect(r.stdout.trim()).toBe("unread <>");
  });

  it("takes the baseline on a box with no pointer yet, and on one with a pointer", () => {
    expect(sh('read_baseline 3 && echo "<$BEFORE_RUN>"').stdout.trim()).toBe("<>");
    pointTo(OLD);
    expect(sh('read_baseline 3 && echo "<$BEFORE_RUN>"').stdout.trim()).toBe(`<${OLD}>`);
  });

  it("accepts a fast completion: a new run since the baseline, marked finished", () => {
    run(OLD, true);
    pointTo(OLD);
    run(NEW, true);
    const r = sh(`read_baseline 1; printf '%s\\n' "${NEW}" > "$FIXTURE_REPO/data/update-logs/latest"; new_run_finished && echo yes || echo no`);
    expect(r.stdout.trim()).toBe("yes");
  });

  it("refuses a stale completion: the pointer still names the run from before", () => {
    run(OLD, true);
    pointTo(OLD);
    expect(sh("read_baseline 1; new_run_finished && echo yes || echo no").stdout.trim()).toBe("no");
  });

  it("refuses a finished new run when the hop that read it failed after printing its answer", () => {
    run(OLD, true);
    pointTo(OLD);
    run(NEW, true);
    const r = sh(
      `read_baseline 1; printf '%s\\n' "${NEW}" > "$FIXTURE_REPO/data/update-logs/latest"; new_run_finished && echo yes || echo no`,
      { failsAfter: "python3" },
    );
    expect(r.stdout.trim()).toBe("no");
  });

  it("refuses a new run that has not finished", () => {
    run(OLD, true);
    pointTo(OLD);
    run(NEW, false);
    const r = sh(`read_baseline 1; printf '%s\\n' "${NEW}" > "$FIXTURE_REPO/data/update-logs/latest"; new_run_finished && echo yes || echo no`);
    expect(r.stdout.trim()).toBe("no");
  });

  it.skipIf(isRoot)("refuses when the pointer cannot be read at the end, whatever the baseline was", () => {
    run(OLD, true);
    pointTo(OLD);
    run(NEW, true);
    const r = sh(`read_baseline 1; printf '%s\\n' "${NEW}" > "$FIXTURE_REPO/data/update-logs/latest"; chmod 000 "$FIXTURE_REPO/data/update-logs/latest"; new_run_finished && echo yes || echo no`);
    expect(r.stdout.trim()).toBe("no");
  });
});
