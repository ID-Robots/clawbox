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

  it("rejects an unknown mode instead of doing something", () => {
    expect(sh(`"${helper}" --whatever`).status).toBe(64);
  });
});

d("clawbox-root-step.sh — the gate in front of the exec", () => {
  it("runs the step when the tree still matches its record", () => {
    sh(`"${helper}" --write`);
    const r = sh(`"${dispatcher}" chpasswd`);
    expect(r.status).toBe(0);
    expect(ran()).toContain("--step chpasswd");
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
      'record_provision_failure() { echo "provision-failure:$1"; }',
      block,
      extra,
      "install_root_libexec",
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
