import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The provisioning marker is the channel the flash host reads INSTEAD of
 * parsing install.sh's stdout. That makes one failure mode worse than no marker
 * at all: a run that cannot write it leaves the PREVIOUS run's `STATUS=ok`
 * sitting at the path, and the flash host reads a stale success as this run's
 * verdict — the exact false-healthy result the surrounding change exists to
 * remove. Every write in the original helper ended in `|| true` with stderr
 * discarded, so that happened silently.
 *
 * Two mechanisms now prevent it, and both are pinned here:
 *
 *   1. The marker is DELETED before provisioning starts, so its presence at the
 *      end means this run wrote it. "No marker" is a possible outcome; "last
 *      run's marker" is not.
 *   2. If the marker cannot be cleared or cannot be written, the run says so and
 *      its verdict becomes `incomplete` on every other channel — exit code and
 *      stdout sentinel — instead of an `ok` no reader of the file can see.
 *
 * These run the real shell out of install.sh rather than a copy of it: the
 * helpers and the final-verdict block are extracted from the file and executed.
 */
const REPO = process.cwd();
const INSTALL_SH = fs.readFileSync(path.join(REPO, "install.sh"), "utf-8");

const RUNNABLE = process.platform !== "win32";

/**
 * Extract a shell function, closing brace included. Anchored at column 0 on
 * both ends, and it throws rather than returning a short slice — a truncated
 * function would either fail to parse or, worse, parse into something that
 * quietly does less than the real one.
 */
