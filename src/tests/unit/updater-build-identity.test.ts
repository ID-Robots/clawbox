import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

// The updater's step list is built from the running edition, and the module
// probes the device at import time. Nothing below starts an update or touches
// systemd: these tests exercise the three units of the WARN + AUTO-REPIN path
// against a throwaway git repo, exactly as the ruling describes them.
//
// Krasi's ruling (2026-08-24): a drifted box is NOT blocked at update time —
// the update proceeds, prints a clear warning, and re-pins to the tested
// commit as part of the run. Only the POST-update verification fails loudly.

const REPO_ROOT = path.resolve(__dirname, "../../..");

const HAS_GIT = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const d = HAS_GIT ? describe : describe.skip;

d("updater — build drift: warn, repin, verify", () => {
  let repo: string;
  let head: string;
  let mod: typeof import("@/lib/updater");

  function git(...args: string[]): string {
    return execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8" }).trim();
  }

  function writeBuildInfo(commit: string | null, buildId = "deployedbuild") {
    const dir = path.join(repo, ".next");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "BUILD_ID"), `${buildId}\n`);
    fs.writeFileSync(path.join(dir, "build-info.json"), JSON.stringify({
      commit,
      shortCommit: commit ? commit.slice(0, 7) : null,
      branch: "beta",
      dirty: false,
      committedAt: "2026-08-21T20:00:00Z",
      builtAt: "2026-08-21T20:09:03Z",
      buildId,
      node: "v22.0.0",
      bun: "1.2.10",
      packageVersion: "3.9.0",
      hermesPin: null,
      openclawPin: null,
    }, null, 2));
  }

  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-updater-drift-"));
    execFileSync("git", ["init", "-q", "-b", "beta", repo]);
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    fs.writeFileSync(path.join(repo, ".gitignore"), ".next/\n.update-branch\n");
    fs.writeFileSync(path.join(repo, "README.md"), "v1\n");
    git("add", "-A");
    git("commit", "-qm", "one");
    // The deliberate drift: HEAD moves on, the build below does not.
    fs.writeFileSync(path.join(repo, "README.md"), "v2\n");
    git("commit", "-qam", "two");
    head = git("rev-parse", "HEAD");
    mod = await import("@/lib/updater");
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  describe("collectDriftWarnings", () => {
    it("warns that the deployed build came from another commit", async () => {
      const stale = git("rev-parse", "HEAD~1");
      writeBuildInfo(stale);

      const warnings = await mod.collectDriftWarnings(repo);
      const drift = warnings.find((w) => w.code === "build-from-other-commit");

      expect(drift, `expected build drift in ${JSON.stringify(warnings)}`).toBeDefined();
      expect(drift!.message).toContain(stale.slice(0, 7));
      expect(drift!.message).toContain(head.slice(0, 7));
      // Plain language, per the deliverable — the owner is told what to do.
      expect(drift!.message).toContain("run Update to realign");
    });

    it("stays quiet when the build is the checkout and the box is pinned", async () => {
      writeBuildInfo(head);
      fs.writeFileSync(path.join(repo, ".update-branch"), "beta\n");
      // A pin whose origin ref this bare test repo cannot resolve reports
      // "unknown", not drift — an offline box must not shout.
      const warnings = await mod.collectDriftWarnings(repo);
      expect(warnings.map((w) => w.code)).toEqual([]);
    });

    it("notices a build with no identity at all", async () => {
      fs.mkdirSync(path.join(repo, ".next"), { recursive: true });
      fs.writeFileSync(path.join(repo, ".next", "BUILD_ID"), "legacybuild\n");
      fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
      fs.writeFileSync(path.join(repo, "scripts", "write-build-info.mjs"), "// stamper\n");
      fs.writeFileSync(path.join(repo, ".update-branch"), "beta\n");

      const warnings = await mod.collectDriftWarnings(repo);
      expect(warnings.map((w) => w.code)).toContain("build-unstamped");
    });

    it("never throws on a directory that is not a checkout", async () => {
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-not-a-repo-"));
      try {
        await expect(mod.collectDriftWarnings(empty)).resolves.toBeInstanceOf(Array);
      } finally {
        fs.rmSync(empty, { recursive: true, force: true });
      }
    });
  });

  describe("repinUpdateBranch (AUTO-REPIN)", () => {
    it("pins an unpinned box to the branch this update resolved", async () => {
      const warnings = await mod.repinUpdateBranch("beta", repo);

      expect(fs.readFileSync(path.join(repo, ".update-branch"), "utf-8").trim()).toBe("beta");
      expect(warnings.map((w) => w.code)).toEqual(["repinned"]);
      expect(warnings[0].message).toContain("beta");
    });

    it("leaves an operator's existing pin alone", async () => {
      fs.writeFileSync(path.join(repo, ".update-branch"), "qa/candidate\n");
      const warnings = await mod.repinUpdateBranch("beta", repo);

      expect(fs.readFileSync(path.join(repo, ".update-branch"), "utf-8").trim()).toBe("qa/candidate");
      expect(warnings).toEqual([]);
    });

    it("repairs a pin that git could never check out", async () => {
      fs.writeFileSync(path.join(repo, ".update-branch"), "--upload-pack=evil\n");
      const warnings = await mod.repinUpdateBranch("beta", repo);

      expect(fs.readFileSync(path.join(repo, ".update-branch"), "utf-8").trim()).toBe("beta");
      expect(warnings.map((w) => w.code)).toEqual(["repinned"]);
      expect(warnings[0].message).toContain("unusable");
    });

    it("refuses to write a branch name git would read as a flag", async () => {
      const warnings = await mod.repinUpdateBranch("--exec=rm -rf /", repo);

      expect(fs.existsSync(path.join(repo, ".update-branch"))).toBe(false);
      expect(warnings.map((w) => w.code)).toEqual(["repin-refused"]);
    });
  });

  describe("runBuildIdentityCheck (the one loud gate)", () => {
    beforeEach(() => {
      // The real script, not a copy of its logic — the whole point is that the
      // device and CI run the same file.
      fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
      fs.copyFileSync(
        path.join(REPO_ROOT, "scripts", "verify-build-identity.sh"),
        path.join(repo, "scripts", "verify-build-identity.sh"),
      );
    });

    it("passes when the build is the checkout", async () => {
      writeBuildInfo(head);
      const result = await mod.runBuildIdentityCheck(repo);
      expect(result.status).toBe("ok");
      expect(result.detail).toContain(head.slice(0, 7));
    });

    it("fails loudly when the rebuild produced someone else's commit", async () => {
      const stale = git("rev-parse", "HEAD~1");
      writeBuildInfo(stale);

      const result = await mod.runBuildIdentityCheck(repo);
      expect(result.status).toBe("failed");
      expect(result.detail).toContain(stale);
      expect(result.detail).toContain(head);
    });

    it("fails when the stamp describes assets other than the deployed ones", async () => {
      writeBuildInfo(head, "recordedbuild");
      fs.writeFileSync(path.join(repo, ".next", "BUILD_ID"), "someotherbuild\n");

      const result = await mod.runBuildIdentityCheck(repo);
      expect(result.status).toBe("failed");
      expect(result.detail).toContain("someotherbuild");
    });

    it("fails when the build carries no identity", async () => {
      fs.mkdirSync(path.join(repo, ".next"), { recursive: true });
      fs.writeFileSync(path.join(repo, ".next", "BUILD_ID"), "legacybuild\n");

      const result = await mod.runBuildIdentityCheck(repo);
      expect(result.status).toBe("failed");
      expect(result.detail).toContain("no build-info.json");
    });

    // Missing script ≠ verified. It must not silently pass as "ok".
    it("reports a missing verifier as skipped, not as a pass", async () => {
      fs.rmSync(path.join(repo, "scripts", "verify-build-identity.sh"), { force: true });
      const result = await mod.runBuildIdentityCheck(repo);
      expect(result.status).toBe("skipped");
    });
  });

  it("registers the verification as the last step of a real update", async () => {
    // Reading the shipped step list rather than re-declaring it: a step added
    // anywhere but the end would be verifying a build that is not yet deployed.
    const src = fs.readFileSync(path.join(REPO_ROOT, "src/lib/updater.ts"), "utf-8");
    const list = src.slice(src.indexOf("const UPDATE_STEPS"), src.indexOf("\n];", src.indexOf("const UPDATE_STEPS")));
    const ids = [...list.matchAll(/^\s{4}id: (?:"([a-z_]+)"|RESTART_STEP_ID),/gm)].map((m) => m[1] ?? "restart");

    expect(ids).toContain("verify_build_identity");
    expect(ids[ids.length - 1]).toBe("verify_build_identity");
    expect(ids.indexOf("verify_build_identity")).toBeGreaterThan(ids.indexOf("restart"));
  });
});
