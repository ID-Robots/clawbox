import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * The bootstrap re-records the root-exec manifest after it hard-resets the tree
 * and before it re-execs into the new install.sh. It used to do that as
 *
 *     "$_mf" --write || echo "[bootstrap] WARN: could not re-record …" >&2
 *
 * and carry on (TASK-584). The comment directly above that line states the
 * problem itself: the reset has just replaced install.sh, scripts/ and config/
 * wholesale, so the manifest is stale by construction — and the root dispatcher
 * fails CLOSED on a stale manifest. Every root step of that very update, and
 * the owner's password change, hostname change, hotspot restart and llama.cpp
 * install afterwards, is then refused with exit 65
 * ("refusing '<step>' — /home/clawbox/clawbox does not match the root-exec
 * manifest"). Observed live on a test box: `--verify` returned 65 and every
 * root step was refused, with one warning line on the stderr of an update
 * nobody was watching as the only trace.
 *
 * So a failed re-record now (a) repairs — the installed helper is the one from
 * before the reset, so it is replaced from the fresh tree and retried — and
 * (b) when that still fails, is carried into the re-exec and recorded against
 * the run's verdict, which is what makes the update report failure instead of
 * success. It is re-verified there rather than believed, and cleared again if a
 * later step re-records the manifest successfully, so neither half can produce a
 * false failure.
 *
 * These tests EXECUTE the shipped blocks out of install.sh under
 * `set -euo pipefail`, with the hard-coded helper path retargeted onto a temp
 * tree the way src/tests/unit/root-exec-manifest.test.ts retargets the shipped
 * scripts' constants.
 */

const REPO = process.cwd();
const INSTALL_SH = readFileSync(path.join(REPO, "install.sh"), "utf-8");
const HELPER_PATH = "/usr/local/libexec/clawbox/clawbox-root-manifest.sh";
const PROJECT_PATH = "/home/clawbox/clawbox";

const canRun =
  process.platform !== "win32" && spawnSync("bash", ["-c", "true"], { stdio: "ignore" }).status === 0;

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "clawbox-bootstrap-manifest-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * Slice a region out of install.sh by its first and last line, and retarget the
 * two hard-coded absolute paths onto the temp tree. Retargeting rather than
 * adding an env seam: these paths select WHICH code root executes and must stay
 * literal in the shipped file.
 */
function shipped(fromLine: string, toLine: string, paths: { helper: string; project: string }): string {
  const start = INSTALL_SH.indexOf(fromLine);
  if (start < 0) throw new Error(`bootstrap slice start not found: ${fromLine}`);
  const end = INSTALL_SH.indexOf(toLine, start);
  if (end < 0) throw new Error(`bootstrap slice end not found: ${toLine}`);
  const text = INSTALL_SH.slice(start, end);
  if (!text.includes(HELPER_PATH)) {
    throw new Error("the slice no longer names the manifest helper — it was extracted wrong");
  }
  return text
    .split(HELPER_PATH).join(paths.helper)
    .split(PROJECT_PATH).join(paths.project)
    // `install -o root -g root` is EPERM for a test runner; the copy itself is
    // what matters here and still happens.
    .replace(/install -o root -g root /g, "install ");
}

interface Bootstrap {
  status: number | null;
  out: string;
  /** One line per call the stub helper received. */
  calls: string[];
  /** The value the bootstrap would hand to the re-exec. */
  marker: string;
}

/**
 * Run the bootstrap's manifest arm with a helper stub whose `--write` fails
 * `failWrites` times before succeeding (Infinity = never succeeds).
 */
function runBootstrap(opts: { failWrites: number; helperInTree?: boolean }): Bootstrap {
  const helper = path.join(root, "libexec", "clawbox-root-manifest.sh");
  const project = path.join(root, "project");
  const callLog = path.join(root, "helper-calls.log");
  const stateFile = path.join(root, "writes");
  mkdirSync(path.dirname(helper), { recursive: true });
  mkdirSync(path.join(project, "config"), { recursive: true });

  // The INSTALLED helper: the one from before the reset. It counts its own
  // --write calls so "retry once" is observable.
  const stub = [
    "#!/usr/bin/env bash",
    `printf 'installed %s\\n' "$*" >> ${JSON.stringify(callLog)}`,
    `n=$(cat ${JSON.stringify(stateFile)} 2>/dev/null || echo 0)`,
    'if [ "${1:-}" = "--write" ]; then',
    `  n=$((n + 1)); printf '%s' "$n" > ${JSON.stringify(stateFile)}`,
    `  [ "$n" -gt ${opts.failWrites === Infinity ? 9999 : opts.failWrites} ] && exit 0`,
    "  exit 1",
    "fi",
    "exit 0",
    "",
  ].join("\n");
  writeFileSync(helper, stub);
  chmodSync(helper, 0o755);

  // The helper the reset just checked out. Present unless the test says the
  // fresh tree does not carry one.
  if (opts.helperInTree !== false) {
    writeFileSync(
      path.join(project, "config", "clawbox-root-manifest.sh"),
      stub.replace("installed %s", "refreshed %s"),
    );
    chmodSync(path.join(project, "config", "clawbox-root-manifest.sh"), 0o755);
  }

  const block = shipped(
    "      _mf=/usr/local/libexec/clawbox/clawbox-root-manifest.sh",
    '      echo "[bootstrap] Re-executing as',
    { helper, project },
  );

  const program = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `_b=${JSON.stringify(project)}`,
    block,
    // What `exec env … CLAWBOX_ROOT_MANIFEST_STALE=…` would carry forward.
    'echo "MARKER=${CLAWBOX_ROOT_MANIFEST_STALE:-0}"',
    'echo "REACHED_EXEC=1"',
    "",
  ].join("\n");
  const file = path.join(root, "bootstrap.sh");
  writeFileSync(file, program);
  chmodSync(file, 0o755);
  const run = spawnSync("bash", [file], { encoding: "utf-8", timeout: 30_000 });
  const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  return {
    status: run.status,
    out,
    calls: existsSync(callLog) ? readFileSync(callLog, "utf-8").trim().split("\n").filter(Boolean) : [],
    marker: /MARKER=(\d)/.exec(run.stdout ?? "")?.[1] ?? "",
  };
}