function shellFunction(name: string): string {
  const re = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}$`, "m");
  const m = re.exec(INSTALL_SH);
  if (!m) throw new Error(`${name}() not found in install.sh`);
  return m[0];
}

/**
 * The final-verdict block: everything from FINAL_RC through the exit. This is
 * the part that has to refuse to say "ok" when the marker could not be
 * published, so the test runs the real lines rather than restating them.
 */
function finalVerdictBlock(): string {
  const start = INSTALL_SH.indexOf('FINAL_RC=0\nif [ "${#PROVISION_FAILURES[@]}"');
  const endMarker = 'exit "$FINAL_RC"';
  const end = INSTALL_SH.indexOf(endMarker, start);
  if (start < 0 || end < 0) {
    throw new Error("install.sh: could not locate the final-verdict block");
  }
  return INSTALL_SH.slice(start, end + endMarker.length);
}

/**
 * Run the extracted helpers (and optionally the final-verdict block) against a
 * chosen marker path, in a shell configured exactly like install.sh's.
 */
function runHarness(opts: {
  statusFile: string;
  body: string;
  withVerdict?: boolean;
  failures?: string[];
  validateRc?: number;
}) {
  const failures = (opts.failures ?? []).map((f) => `"${f}"`).join(" ");
  const script = [
    "set -euo pipefail",
    'PROJECT_DIR="/home/clawbox/clawbox"',
    `PROVISION_STATUS_FILE="${opts.statusFile}"`,
    'PROVISION_RUN_ID="run-under-test"',
    "PROVISION_STATUS_UNPUBLISHED=0",
    `PROVISION_FAILURES=(${failures})`,
    `VALIDATE_RC=${opts.validateRc ?? 0}`,
    shellFunction("invalidate_provision_status"),
    shellFunction("write_provision_status"),
    opts.body,
    opts.withVerdict ? finalVerdictBlock() : "",
    'echo "UNPUBLISHED=$PROVISION_STATUS_UNPUBLISHED"',
  ].join("\n");
  const proc = spawnSync("bash", ["-c", script], { encoding: "utf-8", timeout: 20000 });
  return { ...proc, out: `${proc.stdout ?? ""}${proc.stderr ?? ""}` };
}

function tmpdir(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `clawbox-${tag}-`));
}

describe.runIf(RUNNABLE)("the provisioning marker never speaks for an earlier run", () => {
  it("clears the previous run's marker before this run provisions anything", () => {
    const dir = tmpdir("marker-clear");
    const statusFile = path.join(dir, "provision-status");
    fs.writeFileSync(statusFile, "STATUS=ok\nFAILED_STEPS=\n");

    const proc = runHarness({ statusFile, body: "invalidate_provision_status" });

    expect(proc.status, proc.out).toBe(0);
    // Gone, not overwritten: from here until the summary there is deliberately
    // no verdict on disk, so a run that dies mid-way leaves "no verdict".
    expect(fs.existsSync(statusFile)).toBe(false);
    expect(proc.out).toContain("UNPUBLISHED=0");
  });

  it("reports a marker it could not clear, instead of leaving it to be read", () => {
    // A path `rm -f` cannot remove for ANY uid (a directory, not a file) stands
    // in for the read-only /etc or foreign-owned file seen in the field.
    const dir = tmpdir("marker-stuck");
    const statusFile = path.join(dir, "provision-status");
    fs.mkdirSync(statusFile);

    const proc = runHarness({
      statusFile,
      body: "invalidate_provision_status || true",
    });

    expect(proc.status, proc.out).toBe(0);
    expect(proc.out).toContain("UNPUBLISHED=1");
    expect(proc.out).toContain("EARLIER");
    expect(proc.out).toContain(statusFile);
  });

  it("stamps the run id into the marker it writes", () => {
    const dir = tmpdir("marker-stamp");
    const statusFile = path.join(dir, "provision-status");

    const proc = runHarness({
      statusFile,
      body: 'invalidate_provision_status\nwrite_provision_status incomplete "hermes_edition"',
    });

    expect(proc.status, proc.out).toBe(0);
    const marker = fs.readFileSync(statusFile, "utf-8");
    expect(marker).toContain("RUN_ID=run-under-test");
    expect(marker).toContain("STATUS=incomplete");
    expect(marker).toContain("FAILED_STEPS=hermes_edition");
    expect(proc.out).toContain("UNPUBLISHED=0");
  });

  it("renames a complete marker into place instead of truncating one", () => {
    const dir = tmpdir("marker-atomic");
    const statusFile = path.join(dir, "provision-status");
    // An existing marker at the path, so the replacement is observable.
    fs.writeFileSync(statusFile, "STATUS=ok\n");
    const before = fs.statSync(statusFile).ino;

    const proc = runHarness({ statusFile, body: 'write_provision_status ok ""' });

    expect(proc.status, proc.out).toBe(0);
    // A different inode means the record was written elsewhere and renamed over
    // the old one. Writing in place would keep the inode and expose a truncated
    // file — the same failure the password file had.
    expect(fs.statSync(statusFile).ino).not.toBe(before);
    // Nothing but the marker itself: a temp file left in the directory would
    // mean the rename never happened.
    expect(fs.readdirSync(dir)).toEqual(["provision-status"]);
    const marker = fs.readFileSync(statusFile, "utf-8");
    // Every field of the record, not a prefix of it.
    expect(marker).toMatch(/^RUN_ID=.+$/m);
    expect(marker).toMatch(/^STATUS=ok$/m);
    expect(marker).toMatch(/^FAILED_STEPS=$/m);
    expect(marker).toMatch(/^TIMESTAMP=\d{4}-\d{2}-\d{2}T/m);
  });
});

describe.runIf(RUNNABLE)("a marker that cannot be written is not a healthy verdict", () => {
  /**
   * A marker path whose parent is a regular file: `mkdir -p` and the write both
   * fail with ENOTDIR, for root as well as for anyone else, so this reproduces
   * an unwritable /etc/clawbox without depending on the uid the suite runs as.
   */
  function unwritableStatusFile(tag: string): string {
    const dir = tmpdir(tag);
    const blocker = path.join(dir, "clawbox");
    fs.writeFileSync(blocker, "not a directory\n");
    return path.join(blocker, "provision-status");
  }

  it("says so on stdout and returns non-zero rather than reporting success", () => {
    const statusFile = unwritableStatusFile("marker-unwritable");

    const proc = runHarness({
      statusFile,
      body: 'write_provision_status ok "" || echo "RC=$?"',
    });

    expect(proc.status, proc.out).toBe(0);
    expect(proc.out).toContain("RC=1");
    expect(proc.out).toContain("UNPUBLISHED=1");
    // Names the file, so the operator knows which channel stopped being true.
    expect(proc.out).toContain(statusFile);
    expect(proc.out).toMatch(/could not publish/);
    expect(fs.existsSync(statusFile)).toBe(false);
  });

  it("downgrades an otherwise-green run to INCOMPLETE, and exits non-zero", () => {
    // THE regression: every step passed, but the channel the flash host reads
    // cannot be made to describe this run. Before the fix this printed
    // "[provision-status] OK", exited 0, and left whatever the path already held
    // — a previous run's STATUS=ok — as the flash host's answer.
    const statusFile = unwritableStatusFile("marker-verdict");

    const proc = runHarness({
      statusFile,
      body: "",
      withVerdict: true,
      failures: [],
      validateRc: 0,
    });

    expect(proc.status, proc.out).toBe(1);
    expect(proc.out).toContain("[provision-status] INCOMPLETE");
    expect(proc.out).not.toContain("[provision-status] OK");
    expect(proc.out).toContain("Do NOT ship this box as healthy");
  });

  it("still says OK, and exits 0, when the marker really was published", () => {
    // The counterpart: the downgrade must be caused by the unwritable marker,
    // not by the harness. Same green run, a usable path.
    const dir = tmpdir("marker-verdict-ok");
    const statusFile = path.join(dir, "provision-status");

    const proc = runHarness({ statusFile, body: "", withVerdict: true });

    expect(proc.status, proc.out).toBe(0);
    expect(proc.out).toContain("[provision-status] OK");
    expect(proc.out).toContain("[provision-run] run-under-test");
    expect(fs.readFileSync(statusFile, "utf-8")).toMatch(/^STATUS=ok$/m);
  });

  it("keeps INCOMPLETE for a run that failed a step, marker or no marker", () => {
    const dir = tmpdir("marker-verdict-fail");
    const statusFile = path.join(dir, "provision-status");

    const proc = runHarness({
      statusFile,
      body: "",
      withVerdict: true,
      failures: ["hermes_edition"],
    });

    expect(proc.status, proc.out).toBe(1);
    expect(proc.out).toContain("[provision-status] INCOMPLETE (hermes_edition)");
    expect(fs.readFileSync(statusFile, "utf-8")).toMatch(/^STATUS=incomplete$/m);
  });
});

describe("install.sh wires the marker into the full install", () => {
  it("clears the previous verdict before the first provisioning step", () => {
    // The guarantee in test 1 only holds if the full-install path actually calls
    // it, and calls it BEFORE anything can fail.
    const call = INSTALL_SH.search(/^invalidate_provision_status \|\| true$/m);
    const firstStep = INSTALL_SH.search(/^log "Ensuring clawbox user exists\.\.\."$/m);
    expect(call, "install.sh: no top-level invalidate_provision_status call").toBeGreaterThan(-1);
    expect(firstStep, "install.sh: full-install path not found").toBeGreaterThan(-1);
    expect(call).toBeLessThan(firstStep);
  });

  it("does not clear it in --step mode, which is not a provisioning run", () => {
    // A single-step re-run must not destroy the last full install's verdict.
    const dispatch = INSTALL_SH.indexOf('if [ "${1:-}" = "--step" ]; then');
    const call = INSTALL_SH.search(/^invalidate_provision_status \|\| true$/m);
    expect(dispatch).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(dispatch);
  });
});
