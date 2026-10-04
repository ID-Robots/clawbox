import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { testEnv } from "@/tests/helpers/env";

/**
 * A failed rebuild puts the checkout back on the served build's commit, from
 * the shell of the NEW code (TASK-1427).
 *
 * The in-app rollback lives in the dashboard, so an update driven by an older
 * dashboard never runs it. step_rebuild_reboot is the new code's own step, so
 * the rollback there works whichever build is serving. These run the shipped
 * functions, sliced out of install.sh, against a throwaway git fixture; only
 * do_rebuild and the root-side steps around it are stubbed.
 */

vi.setConfig({ testTimeout: 60_000 });

const REPO = path.resolve(__dirname, "../../..");
const INSTALL_SH = fs.readFileSync(path.join(REPO, "install.sh"), "utf-8");

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
let proj: string;
let oldSha: string;
let newSha: string;

function git(...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
    cwd: proj,
    encoding: "utf-8",
    env: testEnv({ PATH: process.env.PATH ?? "", HOME: tmp, GIT_CONFIG_NOSYSTEM: "1" }),
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function stamp(commit: string | null): void {
  const dir = path.join(proj, ".next", "standalone", ".next");
  fs.mkdirSync(dir, { recursive: true });
  const info: Record<string, unknown> = { shortCommit: commit?.slice(0, 7) ?? null, branch: "beta" };
  if (commit !== null) info.commit = commit;
  fs.writeFileSync(path.join(dir, "build-info.json"), `${JSON.stringify(info, null, 2)}\n`);
}

/** step_rebuild_reboot with the root-side steps stubbed and do_rebuild exiting `rebuildRc`. */
function runStep(rebuildRc: number, rebuildBody?: string): { status: number | null; out: string } {
  const script = [
    "set -euo pipefail",
    `PROJECT_DIR=${JSON.stringify(proj)}`,
    "as_clawbox() { \"$@\"; }",
    "is_test_mode() { return 0; }",
    "for s in step_directories_permissions step_systemd_services step_ollama_install step_openclaw_patch step_openclaw_config step_clawkeep_install step_polkit_rules; do eval \"$s() { :; }\"; done",
    "systemctl() { echo \"systemctl $*\"; }",
    rebuildBody ?? `do_rebuild() { echo do_rebuild; return ${rebuildRc}; }`,
    // The dispatcher's own EXIT trap, which the guard must chain to.
    "outer() { echo \"outer saw $?\"; }",
    "trap outer EXIT",
    "_REBUILD_PREV_EXIT_TRAP=\"\"",
    fn("_rebuild_trap_cmd"),
    fn("arm_rebuild_checkout_guard"),
    fn("disarm_rebuild_checkout_guard"),
    fn("rebuild_checkout_guard"),
    fn("restore_checkout_to_served_build"),
    fn("step_rebuild_reboot"),
    "step_rebuild_reboot",
  ].join("\n");
  const r = spawnSync("bash", ["-c", script], {
    encoding: "utf-8",
    env: testEnv({ PATH: process.env.PATH ?? "", HOME: tmp, GIT_CONFIG_NOSYSTEM: "1" }),
  });
  return { status: r.status, out: r.stdout + r.stderr };
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-1427-")));
  proj = path.join(tmp, "clawbox");
  if (!CAN_RUN) return;
  fs.mkdirSync(proj);
  git("init", "-q", "-b", "beta");
  fs.writeFileSync(path.join(proj, ".gitignore"), ".next/\n");
  fs.writeFileSync(path.join(proj, "app.txt"), "4.1\n");
  git("add", "-A");
  git("commit", "-q", "-m", "old");
  oldSha = git("rev-parse", "HEAD");
  fs.writeFileSync(path.join(proj, "app.txt"), "4.2\n");
  git("commit", "-q", "-am", "new");
  newSha = git("rev-parse", "HEAD");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

d("step_rebuild_reboot: checkout follows the served build on failure", () => {
  it("moves the checkout back to the restored build's commit and keeps the failure", () => {
    stamp(oldSha);
    const r = runStep(3);
    expect(r.status).toBe(3);
    expect(git("rev-parse", "HEAD")).toBe(oldSha);
    expect(git("symbolic-ref", "--short", "HEAD")).toBe("beta");
    expect(fs.readFileSync(path.join(proj, "app.txt"), "utf-8")).toBe("4.1\n");
    expect(r.out).not.toContain("systemctl restart");
    expect(r.out).toContain("outer saw 3");
  });

  it("keeps errexit live inside do_rebuild", () => {
    stamp(oldSha);
    const r = runStep(0, "do_rebuild() { false; echo AFTER-FALSE; }");
    expect(r.status).toBe(1);
    expect(r.out).not.toContain("AFTER-FALSE");
    expect(git("rev-parse", "HEAD")).toBe(oldSha);
  });

  it("works from a detached HEAD", () => {
    git("checkout", "-q", "--detach", newSha);
    stamp(oldSha);
    expect(runStep(1).status).toBe(1);
    expect(git("rev-parse", "HEAD")).toBe(oldSha);
  });

  it("leaves the checkout alone when the build succeeds", () => {
    stamp(oldSha);
    const r = runStep(0);
    expect(r.status).toBe(0);
    expect(git("rev-parse", "HEAD")).toBe(newSha);
    expect(r.out).toContain("systemctl restart clawbox-setup.service");
    expect(r.out).toContain("outer saw 0");
  });

  it("leaves the checkout alone when the served build has no commit stamp", () => {
    stamp(null);
    expect(runStep(1).status).toBe(1);
    expect(git("rev-parse", "HEAD")).toBe(newSha);
  });

  it("leaves the checkout alone when the stamped commit is not in the repository", () => {
    stamp("f".repeat(40));
    const r = runStep(1);
    expect(r.status).toBe(1);
    expect(git("rev-parse", "HEAD")).toBe(newSha);
    expect(r.out).toContain("is not in this checkout");
  });

  it("does nothing when HEAD already is the served build", () => {
    stamp(newSha);
    const r = runStep(1);
    expect(r.status).toBe(1);
    expect(git("rev-parse", "HEAD")).toBe(newSha);
    expect(r.out).not.toContain("Moving the checkout back");
  });
});
