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

/** Rewrite a shipped script's hard-coded constants onto the temp tree. */
function retarget(src: string, dest: string, subs: Array<[RegExp, string]>) {
  let text = fs.readFileSync(src, "utf-8");
  for (const [re, val] of subs) {
    if (!re.test(text)) throw new Error(`constant ${re} not found in ${src}`);
    text = text.replace(re, val);
  }
  // The helper runs as root on the device; the tests do not.
  text = text.replace(/install -d -o root -g root /g, "install -d ");
  fs.writeFileSync(dest, text, { mode: 0o755 });
}

function sh(script: string) {
  return spawnSync("bash", ["-c", script], { encoding: "utf-8" });
}

const RAN_MARKER = () => path.join(tmp, "ran");
const ran = () => (fs.existsSync(RAN_MARKER()) ? fs.readFileSync(RAN_MARKER(), "utf-8") : "");

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-manifest-"));
  project = path.join(tmp, "project");
  libexec = path.join(tmp, "libexec");
  etc = path.join(tmp, "etc");
  manifest = path.join(etc, "root-exec.manifest");
  helper = path.join(libexec, "clawbox-root-manifest.sh");
  dispatcher = path.join(libexec, "clawbox-root-step.sh");

  fs.mkdirSync(path.join(project, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(project, "config"), { recursive: true });
  fs.mkdirSync(libexec, { recursive: true });
  fs.mkdirSync(etc, { recursive: true });

  // A stand-in install.sh that records that it ran, and under which pinning.
  const marker = RAN_MARKER();
  const stub = [
    "#!/usr/bin/env bash",
    `echo "args=$* allow=[${"${CLAWBOX_ALLOW_SELF_UPDATE:-}"}] pinned=[${"${CLAWBOX_INSTALL_BOOTSTRAPPED:-}"}]" > "${marker}"`,
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

  it("refuses a file ADDED under a covered path, which `sha256sum -c` alone cannot see", () => {
    sh(`"${helper}" --write`);
    fs.writeFileSync(path.join(project, "scripts", "extra.sh"), "#!/bin/sh\n");
    const r = sh(`"${helper}" --verify`);
    expect(r.status).toBe(65);
    expect(r.stderr).toMatch(/no longer matches/);
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

  it("refuses an update step too — an update re-records from inside install.sh, after this gate", () => {
    sh(`"${helper}" --write`);
    fs.appendFileSync(path.join(project, "install.sh"), "\n# tampered\n");
    expect(sh(`"${dispatcher}" git_pull`).status).toBe(65);
    expect(ran()).toBe("");
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
    const block = libexecBlock()
      .replace(/\/usr\/local\/libexec\/clawbox/g, libexec)
      .replace(/\/usr\/local\/libexec(?!\/)/g, path.dirname(libexec))
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
    // The block installs from the project tree, so the real sources have to be
    // in it — this is exactly what a device copies.
    fs.copyFileSync(MANIFEST_SRC, path.join(project, "config", "clawbox-root-manifest.sh"));
    fs.copyFileSync(DISPATCHER_SRC, path.join(project, "config", "clawbox-root-step.sh"));
  });

  it("writes the manifest and installs the dispatcher", () => {
    const r = runBlock();
    expect(r.stdout + r.stderr).not.toMatch(/Warning/);
    expect(fs.existsSync(path.join(libexec, "clawbox-root-manifest.sh"))).toBe(true);
    expect(fs.existsSync(path.join(libexec, "clawbox-root-step.sh"))).toBe(true);
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
