import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { SELF_UPDATING_ROOT_STEPS, WEB_ROOT_STEPS } from "@/lib/root-steps";

/**
 * TASK-733 (deep-scan finding #12) — root must not execute a path the clawbox
 * user can write, and that includes the three steps the manifest verify cannot
 * cover.
 *
 * `config/clawbox-root-step.sh` exempts the self-updating family from the
 * manifest check, because an update legitimately rewrites the very files the
 * manifest records. Three of those steps — `bootstrap_updater`, `post_update`,
 * `rebuild_reboot` — are on WEB_ROOT_STEPS, i.e. the web server, the in-UI
 * terminal and the agent's shell can all start them through the NOPASSWD
 * launcher. Before this change they were exec'd straight out of
 * /home/clawbox/clawbox, which is clawbox:clawbox and which install.sh hands
 * back with `chown -R clawbox:clawbox` on every root run: write install.sh,
 * start the step, and the payload runs as root in one move.
 *
 * The fix is a ROOT-OWNED MIRROR of the same three paths the manifest covers
 * (install.sh, scripts/, config/). The dispatcher execs the mirror, never the
 * tree, and only ever restages the mirror from a tree that still matches the
 * root-owned record — so a rewritten tree is not something root can be made to
 * copy, let alone run.
 *
 * Like root-exec-manifest.test.ts, these tests drive the REAL shipped scripts
 * with their constants rewritten onto a temp tree.
 */

// Starts a real process (bash): vitest's 5 s test and 10 s hook defaults are not
// enough on a loaded CI runner. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const REPO = path.resolve(__dirname, "../../..");
const MANIFEST_SRC = path.join(REPO, "config", "clawbox-root-manifest.sh");
const DISPATCHER_SRC = path.join(REPO, "config", "clawbox-root-step.sh");

const CAN_RUN =
  process.platform !== "win32"
  && spawnSync("bash", ["-c", "true"], { stdio: "ignore" }).status === 0
  && spawnSync("sha256sum", ["--version"], { stdio: "ignore" }).status === 0;
const d = CAN_RUN ? describe : describe.skip;

/**
 * `install -o root -g root` is what the shipped scripts really run, and it
 * fails with EPERM for a normal user. Drop the ownership flags so the copy
 * still happens under a test runner; everything else is executed verbatim.
 */
const unroot = (text: string) => text.replace(/install (-d )?-o root -g root /g, "install $1");

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

let tmp: string;
let project: string;
let libexec: string;
let etc: string;
let manifest: string;
let helper: string;
let dispatcher: string;
let mirror: string;
let marker: string;

/** What the last dispatched step recorded: which copy of install.sh ran. */
const ran = () => (fs.existsSync(marker) ? fs.readFileSync(marker, "utf-8").trim() : "");

/**
 * A stand-in install.sh that reports WHERE it was run from. `$0` is the path
 * the dispatcher exec'd, which is the whole question this file asks.
 */
