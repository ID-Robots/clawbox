import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * TASK-445 audit, GAP 2 — root must not execute code the clawbox user can
 * rewrite.
 *
 * The granted chain is `sudo systemctl start clawbox-root-update@<step>.service`
 * -> the root-owned dispatcher -> `/home/clawbox/clawbox/install.sh --step
 * <step>`. Only the middle link was root-owned: install.sh is clawbox:clawbox
 * 0755 inside a clawbox-writable directory (install.sh hands the tree back with
 * `chown -R clawbox:clawbox` on every root run), and the steps it dispatches go
 * on to run more of that same tree as root. So the grant also meant "clawbox
 * may choose the program root runs" — passwordless local root in two moves.
 *
 * The fix is a root-owned sha256 manifest of everything root executes on
 * clawbox's behalf, written by install.sh and verified by the dispatcher before
 * the exec. These tests drive the real shipped scripts, with their constants
 * rewritten onto a temp tree — never a re-implementation of them.
 */

const REPO = path.resolve(__dirname, "../../..");
const MANIFEST_SRC = path.join(REPO, "config", "clawbox-root-manifest.sh");
const DISPATCHER_SRC = path.join(REPO, "config", "clawbox-root-step.sh");
const INSTALL_SH = fs.readFileSync(path.join(REPO, "install.sh"), "utf-8");

/**
 * The liveness token --selftest prints. Three separately installed root-owned
 * files carry it as a literal (the helper, the dispatcher, install.sh) because
 * they cannot share a constant; the last test in this file pins them together.
 */
const SELFTEST_TOKEN = "clawbox-root-manifest alive";

/**
 * A helper cut off where a copy killed part way through would leave it: every
 * function defined, the verb dispatcher at the bottom gone. It parses, runs to
 * EOF under `set -euo pipefail` and exits 0 for `--write`, `--verify` and
 * `--verify-file` alike, without doing any of them.
 */
function truncatedHelper(): string {
  const text = fs.readFileSync(MANIFEST_SRC, "utf-8");
  const cut = text.indexOf('case "${1:-}" in');
  if (cut < 0) throw new Error("the shipped helper no longer ends in a verb dispatcher");
  return text.slice(0, cut);
}

/**
 * The same helper as it was before `--selftest` existed: the verb dispatcher
 * intact, that one arm gone. This is what is INSTALLED on every box updating
 * across this release — the copy in /usr/local/libexec is always the previous
 * release's until a step re-installs it — so it is the shape a liveness probe
 * must not mistake for a stub.
 */
function withoutSelftest(text: string): string {
  const stripped = text.replace(/^ *--selftest\).*\n/m, "");
  if (stripped === text) throw new Error("the shipped helper no longer has a --selftest arm");
  return stripped;
}

/** Lift one function out of install.sh, so the block under test runs the real one. */
function shellFn(name: string): string {
  const start = INSTALL_SH.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`${name} not found in install.sh`);
  const end = INSTALL_SH.indexOf("\n}", start);
  if (end < 0) throw new Error(`${name} has no closing brace`);
  return INSTALL_SH.slice(start, end + 2);
}

const CAN_RUN =
  process.platform !== "win32"
  && spawnSync("bash", ["-c", "true"], { stdio: "ignore" }).status === 0
  && spawnSync("sha256sum", ["--version"], { stdio: "ignore" }).status === 0;
const d = CAN_RUN ? describe : describe.skip;

let tmp: string;
let project: string;
let libexec: string;
let etc: string;
let manifest: string;
let helper: string;
let dispatcher: string;
let marker: string;

/**
 * `install -o root -g root` is what the shipped scripts really run, and it
 * fails with EPERM for a normal user. Drop the ownership flags so the copy
 * still happens under a test runner; everything else is executed verbatim.
 */
const unroot = (text: string) => text.replace(/install (-d )?-o root -g root /g, "install $1");

