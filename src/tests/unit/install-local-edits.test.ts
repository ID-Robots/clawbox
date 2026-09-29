import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { testEnv } from "@/tests/helpers/env";

/**
 * Local edits survive an update (TASK-1316).
 *
 * A customer's box showed "The code on disk has uncommitted changes" beside a
 * failed update. Once that update does run, every road through it hard-resets
 * the checkout — install.sh's bootstrap block, sync_repo_to_update_target (step
 * 1 and `--step git_pull`), then src/lib/updater.ts's own reset and clean — and
 * the owner's edits used to go with no trace and no word.
 *
 * Everything here runs the SHIPPED shell — scripts/preserve-local-edits.sh and
 * functions sliced out of install.sh — against throwaway git fixtures: a dirty
 * tree, untracked files, a detached HEAD, no `.update-branch`. Only what needs
 * root or the network is stubbed.
 */

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const REPO = path.resolve(__dirname, "../../..");
const INSTALL_SH = fs.readFileSync(path.join(REPO, "install.sh"), "utf-8");
const PRESERVE = path.join(REPO, "scripts", "preserve-local-edits.sh");

const CAN_RUN =
  process.platform !== "win32"
  && spawnSync("bash", ["-c", "true"], { stdio: "ignore" }).status === 0
  && spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
const d = CAN_RUN ? describe : describe.skip;

function fn(name: string): string {
  const start = INSTALL_SH.indexOf(`\n${name}() {`);
  if (start < 0) throw new Error(`${name} not found in install.sh`);
  const end = INSTALL_SH.indexOf("\n}", start + 1);
  return INSTALL_SH.slice(start + 1, end + 2);
}

let tmp: string;
let origin: string;
let checkout: string;
let saves: string;
let home: string;
let shims: string;

/** git in a fixture, with an identity and no global config leaking in. */
function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
    cwd,
    encoding: "utf-8",
    env: testEnv({ PATH: process.env.PATH ?? "", HOME: home, GIT_CONFIG_NOSYSTEM: "1" }),
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

