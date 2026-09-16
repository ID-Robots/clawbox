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
import { addWorkerWorktree, ensureTeamBranch, mergeWorkerBranch } from "@/lib/coding-team-worktree";

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

/** The identity, or a failed assertion naming what the lookup said instead. */
async function identityOf(dir: string) {
  const found = await resolveCodingGitIdentity(dir);
  if (!found.ok) throw new Error(`lookup failed: ${found.detail}`);
  return found.identity;
}

describe("resolving the commit identity", () => {
  it("takes the project's own git identity when the folder has one", async () => {
    const dir = repo({ name: "Ada Lovelace", email: "ada@example.com" });
    expect(await identityOf(dir)).toEqual({
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
    expect((await identityOf(dir)).email).toBe("ada@example.com");
  });

  it("falls back to the owner's setting when the project's git config is empty", async () => {
    stored[CODING_AGENT_GIT_NAME_CONFIG_KEY] = "Box Owner";
    stored[CODING_AGENT_GIT_EMAIL_CONFIG_KEY] = "owner@example.com";
    expect(await identityOf(repo())).toEqual({
      name: "Box Owner",
      email: "owner@example.com",
      source: "config",
    });
  });

  it("falls back to the placeholder when both are empty", async () => {
    expect(await identityOf(repo())).toEqual({
      ...CODING_GIT_PLACEHOLDER,
      source: "placeholder",
    });
  });

  it("answers for a folder that is not a repository at all, and for no folder", async () => {
    // `commitRunWork` resolves BEFORE it knows whether the folder will need a
    // `git init`, so "not a repository yet" has to have an answer. Measured:
    // `git config --get` in a plain folder exits 1 — "not set" — and reads the
    // global config, which is the layer an owner actually configures.
    stored[CODING_AGENT_GIT_NAME_CONFIG_KEY] = "Box Owner";
    stored[CODING_AGENT_GIT_EMAIL_CONFIG_KEY] = "owner@example.com";
    const plain = fs.mkdtempSync(path.join(root, "plain-"));
    expect((await identityOf(plain)).source).toBe("config");
    expect((await identityOf("")).source).toBe("config");
  });

  it("reports a lookup it could not MAKE instead of authoring as somebody else", async () => {
    // A fault is not an absence. Exit 1 is git saying "no such key"; a folder
    // that is not there exits 128, and reading that as "this project has no
    // identity" would commit as the owner's setting — or as the placeholder
    // this whole change exists to stop using — on a transient fault.
    stored[CODING_AGENT_GIT_NAME_CONFIG_KEY] = "Box Owner";
    stored[CODING_AGENT_GIT_EMAIL_CONFIG_KEY] = "owner@example.com";
    const found = await resolveCodingGitIdentity(path.join(root, "not-there"));
    expect(found.ok).toBe(false);
    // Never blank: the caller renders this to the owner.
    if (!found.ok) expect(found.detail.length).toBeGreaterThan(0);
    // And the settle says so rather than committing under a guessed name.
    expect(await commitRunWork({
      directory: path.join(root, "not-there"),
      runId: "run-0",
      task: "do a thing",
      summary: null,
    })).toMatchObject({ committed: false });
  });

  it("takes neither half of a source that supplies only one", async () => {
    stored[CODING_AGENT_GIT_NAME_CONFIG_KEY] = "Box Owner";
    stored[CODING_AGENT_GIT_EMAIL_CONFIG_KEY] = "owner@example.com";
    // A name with no address is not an identity, and pairing it with the
    // owner's e-mail would author a commit as someone who does not exist.
    const nameOnly = repo({ name: "Ada Lovelace" });
    expect(await identityOf(nameOnly)).toEqual({
      name: "Box Owner",
      email: "owner@example.com",
      source: "config",
    });
    // The same rule on the config half: a setting with one field filled in
    // falls through to the placeholder rather than borrowing the other.
    delete stored[CODING_AGENT_GIT_NAME_CONFIG_KEY];
    expect((await identityOf(repo())).source).toBe("placeholder");
  });

  it("does not let the box's OWN placeholder in .git/config outvote the owner", async () => {
    // `initRepo` stamps the resolved identity into a folder the settle had to
    // create, so every project this device made before the setting existed
    // carries the placeholder locally. Read back as "the project's identity"
    // it outranks the setting, and the owner fills the fields in, watches them
    // save, and still gets coding-agent@clawbox.local on every commit — in
    // exactly the projects this resolver exists to unblock.
    const stamped = repo({ ...CODING_GIT_PLACEHOLDER });
    // With nothing configured the answer is unchanged: the placeholder, which
    // is what that folder committed as before and still does.
    expect((await identityOf(stamped)).source).toBe("placeholder");

    stored[CODING_AGENT_GIT_NAME_CONFIG_KEY] = "Box Owner";
    stored[CODING_AGENT_GIT_EMAIL_CONFIG_KEY] = "owner@example.com";
    expect(await identityOf(stamped)).toEqual({
      name: "Box Owner",
      email: "owner@example.com",
      source: "config",
    });

    // A real identity in the same folder still wins, which is the whole rule
    // this one is carved out of.
    const real = repo({ name: "Ada Lovelace", email: "ada@example.com" });
    expect((await identityOf(real)).source).toBe("git");
  });

  it("commits as the owner in a folder the box had already stamped", async () => {
    // End to end, through the settle: first run with nothing configured stamps
    // the folder, second run after the owner fills the setting in must carry
    // the owner's name.
    const dir = fs.mkdtempSync(path.join(root, "stamped-"));
    fs.writeFileSync(path.join(dir, "one.txt"), "one\n");
    expect(await commitRunWork({ directory: dir, runId: "run-5", task: "first", summary: null }))
      .toMatchObject({ committed: true, initialized: true });
    expect(authorOf(dir)).toBe(`${CODING_GIT_PLACEHOLDER.name} <${CODING_GIT_PLACEHOLDER.email}>`);
    expect(git(dir, "config", "user.email")).toBe(CODING_GIT_PLACEHOLDER.email);

    stored[CODING_AGENT_GIT_NAME_CONFIG_KEY] = "Box Owner";
    stored[CODING_AGENT_GIT_EMAIL_CONFIG_KEY] = "owner@example.com";
    fs.writeFileSync(path.join(dir, "two.txt"), "two\n");
    expect(await commitRunWork({ directory: dir, runId: "run-6", task: "second", summary: null }))
      .toMatchObject({ committed: true });
    expect(authorOf(dir)).toBe("Box Owner <owner@example.com>");
  });

  it("refuses a stored value git could not author", async () => {
    // `Name <email>` is a FORMAT: an angle bracket or a line break in either
    // half produces a commit header that is not what was typed.
    stored[CODING_AGENT_GIT_NAME_CONFIG_KEY] = "Box <Owner>";
    stored[CODING_AGENT_GIT_EMAIL_CONFIG_KEY] = "owner@example.com";
    expect((await identityOf(repo())).source).toBe("placeholder");
    stored[CODING_AGENT_GIT_NAME_CONFIG_KEY] = "Box Owner";
    stored[CODING_AGENT_GIT_EMAIL_CONFIG_KEY] = "not an address";
    expect((await identityOf(repo())).source).toBe("placeholder");
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

  it("authors the team's preservation commit AND its merge as the project's identity", async () => {
    // Both of these used to be authored by whatever git could find: the
    // preservation commit by the placeholder, and the merge — a `--no-ff`,
    // so always a merge COMMIT — by nothing at all, which fails outright on a
    // repository with no identity of its own.
    const dir = repo({ name: "Ada Lovelace", email: "ada@example.com" });
    fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "first");

    const team = await ensureTeamBranch(dir, "team-1");
    if (!team.ok) throw new Error(team.detail);
    const worker = await addWorkerWorktree(dir, "team-1", "t1", 1);
    if (!worker.ok) throw new Error(worker.detail);

    fs.writeFileSync(path.join(worker.path, "b.txt"), "b\n");
    git(worker.path, "add", "-A");
    git(worker.path, "-c", "user.name=Worker", "-c", "user.email=worker@example.com", "commit", "-qm", "worker work");
    // Something untracked in the team checkout, so the preservation commit
    // runs too — the favicons the box draws at a run's start are the real case.
    fs.writeFileSync(path.join(dir, "stray.txt"), "stray\n");

    const merged = await mergeWorkerBranch(dir, worker.branch, "Coding team: t1");
    expect(merged).toMatchObject({ ok: true, merged: true });
    // The merge commit, and the preservation commit it sits on top of.
    expect(authorOf(dir)).toBe("Ada Lovelace <ada@example.com>");
    expect(git(dir, "log", "-1", "--format=%an <%ae>", "HEAD^")).toBe("Ada Lovelace <ada@example.com>");
    expect(git(dir, "log", "-1", "--format=%s", "HEAD^"))
      .toBe("Coding team: files present in the checkout before a merge");
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
