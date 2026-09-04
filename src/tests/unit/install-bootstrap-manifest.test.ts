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
/**
 * The liveness token config/clawbox-root-manifest.sh prints for `--selftest`.
 * Repeated as a literal in install.sh and config/clawbox-root-step.sh because
 * those are three separately installed root-owned files that cannot share a
 * constant; root-exec-manifest.test.ts pins them against each other.
 */
const SELFTEST_TOKEN = "clawbox-root-manifest alive";
const HELPER_SRC = readFileSync(path.join(REPO, "config", "clawbox-root-manifest.sh"), "utf-8");

const canRun =
  process.platform !== "win32" && spawnSync("bash", ["-c", "true"], { stdio: "ignore" }).status === 0;

/** A 0000 source is readable by root, so that one case would prove nothing there. */
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "clawbox-bootstrap-manifest-"));
});
afterEach(() => {
  // The "unreadable source" case leaves a 0000 file behind.
  try {
    chmodSync(path.join(root, "project", "config", "clawbox-root-manifest.sh"), 0o755);
  } catch { /* not every case writes one */ }
  rmSync(root, { recursive: true, force: true });
});

/**
 * Slice a region out of install.sh by its first and last line, and retarget the
 * two hard-coded absolute paths onto the temp tree. Retargeting rather than
 * adding an env seam: these paths select WHICH code root executes and must stay
 * literal in the shipped file.
 */
