/**
 * coding-folder-kind.ts: which top-level folders of the project folder are
 * the owner's projects, which are git worktrees of one and which are copies a
 * run or an agent made — read from files alone, against real repositories.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { classifyFolders, isRunStyleBranch, normalizeRemote, readGitPointer, readRunMarker, writeRunMarker } from "@/lib/coding-folder-kind";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: GIT_ENV }).trim();

let base: string;

function repo(name: string, url?: string): string {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "a");
  if (url) git(dir, "remote", "add", "origin", url);
  return dir;
}

const kindsOf = (names: string[], known?: Set<string>) =>
  Object.fromEntries([...classifyFolders(base, names, known).values()].map((k) => [k.name, { kind: k.kind, parent: k.parent && path.basename(k.parent) }]));

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folder-kind-")));
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe("classifyFolders", () => {
  it("says a registered linked worktree is a worktree of its main checkout", () => {
    const shop = repo("shop");
    git(shop, "worktree", "add", "-q", "-b", "fix", path.join(base, "shop-fix"));
    expect(kindsOf(["shop", "shop-fix"])).toEqual({ shop: { kind: "project", parent: null }, "shop-fix": { kind: "worktree", parent: "shop" } });
    expect(readGitPointer(path.join(base, "shop-fix"))).toMatchObject({ kind: "worktree", registered: true, mainRoot: shop });
  });

  it("says a cp -r of a worktree is a copy, since git no longer knows it", () => {
    const shop = repo("shop");
    git(shop, "worktree", "add", "-q", "-b", "fix", path.join(base, "shop-fix"));
    fs.cpSync(path.join(base, "shop-fix"), path.join(base, "shop-fix-2"), { recursive: true });
    expect(kindsOf(["shop", "shop-fix", "shop-fix-2"])["shop-fix-2"]).toEqual({ kind: "copy", parent: "shop" });
  });

  it("says a twin with the same origin on a run branch is a copy — even of a project with worktrees", () => {
    const shop = repo("shop", "git@example.com:owner/shop.git");
    git(shop, "worktree", "add", "-q", "-b", "side", path.join(shop, ".claude", "worktrees", "side"));
    fs.cpSync(shop, path.join(base, "shop-run-copy"), { recursive: true });
    git(path.join(base, "shop-run-copy"), "checkout", "-q", "-b", "clawbox/run-abcdef12");
    git(path.join(base, "shop-run-copy"), "remote", "set-url", "origin", "https://example.com/owner/shop");
    expect(kindsOf(["shop", "shop-run-copy"])).toEqual({ shop: { kind: "project", parent: null }, "shop-run-copy": { kind: "copy", parent: "shop" } });
  });

  it("leaves a twin on a branch a person names, and a project the box knows, as projects", () => {
    repo("shop", "https://example.com/owner/shop.git");
    const mine = repo("shop-mine", "https://example.com/owner/shop.git");
    git(mine, "checkout", "-q", "-b", "feature/login");
    const team = repo("shop-team", "https://example.com/owner/shop.git");
    git(team, "checkout", "-q", "-b", "clawbox/team-abcd1234");
    expect(kindsOf(["shop", "shop-mine", "shop-team"], new Set([team]))).toEqual({
      shop: { kind: "project", parent: null },
      "shop-mine": { kind: "project", parent: null },
      "shop-team": { kind: "project", parent: null },
    });
  });

  it("says a folder carrying another worktree's run marker is a copy of that run's project", () => {
    const shop = repo("shop");
    const copy = repo("elsewhere");
    writeRunMarker(copy, { kind: "run", id: "run-abcdef12", project: shop });
    expect(readRunMarker(copy)).toMatchObject({ kind: "run", id: "run-abcdef12", project: shop, path: copy });
    // The marker names the folder it was written in; a copy carries it unchanged.
    fs.cpSync(copy, path.join(base, "elsewhere-2"), { recursive: true });
    expect(kindsOf(["shop", "elsewhere-2"])["elsewhere-2"]).toEqual({ kind: "copy", parent: "shop" });
  });

  it("calls a folder with no git, or with no twin, the owner's project", () => {
    fs.mkdirSync(path.join(base, "notes"));
    repo("solo", "https://example.com/owner/solo.git");
    git(path.join(base, "solo"), "checkout", "-q", "-b", "clawbox/run-abcdef12");
    expect(kindsOf(["notes", "solo"])).toEqual({ notes: { kind: "project", parent: null }, solo: { kind: "project", parent: null } });
  });
});

describe("the small readers", () => {
  it("spells one remote one way, without credentials", () => {
    expect(normalizeRemote("git@github.com:Owner/Repo.git")).toBe("github.com/Owner/Repo");
    expect(normalizeRemote("https://user:secret@GitHub.com/Owner/Repo/")).toBe("github.com/Owner/Repo");
    expect(normalizeRemote("ssh://git@github.com/Owner/Repo.git")).toBe("github.com/Owner/Repo");
  });

  it("knows a run's branch from a person's", () => {
    for (const b of ["clawbox/run-abc", "clawbox/team-x-t1-1", "claude/tidy", "codex/fix", "worktree-agent", "run-12"]) expect(isRunStyleBranch(b)).toBe(true);
    for (const b of ["main", "feature/x", "fix-clawbox", null]) expect(isRunStyleBranch(b)).toBe(false);
  });
});
