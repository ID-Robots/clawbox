/**
 * The folder janitor (src/lib/coding-folder-janitor.ts) against REAL git
 * repositories with real worktrees and copies in a temp project folder: every
 * keep rule (live run, live team, lease, recent, dirty, unpushed, unmerged,
 * the owner's own project), every removal path (merged, pushed, a run
 * worktree with its node_modules link, a .claude worktree, a copy to the
 * trash, a vanished worktree pruned), the per-pass bound, the lock and the
 * settings. The run and team stores are stubs: what the janitor reads from
 * them is a list, and that list is the thing under test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";

// Real git processes: more than vitest's 5 s / 10 s defaults on a loaded runner.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

type RunStub = { id: string; status: string; directory: string; worktree?: { path: string; branch: string; base: string; project: string; removed: boolean } | null; leftover?: boolean; team?: unknown };
type BoardStub = { id: string; status: string; directory: string; tasks: { worktree: string | null }[] };

const stores = vi.hoisted(() => ({ runs: [] as RunStub[], boards: [] as BoardStub[], folder: "", marked: [] as string[] }));
vi.mock("@/lib/coding-agent", () => ({
  listRuns: () => stores.runs.map((r) => ({ leftover: false, worktree: null, ...r })),
  getDefaultDirectory: async () => stores.folder,
  projectDirectoryOf: (r: RunStub) => r.worktree?.project ?? r.directory,
  onRunSettled: () => () => {},
  markRunWorktreesRemoved: (paths: string[]) => {
    stores.marked.push(...paths);
    return paths.length;
  },
}));
vi.mock("@/lib/coding-team-board", () => ({ listBoards: () => stores.boards }));
vi.mock("@/lib/updater", () => ({ updateInFlight: async () => false }));

type Janitor = typeof import("@/lib/coding-folder-janitor");
let janitor: Janitor;
let tmp: string;
let projects: string;
let origin: string;
let restoreEnv: () => void;

const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] }).trim();

const DAY = 24 * 60 * 60_000;

/** A repository in the project folder with one commit on master and, optionally, a bare `origin`. */
function makeRepo(name: string, opts: { remote?: boolean } = {}): string {
  const dir = path.join(projects, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "master");
  fs.writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "first");
  if (opts.remote) {
    const bare = path.join(origin, `${name}.git`);
    execFileSync("git", ["init", "-q", "--bare", bare], { env: GIT_ENV });
    git(dir, "remote", "add", "origin", bare);
    git(dir, "push", "-q", "-u", "origin", "master");
  }
  return dir;
}

function commit(dir: string, file: string, text = "x\n"): void {
  fs.writeFileSync(path.join(dir, file), text);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", `add ${file}`);
}

/** Make a folder's git state look `days` old: HEAD, index and the HEAD log. */
function age(dir: string, days: number): void {
  const dotGit = path.join(dir, ".git");
  let gitDir = dotGit;
  if (fs.statSync(dotGit).isFile()) gitDir = path.resolve(dir, /gitdir:\s*(.+)/.exec(fs.readFileSync(dotGit, "utf8"))![1].trim());
  const when = new Date(Date.now() - days * DAY);
  for (const rel of ["HEAD", "index", path.join("logs", "HEAD")]) {
    const f = path.join(gitDir, rel);
    if (fs.existsSync(f)) fs.utimesSync(f, when, when);
  }
}

function entryFor(plan: Awaited<ReturnType<Janitor["planJanitorPass"]>>, dir: string) {
  const real = fs.existsSync(dir) ? fs.realpathSync(dir) : path.resolve(dir);
  return plan.entries.find((e) => e.path === real || e.path === path.resolve(dir));
}