function stubInstall(tag: string): string {
  return [
    "#!/usr/bin/env bash",
    `printf '%s from=%s args=%s\\n' ${JSON.stringify(tag)} "$0" "$*" > "${marker}"`,
    "",
  ].join("\n");
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-mirror-"));
  project = path.join(tmp, "project");
  libexec = path.join(tmp, "libexec");
  etc = path.join(tmp, "etc");
  mirror = path.join(tmp, "mirror");
  manifest = path.join(etc, "root-exec.manifest");
  helper = path.join(libexec, "clawbox-root-manifest.sh");
  dispatcher = path.join(libexec, "clawbox-root-step.sh");
  marker = path.join(tmp, "ran");

  fs.mkdirSync(path.join(project, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(project, "config"), { recursive: true });
  fs.mkdirSync(libexec, { recursive: true });
  fs.mkdirSync(etc, { recursive: true });

  fs.writeFileSync(path.join(project, "install.sh"), stubInstall("tree"), { mode: 0o755 });
  fs.writeFileSync(path.join(project, "scripts", "start-ap.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(project, "config", "a.service"), "[Unit]\n");

  retarget(MANIFEST_SRC, helper, [
    [/^PROJECT_DIR=.*$/m, `PROJECT_DIR="${project}"`],
    [/^MANIFEST_DIR=.*$/m, `MANIFEST_DIR="${etc}"`],
    [/^MANIFEST_FILE=.*$/m, `MANIFEST_FILE="${manifest}"`],
    [/^MIRROR_DIR=.*$/m, `MIRROR_DIR="${mirror}"`],
  ]);
  retarget(DISPATCHER_SRC, dispatcher, [
    [/^PROJECT_DIR=.*$/m, `PROJECT_DIR="${project}"`],
    [/^MANIFEST_HELPER=.*$/m, `MANIFEST_HELPER="${helper}"`],
    [/^MIRROR_DIR=.*$/m, `MIRROR_DIR="${mirror}"`],
  ]);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** The exempt family the dispatcher itself names, read out of the shipped file. */
function shellList(name: string): string[] {
  const text = fs.readFileSync(DISPATCHER_SRC, "utf-8");
  const m = new RegExp(`^${name}="\\n([^"]*)"`, "m").exec(text);
  if (!m) throw new Error(`${name} not found in ${DISPATCHER_SRC}`);
  return m[1].split(/\s+/).filter(Boolean);
}

d("the root-owned mirror", () => {
  it("stages install.sh, scripts/ and config/ out of the clawbox user's reach", () => {
    expect(sh(`"${helper}" --write`).status).toBe(0);
    const r = sh(`"${helper}" --mirror`);
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readFileSync(path.join(mirror, "install.sh"), "utf-8"))
      .toBe(fs.readFileSync(path.join(project, "install.sh"), "utf-8"));
    expect(fs.existsSync(path.join(mirror, "scripts", "start-ap.sh"))).toBe(true);
    expect(fs.existsSync(path.join(mirror, "config", "a.service"))).toBe(true);
    // The exec bit survives — install.sh runs scripts/ out of here.
    expect(fs.statSync(path.join(mirror, "scripts", "start-ap.sh")).mode & 0o111).not.toBe(0);
  });

  it("covers exactly what the manifest covers, so neither can grow past the other", () => {
    // The one-place pin the whole design rests on: the mirror is built from
    // the same walk the record is, so a path added to COVERED_PATHS is mirrored
    // and a path that is mirrored is recorded.
    fs.mkdirSync(path.join(project, "data"), { recursive: true });
    fs.writeFileSync(path.join(project, "data", "config.json"), "{}\n");
    fs.mkdirSync(path.join(project, "scripts", "__pycache__"), { recursive: true });
    fs.writeFileSync(path.join(project, "scripts", "__pycache__", "x.pyc"), "junk");
    sh(`"${helper}" --write`);
    expect(sh(`"${helper}" --mirror`).status).toBe(0);
    const recorded = fs.readFileSync(manifest, "utf-8")
      .split("\n").filter(Boolean).map((l) => l.replace(/^\S+\s+\*?/, "")).sort();
    const mirrored = sh(`cd "${mirror}" && find . -type f -printf '%P\\n' | sort`)
      .stdout.split("\n").filter(Boolean).sort();
    expect(mirrored).toEqual(recorded);
    // ...and the runtime state the app writes is in neither.
    expect(mirrored.some((f) => f.startsWith("data/"))).toBe(false);
    expect(mirrored.some((f) => f.includes("__pycache__"))).toBe(false);
  });

  it("refuses to install a copy the tree changed under it", () => {
    // The window the post-copy check closes, and the reason the mirror is not
    // simply "cp the tree": `--verify` is asked about $PROJECT_DIR and the
    // answer is stale the instant it returns. The staging directory appearing
    // under a world-readable /var/lib/clawbox is itself the starting gun — a
    // poller that renames a payload over install.sh once it sees
    // $MIRROR_DIR.new lands those bytes in the root-owned copy the dispatcher
    // then execs for three NOPASSWD-startable steps.
    //
    // Simulated the way the sibling suite simulates the same race: the copy is
    // let through and the RECORD is what disagrees with it, which is the
    // identical mismatch a mid-copy swap produces.
    sh(`"${helper}" --write`);
    expect(sh(`"${helper}" --mirror`).status, "the healthy stage failed").toBe(0);
    const before = fs.readFileSync(path.join(mirror, "install.sh"), "utf-8");

    fs.writeFileSync(path.join(project, "install.sh"), stubInstall("PAYLOAD"), { mode: 0o755 });
    const r = sh(`"${helper}" --mirror`);
    expect(r.status, "a tree that no longer matches the record was mirrored anyway").not.toBe(0);
    expect(r.stderr).toMatch(/changed while it was being mirrored/);
    // The PREVIOUS mirror is left standing — a previous root-established build
    // is the right answer, and refusing outright would strand the box.
    expect(fs.readFileSync(path.join(mirror, "install.sh"), "utf-8")).toBe(before);
    // ...and nothing half-built is left where the dispatcher could find it.
    expect(fs.existsSync(`${mirror}.new`), "staging litter survived the refusal").toBe(false);
  });

  it("puts back a mirror an interrupted swap left aside, for mirror_tree's own callers", () => {
    // This case covers `mirror_tree`'s OWN callers only — install.sh's operator
    // repair (`--step systemd_services`) and a flash-host run, neither of which
    // goes through the dispatcher. It calls `--mirror` directly over a tree that
    // no longer verifies, which no caller does; the dispatch path is the case
    // below, and it is the one that actually strands a box.
    //
    // The swap is two renames, and between them $MIRROR_DIR does not exist and
    // $MIRROR_DIR.old holds the only root-established build. A power cut there
    // is not exotic: `rebuild_reboot` reboots the box, and an update is when
    // this function runs. The next restage used to open with
    // `rm -rf "$staging" "$previous"` — destroying that only copy — and if the
    // tree no longer verified (which is exactly the state an update in flight
    // leaves it in) the staging was thrown away too. The box then refuses EVERY
    // root step, including the two that would let it finish the update and heal
    // itself, with a perfectly good mirror one rename away and no console to
    // repair it from.
    sh(`"${helper}" --write`);
    expect(sh(`"${helper}" --mirror`).status, "the healthy stage failed").toBe(0);
    const good = fs.readFileSync(path.join(mirror, "install.sh"), "utf-8");

    fs.renameSync(mirror, `${mirror}.old`);          // killed between the renames
    fs.writeFileSync(path.join(project, "install.sh"), stubInstall("PAYLOAD"), { mode: 0o755 });

    const r = sh(`"${helper}" --mirror`);
    expect(r.status, "a tree that no longer matches the record was mirrored anyway").not.toBe(0);
    expect(fs.existsSync(path.join(mirror, "install.sh")), "the only good mirror was deleted").toBe(true);
    expect(fs.readFileSync(path.join(mirror, "install.sh"), "utf-8")).toBe(good);
    expect(fs.existsSync(`${mirror}.old`), "the aside copy was left to be found again").toBe(false);

    // ...and the customer-visible half: root steps still run, out of the
    // previous root-established build, rather than the box refusing all of them.
    const d2 = sh(`"${dispatcher}" post_update`);
    expect(d2.status, d2.stderr).toBe(0);
    expect(ran()).toBe(`tree from=${path.join(mirror, "install.sh")} args=--step post_update`);
  });

  it("refuses rather than clear the aside copy when it cannot be put back", () => {
    // The restore is `mv -T "$previous" "$MIRROR_DIR"`, and the line after it is
    // `rm -rf "$staging" "$previous"`. If the rename fails, tolerating it throws
    // away the only usable mirror on the very next line — the defect the restore
    // exists to prevent, reached through the restore itself. A non-directory
    // sitting at $MIRROR_DIR is enough to make `mv -T` fail that way.
    sh(`"${helper}" --write`);
    expect(sh(`"${helper}" --mirror`).status, "the healthy stage failed").toBe(0);
    const good = fs.readFileSync(path.join(mirror, "install.sh"), "utf-8");

    fs.renameSync(mirror, `${mirror}.old`);          // killed between the renames
    fs.writeFileSync(mirror, "not a directory\n");   // ...and something is in the way

    const r = sh(`"${helper}" --mirror`);
    expect(r.status, "the restage carried on over a mirror it could not put back").not.toBe(0);
    expect(fs.existsSync(`${mirror}.old`), "the only usable mirror was deleted anyway").toBe(true);
    expect(fs.readFileSync(path.join(`${mirror}.old`, "install.sh"), "utf-8")).toBe(good);
    expect(r.stderr).toMatch(/cannot put back the mirror/);
  });

  it("recovers an interrupted swap on the dispatch path too, where nothing calls --mirror", () => {
    // The sibling of the case above, and the one that actually strands a box.
    // The helper only recovers $MIRROR_DIR.old when something asks it to restage
    // — and the dispatch that meets an interrupted swap is precisely the one
    // whose tree does NOT verify (an update in flight resets and cleans the tree
    // before it is re-recorded), which is the branch that never calls `--mirror`
    // at all. So the dispatcher has to put the copy back itself, before it
    // decides there is nothing to run. Both directories are root-owned under
    // root-owned directories, so this moves bytes root already vouched for.
    sh(`"${helper}" --write`);
    expect(sh(`"${helper}" --mirror`).status, "the healthy stage failed").toBe(0);
    const good = fs.readFileSync(path.join(mirror, "install.sh"), "utf-8");

    fs.renameSync(mirror, `${mirror}.old`);          // killed between the renames
    fs.writeFileSync(path.join(project, "install.sh"), stubInstall("PAYLOAD"), { mode: 0o755 });
    fs.rmSync(marker, { force: true });

    const r = sh(`"${dispatcher}" post_update`);
    expect(r.status, `the box refused every root step: ${r.stderr}`).toBe(0);
    expect(ran(), "root did not run the recovered mirror").toBe(
      `tree from=${path.join(mirror, "install.sh")} args=--step post_update`,
    );
    expect(fs.readFileSync(path.join(mirror, "install.sh"), "utf-8")).toBe(good);
  });

  it("restages in the very dispatch that recovered, so the lock is not still held", () => {
    // The subshell around the dispatcher's recovery. mirror_tree opens its own
    // fd on $MIRROR_DIR.lock in a CHILD process, so a dispatcher that recovered
    // while still holding that lock on its own fd would send `--mirror` into
    // `flock -w 120` and then into `die "another root step is restaging"` — a
    // deadlock this script inflicted on itself, on every dispatch that recovers.
    // Here the tree still verifies, so one dispatch does both things in order.
    sh(`"${helper}" --write`);
    expect(sh(`"${helper}" --mirror`).status, "the healthy stage failed").toBe(0);
    fs.renameSync(mirror, `${mirror}.old`);
    fs.rmSync(marker, { force: true });

    const started = Date.now();
    const r = sh(`"${dispatcher}" post_update`);
    expect(Date.now() - started, "the restage blocked on a lock the recovery never released").toBeLessThan(20_000);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/recovered .*interrupted/);
    expect(fs.existsSync(`${mirror}.old`), "the restage that follows the recovery did not run").toBe(false);
    expect(ran()).toBe(`tree from=${path.join(mirror, "install.sh")} args=--step post_update`);
  });

  it("waits for a restage in flight instead of resurrecting the copy it moved aside", () => {
    // The recovery fires in exactly the window mirror_tree is in between its two
    // renames, so without the lock it races the function it is recovering from:
    // it would put $MIRROR_DIR.old back, the restage's own `mv -T` would then
    // fail with ENOTEMPTY, its rollback would find no $previous, and it would
    // die — leaving the box running the PREVIOUS build with the verified new
    // staging orphaned, while the updater reports success.
    sh(`"${helper}" --write`);
    expect(sh(`"${helper}" --mirror`).status, "the healthy stage failed").toBe(0);
    fs.renameSync(mirror, `${mirror}.old`);          // mid-swap, lock held below

    // The wait for the holder is BOUNDED and its outcome checked: `sh` has no
    // spawnSync timeout, so an environment without `flock` would leave the
    // sentinel absent and spin until this file's 30 s vitest timeout, failing as
    // an opaque timeout instead of saying what was missing.
    const held = path.join(tmp, "held");
    const setup = sh([
      `command -v flock >/dev/null || { echo NO-FLOCK; exit 0; }`,
      `flock "${mirror}.lock" -c 'touch "${held}"; sleep 3' >/dev/null 2>&1 &`,
      `for _ in $(seq 1 100); do [ -f "${held}" ] && break; sleep 0.05; done`,
      `[ -f "${held}" ] || { echo HOLDER-NEVER-STARTED; exit 0; }`,
      `timeout 1 "${dispatcher}" post_update >/dev/null 2>&1`,
      `echo DISPATCHED`,
    ].join("\n"));
    expect(setup.stdout.trim(), `lock holder setup failed: ${setup.stdout}${setup.stderr}`)
      .toContain("DISPATCHED");

    expect(fs.existsSync(`${mirror}.old`), "the copy a restage in flight had moved aside was taken").toBe(true);
    expect(fs.existsSync(mirror), "the mirror was resurrected under a live restage").toBe(false);
  });

  it("replaces the previous mirror rather than merging into it", () => {
    // Not probe-once, and not additive: a file dropped from the tree has to
    // disappear from the copy root runs, or root keeps executing code that no
    // longer ships.
    sh(`"${helper}" --write`);
    sh(`"${helper}" --mirror`);
    expect(fs.existsSync(path.join(mirror, "scripts", "start-ap.sh"))).toBe(true);
    fs.rmSync(path.join(project, "scripts", "start-ap.sh"));
    sh(`"${helper}" --write`);
    expect(sh(`"${helper}" --mirror`).status).toBe(0);
    expect(fs.existsSync(path.join(mirror, "scripts", "start-ap.sh"))).toBe(false);
  });

  it("names its own location, so nothing has to guess where root reads from", () => {
    const r = sh(`"${helper}" --mirror-path`);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(mirror);
  });

  it("is the same path in every file that names it", () => {
    // Three separately installed root-owned files carry it as a literal — the
    // helper, the dispatcher, and install.sh's bootstrap block, which runs
    // before its own constants are parsed. Same reason SELFTEST_TOKEN is
    // repeated, same pin.
    const literal = (file: string, re: RegExp) => {
      const m = re.exec(fs.readFileSync(path.join(REPO, file), "utf-8"));
      if (!m) throw new Error(`mirror path not found in ${file}`);
      return m[1];
    };
    const fromHelper = literal("config/clawbox-root-manifest.sh", /^MIRROR_DIR="([^"]+)"/m);
    expect(fromHelper).toBe("/var/lib/clawbox/root-exec-mirror");
    expect(literal("config/clawbox-root-step.sh", /^MIRROR_DIR="([^"]+)"/m)).toBe(fromHelper);
    expect(literal("install.sh", /\[ "\$_self" = "([^"]+)" \]/)).toBe(fromHelper);
  });
});

d("clawbox-root-step.sh — the exempt family", () => {
  it("never execs the tree for a step the web server can start", () => {
    // THE FINDING. A foothold with clawbox-level code execution rewrites
    // install.sh and starts one of the three exempt steps the sudo launcher
    // grants. Root must run its own copy, and the payload must never run.
    sh(`"${helper}" --write`);
    // First a healthy dispatch, so the mirror holds the real code.
    expect(sh(`"${dispatcher}" post_update`).status, "the healthy dispatch failed").toBe(0);
    expect(ran()).toContain("tree from=");

    fs.writeFileSync(path.join(project, "install.sh"), stubInstall("PAYLOAD"), { mode: 0o755 });
    for (const step of ["bootstrap_updater", "post_update", "rebuild_reboot"]) {
      expect(WEB_ROOT_STEPS, `${step} is no longer web-startable`).toContain(step);
      fs.rmSync(marker, { force: true });
      const r = sh(`"${dispatcher}" ${step}`);
      expect(r.status, `${step}: ${r.stderr}`).toBe(0);
      expect(ran(), `root ran the rewritten tree for ${step}`).not.toContain("PAYLOAD");
      expect(ran(), `${step} did not run from the mirror`).toContain(`from=${path.join(mirror, "install.sh")}`);
    }
  });

  it("runs every self-updating step from the mirror, so a new one cannot skip it", () => {
    // The guard the card asks for: adding a name to SELF_UPDATING_STEPS without
    // routing it through the mirror re-opens the finding, and this fails.
    const exempt = shellList("SELF_UPDATING_STEPS");
    expect([...exempt].sort()).toEqual([...SELF_UPDATING_ROOT_STEPS].sort());
    sh(`"${helper}" --write`);
    sh(`"${dispatcher}" post_update`);
    fs.writeFileSync(path.join(project, "install.sh"), stubInstall("PAYLOAD"), { mode: 0o755 });
    for (const step of exempt) {
      fs.rmSync(marker, { force: true });
      const r = sh(`"${dispatcher}" ${step}`);
      expect(r.status, `${step}: ${r.stderr}`).toBe(0);
      expect(ran(), `${step} ran the clawbox-writable tree`).toBe(
        `tree from=${path.join(mirror, "install.sh")} args=--step ${step}`,
      );
    }
  });

  it("still lets the update family self-update, from the copy root holds", () => {
    sh(`"${helper}" --write`);
    const r = sh(`"${dispatcher}" git_pull`);
    expect(r.status, r.stderr).toBe(0);
    expect(ran()).toContain("--step git_pull");
  });

  it("restages the mirror whenever the tree still matches the record", () => {
    // Not probe-once: the mirror is refreshed on EVERY dispatch whose tree
    // verifies, so an update that legitimately replaced the tree — and
    // re-recorded it — is what root runs on the next step, not the build
    // before it.
    sh(`"${helper}" --write`);
    sh(`"${dispatcher}" post_update`);
    fs.writeFileSync(path.join(project, "install.sh"), stubInstall("second"), { mode: 0o755 });
    sh(`"${helper}" --write`);
    fs.rmSync(marker, { force: true });
    expect(sh(`"${dispatcher}" post_update`).status).toBe(0);
    expect(ran()).toContain("second from=");
  });

  it("refuses when there is no mirror and the tree cannot be vouched for", () => {
    // Fail CLOSED, and say what repairs it. The alternative — falling back to
    // the tree — is the finding with an extra step.
    sh(`"${helper}" --write`);
    fs.writeFileSync(path.join(project, "install.sh"), stubInstall("PAYLOAD"), { mode: 0o755 });
    const r = sh(`"${dispatcher}" post_update`);
    expect(r.status).toBe(65);
    expect(ran()).toBe("");
    expect(r.stderr).toContain(`sudo bash ${path.join(project, "install.sh")} --step systemd_services`);
  });

  it("fails closed for an exempt step when the verifier does nothing", () => {
    // The same fail-open the pinned family already guards: a 0-byte helper
    // answers every verb with 0, so `--mirror` would "succeed" without copying
    // anything and root would exec whatever was left at the mirror path.
    sh(`"${helper}" --write`);
    sh(`"${dispatcher}" post_update`);
    fs.writeFileSync(helper, "", { mode: 0o755 });
    fs.rmSync(marker, { force: true });
    const r = sh(`"${dispatcher}" post_update`);
    expect(r.status, "a stub verifier let an exempt step through").toBe(65);
    expect(ran()).toBe("");
  });
});

/** Lift one function out of install.sh, so the code under test is the real one. */
function shellFn(name: string): string {
  const text = fs.readFileSync(path.join(REPO, "install.sh"), "utf-8");
  const start = text.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`${name} not found in install.sh`);
  const end = text.indexOf("\n}", start);
  if (end < 0) throw new Error(`${name} has no closing brace`);
  return text.slice(start, end + 2);
}

d("install.sh::root_exec_may_anchor — who may re-record what root runs", () => {
  /** Whether the tree still matches the record is set up by each test. */
  function anchor(opts: { fromTree: boolean; resynced: boolean }) {
    return sh([
      "set -uo pipefail",
      `PROJECT_DIR=${JSON.stringify(project)}`,
      `SRC_DIR=${JSON.stringify(opts.fromTree ? project : mirror)}`,
      `ROOT_EXEC_TREE_RESYNCED=${opts.resynced ? 1 : 0}`,
      `ROOT_EXEC_MANIFEST_HELPER=${JSON.stringify(helper)}`,
      shellFn("root_exec_may_anchor"),
      'if root_exec_may_anchor; then echo ANCHOR-ALLOWED; else echo ANCHOR-REFUSED; fi',
    ].join("\n")).stdout.trim();
  }

  it("refuses to re-anchor on a tree nobody can vouch for", () => {
    // THE gate. install.sh running out of the root-owned mirror is the shape
    // every dispatched step has, and `post_update` -> step_systemd_services ->
    // install_root_libexec is web-startable: without this, a foothold rewrites
    // the tree, starts post_update, and root records AND MIRRORS its file —
    // TASK-733 restored through the back door.
    sh(`"${helper}" --write`);
    fs.writeFileSync(path.join(project, "install.sh"), stubInstall("PAYLOAD"), { mode: 0o755 });
    expect(anchor({ fromTree: false, resynced: false })).toBe("ANCHOR-REFUSED");
  });

  it("allows it when this run put the code there itself", () => {
    sh(`"${helper}" --write`);
    fs.writeFileSync(path.join(project, "install.sh"), stubInstall("PAYLOAD"), { mode: 0o755 });
    expect(anchor({ fromTree: false, resynced: true })).toBe("ANCHOR-ALLOWED");
  });

  it("allows it when install.sh is itself running out of the tree", () => {
    // An operator's `sudo bash install.sh`, the flash host, the one-time
    // transition: root already execs that tree, so recording it grants nothing.
    sh(`"${helper}" --write`);
    fs.writeFileSync(path.join(project, "install.sh"), stubInstall("PAYLOAD"), { mode: 0o755 });
    expect(anchor({ fromTree: true, resynced: false })).toBe("ANCHOR-ALLOWED");
  });

  it("refuses even over a tree that still matches — there is nothing to re-record", () => {
    // A tree that matches is not a licence to re-record it; it is the reason no
    // record needs writing at all. write_root_exec_manifest below brings such a
    // record forward without a second walk, which is what closes the window
    // between this gate returning and the walk that fills the record.
    sh(`"${helper}" --write`);
    expect(anchor({ fromTree: false, resynced: false })).toBe("ANCHOR-REFUSED");
  });
});

d("install.sh::write_root_exec_manifest — the record is never re-walked on a hunch", () => {
  /** Verbs the helper under test was asked for, in order. */
  const verbs = () => (fs.existsSync(`${tmp}/verbs`)
    ? fs.readFileSync(`${tmp}/verbs`, "utf-8").trim().split("\n").filter(Boolean)
    : []);

  /**
   * Drive the real function against a WRAPPER around the real helper: it logs
   * the verbs, and can rewrite the tree at the instant the record-writing walk
   * starts. That stands in for a foothold's poller winning the window between
   * the gate's answer and the bytes that reach the record — the same way the
   * suite above simulates the mid-copy race, because a real race would make the
   * test flaky rather than the defect absent.
   */
  function writeManifest(opts: { fromTree: boolean; resynced: boolean; poisonOnWrite?: boolean }) {
    const wrapper = path.join(tmp, "wrapper.sh");
    fs.writeFileSync(wrapper, [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$1" >> ${JSON.stringify(`${tmp}/verbs`)}`,
      ...(opts.poisonOnWrite
        ? [
          `if [ "$1" = "--write" ]; then`,
          `  cat > ${JSON.stringify(path.join(project, "install.sh"))} <<'PAYLOAD_EOF'`,
          stubInstall("PAYLOAD"),
          "PAYLOAD_EOF",
          `  chmod 0755 ${JSON.stringify(path.join(project, "install.sh"))}`,
          "fi",
        ]
        : []),
      `exec ${JSON.stringify(helper)} "$@"`,
      "",
    ].join("\n"), { mode: 0o755 });

    const r = sh([
      "set -uo pipefail",
      `PROJECT_DIR=${JSON.stringify(project)}`,
      `SRC_DIR=${JSON.stringify(opts.fromTree ? project : mirror)}`,
      `ROOT_EXEC_TREE_RESYNCED=${opts.resynced ? 1 : 0}`,
      `ROOT_EXEC_MANIFEST_HELPER=${JSON.stringify(wrapper)}`,
      "clear_provision_failure() { :; }",
      shellFn("root_exec_manifest_helper_alive"),
      shellFn("root_exec_may_anchor"),
      shellFn("root_exec_helper_knows_mirror"),
      shellFn("write_root_exec_manifest"),
      "if write_root_exec_manifest; then echo WRITE=ok; else echo WRITE=failed; fi",
    ].join("\n"));
    return { out: `${r.stdout}${r.stderr}`, verdict: /WRITE=(\w+)/.exec(r.stdout)?.[1] ?? "" };
  }

  it("brings a matching record forward without re-walking the tree", () => {
    // M-1. The old third clause of root_exec_may_anchor asked `--verify` about
    // $PROJECT_DIR and the answer was stale the instant it returned; `--write`
    // then walked the tree AGAIN and recorded whatever was there by then. A
    // foothold that restores the tree, starts post_update (→ install_root_libexec
    // → here, where SRC_DIR is the mirror and nothing was resynced, so that
    // clause is the one that decided) and swaps install.sh between the two walks
    // got its bytes into the record — and from the record into the mirror, whose
    // staged-copy check compares against that same poisoned record.
    sh(`"${helper}" --write`);
    expect(sh(`"${helper}" --mirror`).status, "the healthy stage failed").toBe(0);
    const benign = fs.readFileSync(path.join(mirror, "install.sh"), "utf-8");

    const r = writeManifest({ fromTree: false, resynced: false, poisonOnWrite: true });
    expect(r.verdict, r.out).toBe("ok");
    expect(verbs(), "the record was re-walked over a tree this run did not put there").not.toContain("--write");
    expect(
      fs.readFileSync(path.join(mirror, "install.sh"), "utf-8"),
      "a payload swapped in mid-record reached the copy root execs",
    ).toBe(benign);
  });

  it("still refuses when the record does not describe the tree", () => {
    sh(`"${helper}" --write`);
    fs.writeFileSync(path.join(project, "install.sh"), stubInstall("PAYLOAD"), { mode: 0o755 });
    const r = writeManifest({ fromTree: false, resynced: false });
    expect(r.verdict).toBe("failed");
    expect(r.out).toContain("refusing to re-record the root-exec manifest");
    expect(verbs()).not.toContain("--write");
  });

  it("still re-records at the two moments that may anchor", () => {
    // The gate must not have been turned into "never write": an update that has
    // just reset the tree, and an operator running install.sh out of it, are
    // exactly when the record has to be rewritten — including the very first
    // time, when there is no record to bring forward at all.
    for (const opts of [{ fromTree: false, resynced: true }, { fromTree: true, resynced: false }]) {
      fs.rmSync(`${tmp}/verbs`, { force: true });
      fs.rmSync(manifest, { force: true });
      const r = writeManifest(opts);
      expect(r.verdict, r.out).toBe("ok");
      expect(verbs(), JSON.stringify(opts)).toContain("--write");
      expect(fs.existsSync(path.join(mirror, "install.sh"))).toBe(true);
    }
  });
});

d("clawbox-root-step.sh — the pinned family keeps its guarantees", () => {
  it("runs the pinned steps from the mirror too", () => {
    // The residual the old dispatcher recorded rather than closed: it staged
    // ONE file, and the scripts install.sh goes on to run as root were opened
    // later, out of the tree. The mirror covers them.
    sh(`"${helper}" --write`);
    const r = sh(`"${dispatcher}" chpasswd`);
    expect(r.status, r.stderr).toBe(0);
    expect(ran()).toBe(`tree from=${path.join(mirror, "install.sh")} args=--step chpasswd`);
    expect(fs.existsSync(path.join(mirror, "scripts", "start-ap.sh"))).toBe(true);
  });

  it("still refuses a pinned step once the tree stops matching its record", () => {
    sh(`"${helper}" --write`);
    sh(`"${dispatcher}" chpasswd`);
    fs.rmSync(marker, { force: true });
    fs.writeFileSync(path.join(project, "install.sh"), stubInstall("PAYLOAD"), { mode: 0o755 });
    const r = sh(`"${dispatcher}" chpasswd`);
    expect(r.status).toBe(65);
    expect(r.stderr).toMatch(/does not match the root-exec manifest/);
    expect(ran()).toBe("");
  });

  it("still pins a password change to the on-disk copy — no git, no network", () => {
    sh(`"${helper}" --write`);
    expect(sh(`"${dispatcher}" chpasswd`).status).toBe(0);
    // The stub reports argv only; the pinning env is asserted in
    // root-exec-manifest.test.ts against the same dispatcher.
    expect(ran()).toContain("--step chpasswd");
  });
});
