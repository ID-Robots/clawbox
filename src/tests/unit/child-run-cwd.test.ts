import { describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { resolveCwd, runChild } from "@/lib/child-run";

describe("resolveCwd", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "cwd-"));
  const gone = path.join(repo, ".clawbox", "worktrees", "run-x");

  it("falls back to the owning repo for gh when the worktree is gone", () => {
    expect(resolveCwd("gh", gone)).toBe(repo);
  });
  it("never falls back for git", () => {
    expect(resolveCwd("git", gone)).toBe(gone);
  });
  it("keeps an existing folder", () => {
    expect(resolveCwd("gh", repo)).toBe(repo);
  });
  it("a gh call from a removed worktree starts instead of failing ENOENT", async () => {
    const r = await runChild("gh", ["--version"], { cwd: gone, timeoutMs: 10_000, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
    expect(r.startError).not.toBe("ENOENT");
  });
});
