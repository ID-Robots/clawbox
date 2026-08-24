import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { execFileSync, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * TASK-447 round 2, defect 2: "A detached HEAD with no pin silently retargets
 * the device to origin/main."
 *
 * `git symbolic-ref --short HEAD` FAILS on a detached HEAD — the state a
 * support engineer leaves behind with `git checkout <sha>`, and the state the
 * hardware pass was asked to create. Both resolvers swallowed that failure and
 * returned the module-level `main` default, after which the updater runs
 * `checkout main && reset --hard origin/main`: a beta device silently moved to
 * the fleet release channel, and PR #463's auto-repin then wrote "main" into
 * `.update-branch` so every future update went there too.
 *
 * Everything below runs against throwaway git repositories — no device, no
 * network, no systemd. `refs/remotes/origin/*` is written directly with
 * `update-ref`, which is exactly what a real clone's remote-tracking refs are.
 *
 * The TypeScript resolver (src/lib/updater.ts, the `restart` step) and the bash
 * one (install.sh, step 1 — the step that actually moves the tree first) are
 * both covered, because fixing only one of them fixes nothing.
 */

const REPO_ROOT = path.resolve(__dirname, "../../..");
const INSTALL_SH = fs.readFileSync(path.join(REPO_ROOT, "install.sh"), "utf-8");

const HAS_GIT = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
const HAS_BASH = process.platform !== "win32" && spawnSync("bash", ["-c", "true"], { stdio: "ignore" }).status === 0;
const d = HAS_GIT ? describe : describe.skip;
const db = HAS_GIT && HAS_BASH ? describe : describe.skip;

function extractShellFunction(name: string): string {
  const start = INSTALL_SH.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`${name} not found in install.sh`);
  const end = INSTALL_SH.indexOf("\n}", start);
  if (end < 0) throw new Error(`${name} has no closing brace`);
  return `${INSTALL_SH.slice(start, end)}\n}`;
}

let repo: string;

function git(...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8" }).trim();
}

/** A repo on `beta`, with origin/beta and origin/main as a real clone would have. */
function seedRepo(): void {
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  fs.writeFileSync(path.join(repo, ".gitignore"), ".next/\n.update-branch\n");
  fs.writeFileSync(path.join(repo, "README.md"), "one\n");
  git("add", "-A");
  git("commit", "-qm", "one");
  git("update-ref", "refs/remotes/origin/main", git("rev-parse", "HEAD"));
  git("checkout", "-qb", "beta");
  fs.writeFileSync(path.join(repo, "README.md"), "two\n");
  git("commit", "-qam", "two");
  git("update-ref", "refs/remotes/origin/beta", git("rev-parse", "HEAD"));
}

/** The deployed build's own stamp — evidence written on the device at build time. */
function writeBuildStamp(branch: string | null): void {
  const dir = path.join(repo, ".next");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "BUILD_ID"), "deployedbuild\n");
  fs.writeFileSync(
    path.join(dir, "build-info.json"),
    JSON.stringify({ commit: git("rev-parse", "HEAD"), branch, buildId: "deployedbuild" }, null, 2),
  );
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-branch-"));
  seedRepo();
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

