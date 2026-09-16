/**
 * WHO the box commits as.
 *
 * The defect this pins: every commit the coding agent made on the owner's
 * behalf was authored `ClawBox Coding Agent <coding-agent@clawbox.local>`, an
 * address that belongs to nobody. On a project wired to the Vercel GitHub
 * integration that fails the deployment check — "Git author must have access
 * to the project on Vercel to create deployments" — so the agent's own
 * bookkeeping commits blocked the pull requests it had just opened.
 *
 * What is asserted here is the resolution ORDER and that it reaches real
 * commits: the project's own git config first, then the owner's setting in
 * data/config.json, then the placeholder — and a source supplies BOTH halves
 * of an identity or neither, because a name from one source and an address
 * from another is an identity nobody configured.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

// Real git, several processes per case, on a Jetson — the same ceilings its
// two neighbours declare (coding-git.test.ts, coding-run-worktree.test.ts).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/** data/config.json, as a plain object the tests set key by key. */
const stored: Record<string, unknown> = {};
const configGet = vi.hoisted(() => vi.fn());
const configSet = vi.hoisted(() => vi.fn());
vi.mock("@/lib/config-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config-store")>()),
  get: configGet,
  set: configSet,
}));

import {
  CODING_AGENT_GIT_EMAIL_CONFIG_KEY,
  CODING_AGENT_GIT_NAME_CONFIG_KEY,
  CODING_GIT_PLACEHOLDER,
  identityArgs,
  MAX_GIT_IDENTITY_CHARS,
  normalizeCodingGitEmail,
  normalizeCodingGitName,
  resolveCodingGitIdentity,
} from "@/lib/coding-git-identity";
import { commitRunWork } from "@/lib/coding-git";
import { addRunWorktree } from "@/lib/coding-run-worktree";

let root = "";
/** A HOME with no `.gitconfig` in it, so "the project has no identity" really
 *  means none — otherwise whoever runs the suite lends git theirs. */
let fakeHome = "";
let realHome: string | undefined;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-git-identity-"));
  fakeHome = path.join(root, "home");
  fs.mkdirSync(fakeHome, { recursive: true });
  realHome = process.env.HOME;
  process.env.HOME = fakeHome;
});

afterAll(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  for (const key of Object.keys(stored)) delete stored[key];
  configGet.mockReset().mockImplementation(async (key: string) => stored[key]);
  configSet.mockReset().mockImplementation(async (key: string, value: unknown) => {
    if (value === undefined) delete stored[key];
    else stored[key] = value;
  });
});

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf-8",
    env: { ...process.env, HOME: fakeHome, GIT_CONFIG_NOSYSTEM: "1" },
  }).trim();
}

/** A repository of its own, with whatever identity the test wants in it. */
function repo(identity?: { name?: string; email?: string }): string {
  const dir = fs.mkdtempSync(path.join(root, "repo-"));
  execFileSync("git", ["init", "-q", "-b", "main", dir], {
    env: { ...process.env, HOME: fakeHome, GIT_CONFIG_NOSYSTEM: "1" },
  });
  if (identity?.name) git(dir, "config", "user.name", identity.name);
  if (identity?.email) git(dir, "config", "user.email", identity.email);
  return dir;
}

/** `Name <email>` of the newest commit on `ref`. */
function authorOf(dir: string, ref = "HEAD"): string {
  return git(dir, "log", "-1", "--format=%an <%ae>", ref);
}