/**
 * Run the verdict block — the marker check that decides whether this run
 * reports a failure — with a helper stub whose `--verify` answers `verifies`.
 */
function runVerdict(opts: { marker: string; verifies: boolean; alsoWrite?: boolean }): {
  status: number | null;
  out: string;
  failures: string;
} {
  const helper = path.join(root, "libexec", "clawbox-root-manifest.sh");
  mkdirSync(path.dirname(helper), { recursive: true });
  writeFileSync(
    helper,
    ["#!/usr/bin/env bash", `[ "\${1:-}" = "--verify" ] && exit ${opts.verifies ? 0 : 65}`, "exit 0", ""].join("\n"),
  );
  chmodSync(helper, 0o755);

  const block = shipped("record_provision_failure() {", "\n# ── The marker must never speak", {
    helper,
    project: path.join(root, "project"),
  });
  // The repair path: write_root_exec_manifest clears what it fixed.
  const writer = (() => {
    const start = INSTALL_SH.indexOf("write_root_exec_manifest() {");
    if (start < 0) throw new Error("write_root_exec_manifest not found");
    const end = INSTALL_SH.indexOf("\n}", start);
    return INSTALL_SH.slice(start, end + 2);
  })();

  const program = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "PROVISION_FAILURES=()",
    `CLAWBOX_ROOT_MANIFEST_STALE=${JSON.stringify(opts.marker)}`,
    `ROOT_EXEC_MANIFEST_HELPER=${JSON.stringify(helper)}`,
    block,
    writer,
    opts.alsoWrite ? "write_root_exec_manifest" : "true",
    'echo "FAILURES=${PROVISION_FAILURES[*]-}"',
    "",
  ].join("\n");
  const file = path.join(root, "verdict.sh");
  writeFileSync(file, program);
  chmodSync(file, 0o755);
  const run = spawnSync("bash", [file], { encoding: "utf-8", timeout: 30_000 });
  return {
    status: run.status,
    out: `${run.stdout ?? ""}${run.stderr ?? ""}`,
    failures: /FAILURES=(.*)/.exec(run.stdout ?? "")?.[1] ?? "",
  };
}

