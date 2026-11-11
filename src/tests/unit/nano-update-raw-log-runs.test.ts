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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

/** Runs `script` with the library sourced and `board` running locally; `hop: false` is a hop that failed. */
function sh(script: string, { hop = true }: { hop?: boolean } = {}): { status: number | null; stdout: string } {
  const board = hop
    ? 'board() { local s=$1; shift; REPO="$FIXTURE_REPO" bash -c "$s" bash "$@"; }'
    : "board() { return 255; }";
  const r = spawnSync("bash", ["-c", `set -uo pipefail\n${board}\nsource "${LIB}"\n${script}`], {
    encoding: "utf-8",
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

  it("fails when the hop to the board failed", () => {
    pointTo(OLD);
    expect(sh("latest_run", { hop: false })).toEqual({ status: 1, stdout: "" });
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