describe("resolving the commit identity", () => {
  it("takes the project's own git identity when the folder has one", async () => {
    const dir = repo({ name: "Ada Lovelace", email: "ada@example.com" });
    expect(await resolveCodingGitIdentity(dir)).toEqual({
      name: "Ada Lovelace",
      email: "ada@example.com",
      source: "git",
    });
  });

  it("prefers the project's identity over the owner's setting", async () => {
    stored[CODING_AGENT_GIT_NAME_CONFIG_KEY] = "Box Owner";
    stored[CODING_AGENT_GIT_EMAIL_CONFIG_KEY] = "owner@example.com";
    const dir = repo({ name: "Ada Lovelace", email: "ada@example.com" });
    // A repository the owner already commits to by hand keeps its own history's
    // identity; the setting is the answer for folders that have none.
    expect((await resolveCodingGitIdentity(dir)).email).toBe("ada@example.com");
  });

  it("falls back to the owner's setting when the project's git config is empty", async () => {
    stored[CODING_AGENT_GIT_NAME_CONFIG_KEY] = "Box Owner";
    stored[CODING_AGENT_GIT_EMAIL_CONFIG_KEY] = "owner@example.com";
    expect(await resolveCodingGitIdentity(repo())).toEqual({
      name: "Box Owner",
      email: "owner@example.com",
      source: "config",
    });
  });

  it("falls back to the placeholder when both are empty", async () => {
    expect(await resolveCodingGitIdentity(repo())).toEqual({
      ...CODING_GIT_PLACEHOLDER,
      source: "placeholder",
    });
  });

  it("answers for a folder that is not a repository at all, and for no folder", async () => {
    // `commitRunWork` resolves BEFORE it knows whether the folder will need a
    // `git init`, so "not a repository yet" has to have an answer.
    stored[CODING_AGENT_GIT_NAME_CONFIG_KEY] = "Box Owner";
    stored[CODING_AGENT_GIT_EMAIL_CONFIG_KEY] = "owner@example.com";
    const plain = fs.mkdtempSync(path.join(root, "plain-"));
    expect((await resolveCodingGitIdentity(plain)).source).toBe("config");
    expect((await resolveCodingGitIdentity(path.join(root, "not-there"))).source).toBe("config");
    expect((await resolveCodingGitIdentity("")).source).toBe("config");
  });

  it("takes neither half of a source that supplies only one", async () => {
    stored[CODING_AGENT_GIT_NAME_CONFIG_KEY] = "Box Owner";
    stored[CODING_AGENT_GIT_EMAIL_CONFIG_KEY] = "owner@example.com";
    // A name with no address is not an identity, and pairing it with the
    // owner's e-mail would author a commit as someone who does not exist.
    const nameOnly = repo({ name: "Ada Lovelace" });
    expect(await resolveCodingGitIdentity(nameOnly)).toEqual({
      name: "Box Owner",
      email: "owner@example.com",
      source: "config",
    });
    // The same rule on the config half: a setting with one field filled in
    // falls through to the placeholder rather than borrowing the other.
    delete stored[CODING_AGENT_GIT_NAME_CONFIG_KEY];
    expect((await resolveCodingGitIdentity(repo())).source).toBe("placeholder");
  });

  it("refuses a stored value git could not author", async () => {
    // `Name <email>` is a FORMAT: an angle bracket or a line break in either
    // half produces a commit header that is not what was typed.
    stored[CODING_AGENT_GIT_NAME_CONFIG_KEY] = "Box <Owner>";
    stored[CODING_AGENT_GIT_EMAIL_CONFIG_KEY] = "owner@example.com";
    expect((await resolveCodingGitIdentity(repo())).source).toBe("placeholder");
    stored[CODING_AGENT_GIT_NAME_CONFIG_KEY] = "Box Owner";
    stored[CODING_AGENT_GIT_EMAIL_CONFIG_KEY] = "not an address";
    expect((await resolveCodingGitIdentity(repo())).source).toBe("placeholder");
  });

  it("normalizes what the owner may type", () => {
    expect(normalizeCodingGitName("  Ada Lovelace  ")).toBe("Ada Lovelace");
    expect(normalizeCodingGitName("")).toBeNull();
    expect(normalizeCodingGitName("   ")).toBeNull();
    expect(normalizeCodingGitName(42)).toBeNull();
    expect(normalizeCodingGitName("a".repeat(MAX_GIT_IDENTITY_CHARS + 1))).toBeNull();
    expect(normalizeCodingGitName("Ada\nLovelace")).toBeNull();
    expect(normalizeCodingGitEmail(" ada@example.com ")).toBe("ada@example.com");
    expect(normalizeCodingGitEmail("ada@localdomain")).toBe("ada@localdomain");
    expect(normalizeCodingGitEmail("ada@")).toBeNull();
    expect(normalizeCodingGitEmail("@example.com")).toBeNull();
    expect(normalizeCodingGitEmail("ada example.com")).toBeNull();
    expect(normalizeCodingGitEmail(null)).toBeNull();
  });

  it("builds the argv prefix every commit-making call passes", () => {
    expect(identityArgs({ name: "Ada Lovelace", email: "ada@example.com" })).toEqual([
      "-c", "user.name=Ada Lovelace",
      "-c", "user.email=ada@example.com",
    ]);
  });
});