d("resolveUpdateBranch (src/lib/updater.ts) — a detached HEAD is never main by default", () => {
  let mod: typeof import("@/lib/updater");

  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mod = await import("@/lib/updater");
  });

  it("recovers the branch from the deployed build's stamp", async () => {
    const sha = git("rev-parse", "HEAD");
    writeBuildStamp("beta");
    git("checkout", "-q", "--detach", sha);
    // The local `beta` branch still exists here, so this also pins the order:
    // the stamp is consulted first because it is the device's own record.

    const resolved = await mod.resolveUpdateBranch(repo);

    expect(resolved).toEqual({ local: "beta", upstream: "origin/beta", source: "detached-recovered" });
  });

  it("recovers from the branches that contain HEAD when there is no build stamp", async () => {
    git("checkout", "-q", "--detach", git("rev-parse", "HEAD"));

    const resolved = await mod.resolveUpdateBranch(repo);

    expect(resolved.local).toBe("beta");
    expect(resolved.upstream).toBe("origin/beta");
    expect(resolved.source).toBe("detached-recovered");
  });

  it("prefers the device's own branch over main when both contain HEAD", async () => {
    // The merge-base case: this commit is on main AND on beta. main must lose —
    // it is the release channel, and moving a beta box there is not an update.
    git("checkout", "-q", "--detach", git("rev-parse", "HEAD~1"));

    const resolved = await mod.resolveUpdateBranch(repo);

    expect(resolved.local).toBe("beta");
  });

  it("REFUSES the update when nothing on the device says which branch it belongs to", async () => {
    git("checkout", "-q", "--detach", git("rev-parse", "HEAD"));
    fs.writeFileSync(path.join(repo, "hotfix.txt"), "support engineer was here\n");
    git("add", "-A");
    git("commit", "-qm", "detached work no branch contains");

    await expect(mod.resolveUpdateBranch(repo)).rejects.toThrow(mod.UnresolvableUpdateBranchError);
    await expect(mod.resolveUpdateBranch(repo)).rejects.toThrow(/detached HEAD/i);
    // The whole point: it does not quietly answer "main".
    await expect(mod.resolveUpdateBranch(repo)).rejects.toThrow(/channel change, not an update/i);
  });

  it("still honours an explicit pin on a detached checkout", async () => {
    fs.writeFileSync(path.join(repo, ".update-branch"), "beta\n");
    git("checkout", "-q", "--detach", git("rev-parse", "HEAD"));

    expect(await mod.resolveUpdateBranch(repo)).toEqual({
      local: "beta", upstream: "origin/beta", source: "pin-file",
    });
  });

  it("uses the configured upstream when the branch still has one", async () => {
    git("config", "branch.beta.remote", "origin");
    git("config", "branch.beta.merge", "refs/heads/beta");

    expect(await mod.resolveUpdateBranch(repo)).toEqual({
      local: "beta", upstream: "origin/beta", source: "checkout-branch",
    });
  });

  it("keeps a re-cloned box on its own branch when the upstream LINK is gone", async () => {
    // A re-clone drops `branch.<name>.merge` even though the branch survives,
    // and rule 2 then fell through to main. seedRepo() leaves beta with no
    // upstream config at all, which is exactly that state.
    expect(spawnSync("git", ["-C", repo, "config", "--get", "branch.beta.merge"]).status).not.toBe(0);

    expect(await mod.resolveUpdateBranch(repo)).toEqual({
      local: "beta", upstream: "origin/beta", source: "checkout-branch",
    });
  });

  it("reports main as evidence, not as a fallback, when the box is on main", async () => {
    git("checkout", "-q", "main");

    expect(await mod.resolveUpdateBranch(repo)).toEqual({
      local: "main", upstream: "origin/main", source: "checkout-branch",
    });
  });
});

d("repinUpdateBranch — a pin is a record, so only evidence may be pinned", () => {
  let mod: typeof import("@/lib/updater");
  const pinFile = () => path.join(repo, ".update-branch");

  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mod = await import("@/lib/updater");
  });

  it("refuses to pin a branch that was only a fallback", async () => {
    const warnings = await mod.repinUpdateBranch("main", repo, "default");

    expect(warnings.map((w) => w.code)).toEqual(["repin-skipped"]);
    expect(fs.existsSync(pinFile())).toBe(false);
  });

  it("never pins main even when main IS the evidence", async () => {
    // main is already the fallback, so a pin changes nothing today and would
    // only freeze a device an operator later moves by hand — install.sh's
    // adoptable_checkout_branch has always applied the same rule.
    expect(await mod.repinUpdateBranch("main", repo, "checkout-branch")).toEqual([]);
    expect(fs.existsSync(pinFile())).toBe(false);
  });

  it("pins a branch recovered from a detached HEAD, so the next update needs no recovery", async () => {
    const warnings = await mod.repinUpdateBranch("beta", repo, "detached-recovered");

    expect(warnings.map((w) => w.code)).toEqual(["repinned"]);
    expect(fs.readFileSync(pinFile(), "utf-8").trim()).toBe("beta");
  });
});