beforeEach(() => {
  // realpath: the bootstrap block compares `pwd -P` against a literal path.
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-local-edits-")));
  home = path.join(tmp, "home");
  shims = path.join(tmp, "shims");
  fs.mkdirSync(home);
  fs.mkdirSync(shims);
  origin = path.join(tmp, "origin");
  checkout = path.join(tmp, "clawbox");
  saves = path.join(tmp, "clawbox-local-edits");
  if (!CAN_RUN) return;

  // The "release repository": main and beta, the shape of the real one.
  fs.mkdirSync(origin);
  git(origin, "init", "-q", "-b", "main");
  write(path.join(origin, ".gitignore"), "node_modules/\ndata/\n.update-branch\n");
  write(path.join(origin, "install.sh"), "#!/usr/bin/env bash\necho re-executed\n");
  write(path.join(origin, "scripts", "a.sh"), "echo a\n");
  write(path.join(origin, "config", "c.conf"), "one\n");
  write(path.join(origin, "src", "app.ts"), "export const v = 1;\n");
  git(origin, "add", "-A");
  git(origin, "commit", "-q", "-m", "release 1");
  git(origin, "checkout", "-q", "-b", "beta");
  write(path.join(origin, "src", "app.ts"), "export const v = 2;\n");
  git(origin, "commit", "-q", "-am", "beta 2");
  git(origin, "checkout", "-q", "main");

  git(tmp, "clone", "-q", "--branch", "beta", origin, checkout);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Give the checkout the edits an owner makes: tracked, staged, untracked, ignored. */
function dirty(): void {
  write(path.join(checkout, "src", "app.ts"), "export const v = 2; // tuned on the box\n");
  git(checkout, "rm", "-q", "--cached", "config/c.conf");
  fs.rmSync(path.join(checkout, "config", "c.conf"));
  write(path.join(checkout, "notes.md"), "my notes\n");
  write(path.join(checkout, "tools", "helper.sh"), "echo mine\n");
  // Ignored state the update must neither copy nor remove.
  write(path.join(checkout, "data", "config.json"), "{}\n");
  write(path.join(checkout, "node_modules", "x", "index.js"), "module.exports = 1;\n");
}

/** Advance origin/beta, so the update has somewhere to go. */
function release(): string {
  git(origin, "checkout", "-q", "beta");
  write(path.join(origin, "src", "app.ts"), "export const v = 3;\n");
  git(origin, "commit", "-q", "-am", "beta 3");
  git(origin, "checkout", "-q", "main");
  return git(origin, "rev-parse", "beta");
}

/** `git` that refuses `stash`, and an `id` that answers 0 — for the refusals. */
function shim(name: "git-no-stash" | "id-root"): void {
  if (name === "git-no-stash") {
    const real = spawnSync("bash", ["-c", "command -v git"], { encoding: "utf-8" }).stdout.trim();
    write(path.join(shims, "git"), `#!/usr/bin/env bash\nfor a in "$@"; do [ "$a" = stash ] && { echo "stash refused" >&2; exit 1; }; done\nexec ${real} "$@"\n`);
    fs.chmodSync(path.join(shims, "git"), 0o755);
  } else {
    const real = spawnSync("bash", ["-c", "command -v id"], { encoding: "utf-8" }).stdout.trim();
    write(path.join(shims, "id"), `#!/usr/bin/env bash\nif [ "$#" = 1 ] && [ "$1" = -u ]; then echo 0; exit 0; fi\nexec ${real} "$@"\n`);
    fs.chmodSync(path.join(shims, "id"), 0o755);
  }
}

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return testEnv({
    PATH: `${shims}:${process.env.PATH ?? ""}`,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    CLAWBOX_LOCAL_EDITS_DIR: saves,
    CLAWBOX_GIT_RETRIES: "1",
    ...extra,
  });
}

function savedDirs(): string[] {
  return fs.existsSync(saves) ? fs.readdirSync(saves).sort() : [];
}

/** step_bootstrap_updater as the in-app update's step 1 runs it, root and network stubbed. */
function runStep1(extra: Record<string, string> = {}): { status: number; out: string } {
  const script = [
    "set -euo pipefail",
    `PROJECT_DIR=${JSON.stringify(checkout)}`,
    // install.sh reads scripts/ out of $SRC_DIR — the root-owned mirror on a box.
    `SRC_DIR=${JSON.stringify(REPO)}`,
    "CLAWBOX_USER=clawbox",
    "ROOT_EXEC_TREE_RESYNCED=0",
    "chown() { :; }",
    "step_fix_git_perms() { :; }",
    "handover_legacy_updater() { :; }",
    "refresh_root_exec_manifest() { echo manifest-refreshed; }",
    'record_provision_failure() { echo "recorded $1"; }',
    fn("git_retryable_failure"),
    fn("git_with_retry"),
    fn("use_tree_owner_for_git"),
    fn("preserve_local_edits"),
    fn("is_safe_git_ref"),
    fn("recover_detached_branch"),
    fn("resolve_update_branch"),
    fn("refuse_unresolved_update_target"),
    fn("sync_repo_to_update_target"),
    fn("step_bootstrap_updater"),
    "step_bootstrap_updater",
  ].join("\n");
  const r = spawnSync("bash", ["-c", script], { encoding: "utf-8", env: env(extra) });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

d("sync_repo_to_update_target saves the owner's edits, then updates a clean tree", () => {
  it("updates a DETACHED HEAD with no .update-branch, and keeps every edit outside the tree", () => {
    git(checkout, "checkout", "-q", "--detach");
    expect(fs.existsSync(path.join(checkout, ".update-branch"))).toBe(false);
    const base = git(checkout, "rev-parse", "HEAD");
    dirty();
    const target = release();

    const r = runStep1();
    expect(r.status, r.out).toBe(0);
    // No pin, no branch: the target still resolves — to the branch this
    // checkout came from, never to main — and the update runs.
    expect(r.out).toContain("Refreshing updater files on branch 'beta'");
    expect(git(checkout, "rev-parse", "HEAD")).toBe(target);
    // ...on a clean tree: tracked edits reset, untracked files cleaned.
    expect(git(checkout, "status", "--porcelain")).toBe("");
    expect(fs.existsSync(path.join(checkout, "notes.md"))).toBe(false);
    // Ignored state is neither copied nor removed.
    expect(fs.readFileSync(path.join(checkout, "data", "config.json"), "utf-8")).toBe("{}\n");
    expect(fs.existsSync(path.join(checkout, "node_modules", "x", "index.js"))).toBe(true);

    // One dated save, outside the tree, and the owner is told where.
    const dirs = savedDirs();
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toMatch(/^\d{8}T\d{6}Z$/);
    const saved = path.join(saves, dirs[0]);
    expect(r.out).toMatch(/^CLAWBOX-WARN\[local-edits-saved\]: .*2 changed files, 2 new files/m);
    expect(r.out).toContain(saved);
    expect(fs.readFileSync(path.join(saved, "BASE"), "utf-8")).toContain(base);
    expect(fs.readFileSync(path.join(saved, "untracked", "notes.md"), "utf-8")).toBe("my notes\n");
    expect(fs.readFileSync(path.join(saved, "untracked", "tools", "helper.sh"), "utf-8")).toBe("echo mine\n");
    expect(fs.existsSync(path.join(saved, "untracked", "data"))).toBe(false);
    expect(fs.existsSync(path.join(saved, "untracked", "node_modules"))).toBe(false);
    expect(fs.readFileSync(path.join(saved, "README.txt"), "utf-8")).toContain("git apply --3way");
    // Private to the owner: an edit can be anything, a pasted key included.
    expect(fs.statSync(saved).mode & 0o077).toBe(0);

    // The patch is the edit: applied to the commit it was made on, it gives
    // the owner's tree back.
    git(checkout, "checkout", "-q", "--detach", base);
    git(checkout, "apply", path.join(saved, "tracked.patch"));
    expect(fs.readFileSync(path.join(checkout, "src", "app.ts"), "utf-8")).toBe("export const v = 2; // tuned on the box\n");
    expect(fs.existsSync(path.join(checkout, "config", "c.conf"))).toBe(false);
  });

  it("updates a named branch with no .update-branch", () => {
    dirty();
    const target = release();
    const r = runStep1();
    expect(r.status, r.out).toBe(0);
    expect(git(checkout, "rev-parse", "HEAD")).toBe(target);
    expect(git(checkout, "status", "--porcelain")).toBe("");
    expect(savedDirs()).toHaveLength(1);
  });

  it("saves nothing, and says nothing, over a clean tree", () => {
    const target = release();
    const r = runStep1();
    expect(r.status, r.out).toBe(0);
    expect(git(checkout, "rev-parse", "HEAD")).toBe(target);
    expect(r.out).not.toContain("CLAWBOX-WARN");
    expect(fs.existsSync(saves)).toBe(false);
  });

  it("falls back to the checkout's git stash when the copy cannot be written, and still updates", () => {
    dirty();
    const target = release();
    // A FILE where the save directory should go: mkdir fails, as on a full disk.
    fs.writeFileSync(saves, "not a directory");
    const r = runStep1();
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/^CLAWBOX-WARN\[local-edits-saved\]: .*git stash/m);
    expect(git(checkout, "rev-parse", "HEAD")).toBe(target);
    const stash = git(checkout, "stash", "list");
    expect(stash).toContain("clawbox-update");
    // The stash holds the untracked files too.
    expect(git(checkout, "show", "--name-only", "--format=", "stash@{0}^3")).toContain("notes.md");
  });

  it("refuses to reset edits it could not save anywhere, and leaves the tree exactly as it was", () => {
    dirty();
    release();
    const before = git(checkout, "rev-parse", "HEAD");
    fs.writeFileSync(saves, "not a directory");
    shim("git-no-stash");
    const r = runStep1();
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/^Error: this ClawBox has local changes to its code that could not be saved/m);
    expect(git(checkout, "rev-parse", "HEAD")).toBe(before);
    expect(fs.readFileSync(path.join(checkout, "src", "app.ts"), "utf-8")).toContain("tuned on the box");
    expect(fs.readFileSync(path.join(checkout, "notes.md"), "utf-8")).toBe("my notes\n");
  });

  it("saves before EVERY reset in the function, and cleans only after the reset to upstream", () => {
    const body = fn("sync_repo_to_update_target");
    const saveAt = body.indexOf("preserve_local_edits");
    expect(saveAt).toBeGreaterThan(-1);
    const resets = [...body.matchAll(/reset --hard/g)].map((m) => m.index ?? -1);
    expect(resets.length).toBeGreaterThanOrEqual(2);
    for (const at of resets) expect(saveAt).toBeLessThan(at);
    expect(body.indexOf("clean -fd")).toBeGreaterThan(Math.max(...resets));
    // step_git_pull (the full install) reaches the same function.
    expect(fn("step_git_pull")).toContain("sync_repo_to_update_target");
  });
});