function shipped(
  fromLine: string,
  toLine: string,
  paths: { helper: string; project: string; inclusive?: boolean; must?: string },
): string {
  const start = INSTALL_SH.indexOf(fromLine);
  if (start < 0) throw new Error(`bootstrap slice start not found: ${fromLine}`);
  const end = INSTALL_SH.indexOf(toLine, start);
  if (end < 0) throw new Error(`bootstrap slice end not found: ${toLine}`);
  const text = INSTALL_SH.slice(start, paths.inclusive ? end + toLine.length : end);
  // A slice that lost its subject would make every assertion over it pass for
  // the wrong reason, so each caller names something its region must contain.
  const must = paths.must ?? HELPER_PATH;
  if (!text.includes(must)) {
    throw new Error(`the slice no longer contains ${JSON.stringify(must)} — it was extracted wrong`);
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
  /** The live helper's bytes as the run found them. */
  helperBefore: string;
  /** The helper the reset just checked out — what a repair must install. */
  helperInTree: string;
  /** The live helper's bytes after the run — the thing a bad copy destroys. */
  helperAfter: string;
  /** Whether a staged `<helper>.new` was left behind in libexec. */
  stagedLeft: boolean;
}

/**
 * Run the bootstrap's manifest arm with a helper stub whose `--write` fails
 * `failWrites` times before succeeding (Infinity = never succeeds).
 */
function runBootstrap(opts: {
  failWrites: number;
  helperInTree?: boolean;
  /**
   * How the copy from the reset tree fails.
   *
   * "unreadable" — the source cannot be opened, so `install` fails before
   * writing anything (a directory would not do: the shipped `[ -f ]` guard
   * filters it out before `install` is ever reached, which is the
   * `helperInTree: false` path). "truncates" — the source is larger than an
   * RLIMIT_FSIZE the run is given, so `install` is killed by SIGXFSZ PART WAY
   * THROUGH the copy.
   * The second is the one that matters: `install` writes into the destination
   * inode with O_TRUNC, so a copy straight over the live helper leaves a cut-off
   * file behind — and a truncated helper exits 0 for `--verify`, which turns the
   * root dispatcher from fail-closed into fail-open for every pinned step.
   * Neither depends on the runner's privileges; a read-only mode is ignored by
   * root.
   */
  stagingFails?: "unreadable" | "truncates";
  /**
   * What is sitting at the installed helper path when the bootstrap starts.
   *
   * "empty" and "truncated" are the same defect from two directions: a copy
   * that died part way through leaves a helper that RUNS and exits 0 for
   * `--write`, `--verify` and `--verify-file` without doing any of them —
   * `install` writes into the existing inode with O_TRUNC, and an interrupted
   * in-place copy is how one gets there. "truncated" is the shipped helper cut
   * where its verb dispatcher begins, so every function is defined and nothing
   * dispatches; "empty" is the 0-byte case. Both must be detected and replaced,
   * because the exit status of such a helper is what the bootstrap here — and
   * the root dispatcher afterwards — would otherwise read as "the tree is
   * recorded and matches".
   */
  installed?: "healthy" | "empty" | "truncated";
}): Bootstrap {
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
    // A stub stands in for a COMPLETE helper, so it answers the liveness verb.
    // The "empty"/"truncated" modes install one that cannot.
    `if [ "\${1:-}" = "--selftest" ]; then printf '%s\\n' ${JSON.stringify(SELFTEST_TOKEN)}; exit 0; fi`,
    `n=$(cat ${JSON.stringify(stateFile)} 2>/dev/null || echo 0)`,
    'if [ "${1:-}" = "--write" ]; then',
    `  n=$((n + 1)); printf '%s' "$n" > ${JSON.stringify(stateFile)}`,
    `  [ "$n" -gt ${opts.failWrites === Infinity ? 9999 : opts.failWrites} ] && exit 0`,
    "  exit 1",
    "fi",
    "exit 0",
    "",
  ].join("\n");
  // The bytes the bootstrap finds installed. A dead helper is executable and
  // 0755 exactly like a live one — `install` sets the mode when it creates the
  // file, so an interrupted copy leaves the mode intact and only the content
  // short. Nothing about the file says it is a stub except that it does nothing.
  const installedText =
    opts.installed === "empty"
      ? ""
      : opts.installed === "truncated"
        ? (() => {
            const cut = HELPER_SRC.indexOf('case "${1:-}" in');
            if (cut < 0) throw new Error("the shipped helper no longer ends in a verb dispatcher");
            return HELPER_SRC.slice(0, cut);
          })()
        : stub;
  writeFileSync(helper, installedText);
  chmodSync(helper, 0o755);

  // The helper the reset just checked out. Present unless the test says the
  // fresh tree does not carry one.
  const treeHelper = path.join(project, "config", "clawbox-root-manifest.sh");
  let treeText = "";
  if (opts.helperInTree !== false) {
    // Padded past the size limit the "truncates" run imposes, so the copy dies
    // mid-write rather than before it starts.
    const pad = opts.stagingFails === "truncates" ? `\n${"# pad\n".repeat(30_000)}` : "";
    treeText = stub.replace("installed %s", "refreshed %s") + pad;
    writeFileSync(treeHelper, treeText);
    chmodSync(treeHelper, opts.stagingFails === "unreadable" ? 0o000 : 0o755);
  }

  // The slice runs THROUGH the `exec`, into a stub install.sh that prints the
  // environment it was handed. Asserting the exec line by substring instead
  // would pass over a hard-coded 0 or a typo'd inner expansion — the marker
  // surviving the re-exec is the single most important link in this chain.
  writeFileSync(
    path.join(project, "install.sh"),
    [
      "#!/usr/bin/env bash",
      'echo "MARKER=${CLAWBOX_ROOT_MANIFEST_STALE:-unset}"',
      'echo "BOOTSTRAPPED=${CLAWBOX_INSTALL_BOOTSTRAPPED:-unset}"',
      'echo "REACHED_EXEC=1"',
      "",
    ].join("\n"),
  );
  chmodSync(path.join(project, "install.sh"), 0o755);

  const block = shipped(
    "      _mf=/usr/local/libexec/clawbox/clawbox-root-manifest.sh",
    'bash "$_b/install.sh" "$@"',
    { helper, project, inclusive: true },
  );

  const program = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    // 8 blocks, and no core file: the copy below is killed part way through.
    ...(opts.stagingFails === "truncates" ? ["ulimit -c 0", "ulimit -f 8"] : []),
    `_b=${JSON.stringify(project)}`,
    block,
    // Never reached: the block above ends in `exec`.
    'echo "MARKER=exec-did-not-happen"',
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
    helperBefore: installedText,
    helperInTree: treeText,
    helperAfter: existsSync(helper) ? readFileSync(helper, "utf-8") : "",
    stagedLeft: existsSync(`${helper}.new`),
  };
}

/**
 * Run the verdict block — the marker check that decides whether this run
 * reports a failure — with a helper stub whose `--verify` answers `verifies`.
 */