/** Rewrite a shipped script's hard-coded constants onto the temp tree. */
function retarget(src: string, dest: string, subs: Array<[RegExp, string]>) {
  let text = fs.readFileSync(src, "utf-8");
  for (const [re, val] of subs) {
    if (!re.test(text)) throw new Error(`constant ${re} not found in ${src}`);
    text = text.replace(re, val);
  }
  fs.writeFileSync(dest, unroot(text), { mode: 0o755 });
}

function sh(script: string) {
  return spawnSync("bash", ["-c", script], { encoding: "utf-8" });
}

const ran = () => (fs.existsSync(marker) ? fs.readFileSync(marker, "utf-8") : "");

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-manifest-"));
  project = path.join(tmp, "project");
  libexec = path.join(tmp, "libexec");
  etc = path.join(tmp, "etc");
  manifest = path.join(etc, "root-exec.manifest");
  helper = path.join(libexec, "clawbox-root-manifest.sh");
  dispatcher = path.join(libexec, "clawbox-root-step.sh");
  marker = path.join(tmp, "ran");

  fs.mkdirSync(path.join(project, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(project, "config"), { recursive: true });
  fs.mkdirSync(libexec, { recursive: true });
  fs.mkdirSync(etc, { recursive: true });

  // A stand-in install.sh that records that it ran, and under which pinning.
  const stub = [
    "#!/usr/bin/env bash",
    `echo "args=$* allow=[\${CLAWBOX_ALLOW_SELF_UPDATE:-}] pinned=[\${CLAWBOX_INSTALL_BOOTSTRAPPED:-}]" > "${marker}"`,
    "",
  ].join("\n");
  fs.writeFileSync(path.join(project, "install.sh"), stub, { mode: 0o755 });
  fs.writeFileSync(path.join(project, "scripts", "start-ap.sh"), "#!/bin/sh\nexit 0\n");
  fs.writeFileSync(path.join(project, "config", "a.service"), "[Unit]\n");

  retarget(MANIFEST_SRC, helper, [
    [/^PROJECT_DIR=.*$/m, `PROJECT_DIR="${project}"`],
    [/^MANIFEST_DIR=.*$/m, `MANIFEST_DIR="${etc}"`],
    [/^MANIFEST_FILE=.*$/m, `MANIFEST_FILE="${manifest}"`],
  ]);
  retarget(DISPATCHER_SRC, dispatcher, [
    [/^PROJECT_DIR=.*$/m, `PROJECT_DIR="${project}"`],
    [/^MANIFEST_HELPER=.*$/m, `MANIFEST_HELPER="${helper}"`],
    [/^RUN_DIR=.*$/m, `RUN_DIR="${path.join(tmp, "run")}"`],
  ]);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

d("clawbox-root-manifest.sh", () => {
  it("records the tree and then verifies it", () => {
    expect(sh(`"${helper}" --write`).status).toBe(0);
    expect(fs.existsSync(manifest)).toBe(true);
    expect(sh(`"${helper}" --verify`).status).toBe(0);
  });

  it("refuses once install.sh changes", () => {
    sh(`"${helper}" --write`);
    fs.appendFileSync(path.join(project, "install.sh"), "\nid -u\n");
    const r = sh(`"${helper}" --verify`);
    expect(r.status).toBe(65);
    expect(r.stderr).toMatch(/does not match/);
  });

  it("refuses once a script a root step runs changes", () => {
    // The indirection GAP 2 is really about: install.sh is only the FIRST file
    // root executes out of the clawbox-writable tree.
    sh(`"${helper}" --write`);
    fs.writeFileSync(path.join(project, "scripts", "start-ap.sh"), "#!/bin/sh\nid > /dev/null\n");
    expect(sh(`"${helper}" --verify`).status).toBe(65);
  });

  it("does NOT treat an added file as tampering", () => {
    // Deliberate, and the reason is availability. Root only ever executes files
    // install.sh names explicitly, and all of those are recorded — so a file
    // nobody runs is not a way to make root run it. Failing on additions, on the
    // other hand, means any stray file under scripts/ refuses every root step
    // for good on a console-less appliance. `scripts/__pycache__` alone would do
    // it: the gateway's ExecStartPre imports scripts/gateway_origins.py, so
    // CPython writes a .pyc there the first time the gateway starts.
    sh(`"${helper}" --write`);
    fs.writeFileSync(path.join(project, "scripts", "extra.sh"), "#!/bin/sh\n");
    expect(sh(`"${helper}" --verify`).status).toBe(0);
  });

  it("never records generated content that lives inside a covered path", () => {
    fs.mkdirSync(path.join(project, "scripts", "__pycache__"), { recursive: true });
    fs.writeFileSync(path.join(project, "scripts", "__pycache__", "x.cpython-310.pyc"), "old");
    sh(`"${helper}" --write`);
    expect(fs.readFileSync(manifest, "utf-8")).not.toContain("__pycache__");
    // A python minor-version bump renames it and rewrites the bytes. Neither may
    // turn an ordinary distro upgrade into a device that cannot set its password.
    fs.rmSync(path.join(project, "scripts", "__pycache__", "x.cpython-310.pyc"));
    fs.writeFileSync(path.join(project, "scripts", "__pycache__", "x.cpython-312.pyc"), "new");
    expect(sh(`"${helper}" --verify`).status).toBe(0);
  });

  it("refuses a file removed from under a covered path", () => {
    sh(`"${helper}" --write`);
    fs.rmSync(path.join(project, "config", "a.service"));
    expect(sh(`"${helper}" --verify`).status).toBe(65);
  });

  it("refuses when there is no manifest at all", () => {
    const r = sh(`"${helper}" --verify`);
    expect(r.status).toBe(65);
    expect(r.stderr).toMatch(/no manifest/);
  });

  it("does not cover the runtime state the app has to write", () => {
    // data/, .next/ and node_modules/ change on every build and every request.
    // Covering them would turn an ordinary build into a device that refuses to
    // change its own password, so they are deliberately outside the record.
    sh(`"${helper}" --write`);
    fs.mkdirSync(path.join(project, "data"), { recursive: true });
    fs.writeFileSync(path.join(project, "data", "config.json"), "{}");
    fs.mkdirSync(path.join(project, ".next"), { recursive: true });
    fs.writeFileSync(path.join(project, ".next", "build"), "x");
    expect(sh(`"${helper}" --verify`).status).toBe(0);
  });

  it("refuses to record a name sha256sum would have to escape", () => {
    // sha256sum escapes a filename containing a backslash or a newline: it
    // prefixes the line with `\` and re-encodes them. The manifest's path column
    // is read back with a fixed-width strip, so recording such a name would
    // produce a manifest this script cannot parse — and, because re-recording
    // reproduces it, a device that refuses every root step for good. Refuse to
    // write it instead.
    fs.writeFileSync(path.join(project, "scripts", "back\\slash.sh"), "#!/bin/sh\n");
    const r = sh(`"${helper}" --write`);
    expect(r.status).toBe(65);
    expect(r.stderr).toMatch(/backslash or a newline/);
    expect(fs.existsSync(manifest), "no manifest may be left behind").toBe(false);
  });

  it("records a name containing an asterisk, which needs no escaping", () => {
    // The guard above is about sha256sum's escaping rules, not about "unusual
    // characters" — getting it wrong in the other direction would refuse a
    // perfectly ordinary file and brick the same steps.
    fs.writeFileSync(path.join(project, "scripts", "star*.sh"), "#!/bin/sh\n");
    expect(sh(`"${helper}" --write`).status).toBe(0);
    expect(sh(`"${helper}" --verify`).status).toBe(0);
  });

  it("checks one already-opened copy against what it recorded for a path", () => {
    // --verify answers a question about the tree and is stale the moment it
    // returns; the dispatcher copies the file it will run somewhere clawbox
    // cannot reach and asks about the COPY. Same bytes it execs.
    sh(`"${helper}" --write`);
    const copy = path.join(tmp, "copy.sh");
    fs.copyFileSync(path.join(project, "install.sh"), copy);
    expect(sh(`"${helper}" --verify-file install.sh "${copy}"`).status).toBe(0);

    fs.appendFileSync(copy, "\n# swapped\n");
    const r = sh(`"${helper}" --verify-file install.sh "${copy}"`);
    expect(r.status).toBe(65);
    expect(r.stderr).toMatch(/does not match/);

    // A path that was never recorded is refused, not silently accepted.
    expect(sh(`"${helper}" --verify-file scripts/nope.sh "${copy}"`).status).toBe(65);
    expect(sh(`"${helper}" --verify-file install.sh "${tmp}/missing"`).status).toBe(66);
  });

  it("rejects an unknown mode instead of doing something", () => {
    expect(sh(`"${helper}" --whatever`).status).toBe(64);
  });

  it("proves it is the whole program, which is what its exit status cannot", () => {
    // Every verb above answers with an exit status, and an exit status is
    // exactly what a helper that lost its bottom half cannot be trusted for:
    // it exits 0 for all of them. Only a copy that reaches the verb dispatcher
    // can print this token.
    const r = sh(`"${helper}" --selftest`);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(SELFTEST_TOKEN);

    for (const [what, text] of [["a 0-byte", ""], ["a truncated", truncatedHelper()]] as const) {
      fs.writeFileSync(helper, text, { mode: 0o755 });
      const dead = sh(`"${helper}" --selftest`);
      expect(dead.stdout.trim(), `${what} helper printed the token`).not.toBe(SELFTEST_TOKEN);
      // ...while still answering every real verb with a clean success.
      expect(sh(`"${helper}" --write`).status, `${what} helper refused --write`).toBe(0);
      expect(sh(`"${helper}" --verify`).status, `${what} helper refused --verify`).toBe(0);
    }
  });
});

d("clawbox-root-step.sh — the gate in front of the exec", () => {
  it("runs the step when the tree still matches its record", () => {
    sh(`"${helper}" --write`);
    const r = sh(`"${dispatcher}" chpasswd`);
    expect(r.status).toBe(0);
    expect(ran()).toContain("--step chpasswd");
  });

  it("execs a copy it holds, not the path it checked", () => {
    // Verifying $ENTRYPOINT and then exec'ing $ENTRYPOINT is a race: bash opens
    // the file after the check returns. The dispatcher copies it into a
    // root-only directory, hashes the copy, and runs that.
    sh(`"${helper}" --write`);
    expect(sh(`"${dispatcher}" chpasswd`).status).toBe(0);
    const staged = path.join(tmp, "run", "root-step-install.sh");
    expect(fs.existsSync(staged), "the dispatcher did not stage the entrypoint").toBe(true);
    expect(fs.readFileSync(staged, "utf-8")).toBe(fs.readFileSync(path.join(project, "install.sh"), "utf-8"));
    expect(ran()).toContain("--step chpasswd");
  });

  it("refuses when the staged copy does not match the record", () => {
    // The window the copy closes: install.sh is replaced after --verify passed.
    // Simulated by breaking the manifest entry for it, which is the same
    // mismatch the copy would surface.
    sh(`"${helper}" --write`);
    const line = fs.readFileSync(manifest, "utf-8")
      .split("\n")
      .find((l) => l.endsWith("install.sh"))!;
    fs.writeFileSync(
      manifest,
      fs.readFileSync(manifest, "utf-8").replace(line, line.replace(/^[0-9a-f]{4}/, "dead")),
    );
    expect(sh(`"${dispatcher}" chpasswd`).status).toBe(65);
    expect(ran()).toBe("");
  });

  it("refuses the step, and never execs, once install.sh is rewritten", () => {
    sh(`"${helper}" --write`);
    fs.writeFileSync(path.join(project, "install.sh"), "#!/bin/sh\nid -u\n", { mode: 0o755 });
    const r = sh(`"${dispatcher}" chpasswd`);
    expect(r.status).toBe(65);
    expect(r.stderr).toMatch(/does not match the root-exec manifest/);
    expect(ran()).toBe("");
  });

  it("lets an update step through a stale record, because an update is what makes it stale", () => {
    // src/lib/updater.ts does its own fetch/reset/clean as the clawbox user
    // before it starts the rebuild step, and scripts/force-update.sh does the
    // same by hand. Verifying here would fail those flows at their next step and
    // leave the device refusing every root step afterwards. The update family
    // re-records instead, as its first action, which is also what heals a tree
    // replaced from the outside. This is not a hole in the allow-list: TASK-445
    // removed every sudo grant for a self-updating instance.
    sh(`"${helper}" --write`);
    fs.appendFileSync(path.join(project, "install.sh"), "\n# replaced by an update\n");
    expect(sh(`"${dispatcher}" git_pull`).status).toBe(0);
    expect(ran()).toContain("allow=[1]");
  });

  it("still refuses every step a foothold can actually reach", () => {
    // The four instances config/clawbox-sudoers grants, and the rest of the
    // pinned family. None of them is supposed to change the covered files.
    sh(`"${helper}" --write`);
    fs.appendFileSync(path.join(project, "install.sh"), "\n# tampered\n");
    for (const step of ["chpasswd", "set_hostname", "restart_ap", "llamacpp_install", "recover"]) {
      expect(sh(`"${dispatcher}" ${step}`).status, `${step} ran against a tampered tree`).toBe(65);
      expect(ran()).toBe("");
    }
  });

  it("fails closed when the verifier is installed but does nothing", () => {
    // A 0-byte or truncated helper is the missing-verifier case with a worse
    // ending: it is present and executable, so the `-x` guard passes, and it
    // answers `--verify` AND the `--verify-file` about the staged copy with 0.
    // The dispatcher would then exec /home/clawbox/clawbox/install.sh as root
    // on the word of a program that never hashed anything — and that tree is
    // writable by the unprivileged user the web server runs as, which is the
    // whole reason the manifest exists (TASK-445).
    for (const [what, text] of [["0-byte", ""], ["truncated", truncatedHelper()]] as const) {
      sh(`"${helper}" --write`);
      fs.writeFileSync(helper, text, { mode: 0o755 });
      const r = sh(`"${dispatcher}" chpasswd`);
      expect(r.status, `a ${what} helper let the step through`).toBe(65);
      expect(ran(), `a ${what} helper let root exec the tree`).toBe("");
      // Loudly, and with a repair the operator can actually type — the whole
      // command, not a fragment. `systemd_services` is the step that re-installs
      // the helper AND re-records the manifest, and the path has to be the
      // on-disk entrypoint: a few lines below this check the script repoints
      // $ENTRYPOINT at a copy under /run that is deleted on reboot and that the
      // operator cannot execute, so a probe moved after that point would print a
      // remedy which cannot be run.
      expect(r.stderr).toContain(`sudo bash ${path.join(project, "install.sh")} --step systemd_services`);
      fs.rmSync(marker, { force: true });
      retarget(MANIFEST_SRC, helper, [
        [/^PROJECT_DIR=.*$/m, `PROJECT_DIR="${project}"`],
        [/^MANIFEST_DIR=.*$/m, `MANIFEST_DIR="${etc}"`],
        [/^MANIFEST_FILE=.*$/m, `MANIFEST_FILE="${manifest}"`],
      ]);
    }
  });

  it("still runs the step through a helper from before --selftest existed", () => {
    // The false failure the probe must not become, and it would be a fleet-wide
    // one: on EVERY box updating across this release the installed helper is the
    // previous release's, which does not know `--selftest`. Its 64 is not a
    // refusal to answer — it is the verb dispatcher at the bottom of the file
    // running, which is the very thing being asked about, and which a stub
    // cannot do. So an old helper is live and the step goes through.
    sh(`"${helper}" --write`);
    fs.writeFileSync(helper, withoutSelftest(fs.readFileSync(helper, "utf-8")), { mode: 0o755 });
    expect(sh(`"${helper}" --selftest`).status, "the stand-in must answer 64, not 0").toBe(64);
    const r = sh(`"${dispatcher}" chpasswd`);
    expect(r.status, r.stderr).toBe(0);
    expect(ran()).toContain("--step chpasswd");
  });

  it("fails closed when the verifier itself is missing", () => {
    sh(`"${helper}" --write`);
    fs.rmSync(helper);
    const r = sh(`"${dispatcher}" chpasswd`);
    expect(r.status).toBe(65);
    expect(r.stderr).toMatch(/is missing/);
    expect(ran()).toBe("");
  });

  it("still refuses a step name outside the allow-list, before it verifies anything", () => {
    expect(sh(`"${dispatcher}" ../../etc/shadow`).status).toBe(64);
    expect(sh(`"${dispatcher}" definitely_not_a_step`).status).toBe(64);
  });

  it("pins a password change to the on-disk copy — no git, no network", () => {
    // TASK-445's own acceptance criterion. chpasswd is not in
    // SELF_UPDATING_STEPS, so install.sh's bootstrap (git fetch + reset --hard +
    // re-exec) is switched off for it.
    sh(`"${helper}" --write`);
    expect(sh(`"${dispatcher}" chpasswd`).status).toBe(0);
    expect(ran()).toContain("allow=[] pinned=[1]");
  });

  it("lets the update family self-update", () => {
    sh(`"${helper}" --write`);
    expect(sh(`"${dispatcher}" git_pull`).status).toBe(0);
    expect(ran()).toContain("allow=[1] pinned=[]");
  });
});

/** install.sh's root-owned-entrypoint block, verbatim. */
function libexecBlock(): string {
  const start = INSTALL_SH.indexOf("ROOT_LIBEXEC_DIR=");
  const end = INSTALL_SH.indexOf("# ── sudoers ─");
  if (start < 0 || end < 0) throw new Error("libexec block markers not found in install.sh");
  return INSTALL_SH.slice(start, end);
}

d("install.sh::install_root_libexec", () => {
  function runBlock(extra = "") {
    const block = unroot(libexecBlock())
      .replace(/\/usr\/local\/libexec\/clawbox/g, libexec)
      .replace(/\/usr\/local\/libexec/g, path.dirname(libexec))
      .replace(/\/etc\/clawbox/g, etc);
    return sh([
      "set -uo pipefail",
      `PROJECT_DIR="${project}"`,
      'record_provision_failure() { PROVISION_FAILURES+=("$1"); echo "provision-failure:$1"; }',
      // write_root_exec_manifest now CLEARS what it repaired (TASK-584): a
      // manifest the bootstrap could not write and a later step did is not a
      // failure of the run. The real helper is lifted out of install.sh rather
      // than stubbed, so this block exercises the clearing it actually does.
      //
      // Seeded, not empty. With an empty array and a record stub that only
      // echoed, clear_provision_failure had nothing to remove: the lifted
      // function proved only that the name resolves, while the line below
      // reports what it actually removed.
      "PROVISION_FAILURES=(root_exec_manifest)",
      shellFn("clear_provision_failure"),
      // write_root_exec_manifest refuses to read the exit status of a helper
      // that has not proved it is complete, so the real probe is lifted too.
      shellFn("root_exec_manifest_helper_alive"),
      block,
      extra,
      "install_root_libexec",
      'echo "remaining-failures:${PROVISION_FAILURES[*]-}"',
    ].join("\n"));
  }

  beforeEach(() => {
    // install_root_libexec copies out of the project tree, so the sources have
    // to be in it — retargeted, because the copies it installs are then RUN
    // (write_root_exec_manifest calls the one it just placed in libexec) and the
    // shipped constants point at /home/clawbox/clawbox.
    retarget(MANIFEST_SRC, path.join(project, "config", "clawbox-root-manifest.sh"), [
      [/^PROJECT_DIR=.*$/m, `PROJECT_DIR="${project}"`],
      [/^MANIFEST_DIR=.*$/m, `MANIFEST_DIR="${etc}"`],
      [/^MANIFEST_FILE=.*$/m, `MANIFEST_FILE="${manifest}"`],
    ]);
    retarget(DISPATCHER_SRC, path.join(project, "config", "clawbox-root-step.sh"), [
      [/^PROJECT_DIR=.*$/m, `PROJECT_DIR="${project}"`],
      [/^MANIFEST_HELPER=.*$/m, `MANIFEST_HELPER="${helper}"`],
    ]);
  });

  it("writes the manifest and installs the dispatcher", () => {
    // Both files already exist here — the outer beforeEach put retargeted copies
    // there — so assert on the CONTENT. Otherwise the test passes whether or not
    // install_root_libexec copied anything.
    const r = runBlock();
    expect(r.stdout + r.stderr).not.toMatch(/Warning/);
    for (const name of ["clawbox-root-manifest.sh", "clawbox-root-step.sh"]) {
      expect(
        fs.readFileSync(path.join(libexec, name), "utf-8"),
        `${name} was not installed from the project tree`,
      ).toBe(fs.readFileSync(path.join(project, "config", name), "utf-8"));
    }
    expect(fs.existsSync(manifest)).toBe(true);
  });

  it("records the tree it is about to authorise, so the new dispatcher verifies", () => {
    runBlock();
    expect(sh(`"${helper}" --verify`).status).toBe(0);
  });

  it("clears a bootstrap failure it has just repaired", () => {
    // The bootstrap records root_exec_manifest when it cannot re-record the
    // manifest after the hard reset. This step re-records it half a minute
    // later, and a run that ends healthy must not still report that failure —
    // that is a false failure over an install that is fine (TASK-584).
    const r = runBlock();
    expect(r.stdout + r.stderr).toMatch(/remaining-failures:\s*$/m);
  });

  it("clears only the token it repaired", () => {
    // The control: without this, "clears" would pass over a function that
    // emptied the whole array and lost every other step's failure.
    const r = runBlock("PROVISION_FAILURES=(openclaw_tts root_exec_manifest hermes_edition)");
    expect(r.stdout + r.stderr).toMatch(/remaining-failures:openclaw_tts hermes_edition/);
  });

  it("does not clear the failure when the manifest does not verify after the write", () => {
    // `--write` returning 0 says the helper believes it wrote something, not
    // that the record now matches the tree. Clearing the recorded failure on
    // the write alone reports a repair that has not been shown to have
    // happened — and every pinned root step afterwards still fails closed.
    fs.writeFileSync(
      path.join(project, "config", "clawbox-root-manifest.sh"),
      [
        "#!/usr/bin/env bash",
        `[ "\${1:-}" = "--selftest" ] && { printf '%s\\n' "${SELFTEST_TOKEN}"; exit 0; }`,
        '[ "${1:-}" = "--write" ] && exit 0',
        '[ "${1:-}" = "--verify" ] && exit 65',
        "exit 64",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(libexec, "clawbox-root-step.sh"), "#!/bin/sh\n# previous\n", { mode: 0o755 });
    const r = runBlock();
    expect(r.stdout + r.stderr).toMatch(/remaining-failures:root_exec_manifest/);
    expect(r.stdout + r.stderr).toMatch(/leaving the existing root dispatcher in place/);
    expect(fs.readFileSync(path.join(libexec, "clawbox-root-step.sh"), "utf-8")).toContain("# previous");
  });

  it("refuses to record anything through a helper that cannot prove it is live", () => {
    // The same 0-byte helper, one layer up: it exits 0 for `--write`, so the
    // run would install the dispatcher and clear the failure over a manifest
    // that was never written. The dispatcher must stay where it is.
    fs.writeFileSync(path.join(project, "config", "clawbox-root-manifest.sh"), "", { mode: 0o755 });
    fs.writeFileSync(path.join(libexec, "clawbox-root-step.sh"), "#!/bin/sh\n# previous\n", { mode: 0o755 });
    const r = runBlock();
    expect(r.stdout + r.stderr).toMatch(/remaining-failures:root_exec_manifest/);
    expect(fs.readFileSync(path.join(libexec, "clawbox-root-step.sh"), "utf-8")).toContain("# previous");
    expect(fs.existsSync(manifest), "no manifest was written, yet one appeared").toBe(false);
  });

  it("keeps the existing dispatcher when the manifest cannot be written", () => {
    // A dispatcher newer than its manifest refuses every root step: no password
    // change, no hostname change, no hotspot restart, on a box with no console.
    // So the manifest is written FIRST and the dispatcher only follows it.
    fs.writeFileSync(path.join(libexec, "clawbox-root-step.sh"), "#!/bin/sh\n# previous\n", { mode: 0o755 });
    const r = runBlock("write_root_exec_manifest() { return 1; }");
    expect(r.stdout + r.stderr).toMatch(/leaving the existing root dispatcher in place/);
    expect(r.stdout + r.stderr).toMatch(/provision-failure:root_exec_manifest/);
    expect(fs.readFileSync(path.join(libexec, "clawbox-root-step.sh"), "utf-8")).toContain("# previous");
  });
});

d("install.sh::install_root_file", () => {
  it("never leaves a prefix of a root helper where the live one was", () => {
    // The stub factory, on the path that runs on EVERY install and every
    // `--step systemd_services` — which is the remedy every refusal in this
    // chain prints. `install` writes into the destination inode with O_TRUNC,
    // so a copy killed part way through (a full or read-only /usr) left an
    // executable PREFIX of the file behind. Every script install_root_libexec
    // installs dispatches at the BOTTOM, so that prefix is silently PERMISSIVE:
    // a truncated clawbox-root-manifest.sh exits 0 for --write and --verify
    // without looking, and a truncated clawbox-root-step.sh reaches EOF and
    // exits 0 without exec'ing the step at all — which `Type=oneshot` reports
    // to the updater as a step that succeeded.
    const dst = path.join(libexec, "victim.sh");
    const live = "#!/bin/sh\n# the working copy\nexit 0\n";
    fs.writeFileSync(dst, live, { mode: 0o755 });
    const src = path.join(tmp, "big.sh");
    fs.writeFileSync(src, `#!/bin/sh\n${"# pad\n".repeat(30_000)}exit 0\n`);

    // RLIMIT_FSIZE 8 blocks = 4096 bytes, so the source cannot fit and the copy
    // dies mid-write — the real shape of the failure, not a mocked one.
    const r = sh(
      [
        "set -uo pipefail",
        unroot(shellFn("install_root_file")),
        "ulimit -f 8",
        `if install_root_file "${src}" "${dst}"; then echo RC=ok; else echo RC=fail; fi`,
        "",
      ].join("\n"),
    );
    expect(r.stdout, r.stderr).toContain("RC=fail");
    expect(fs.readFileSync(dst, "utf-8"), "a failed copy truncated the live file").toBe(live);
    expect(fs.existsSync(`${dst}.new`), "a staged copy was left behind").toBe(false);
  });

  it("installs the whole file when the copy fits", () => {
    const dst = path.join(libexec, "victim.sh");
    const src = path.join(tmp, "small.sh");
    fs.writeFileSync(src, "#!/bin/sh\nexit 7\n");
    const r = sh(
      ["set -euo pipefail", unroot(shellFn("install_root_file")), `install_root_file "${src}" "${dst}"`, ""].join("\n"),
    );
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readFileSync(dst, "utf-8")).toBe("#!/bin/sh\nexit 7\n");
    expect(fs.statSync(dst).mode & 0o777).toBe(0o755);
    expect(fs.existsSync(`${dst}.new`)).toBe(false);
  });
});

d("the liveness token", () => {
  it("is the same literal in every file that asks for it", () => {
    // The helper, the root dispatcher and install.sh are three separately
    // installed root-owned files, so the token cannot be a shared constant. A
    // typo in one of them is silent in the direction that matters: the caller
    // stops believing a healthy helper, or — worse — a caller that never got
    // updated keeps believing a dead one.
    const helperText = fs.readFileSync(MANIFEST_SRC, "utf-8");
    expect(helperText).toContain(`SELFTEST_TOKEN="${SELFTEST_TOKEN}"`);
    expect(fs.readFileSync(DISPATCHER_SRC, "utf-8")).toContain(SELFTEST_TOKEN);
    // Twice in install.sh: the bootstrap block runs before any function it
    // could share, so it carries its own copy of the probe.
    expect(INSTALL_SH.split(SELFTEST_TOKEN).length - 1).toBeGreaterThanOrEqual(2);
  });
});
