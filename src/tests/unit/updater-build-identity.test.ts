import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

// Starts a real process (bash / python3 / node / git): vitest's 5 s test and
// 10 s hook defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// The updater's step list is built from the running edition, and the module
// probes the device at import time. Nothing below starts an update or touches
// systemd: these tests exercise the two units of the WARN + AUTO-REPIN path
// against a throwaway git repo, exactly as the ruling describes them.
//
// Krasi's ruling (2026-08-24): a drifted box is NOT blocked at update time —
// the update proceeds, prints a clear warning, and re-pins to the tested
// commit as part of the run. The post-update verification step that used to
// fail loudly was removed on 2026-09-17 (see the note at the end of
// UPDATE_STEPS in src/lib/updater.ts); the build is still verified by
// install.sh's do_rebuild right after `bun run build`, and by CI.

const HAS_GIT = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const d = HAS_GIT ? describe : describe.skip;

d("updater — build drift: warn, repin", () => {
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
});