describe.runIf(canRun)("the bootstrap's root-exec manifest re-record", () => {
  it("re-records once and carries nothing forward when it works", () => {
    const run = runBootstrap({ failWrites: 0 });
    expect(run.status).toBe(0);
    expect(run.calls).toEqual(["installed --write"]);
    expect(run.marker).toBe("0");
  });

  it("refreshes the helper from the reset tree and retries before giving up", () => {
    // The installed helper is the one from BEFORE the hard reset — the most
    // likely reason it just failed — so replacing it is the repair to try
    // before reporting anything.
    const run = runBootstrap({ failWrites: 1 });
    expect(run.status).toBe(0);
    expect(run.calls).toHaveLength(2);
    expect(run.calls[1]).toBe("refreshed --write");
    expect(run.marker, "a manifest that was repaired must not be carried forward").toBe("0");
  });

  it("carries the failure into the re-exec when the retry fails too", () => {
    // Today: one WARN line on stderr, nothing carried, and the update goes on
    // into steps the dispatcher will refuse with exit 65.
    const run = runBootstrap({ failWrites: Infinity });
    expect(run.status).toBe(0);
    expect(run.marker).toBe("1");
  });

  it("never aborts the bootstrap, even with no helper in the reset tree", () => {
    // This is the boot path: an abort here leaves a box that has already been
    // reset to new code with nothing installed.
    const run = runBootstrap({ failWrites: Infinity, helperInTree: false });
    expect(run.status).toBe(0);
    expect(run.out).toContain("REACHED_EXEC=1");
    expect(run.marker).toBe("1");
  });

  it("hands the marker to the re-exec'd process", () => {
    // The block under test ends before the exec, so the exec line itself is
    // pinned here: without this the marker is computed and thrown away.
    const execLine = INSTALL_SH.slice(INSTALL_SH.indexOf('exec env CLAWBOX_INSTALL_BOOTSTRAPPED=1'));
    expect(execLine.slice(0, 300)).toContain("CLAWBOX_ROOT_MANIFEST_STALE");
  });
});

describe.runIf(canRun)("a stale manifest is reported against the run's verdict", () => {
  it("records a provisioning failure, so the update cannot report success", () => {
    const run = runVerdict({ marker: "1", verifies: false });
    expect(run.status).toBe(0);
    expect(run.failures).toContain("root_exec_manifest");
    // The operator is told what is broken and how to repair it, not just that
    // something failed.
    expect(run.out).toMatch(/REFUSED \(exit 65\)/);
    expect(run.out).toContain("--write");
  });

  it("records nothing when the manifest verifies after all", () => {
    // The marker says the bootstrap's write failed, not that the record is
    // still wrong — reporting a failure over a good manifest is the opposite
    // defect.
    const run = runVerdict({ marker: "1", verifies: true });
    expect(run.failures.trim()).toBe("");
  });

  it("records nothing when the bootstrap never set the marker", () => {
    const run = runVerdict({ marker: "0", verifies: false });
    expect(run.failures.trim()).toBe("");
  });

  it("clears the recorded failure when a later step re-records the manifest", () => {
    // install_root_libexec re-records it during a full run; that IS the repair,
    // so the run must stop reporting it.
    const run = runVerdict({ marker: "1", verifies: false, alsoWrite: true });
    expect(run.failures.trim()).toBe("");
  });
});