d("the bootstrap block saves before ITS reset, the first one an update performs", () => {
  /**
   * The block at the top of install.sh, run for real: it fetches, resets the
   * checkout to origin/<branch> and re-execs. Retargeted onto the fixture by
   * replacing the two literal paths it names, exactly as
   * install-bootstrap-manifest.test.ts does; $_self is a stand-in "mirror"
   * holding scripts/preserve-local-edits.sh, as the root-owned one does.
   */
  function runBootstrap(): { status: number; out: string } {
    const start = INSTALL_SH.indexOf('_self="$(cd "$(dirname "${BASH_SOURCE[0]}")"');
    const end = INSTALL_SH.indexOf("# ── Constants");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const mirror = path.join(tmp, "mirror");
    fs.mkdirSync(path.join(mirror, "scripts"), { recursive: true });
    fs.copyFileSync(PRESERVE, path.join(mirror, "scripts", "preserve-local-edits.sh"));
    const block = INSTALL_SH.slice(start, end)
      .split("/var/lib/clawbox/root-exec-mirror").join(mirror)
      .split("/home/clawbox/clawbox").join(checkout)
      // Never the box's real manifest helper: this runner may BE a ClawBox.
      .split("/usr/local/libexec/clawbox/clawbox-root-manifest.sh").join(path.join(tmp, "no-such-helper"));
    const script = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      fn("git_retryable_failure"),
      fn("git_with_retry"),
      fn("use_tree_owner_for_git"),
      fn("preserve_local_edits"),
      fn("_clawbox_may_self_update"),
      block,
      'echo "after-bootstrap bootstrapped=${CLAWBOX_INSTALL_BOOTSTRAPPED:-no}"',
    ].join("\n");
    fs.writeFileSync(path.join(mirror, "install.sh"), script);
    const r = spawnSync("bash", [path.join(mirror, "install.sh")], { encoding: "utf-8", env: env() });
    return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  }

  it("saves the edits, then resets and re-execs", () => {
    dirty();
    const target = release();
    const r = runBootstrap();
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("CLAWBOX-WARN[local-edits-saved]");
    expect(r.out).toContain("after-bootstrap bootstrapped=1");
    expect(git(checkout, "rev-parse", "HEAD")).toBe(target);
    expect(savedDirs()).toHaveLength(1);
    const saved = path.join(saves, savedDirs()[0]);
    expect(fs.readFileSync(path.join(saved, "untracked", "notes.md"), "utf-8")).toBe("my notes\n");
  });

  it("does not reset at all when the edits cannot be saved", () => {
    dirty();
    release();
    const before = git(checkout, "rev-parse", "HEAD");
    fs.writeFileSync(saves, "not a directory");
    shim("git-no-stash");
    const r = runBootstrap();
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("local changes that could not be saved; not resetting it");
    expect(r.out).toContain("after-bootstrap bootstrapped=no");
    expect(git(checkout, "rev-parse", "HEAD")).toBe(before);
    expect(fs.readFileSync(path.join(checkout, "src", "app.ts"), "utf-8")).toContain("tuned on the box");
  });
});