function runVerdict(opts: {
  marker: string;
  /** What `--verify` answers BEFORE anything has written a manifest. */
  verifies: boolean;
  /**
   * What it answers AFTER a `--write` succeeded. Separate because that is the
   * distinction write_root_exec_manifest turns on: a write can return 0 and
   * leave a record that still does not verify, and the run must not report a
   * repair on the strength of the write alone. Defaults to `verifies`.
   */
  writeVerifies?: boolean;
  /** Install a 0-byte helper instead: it exits 0 for --verify without looking. */
  deadHelper?: boolean;
  alsoWrite?: boolean;
  /** Also call refresh_root_exec_manifest, with a helper whose --write does this. */
  refresh?: "works" | "fails";
}): {
  status: number | null;
  out: string;
  failures: string;
  /** "ok" / "failed" when alsoWrite ran, "" otherwise. */
  write: string;
} {
  const helper = path.join(root, "libexec", "clawbox-root-manifest.sh");
  mkdirSync(path.dirname(helper), { recursive: true });
  const wrote = path.join(root, "wrote");
  writeFileSync(
    helper,
    opts.deadHelper
      ? ""
      : [
          "#!/usr/bin/env bash",
          `[ "\${1:-}" = "--selftest" ] && { printf '%s\\n' ${JSON.stringify(SELFTEST_TOKEN)}; exit 0; }`,
          'if [ "${1:-}" = "--write" ]; then',
          ...(opts.refresh === "fails" ? ["  exit 1"] : []),
          `  : > ${JSON.stringify(wrote)}`,
          "  exit 0",
          "fi",
          'if [ "${1:-}" = "--verify" ]; then',
          `  [ -e ${JSON.stringify(wrote)} ] && exit ${(opts.writeVerifies ?? opts.verifies) ? 0 : 65}`,
          `  exit ${opts.verifies ? 0 : 65}`,
          "fi",
          "exit 0",
          "",
        ].join("\n"),
  );
  chmodSync(helper, 0o755);

  const block = shipped(
    "record_provision_failure() {",
    'if [ "${CLAWBOX_ROOT_MANIFEST_STALE:-0}" = "1" ]; then',
    { helper, project: path.join(root, "project"), must: "clear_provision_failure() {" },
  ) + shipped('if [ "${CLAWBOX_ROOT_MANIFEST_STALE:-0}" = "1" ]; then', "\nfi", {
    helper,
    project: path.join(root, "project"),
    inclusive: true,
  });
  // The repair path: write_root_exec_manifest clears what it fixed, and
  // refresh_root_exec_manifest records what it could not.
  const fn = (name: string) => {
    const start = INSTALL_SH.indexOf(`${name}() {`);
    if (start < 0) throw new Error(`${name} not found`);
    const end = INSTALL_SH.indexOf("\n}", start);
    if (end < 0) throw new Error(`${name} has no closing brace`);
    return INSTALL_SH.slice(start, end + 2);
  };
  const writer = `${fn("write_root_exec_manifest")}\n${fn("refresh_root_exec_manifest")}`;

  const program = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "PROVISION_FAILURES=()",
    `CLAWBOX_ROOT_MANIFEST_STALE=${JSON.stringify(opts.marker)}`,
    `ROOT_EXEC_MANIFEST_HELPER=${JSON.stringify(helper)}`,
    `PROJECT_DIR=${JSON.stringify(path.join(root, "project"))}`,
    block,
    writer,
    // `if`, not a bare call: write_root_exec_manifest returns non-zero on a
    // manifest that does not verify, and a bare call would take the whole
    // script down with `set -e` before the line that reports what is left —
    // which reads as an empty failure list, i.e. as a success.
    opts.alsoWrite ? 'if write_root_exec_manifest; then echo "WRITE=ok"; else echo "WRITE=failed"; fi' : "true",
    opts.refresh ? "refresh_root_exec_manifest" : "true",
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
    write: /WRITE=(\w+)/.exec(run.stdout ?? "")?.[1] ?? "",
  };
}