function logLines(): Record<string, unknown>[] {
  const file = janitor.janitorLogPath();
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

beforeEach(async () => {
  restoreEnv = saveEnv("CLAWBOX_ROOT", "CLAWBOX_LEASE_FILES");
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folder-janitor-")));
  projects = path.join(tmp, "Projects");
  origin = path.join(tmp, "remotes");
  fs.mkdirSync(projects, { recursive: true });
  fs.mkdirSync(origin, { recursive: true });
  fs.mkdirSync(path.join(tmp, "root", "data"), { recursive: true });
  process.env.CLAWBOX_ROOT = path.join(tmp, "root");
  process.env.CLAWBOX_LEASE_FILES = path.join(tmp, "leases");
  stores.runs = [];
  stores.boards = [];
  stores.marked = [];
  stores.folder = projects;
  vi.resetModules();
  janitor = await import("@/lib/coding-folder-janitor");
});

afterEach(() => {
  janitor.stop();
  restoreEnv();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("what is a candidate", () => {
  it("never lists the owner's own projects, however old and clean", async () => {
    const mine = makeRepo("mine");
    fs.mkdirSync(path.join(projects, "notes"));
    fs.writeFileSync(path.join(projects, "notes", "todo.txt"), "x\n");
    age(mine, 90);
    const plan = await janitor.planJanitorPass();
    expect(plan.entries).toEqual([]);
    expect(plan.userProjects).toBe(2);
    const result = await janitor.runJanitorPass({ trigger: "manual" });
    expect(result.removed + result.trashed).toBe(0);
    expect(fs.existsSync(mine)).toBe(true);
  });

  it("finds worktrees wherever git keeps them: beside the project, under .clawbox and .claude, and outside the folder", async () => {
    const alpha = makeRepo("alpha");
    const sibling = path.join(projects, "alpha-ref-task-7");
    const run = path.join(alpha, ".clawbox", "worktrees", "run-abcdef12");
    const claude = path.join(alpha, ".claude", "worktrees", "tidy");
    const outside = path.join(tmp, "elsewhere", "alpha-tmp");
    git(alpha, "worktree", "add", "-q", "-b", "ref-task-7", sibling);
    git(alpha, "worktree", "add", "-q", "-b", "clawbox/run-abcdef12", run);
    git(alpha, "worktree", "add", "-q", "-b", "claude/tidy", claude);
    git(alpha, "worktree", "add", "-q", "-b", "worktree-tmp", outside);
    const plan = await janitor.planJanitorPass();
    expect(plan.entries.map((e) => e.path).sort()).toEqual([sibling, run, claude, outside].sort());
    expect(plan.entries.every((e) => e.kind === "worktree" && e.project === alpha)).toBe(true);
    // The worktree beside the project is not one of the owner's projects.
    expect(plan.userProjects).toBe(1);
  });
});

describe("what is removed", () => {
  it("removes a clean, idle worktree whose branch is merged, keeps the branch and logs it", async () => {
    const alpha = makeRepo("alpha");
    const wt = path.join(projects, "alpha-merged");
    git(alpha, "worktree", "add", "-q", "-b", "feature", wt);
    commit(wt, "feature.txt", "a feature\n");
    git(alpha, "merge", "-q", "--no-ff", "--no-edit", "feature");
    age(wt, 30);

    const plan = await janitor.planJanitorPass();
    expect(entryFor(plan, wt)).toMatchObject({ action: "remove", reason: "merged", branch: "feature" });

    const result = await janitor.runJanitorPass({ trigger: "manual" });
    expect(result.removed).toBe(1);
    expect(fs.existsSync(wt)).toBe(false);
    expect(git(alpha, "worktree", "list", "--porcelain")).not.toContain(wt);
    expect(git(alpha, "branch", "--list", "feature")).toContain("feature");
    const [line] = logLines();
    expect(line).toMatchObject({ action: "removed", kind: "worktree", path: wt, branch: "feature", reason: "merged", trigger: "manual" });
    expect(line.freedBytes).toBeGreaterThan(0);
    expect(janitor.readJanitorState().lastPass).toMatchObject({ trigger: "manual", removed: 1 });
  });

  it("removes a clean, idle worktree whose branch is pushed but not merged", async () => {
    const alpha = makeRepo("alpha", { remote: true });
    const wt = path.join(projects, "alpha-pushed");
    git(alpha, "worktree", "add", "-q", "-b", "pushed-work", wt);
    commit(wt, "work.txt");
    git(wt, "push", "-q", "-u", "origin", "pushed-work");
    age(wt, 30);
    const plan = await janitor.planJanitorPass();
    expect(entryFor(plan, wt)).toMatchObject({ action: "remove", reason: "pushed" });
    await janitor.runJanitorPass({ trigger: "manual" });
    expect(fs.existsSync(wt)).toBe(false);
  });

  it("removes a run worktree with its node_modules link, leaving the project's node_modules alone", async () => {
    const alpha = makeRepo("alpha");
    fs.mkdirSync(path.join(alpha, "node_modules", "dep"), { recursive: true });
    fs.writeFileSync(path.join(alpha, "node_modules", "dep", "index.js"), "1\n");
    fs.appendFileSync(path.join(alpha, ".git", "info", "exclude"), "node_modules/\n/.clawbox/\n");
    const run = path.join(alpha, ".clawbox", "worktrees", "run-abcdef12");
    git(alpha, "worktree", "add", "-q", "-b", "clawbox/run-abcdef12", run);
    fs.symlinkSync(path.join(alpha, "node_modules"), path.join(run, "node_modules"));
    age(run, 30);
    const plan = await janitor.planJanitorPass();
    expect(entryFor(plan, run)).toMatchObject({ action: "remove", reason: "merged" });
    await janitor.runJanitorPass({ trigger: "manual" });
    expect(fs.existsSync(run)).toBe(false);
    expect(fs.existsSync(path.join(alpha, "node_modules", "dep", "index.js"))).toBe(true);
  });

  it("removes an idle .claude worktree", async () => {
    const alpha = makeRepo("alpha");
    const claude = path.join(alpha, ".claude", "worktrees", "tidy");
    git(alpha, "worktree", "add", "-q", "-b", "claude/tidy", claude);
    age(claude, 30);
    const result = await janitor.runJanitorPass({ trigger: "manual" });
    expect(result.removed).toBe(1);
    expect(fs.existsSync(claude)).toBe(false);
  });

  it("moves a pushed copy of a project to the box's trash, on a shelf of its own", async () => {
    const alpha = makeRepo("alpha", { remote: true });
    const copy = path.join(projects, "alpha-copy-1");
    fs.cpSync(alpha, copy, { recursive: true });
    git(copy, "checkout", "-q", "-b", "clawbox/run-copy1234");
    commit(copy, "copy.txt");
    git(copy, "push", "-q", "-u", "origin", "clawbox/run-copy1234");
    age(copy, 30);
    age(alpha, 30);

    const plan = await janitor.planJanitorPass();
    expect(plan.entries).toHaveLength(1);
    expect(entryFor(plan, copy)).toMatchObject({ kind: "copy", action: "trash", reason: "pushed", project: alpha });

    const result = await janitor.runJanitorPass({ trigger: "manual" });
    expect(result.trashed).toBe(1);
    expect(fs.existsSync(copy)).toBe(false);
    expect(fs.existsSync(alpha)).toBe(true);
    const shelf = janitor.janitorTrashDir(projects);
    const [entry] = fs.readdirSync(shelf);
    expect(entry).toMatch(/^alpha-copy-1--\d{8}T\d{6}Z$/);
    expect(fs.existsSync(path.join(shelf, entry, "copy.txt"))).toBe(true);
    // The owner's deleted projects live one level up; the shelf is no entry of theirs.
    expect(fs.readdirSync(path.dirname(shelf))).toEqual(["run-copies"]);
    expect(logLines()[0]).toMatchObject({ action: "trashed", kind: "copy", path: copy, branch: "clawbox/run-copy1234", trashPath: path.join(shelf, entry) });
  });

  it("still takes a copy a settled run once worked in, but never the original a run's worktree was made from", async () => {
    const alpha = makeRepo("alpha", { remote: true });
    // A team left the original on its own branch: a run-style branch, a twin
    // with the same origin — and still the original, because the box made a
    // run worktree from it.
    git(alpha, "checkout", "-q", "-b", "clawbox/team-abcd1234");
    git(alpha, "push", "-q", "-u", "origin", "clawbox/team-abcd1234");
    const copy = path.join(projects, "alpha-copy-2");
    fs.cpSync(alpha, copy, { recursive: true });
    git(copy, "checkout", "-q", "-b", "clawbox/run-copy9999");
    git(copy, "push", "-q", "-u", "origin", "clawbox/run-copy9999");
    age(copy, 30);
    age(alpha, 30);
    stores.runs = [
      { id: "run-incopy12", status: "completed", directory: copy },
      { id: "run-made1234", status: "completed", directory: path.join(alpha, ".clawbox", "worktrees", "run-made1234"), worktree: { path: path.join(alpha, ".clawbox", "worktrees", "run-made1234"), branch: "clawbox/run-made1234", base: "master", project: alpha, removed: true } },
    ];
    const plan = await janitor.planJanitorPass();
    expect(plan.entries.map((e) => [path.basename(e.path), e.action])).toEqual([["alpha-copy-2", "trash"]]);
  });

  it("prunes a worktree whose folder is already gone", async () => {
    const alpha = makeRepo("alpha");
    const gone = path.join(tmp, "tmpdir", "alpha-gone");
    git(alpha, "worktree", "add", "-q", "-b", "gone", gone);
    fs.rmSync(gone, { recursive: true, force: true });
    const plan = await janitor.planJanitorPass();
    expect(entryFor(plan, gone)).toMatchObject({ action: "prune", reason: "missing" });
    const result = await janitor.runJanitorPass({ trigger: "manual" });
    expect(result.pruned).toBe(1);
    expect(git(alpha, "worktree", "list", "--porcelain")).not.toContain("alpha-gone");
    expect(git(alpha, "branch", "--list", "gone")).toContain("gone");
  });

  it("removes at most its share in one pass and says which wait", async () => {
    const alpha = makeRepo("alpha");
    const trees = ["a", "b", "c"].map((n) => {
      const wt = path.join(projects, `alpha-${n}`);
      git(alpha, "worktree", "add", "-q", "-b", `b-${n}`, wt);
      return wt;
    });
    for (const wt of trees) age(wt, 30);
    const plan = await janitor.planJanitorPass({ maxRemovals: 2 });
    expect(plan.entries.filter((e) => e.action === "remove")).toHaveLength(2);
    expect(plan.entries.filter((e) => e.reason === "limit")).toHaveLength(1);
    const result = await janitor.runJanitorPass({ trigger: "manual", maxRemovals: 2 });
    expect(result.removed).toBe(2);
    expect(trees.filter((t) => fs.existsSync(t))).toHaveLength(1);
  });
});

describe("what is kept, and why", () => {
  async function keptFor(dir: string) {
    const plan = await janitor.planJanitorPass();
    const entry = entryFor(plan, dir);
    await janitor.runJanitorPass({ trigger: "manual" });
    expect(fs.existsSync(dir)).toBe(true);
    return entry;
  }

  it("keeps a dirty worktree — untracked files count", async () => {
    const alpha = makeRepo("alpha");
    const wt = path.join(projects, "alpha-dirty");
    git(alpha, "worktree", "add", "-q", "-b", "dirty", wt);
    fs.writeFileSync(path.join(wt, "scratch.txt"), "not committed\n");
    age(wt, 30);
    expect(await keptFor(wt)).toMatchObject({ action: "keep", reason: "dirty" });
  });

  it("keeps a worktree with commits its upstream does not have", async () => {
    const alpha = makeRepo("alpha", { remote: true });
    const wt = path.join(projects, "alpha-unpushed");
    git(alpha, "worktree", "add", "-q", "-b", "unpushed", wt);
    commit(wt, "one.txt");
    git(wt, "push", "-q", "-u", "origin", "unpushed");
    commit(wt, "two.txt");
    age(wt, 30);
    expect(await keptFor(wt)).toMatchObject({ action: "keep", reason: "unpushed" });
  });

  it("keeps a worktree whose branch is neither merged nor pushed", async () => {
    const alpha = makeRepo("alpha");
    const wt = path.join(projects, "alpha-unmerged");
    git(alpha, "worktree", "add", "-q", "-b", "unmerged", wt);
    commit(wt, "work.txt");
    age(wt, 30);
    expect(await keptFor(wt)).toMatchObject({ action: "keep", reason: "unmerged" });
  });

  it("keeps a worktree used within the retention period, and honours a shorter one", async () => {
    const alpha = makeRepo("alpha");
    const wt = path.join(projects, "alpha-recent");
    git(alpha, "worktree", "add", "-q", "-b", "recent", wt);
    age(wt, 5);
    expect(await keptFor(wt)).toMatchObject({ action: "keep", reason: "recent", idleDays: 5 });
    await janitor.saveJanitorSettings({ retentionDays: 3 });
    age(wt, 5);
    expect(entryFor(await janitor.planJanitorPass(), wt)).toMatchObject({ action: "remove" });
  });

  it.each(["running", "paused", "queued", "draft"])("keeps a worktree a %s run is working in", async (status) => {
    const alpha = makeRepo("alpha");
    const wt = path.join(alpha, ".clawbox", "worktrees", "run-live1234");
    git(alpha, "worktree", "add", "-q", "-b", "clawbox/run-live1234", wt);
    age(wt, 30);
    stores.runs = [{ id: "run-live1234", status, directory: wt, worktree: { path: wt, branch: "clawbox/run-live1234", base: "master", project: alpha, removed: false } }];
    expect(await keptFor(wt)).toMatchObject({ action: "keep", reason: "live_run" });
  });

  it("keeps a worktree a settled run left a process running in", async () => {
    const alpha = makeRepo("alpha");
    const wt = path.join(projects, "alpha-server");
    git(alpha, "worktree", "add", "-q", "-b", "server", wt);
    age(wt, 30);
    stores.runs = [{ id: "run-srv12345", status: "completed", directory: wt, leftover: true }];
    expect(await keptFor(wt)).toMatchObject({ action: "keep", reason: "live_run" });
  });

  it("removes a worktree whose run has settled", async () => {
    const alpha = makeRepo("alpha");
    const wt = path.join(alpha, ".clawbox", "worktrees", "run-done1234");
    git(alpha, "worktree", "add", "-q", "-b", "clawbox/run-done1234", wt);
    age(wt, 30);
    stores.runs = [{ id: "run-done1234", status: "completed", directory: wt, worktree: { path: wt, branch: "clawbox/run-done1234", base: "master", project: alpha, removed: false } }];
    await janitor.runJanitorPass({ trigger: "manual" });
    expect(fs.existsSync(wt)).toBe(false);
    // …and tells the run's record, so a resume rebuilds the tree from its branch.
    expect(stores.marked).toEqual([wt]);
  });

  it("keeps the worktrees of a team that has not settled", async () => {
    const alpha = makeRepo("alpha");
    const wt = path.join(alpha, ".clawbox", "worktrees", "t1-1");
    git(alpha, "worktree", "add", "-q", "-b", "clawbox/team-abcd1234-t1-1", wt);
    age(wt, 30);
    stores.boards = [{ id: "team-abcd1234", status: "working", directory: alpha, tasks: [{ worktree: wt }] }];
    expect(await keptFor(wt)).toMatchObject({ action: "keep", reason: "live_team" });
  });

  it("keeps a worktree a lab or board lease names", async () => {
    const alpha = makeRepo("alpha");
    const wt = path.join(projects, "alpha-ref-task-7");
    git(alpha, "worktree", "add", "-q", "-b", "ref-task-7", wt);
    age(wt, 30);
    fs.mkdirSync(path.join(tmp, "leases"));
    fs.writeFileSync(path.join(tmp, "leases", "board-a"), "lab1 board-a coding-agent task-7: bench the fix\n");
    expect(await keptFor(wt)).toMatchObject({ action: "keep", reason: "lease" });
  });

  it("keeps a worktree somebody locked", async () => {
    const alpha = makeRepo("alpha");
    const wt = path.join(projects, "alpha-locked");
    git(alpha, "worktree", "add", "-q", "-b", "locked", wt);
    git(alpha, "worktree", "lock", wt);
    age(wt, 30);
    expect(await keptFor(wt)).toMatchObject({ action: "keep", reason: "locked" });
  });

  it("keeps a copy that is not pushed", async () => {
    const alpha = makeRepo("alpha", { remote: true });
    const copy = path.join(projects, "alpha-copy2");
    fs.cpSync(alpha, copy, { recursive: true });
    git(copy, "checkout", "-q", "-b", "clawbox/run-copy5678");
    commit(copy, "local.txt");
    age(copy, 30);
    expect(await keptFor(copy)).toMatchObject({ kind: "copy", action: "keep", reason: "unmerged" });
  });

  it("does not make a folder look used by looking at it", async () => {
    const alpha = makeRepo("alpha");
    const wt = path.join(projects, "alpha-dirty");
    git(alpha, "worktree", "add", "-q", "-b", "dirty", wt);
    fs.writeFileSync(path.join(wt, "README.md"), "changed\n");
    age(wt, 30);
    await janitor.planJanitorPass();
    const again = await janitor.planJanitorPass();
    expect(entryFor(again, wt)).toMatchObject({ reason: "dirty", idleDays: 30 });
  });
});

describe("the pass itself", () => {
  it("does nothing on a schedule while the switch is off, and the owner's button still works", async () => {
    const alpha = makeRepo("alpha");
    const wt = path.join(projects, "alpha-old");
    git(alpha, "worktree", "add", "-q", "-b", "old", wt);
    age(wt, 30);
    await janitor.saveJanitorSettings({ enabled: false });
    expect(await janitor.runJanitorPass({ trigger: "daily" })).toMatchObject({ skipped: "disabled", removed: 0 });
    expect(fs.existsSync(wt)).toBe(true);
    expect(await janitor.runJanitorPass({ trigger: "manual", ignoreSwitch: true })).toMatchObject({ skipped: null, removed: 1 });
  });

  it("never runs two passes at once", async () => {
    makeRepo("alpha");
    const [a, b] = await Promise.all([
      janitor.runJanitorPass({ trigger: "daily" }),
      janitor.runJanitorPass({ trigger: "daily" }),
    ]);
    expect([a.skipped, b.skipped].filter((s) => s === "busy")).toHaveLength(1);
    // Both settled before the test ends: a pass left running would hold the next test's lock.
    const both = await Promise.allSettled([
      janitor.runJanitorPass({ trigger: "manual", throwIfBusy: true }),
      janitor.runJanitorPass({ trigger: "manual", throwIfBusy: true }),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(both.find((r) => r.status === "rejected")).toMatchObject({ reason: { kind: "busy" } });
  });

  it("stands aside while another process holds the lock, and takes a dead one's", async () => {
    makeRepo("alpha");
    const lock = path.join(tmp, "root", "data", "coding-folder-janitor.lock");
    fs.writeFileSync(lock, `${process.pid} ${Date.now()}\n`);
    expect((await janitor.runJanitorPass({ trigger: "daily" })).skipped).toBe("busy");
    fs.writeFileSync(lock, `999999999 ${Date.now()}\n`);
    expect((await janitor.runJanitorPass({ trigger: "daily" })).skipped).toBeNull();
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("expires copies past the trash's retention, and only those", async () => {
    const shelf = janitor.janitorTrashDir(projects);
    const old = new Date(Date.now() - 40 * DAY).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const fresh = new Date(Date.now() - 2 * DAY).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    for (const name of [`a--${old}`, `b--${fresh}`, "not-ours"]) fs.mkdirSync(path.join(shelf, name), { recursive: true });
    await janitor.runJanitorPass({ trigger: "daily" });
    expect(fs.readdirSync(shelf).sort()).toEqual([`b--${fresh}`, "not-ours"]);
    expect(logLines().map((l) => l.action)).toEqual(["expired"]);
  });
});

describe("settings", () => {
  it("is on with 14 days by default, and refuses a bad value rather than clamping it", async () => {
    expect(await janitor.readJanitorSettings()).toEqual({ enabled: true, retentionDays: 14 });
    await expect(janitor.saveJanitorSettings({ retentionDays: 0 })).rejects.toMatchObject({ kind: "invalid" });
    await expect(janitor.saveJanitorSettings({ retentionDays: 2.5 })).rejects.toMatchObject({ kind: "invalid" });
    await expect(janitor.saveJanitorSettings({ enabled: "yes" })).rejects.toMatchObject({ kind: "invalid" });
    expect(await janitor.saveJanitorSettings({ enabled: false, retentionDays: 30 })).toEqual({ enabled: false, retentionDays: 30 });
    expect(await janitor.readJanitorSettings()).toEqual({ enabled: false, retentionDays: 30 });
  });
});