describe("the commits the box makes carry the resolved identity", () => {
  it("authors the settle's commit as the project's own identity", async () => {
    const dir = repo({ name: "Ada Lovelace", email: "ada@example.com" });
    fs.writeFileSync(path.join(dir, "note.txt"), "work\n");
    const outcome = await commitRunWork({ directory: dir, runId: "run-1", task: "do a thing", summary: null });
    expect(outcome.committed).toBe(true);
    expect(authorOf(dir)).toBe("Ada Lovelace <ada@example.com>");
  });

  it("authors the settle's commit as the owner's setting, and configures a folder it had to create", async () => {
    stored[CODING_AGENT_GIT_NAME_CONFIG_KEY] = "Box Owner";
    stored[CODING_AGENT_GIT_EMAIL_CONFIG_KEY] = "owner@example.com";
    const dir = fs.mkdtempSync(path.join(root, "fresh-"));
    fs.writeFileSync(path.join(dir, "note.txt"), "work\n");
    const outcome = await commitRunWork({ directory: dir, runId: "run-2", task: "do a thing", summary: null });
    expect(outcome).toMatchObject({ committed: true, initialized: true });
    expect(authorOf(dir)).toBe("Box Owner <owner@example.com>");
    // `git init` writes the identity into the new repository too, so the
    // owner's own later commits in that folder match the box's.
    expect(git(dir, "config", "user.email")).toBe("owner@example.com");
  });

  it("authors a run worktree's bookkeeping commit as the resolved identity", async () => {
    stored[CODING_AGENT_GIT_NAME_CONFIG_KEY] = "Box Owner";
    stored[CODING_AGENT_GIT_EMAIL_CONFIG_KEY] = "owner@example.com";
    // An unborn HEAD: the worktree has nothing to fork from, so the box makes
    // the empty first commit itself. That is the commit that used to be
    // authored by the placeholder.
    const dir = repo();
    const added = await addRunWorktree({
      projectDir: dir,
      runId: "run-3",
      protectedRoot: path.join(root, "clawbox-checkout"),
    });
    expect(added.ok).toBe(true);
    expect(authorOf(dir, "main")).toBe("Box Owner <owner@example.com>");
    expect(git(dir, "log", "-1", "--format=%s", "main")).toBe("Initial commit");
  });

  it("still commits on a box that has told it nothing", async () => {
    // The placeholder is the FLOOR, not the rule: a run's work must still be
    // recorded on a device with no git config and no setting.
    const dir = fs.mkdtempSync(path.join(root, "bare-"));
    fs.writeFileSync(path.join(dir, "note.txt"), "work\n");
    expect(await commitRunWork({ directory: dir, runId: "run-4", task: "do a thing", summary: null }))
      .toMatchObject({ committed: true });
    expect(authorOf(dir)).toBe(`${CODING_GIT_PLACEHOLDER.name} <${CODING_GIT_PLACEHOLDER.email}>`);
  });
});