db("resolve_update_branch (install.sh) — step 1 mirrors the same rules", () => {
  // Sourced verbatim so the test exercises the code that ships.
  const FNS = [
    extractShellFunction("is_safe_git_ref"),
    extractShellFunction("recover_detached_branch"),
    extractShellFunction("resolve_update_branch"),
  ].join("\n\n");

  function resolve(): { local: string; upstream: string; unresolved: string } {
    const script = `
set -uo pipefail
PROJECT_DIR="${repo}"
${FNS}
resolve_update_branch
printf 'LOCAL=%s\\nUPSTREAM=%s\\nUNRESOLVED=%s\\n' "$UPDATE_TARGET_LOCAL" "$UPDATE_TARGET_UPSTREAM" "$UPDATE_TARGET_UNRESOLVED"
`;
    const out = spawnSync("bash", ["-c", script], { encoding: "utf-8" });
    expect(out.status, out.stderr).toBe(0);
    const read = (key: string) => out.stdout.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1] ?? "";
    return { local: read("LOCAL"), upstream: read("UPSTREAM"), unresolved: read("UNRESOLVED") };
  }

  it("recovers the branch from the deployed build's stamp on a detached HEAD", () => {
    writeBuildStamp("beta");
    git("checkout", "-q", "--detach", git("rev-parse", "HEAD"));

    expect(resolve()).toEqual({ local: "beta", upstream: "origin/beta", unresolved: "0" });
  });

  it("recovers from the branches that contain HEAD when there is no stamp", () => {
    git("checkout", "-q", "--detach", git("rev-parse", "HEAD"));

    expect(resolve()).toEqual({ local: "beta", upstream: "origin/beta", unresolved: "0" });
  });

  it("flags the update as unresolvable instead of syncing to main", () => {
    git("checkout", "-q", "--detach", git("rev-parse", "HEAD"));
    fs.writeFileSync(path.join(repo, "hotfix.txt"), "support engineer was here\n");
    git("add", "-A");
    git("commit", "-qm", "detached work no branch contains");

    const resolved = resolve();
    expect(resolved.unresolved).toBe("1");
    expect(resolved.local).toBe("");
  });

  it("keeps a re-cloned box on its own branch when the upstream link is gone", () => {
    expect(resolve()).toEqual({ local: "beta", upstream: "origin/beta", unresolved: "0" });
  });

  it("still honours an explicit pin on a detached checkout", () => {
    fs.writeFileSync(path.join(repo, ".update-branch"), "beta\n");
    git("checkout", "-q", "--detach", git("rev-parse", "HEAD"));

    expect(resolve()).toEqual({ local: "beta", upstream: "origin/beta", unresolved: "0" });
  });

  it("both sync callers refuse an unresolved target rather than syncing", () => {
    // The refusal is only worth anything if the steps that move the tree check
    // it — step 1 (bootstrap_updater) is the one that moved it first.
    const bootstrap = extractShellFunction("step_bootstrap_updater");
    const gitPull = extractShellFunction("step_git_pull");
    for (const fn of [bootstrap, gitPull]) {
      // The check sits immediately after the resolution and before the sync.
      expect(fn).toMatch(
        /resolve_update_branch\n\s*\[ "\$\{UPDATE_TARGET_UNRESOLVED:-0\}" -eq 1 \] && refuse_unresolved_update_target/,
      );
      expect(fn.indexOf("refuse_unresolved_update_target"))
        .toBeLessThan(fn.lastIndexOf("sync_repo_to_update_target"));
    }
    expect(INSTALL_SH).toMatch(/refuse_unresolved_update_target\(\) \{[\s\S]*?exit 1/);
  });

  it("the top-of-file bootstrap block does not reset a detached checkout onto main", () => {
    // This block runs before every update step and does its own `reset --hard
    // origin/$_br`, so a `main` default there is the same retarget one screen
    // earlier.
    const block = INSTALL_SH.slice(
      INSTALL_SH.indexOf("if [ -z \"${CLAWBOX_INSTALL_BOOTSTRAPPED:-}\" ]"),
      INSTALL_SH.indexOf("# ── Constants ──"),
    );
    expect(block).not.toMatch(/_br="main"/);
    expect(block).toMatch(/build-info\.json/);
    expect(block).toMatch(/cannot tell which branch this checkout belongs to/);
  });
});