d("scripts/preserve-local-edits.sh", () => {
  function preserve(extra: Record<string, string> = {}): { status: number; out: string } {
    const r = spawnSync("bash", [PRESERVE, checkout], { encoding: "utf-8", env: env(extra) });
    return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  }

  it("keeps only the newest saves, and touches nothing it did not write", () => {
    fs.mkdirSync(saves, { recursive: true });
    const old = ["20260101T000000Z", "20260102T000000Z", "20260103T000000Z", "20260104T000000Z", "20260105T000000Z-2"];
    for (const name of old) fs.mkdirSync(path.join(saves, name));
    fs.mkdirSync(path.join(saves, "keep-me"));
    fs.writeFileSync(path.join(saves, "20260100T000000Z"), "a file, not a save");
    dirty();
    const r = preserve({ CLAWBOX_LOCAL_EDITS_KEEP: "3" });
    expect(r.status, r.out).toBe(0);
    const left = savedDirs();
    expect(left).toContain("keep-me");
    expect(left).toContain("20260100T000000Z");
    const dated = left.filter((n) => /^\d{8}T\d{6}Z(-\d+)?$/.test(n) && fs.statSync(path.join(saves, n)).isDirectory());
    expect(dated).toHaveLength(3);
    expect(dated).toContain("20260104T000000Z");
    expect(dated).toContain("20260105T000000Z-2");
    expect(dated.some((n) => n.startsWith("2026010") === false)).toBe(true);
  });

  it("never runs as root over another account's tree", () => {
    shim("id-root");
    dirty();
    const r = preserve();
    expect(r.status).toBe(1);
    expect(r.out).toContain("refusing to run as root");
    expect(fs.existsSync(saves)).toBe(false);
  });

  it("copies a symlink as a symlink rather than following it out of the tree", () => {
    fs.symlinkSync("/etc/hostname", path.join(checkout, "link"));
    const r = preserve();
    expect(r.status, r.out).toBe(0);
    const copy = path.join(saves, savedDirs()[0], "untracked", "link");
    expect(fs.lstatSync(copy).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(copy)).toBe("/etc/hostname");
  });
});