describe.runIf(canRun)("the bootstrap's root-exec manifest re-record", () => {
  it("re-records once and carries nothing forward when it works", () => {
    const run = runBootstrap({ failWrites: 0 });
    expect(run.status).toBe(0);
    // --selftest FIRST, then --write AND --verify: the write's own status is
    // only worth reading once the helper has proved it is the whole program.
    expect(run.calls).toEqual(["installed --selftest", "installed --write", "installed --verify"]);
    expect(run.marker).toBe("0");
    expect(run.helperAfter, "a healthy helper must not be re-staged").toBe(run.helperBefore);
  });

  it("refreshes the helper from the reset tree and retries before giving up", () => {
    // The installed helper is the one from BEFORE the hard reset — the most
    // likely reason it just failed — so replacing it is the repair to try
    // before reporting anything.
    const run = runBootstrap({ failWrites: 1 });
    expect(run.status).toBe(0);
    expect(run.calls).toEqual([
      "installed --selftest",
      "installed --write",
      "refreshed --selftest",
      "refreshed --write",
      "refreshed --verify",
    ]);
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

  it("leaves the live helper byte-identical when the copy dies mid-write", () => {
    // The most dangerous line in this change, and nothing failed if it was
    // reverted: the call sequence is identical whether the copy goes to
    // "$_mf.new" and is renamed, or straight over "$_mf". `install` writes into
    // the existing inode with O_TRUNC, so a copy killed part way through — a
    // full or read-only root filesystem, which is the same condition that most
    // often fails the write this repair is answering — leaves a cut-off helper
    // behind. Measured both ways with an RLIMIT_FSIZE child: temp+rename keeps
    // the live helper at its original bytes; installing over it leaves an
    // 8192-byte survivor whose `--verify` still exits 0, which is worse than the
    // stale manifest it was trying to fix — it turns the root dispatcher from
    // fail-closed into fail-open for every pinned step.
    const run = runBootstrap({ failWrites: Infinity, stagingFails: "truncates" });
    expect(run.status).toBe(0);
    expect(run.helperAfter, "the live helper was truncated by a failed copy").toBe(run.helperBefore);
    expect(run.stagedLeft, "a half-written .new was left in libexec").toBe(false);
    expect(run.out).toContain("REACHED_EXEC=1");
    expect(run.marker).toBe("1");
  });

  it.skipIf(isRoot)("cleans up and carries on when the copy fails outright", () => {
    // The other half: `install` that fails before writing anything must leave
    // no staged file behind and must not abort the boot path.
    const run = runBootstrap({ failWrites: Infinity, stagingFails: "unreadable" });
    expect(run.status).toBe(0);
    expect(run.out).toContain("could not stage a fresh root-exec manifest helper");
    expect(run.helperAfter).toBe(run.helperBefore);
    expect(run.stagedLeft).toBe(false);
    expect(run.out).toContain("REACHED_EXEC=1");
    expect(run.marker).toBe("1");
  });


  it("replaces a 0-byte helper instead of reading its exit status as an answer", () => {
    // The fail-OPEN this arm exists to close. An empty executable file runs to
    // EOF and exits 0 — for `--write`, for `--verify`, and for the
    // `--verify-file` the root dispatcher asks about the copy it is about to
    // execute as root. So `--write && --verify` returning 0 proves nothing
    // here, and the same helper then tells the dispatcher that a tree it never
    // hashed matches a manifest that may not exist.
    const run = runBootstrap({ failWrites: 0, installed: "empty" });
    expect(run.status).toBe(0);
    expect(run.helperAfter, "the dead helper was left installed").toBe(run.helperInTree);
    expect(run.out).toContain("[bootstrap] WARN: the installed root-exec manifest helper");
    // Repaired, so nothing is carried into the re-exec: the replacement wrote
    // and verified the record.
    expect(run.calls).toEqual(["refreshed --selftest", "refreshed --write", "refreshed --verify"]);
    expect(run.marker).toBe("0");
    expect(run.stagedLeft).toBe(false);
  });

  it("replaces a helper truncated where a mid-write copy would cut it", () => {
    // The shipped helper with its verb dispatcher gone: every function defined,
    // `set -euo pipefail` honoured, and exit 0 for every verb. This is what a
    // copy killed by a full disk actually leaves behind, and it is
    // indistinguishable from a working helper by exit status alone.
    const run = runBootstrap({ failWrites: 0, installed: "truncated" });
    expect(run.status).toBe(0);
    expect(run.helperAfter).toBe(run.helperInTree);
    expect(run.calls).toEqual(["refreshed --selftest", "refreshed --write", "refreshed --verify"]);
    expect(run.marker).toBe("0");
  });

  it("carries the failure forward when a dead helper cannot be replaced", () => {
    // Nothing in the reset tree to repair with, so the run must not pretend the
    // record is current — the dispatcher refuses every pinned step until it is.
    const run = runBootstrap({ failWrites: 0, installed: "empty", helperInTree: false });
    expect(run.status).toBe(0);
    expect(run.out).toContain("REACHED_EXEC=1");
    expect(run.marker).toBe("1");
    expect(run.calls, "a helper that cannot answer must not be asked to record").toEqual([]);
  });

  it("re-execs into the refreshed tree with the bootstrap flag set", () => {
    // The other half of the exec's contract, executed rather than matched.
    const run = runBootstrap({ failWrites: 0 });
    expect(run.out).toContain("REACHED_EXEC=1");
    expect(run.out).toContain("BOOTSTRAPPED=1");
  });
});

describe.runIf(canRun)("a stale manifest is reported against the run's verdict", () => {
  it("records a provisioning failure, so the update cannot report success", () => {
    const run = runVerdict({ marker: "1", verifies: false });
    expect(run.status).toBe(0);
    expect(run.failures).toContain("root_exec_manifest");
    // The operator is told what is broken and how to repair it, not just that
    // something failed — and the repair is a step that EXISTS and that
    // re-installs the helper too, not the command that just failed twice.
    expect(run.out).toMatch(/REFUSED \(exit 65\)/);
    expect(run.out).toContain("--step systemd_services");
  });

  it("does not read a dead helper's 0 as 'it verifies after all'", () => {
    // The marker is re-checked rather than believed, and the re-check runs the
    // same helper the bootstrap just failed to use. If that helper is the empty
    // one, its `--verify` exits 0 and the run clears a failure nobody repaired
    // — the false success this whole chain is about, one step further along.
    const run = runVerdict({ marker: "1", verifies: true, deadHelper: true });
    expect(run.failures).toContain("root_exec_manifest");
    expect(run.out).not.toContain("verifies after all");
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

  it("records the OTHER re-record too — sync_repo_to_update_target's", () => {
    // install.sh re-records the manifest after a hard reset in TWO places. The
    // second, `refresh_root_exec_manifest` (reached from
    // sync_repo_to_update_target), had the same `--write || echo WARN` shape: a
    // failure there left the step exiting 0 with a stale manifest, and the
    // operator met it as an opaque exit-65 on some later step instead. Without
    // this the run's verdict is asymmetric — cleared by a success, never set by
    // a failure.
    const run = runVerdict({ marker: "0", verifies: false, refresh: "fails" });
    expect(run.status).toBe(0);
    expect(run.failures).toContain("root_exec_manifest");
    expect(run.out).toMatch(/Warning: could not re-record/);
  });

  it("stays quiet when that re-record works", () => {
    // "Works" now means both halves: the write returned 0 AND the manifest it
    // wrote verifies. Nothing may be cleared on the write alone.
    const run = runVerdict({ marker: "0", verifies: false, writeVerifies: true, refresh: "works" });
    expect(run.failures.trim()).toBe("");
  });

  it("still reports the re-record that wrote a manifest which does not verify", () => {
    // The write succeeded and the record is still not usable — every pinned
    // root step keeps failing closed, so the run must keep saying so.
    const run = runVerdict({ marker: "0", verifies: false, writeVerifies: false, refresh: "works" });
    expect(run.failures).toContain("root_exec_manifest");
    expect(run.out).toMatch(/Warning: could not re-record/);
  });

  it("clears the recorded failure when a later step re-records the manifest", () => {
    // install_root_libexec re-records it during a full run; that IS the repair,
    // so the run must stop reporting it.
    const run = runVerdict({ marker: "1", verifies: false, writeVerifies: true, alsoWrite: true });
    expect(run.write).toBe("ok");
    expect(run.failures.trim()).toBe("");
  });

  it("keeps reporting it when the re-record wrote a manifest that does not verify", () => {
    // The write's own 0 is not the repair. Without this the run reports a
    // recovery while the root dispatcher still refuses every pinned step —
    // and install_root_libexec installs that dispatcher on the same answer.
    const run = runVerdict({ marker: "1", verifies: false, writeVerifies: false, alsoWrite: true });
    expect(run.write).toBe("failed");
    expect(run.failures).toContain("root_exec_manifest");
  });
});
