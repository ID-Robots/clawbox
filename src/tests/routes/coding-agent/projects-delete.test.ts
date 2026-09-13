/**
 * The route that removes a project folder.
 *
 * Everything below runs against a REAL temp CLAWBOX_ROOT with REAL git
 * repositories in it: the refusals this route exists for are statements about a
 * filesystem and a working tree, and a mocked `fs` would only assert the test's
 * own idea of them. The run store, the secret store and the Vercel links are
 * mocked, because those are the collaborators whose CALLS are what is being
 * checked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { installSessionFixture, type SessionFixture } from "@/tests/helpers/session";
import { saveEnv } from "@/tests/helpers/env";

// Starts a real process (git): vitest's 5 s test and 10 s hook defaults are
// not enough on a loaded CI runner. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const listRuns = vi.hoisted(() => vi.fn(() => [] as unknown[]));
const getDefaultDirectory = vi.hoisted(() => vi.fn(async () => null as string | null));
const listProjects = vi.hoisted(() => vi.fn(async () => ({ directory: null as string | null, projects: [] as unknown[] })));
vi.mock("@/lib/coding-agent", () => ({
  listRuns,
  getDefaultDirectory,
  listProjects,
  projectDirectoryOf: (run: { directory: string; worktree?: { project: string } | null }) => run.worktree?.project ?? run.directory,
}));

const deleteVercelLink = vi.hoisted(() => vi.fn(async () => false));
const readVercelLink = vi.hoisted(() => vi.fn(async () => null as unknown));
vi.mock("@/lib/vercel-link", () => ({ deleteVercelLink, readVercelLink }));

const deleteSecretsForScope = vi.hoisted(() => vi.fn(async () => [] as string[]));
const listSecrets = vi.hoisted(() => vi.fn(async () => [] as { name: string; scope: string }[]));
vi.mock("@/lib/project-secrets", () => ({ deleteSecretsForScope, listSecrets }));

const MCP_TOKEN = "mcp-bearer-token-for-the-agent-0123456789";

let GET: (req: Request) => Promise<Response>;
let DELETE: (req: Request) => Promise<Response>;
let session: SessionFixture;
let restore: () => void;
let owner: string;

const URL_BASE = "http://localhost/setup-api/coding-agent/projects/delete";

function headers(auth?: { cookie?: string; bearer?: string; origin?: string }): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json", host: "localhost" };
  if (auth?.cookie) h.cookie = auth.cookie;
  if (auth?.bearer) h.authorization = `Bearer ${auth.bearer}`;
  if (auth?.origin !== undefined) h.origin = auth.origin;
  return h;
}

function get(query: Record<string, string>, auth?: Parameters<typeof headers>[0]): Request {
  return new Request(`${URL_BASE}?${new URLSearchParams(query)}`, { headers: headers(auth) });
}

function del(body: unknown, auth?: Parameters<typeof headers>[0]): Request {
  return new Request(URL_BASE, { method: "DELETE", headers: headers(auth), body: JSON.stringify(body) });
}

const owned = () => ({ cookie: session.cookie, origin: "http://localhost" });

function git(dir: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: dir, stdio: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
}

/** A project folder with a repository, one commit, and nothing outstanding. */
function repo(name: string, opts: { pushed?: boolean } = {}): string {
  const dir = path.join(owner, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@x");
  git(dir, "config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "index.html"), "hello");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "first");
  if (opts.pushed) {
    // A real upstream, so "unpushed commits" is genuinely zero rather than
    // merely unasked: `@{upstream}..HEAD` is the whole of that check.
    const remote = path.join(session.root, `${name}-origin.git`);
    execFileSync("git", ["init", "-q", "--bare", remote], { stdio: "pipe" });
    git(dir, "remote", "add", "origin", remote);
    git(dir, "push", "-q", "-u", "origin", "main");
  }
  return dir;
}

beforeEach(async () => {
  restore = saveEnv("CLAWBOX_MCP_TOKEN");
  process.env.CLAWBOX_MCP_TOKEN = MCP_TOKEN;
  session = installSessionFixture();
  owner = path.join(session.root, "Projects");
  fs.mkdirSync(owner, { recursive: true });
  fs.mkdirSync(path.join(session.root, "data", "code-projects"), { recursive: true });

  vi.resetModules();
  vi.clearAllMocks();
  listRuns.mockReturnValue([]);
  getDefaultDirectory.mockResolvedValue(owner);
  listProjects.mockResolvedValue({ directory: owner, projects: [] });
  deleteVercelLink.mockResolvedValue(false);
  readVercelLink.mockResolvedValue(null);
  deleteSecretsForScope.mockResolvedValue([]);
  listSecrets.mockResolvedValue([]);

  const mod = await import("@/app/setup-api/coding-agent/projects/delete/route");
  GET = mod.GET;
  DELETE = mod.DELETE;
});

afterEach(() => {
  session.cleanup();
  restore();
});

describe("who may remove a project", () => {
  it("refuses the MCP bearer outright, for reading as well as removing", async () => {
    const project = repo("shop", { pushed: true });

    const read = await GET(get({ folder: "shop" }, { bearer: MCP_TOKEN }));
    expect(read.status).toBe(403);
    expect(await read.json()).toMatchObject({ kind: "owner_only" });

    const removed = await DELETE(del({ folder: "shop", confirm: "shop" }, { bearer: MCP_TOKEN }));
    expect(removed.status).toBe(403);
    expect(await removed.json()).toMatchObject({ kind: "owner_only" });
    expect(fs.existsSync(project)).toBe(true);
  });

  it("refuses another page in the owner's browser", async () => {
    const project = repo("shop", { pushed: true });
    const res = await DELETE(del({ folder: "shop", confirm: "shop" }, { cookie: session.cookie, origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ kind: "cross_origin" });
    expect(fs.existsSync(project)).toBe(true);
  });

  it("refuses a caller with no session at all", async () => {
    repo("shop", { pushed: true });
    expect((await GET(get({ folder: "shop" }))).status).toBe(403);
    expect((await DELETE(del({ folder: "shop", confirm: "shop" }))).status).toBe(403);
  });
});

describe("the project has to be named twice", () => {
  it("refuses a confirm that is not the folder's own name", async () => {
    const project = repo("shop", { pushed: true });
    for (const confirm of [undefined, "", "Shop", "shop ", true, "something-else"]) {
      const res = await DELETE(del({ folder: "shop", confirm }, owned()));
      expect(res.status, String(confirm)).toBe(400);
      expect(await res.json()).toMatchObject({ code: "confirm_mismatch" });
    }
    expect(fs.existsSync(project)).toBe(true);
  });

  it("never lets a name with a trailing space remove the folder beside it", async () => {
    const shop = repo("shop", { pushed: true });
    const spaced = path.join(owner, "shop ");
    fs.mkdirSync(spaced);

    // The spaced folder is not a repository, so it needs `force` — and what it
    // removes must be ITSELF, with `shop` untouched.
    const res = await DELETE(del({ folder: "shop ", confirm: "shop ", force: true }, owned()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.directory).toBe(spaced);
    expect(fs.existsSync(spaced)).toBe(false);
    expect(fs.existsSync(shop)).toBe(true);

    // And the trimmed confirmation does not satisfy the untrimmed name.
    fs.mkdirSync(spaced);
    const trimmed = await DELETE(del({ folder: "shop ", confirm: "shop", force: true }, owned()));
    expect(trimmed.status).toBe(400);
    expect(await trimmed.json()).toMatchObject({ code: "confirm_mismatch" });
    expect(fs.existsSync(spaced)).toBe(true);
  });

  it("refuses a name that is a path rather than one folder", async () => {
    const res = await DELETE(del({ folder: "../Projects", confirm: "../Projects" }, owned()));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "invalid" });
  });

  it("answers 404 for a project this box does not have", async () => {
    const res = await DELETE(del({ folder: "ghost", confirm: "ghost" }, owned()));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "not_found" });
  });
});

describe("the refusals", () => {
  it("refuses while a run is live in the project, and says which", async () => {
    const project = repo("shop", { pushed: true });
    listRuns.mockReturnValue([
      { id: "run-abc12345", task: "Add a toggle", status: "running", projectId: null, directory: path.join(project, "src") },
    ]);

    const preview = await GET(get({ folder: "shop" }, owned()));
    expect(await preview.json()).toMatchObject({
      refusal: { code: "live_run" },
      liveRuns: [{ id: "run-abc12345" }],
    });

    const res = await DELETE(del({ folder: "shop", confirm: "shop", force: true }, owned()));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("live_run");
    // A live run is not something `force` clears — see the route's header.
    expect(body.error).toContain("run-abc12345");
    expect(fs.existsSync(project)).toBe(true);
  });

  it("does not recognise a folder NESTED in a project as a project entry", async () => {
    // Named for what this actually reaches. A folder name is one path segment
    // joined to a root, so `packages` is looked for at `<owner>/packages` and
    // `data/code-projects/packages` — neither of which exists — and the answer
    // is `not_found` before the containment check is ever asked. The
    // `outside_roots` verdict itself is covered by the `isDirectlyInside` unit
    // tests and by the no-project-folder-set case; it is not reachable here.
    const project = repo("shop", { pushed: true });
    fs.mkdirSync(path.join(project, "packages"), { recursive: true });
    const res = await DELETE(del({ folder: "packages", confirm: "packages" }, owned()));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "not_found" });
    expect(fs.existsSync(path.join(project, "packages"))).toBe(true);
  });

  it("refuses while a run is STARTING in the project, before its record exists", async () => {
    // THE RACE THIS FEATURE LOST A FILE TO.
    //
    // `assertDirectoryFree` passes synchronously and then `startRun` spends six
    // awaits — the spawn tools, the folder, the settings, the worktree, the
    // auto-PR read, the secrets — before `insertRun` makes the run visible. A
    // removal that looked at the run store during that window saw NOTHING live
    // and moved the folder out from under a run already committed to starting
    // in it. Re-reading the store immediately before the move does not find it
    // either: it is not in the store yet.
    //
    // So the start leaves a CLAIM, and the removal reads it. `listRuns` stays
    // empty here on purpose — that is precisely the state that fooled the old
    // guard, and a test that put a run in the store would be testing the check
    // that already worked.
    const project = repo("shop", { pushed: true });
    listRuns.mockReturnValue([]);
    const lock = await import("@/lib/coding-project-removal-lock");
    const release = lock.beginRunStart(path.join(project, ".clawbox", "worktrees", "run-abc12345"));

    try {
      const res = await DELETE(del({ folder: "shop", confirm: "shop", force: true }, owned()));
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: "live_run" });
      // The whole point: the folder is still there.
      expect(fs.existsSync(project)).toBe(true);
    } finally {
      release();
    }

    // And once that run has finished starting, the removal goes through.
    const after = await DELETE(del({ folder: "shop", confirm: "shop", force: true }, owned()));
    expect(after.status).toBe(200);
    expect(fs.existsSync(project)).toBe(false);
  });

  it("refuses a symlink pointing outside the roots", async () => {
    const outside = path.join(session.root, "elsewhere");
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "keep.txt"), "mine");
    fs.symlinkSync(outside, path.join(owner, "escape"));

    const res = await DELETE(del({ folder: "escape", confirm: "escape" }, owned()));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "path_escape" });
    expect(fs.readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("mine");
  });

  it("refuses ClawBox's own checkout", async () => {
    // The owner's project folder set to the checkout's PARENT, which is the one
    // arrangement in which the checkout is a folder directly inside a root.
    getDefaultDirectory.mockResolvedValue(path.dirname(session.root));
    const folder = path.basename(session.root);

    const res = await DELETE(del({ folder, confirm: folder }, owned()));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "protected_checkout" });
    expect(fs.existsSync(path.join(session.root, "data"))).toBe(true);
  });

  it("refuses a folder with uncommitted changes, and lists them", async () => {
    const project = repo("shop", { pushed: true });
    fs.writeFileSync(path.join(project, "index.html"), "changed");
    fs.writeFileSync(path.join(project, "new.txt"), "untracked");

    const preview = await (await GET(get({ folder: "shop" }, owned()))).json();
    expect(preview.refusal.code).toBe("unsaved_work");
    expect(preview.unsaved.dirtyCount).toBe(2);
    expect(preview.unsaved.dirty.sort()).toEqual(["index.html", "new.txt"]);

    const res = await DELETE(del({ folder: "shop", confirm: "shop" }, owned()));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "unsaved_work" });
    expect(fs.existsSync(project)).toBe(true);
  });

  it("refuses a folder with commits no remote has", async () => {
    const project = repo("shop", { pushed: true });
    fs.writeFileSync(path.join(project, "later.txt"), "more");
    git(project, "add", "-A");
    git(project, "commit", "-qm", "second");

    const preview = await (await GET(get({ folder: "shop" }, owned()))).json();
    expect(preview.unsaved).toMatchObject({ dirtyCount: 0, unpushed: 1, any: true });
    expect((await DELETE(del({ folder: "shop", confirm: "shop" }, owned()))).status).toBe(409);
    expect(fs.existsSync(project)).toBe(true);
  });

  it("counts a NEVER-pushed project's whole history as unpushed, not as zero", async () => {
    repo("local-only");
    const preview = await (await GET(get({ folder: "local-only" }, owned()))).json();
    expect(preview.unsaved).toMatchObject({ unpushed: 1, any: true });
  });

  it("refuses a folder with a leftover run copy under .clawbox", async () => {
    const project = repo("shop", { pushed: true });
    fs.mkdirSync(path.join(project, ".clawbox", "worktrees", "run-leftover"), { recursive: true });

    const preview = await (await GET(get({ folder: "shop" }, owned()))).json();
    expect(preview.unsaved.worktrees).toEqual(["run-leftover"]);
    expect(preview.refusal.code).toBe("unsaved_work");
    expect((await DELETE(del({ folder: "shop", confirm: "shop" }, owned()))).status).toBe(409);
  });

  it("sees unpushed commits on a branch that is NOT checked out", async () => {
    // `@{upstream}..HEAD` asks only about the branch in the working tree, so a
    // finished feature branch nobody pushed reported ZERO and the folder
    // deleted without force.
    const project = repo("shop", { pushed: true });
    git(project, "checkout", "-q", "-b", "feature");
    fs.writeFileSync(path.join(project, "feature.txt"), "only here");
    git(project, "add", "-A");
    git(project, "commit", "-qm", "on the feature branch");
    git(project, "checkout", "-q", "main");

    const preview = await (await GET(get({ folder: "shop" }, owned()))).json();
    expect(preview.unsaved).toMatchObject({ dirtyCount: 0, unpushed: 1, any: true });
    expect((await DELETE(del({ folder: "shop", confirm: "shop" }, owned()))).status).toBe(409);
    expect(fs.existsSync(project)).toBe(true);
  });

  it("sees a stash, which no branch and no push carries", async () => {
    const project = repo("shop", { pushed: true });
    fs.writeFileSync(path.join(project, "index.html"), "work in progress");
    git(project, "stash", "push", "-q", "-m", "wip");

    const preview = await (await GET(get({ folder: "shop" }, owned()))).json();
    expect(preview.unsaved).toMatchObject({ dirtyCount: 0, stashes: 1, any: true });
    expect((await DELETE(del({ folder: "shop", confirm: "shop" }, owned()))).status).toBe(409);
  });

  it("sees IGNORED files — the only copy of a local database looks like node_modules to git", async () => {
    const project = repo("shop", { pushed: true });
    fs.writeFileSync(path.join(project, ".gitignore"), "app.db\n");
    fs.writeFileSync(path.join(project, "app.db"), "the only copy");
    git(project, "add", "-A");
    git(project, "commit", "-qm", "ignore the db");
    git(project, "push", "-q", "origin", "main");

    const preview = await (await GET(get({ folder: "shop" }, owned()))).json();
    expect(preview.unsaved.ignored).toContain("app.db");
    expect(preview.unsaved.any).toBe(true);
    expect((await DELETE(del({ folder: "shop", confirm: "shop" }, owned()))).status).toBe(409);
  });

  it("does not read a PARENT repository's cleanliness as the project's own", async () => {
    // A code project with no `.git` of its own, nested under the app repo.
    // `--is-inside-work-tree` says yes and every check then described the
    // PARENT — clean, pushed, and knowing nothing about this folder. It
    // deleted without force.
    const outer = path.join(owner, "outer");
    fs.mkdirSync(outer, { recursive: true });
    git(outer, "init", "-q", "-b", "main");
    git(outer, "config", "user.email", "t@x");
    git(outer, "config", "user.name", "t");
    fs.writeFileSync(path.join(outer, "readme.md"), "outer");
    git(outer, "add", "-A");
    git(outer, "commit", "-qm", "outer");
    const nested = path.join(outer, "nested");
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, "only-here.txt"), "not in any repository of its own");

    getDefaultDirectory.mockResolvedValue(outer);
    const preview = await (await GET(get({ folder: "nested" }, owned()))).json();
    expect(preview.unsaved).toMatchObject({ notARepository: true, any: true });
    expect((await DELETE(del({ folder: "nested", confirm: "nested" }, owned()))).status).toBe(409);
    expect(fs.existsSync(nested)).toBe(true);
  });

  it("refuses a folder with no git history of its own", async () => {
    const plain = path.join(owner, "notes");
    fs.mkdirSync(plain, { recursive: true });
    fs.writeFileSync(path.join(plain, "a.md"), "words");

    const preview = await (await GET(get({ folder: "notes" }, owned()))).json();
    expect(preview.unsaved).toMatchObject({ notARepository: true, any: true });
    expect((await DELETE(del({ folder: "notes", confirm: "notes" }, owned()))).status).toBe(409);
    expect(fs.existsSync(plain)).toBe(true);
  });
});

describe("a run that starts while the removal is in flight", () => {
  it("is refused, and the folder is NOT moved out from under it", async () => {
    // The audit's repro: the live-run check passes, then four git processes and
    // a copy run, and a run inserted in that window writes into a folder that
    // is being copied. A file written between the copy and the removal was gone
    // from both — and the delete answered success.
    const project = repo("shop", { pushed: true });
    // The run store answers "nothing live" the first time and a live run the
    // second, which is exactly a record landing during the git checks.
    let asked = 0;
    listRuns.mockImplementation(() => {
      asked += 1;
      return asked <= 1
        ? []
        : [{ id: "run-raced0001", task: "t", status: "running", projectId: null, directory: project }];
    });

    const res = await DELETE(del({ folder: "shop", confirm: "shop" }, owned()));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "live_run" });
    expect(fs.existsSync(path.join(project, "index.html"))).toBe(true);
  });

  it("cannot start at all: the run lifecycle refuses a folder being removed", async () => {
    // The other half of the exclusion, and the half a second unlocked check
    // could not provide. Both sides read one synchronous set.
    const lock = await import("@/lib/coding-project-removal-lock");
    lock._resetProjectRemovalsForTests();
    const project = path.join(owner, "shop");

    expect(lock.isProjectBeingRemoved(project)).toBe(false);
    const release = lock.beginProjectRemoval(project);
    try {
      expect(lock.isProjectBeingRemoved(project)).toBe(true);
      // A run works at any depth inside its project, so the whole subtree is shut.
      expect(lock.isProjectBeingRemoved(path.join(project, "src", "api"))).toBe(true);
      expect(lock.isProjectBeingRemoved(path.join(project, ".clawbox", "worktrees", "run-x"))).toBe(true);
      // …and nothing beside it is.
      expect(lock.isProjectBeingRemoved(path.join(owner, "shop-two"))).toBe(false);
      expect(lock.isProjectBeingRemoved(owner)).toBe(false);
    } finally {
      release();
    }
    expect(lock.isProjectBeingRemoved(project)).toBe(false);
  });

  it("releases the claim however the removal ends", async () => {
    const lock = await import("@/lib/coding-project-removal-lock");
    lock._resetProjectRemovalsForTests();
    const project = repo("shop", { pushed: true });

    // A refusal must not leave the folder claimed for ever — that would make
    // every later run in it fail with "being removed".
    listRuns.mockReturnValue([{ id: "run-live00001", task: "t", status: "running", projectId: null, directory: project }]);
    expect((await DELETE(del({ folder: "shop", confirm: "shop" }, owned()))).status).toBe(409);
    expect(lock.isProjectBeingRemoved(project)).toBe(false);

    listRuns.mockReturnValue([]);
    expect((await DELETE(del({ folder: "shop", confirm: "shop" }, owned()))).status).toBe(200);
    expect(lock.isProjectBeingRemoved(project)).toBe(false);
  });
});

describe("the success path", () => {
  it("moves a clean project into the trash and says where it went", async () => {
    const project = repo("shop", { pushed: true });
    readVercelLink.mockResolvedValue({ projectId: "prj_1" });
    listSecrets.mockResolvedValue([{ name: "VERCEL_TOKEN", scope: "shop" }, { name: "OTHER", scope: "@box" }]);
    deleteVercelLink.mockResolvedValue(true);
    deleteSecretsForScope.mockResolvedValue(["VERCEL_TOKEN"]);
    listProjects.mockResolvedValue({ directory: owner, projects: [] });

    const preview = await (await GET(get({ folder: "shop" }, owned()))).json();
    expect(preview).toMatchObject({
      folder: "shop",
      kind: "folder",
      refusal: null,
      vercelLinked: true,
      secretNames: ["VERCEL_TOKEN"],
      retentionDays: 30,
      retentionMax: 10,
      trashCount: 0,
      wouldPurge: [],
    });
    expect(preview.size.files).toBeGreaterThan(0);

    const res = await DELETE(del({ folder: "shop", confirm: "shop" }, owned()));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toMatchObject({
      ok: true,
      folder: "shop",
      vercelLinkRemoved: true,
      secretsRemoved: ["VERCEL_TOKEN"],
      forced: false,
      retentionDays: 30,
      retentionMax: 10,
      prunedEarly: [],
    });
    // IT IS A MOVE, NOT A DELETE. The folder is gone from the project root and
    // its contents are readable where the answer says they are.
    expect(fs.existsSync(project)).toBe(false);
    expect(body.trashPath.startsWith(path.join(owner, ".deleted-projects"))).toBe(true);
    expect(fs.readFileSync(path.join(body.trashPath, "index.html"), "utf8")).toBe("hello");
    expect(body.keptUntil - body.deletedAt).toBe(30 * 24 * 60 * 60_000);

    // The references went with it, and the re-read listing travels with the answer.
    expect(deleteVercelLink).toHaveBeenCalledWith("shop");
    expect(deleteSecretsForScope).toHaveBeenCalledWith("shop");
    expect(body.projects).toEqual([]);
    // The two roots are said APART: `directory` is the folder that was removed,
    // `projectsDirectory` is the listing's own root. Answering the listing's
    // root as `directory` is the bug this pins.
    expect(body.directory).toBe(project);
    expect(body.projectsDirectory).toBe(owner);
  });

  it("removes a code project by its id", async () => {
    const site = path.join(session.root, "data", "code-projects", "site");
    fs.mkdirSync(site, { recursive: true });
    git(site, "init", "-q", "-b", "main");
    git(site, "config", "user.email", "t@x");
    git(site, "config", "user.name", "t");

    const res = await DELETE(del({ folder: "site", kind: "codeProject", confirm: "site" }, owned()));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, folder: "site", kind: "codeProject" });
    expect(fs.existsSync(site)).toBe(false);
  });

  it("removes a folder with unsaved work only when force is explicit", async () => {
    const project = repo("shop", { pushed: true });
    fs.writeFileSync(path.join(project, "index.html"), "changed");

    expect((await DELETE(del({ folder: "shop", confirm: "shop" }, owned()))).status).toBe(409);
    expect((await DELETE(del({ folder: "shop", confirm: "shop", force: "yes" }, owned()))).status).toBe(409);
    expect(fs.existsSync(project)).toBe(true);

    const res = await DELETE(del({ folder: "shop", confirm: "shop", force: true }, owned()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.forced).toBe(true);
    expect(fs.existsSync(project)).toBe(false);
    expect(fs.readFileSync(path.join(body.trashPath, "index.html"), "utf8")).toBe("changed");
  });

  it("keeps the run records of a project it removed", async () => {
    const project = repo("shop", { pushed: true });
    listRuns.mockReturnValue([
      { id: "run-done0001", task: "t", status: "completed", projectId: null, directory: project },
      { id: "run-done0002", task: "t", status: "completed", projectId: null, directory: path.join(project, "api") },
      { id: "run-other001", task: "t", status: "completed", projectId: null, directory: path.join(owner, "elsewhere") },
    ]);
    const body = await (await DELETE(del({ folder: "shop", confirm: "shop" }, owned()))).json();
    expect(body.runsKept).toBe(2);
  });

  it("prunes older trash entries past the retention rule on the way past", async () => {
    repo("shop", { pushed: true });
    const trash = path.join(owner, ".deleted-projects");
    fs.mkdirSync(trash, { recursive: true });
    const long = new Date(Date.now() - 60 * 24 * 60 * 60_000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    fs.mkdirSync(path.join(trash, `ancient--${long}`));

    const body = await (await DELETE(del({ folder: "shop", confirm: "shop" }, owned()))).json();
    expect(body.pruned).toEqual([`ancient--${long}`]);
    expect(fs.existsSync(path.join(trash, `ancient--${long}`))).toBe(false);
  });

  it("warns which removal the count bound would take, then reports that it did", async () => {
    // The consent defect the audit found: the dialog promised 30 days while the
    // count bound could take a folder minutes after it arrived. The preview now
    // names what THIS removal would cost, and the outcome says what it cost.
    repo("shop", { pushed: true });
    const trash = path.join(owner, ".deleted-projects");
    fs.mkdirSync(trash, { recursive: true });
    const stamp = (msAgo: number) => new Date(Date.now() - msAgo).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    // A full shelf, every entry well inside its thirty days.
    const names: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const name = `p${i}--${stamp(i * 60_000)}`;
      names.push(name);
      fs.mkdirSync(path.join(trash, name));
    }
    const oldest = names[names.length - 1];

    const preview = await (await GET(get({ folder: "shop" }, owned()))).json();
    expect(preview).toMatchObject({ retentionMax: 10, trashCount: 10, wouldPurge: [oldest] });
    // The preview NAMES it rather than refusing: the dialog has to be able to
    // draw the tick beside the list. The refusal is the route's, and only when
    // the tick is absent — see "refuses to purge somebody else's…" above.
    expect(preview.refusal).toBeNull();
    expect(fs.existsSync(path.join(trash, oldest))).toBe(true);

    const body = await (await DELETE(del({ folder: "shop", confirm: "shop", purgeOldest: true }, owned()))).json();
    expect(body.prunedEarly).toEqual([oldest]);
    expect(body.pruned).toEqual([oldest]);
    expect(fs.existsSync(path.join(trash, oldest))).toBe(false);
    // The shelf is still exactly the bound, with the new arrival on it.
    expect(fs.readdirSync(trash)).toHaveLength(10);
  });

  it("reports an EXPIRED prune apart from an early one", async () => {
    repo("shop", { pushed: true });
    const trash = path.join(owner, ".deleted-projects");
    fs.mkdirSync(trash, { recursive: true });
    const long = new Date(Date.now() - 60 * 24 * 60 * 60_000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    fs.mkdirSync(path.join(trash, `ancient--${long}`));

    const body = await (await DELETE(del({ folder: "shop", confirm: "shop" }, owned()))).json();
    expect(body.pruned).toEqual([`ancient--${long}`]);
    // Nobody was promised that one, so the dialog has nothing to apologise for.
    expect(body.prunedEarly).toEqual([]);
  });

  it("refuses to purge somebody else's recoverable project without an explicit yes", async () => {
    // The shelf is full and every entry is still inside its thirty days, so
    // this removal would delete one for good. Refused — being told is not the
    // same as agreeing — and cleared only by the flag the dialog ticks.
    repo("shop", { pushed: true });
    const trash = path.join(owner, ".deleted-projects");
    fs.mkdirSync(trash, { recursive: true });
    const stamp = (msAgo: number) => new Date(Date.now() - msAgo).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const names: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const name = `p${i}--${stamp(i * 60_000)}`;
      names.push(name);
      fs.mkdirSync(path.join(trash, name));
    }
    const oldest = names[names.length - 1];

    const refused = await DELETE(del({ folder: "shop", confirm: "shop" }, owned()));
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "trash_full" });
    // NOTHING happened: the project is still there and so is the oldest entry.
    expect(fs.existsSync(path.join(owner, "shop"))).toBe(true);
    expect(fs.existsSync(path.join(trash, oldest))).toBe(true);

    const body = await (await DELETE(del({ folder: "shop", confirm: "shop", purgeOldest: true }, owned()))).json();
    expect(body.prunedEarly).toEqual([oldest]);
    expect(fs.existsSync(path.join(trash, oldest))).toBe(false);
  });

  it("leaves the secrets and the Vercel link alone when another project shares the name", async () => {
    // A folder project and a code project may both be called `shop`, and the
    // secret store is keyed by that name alone — so clearing it here took the
    // credentials of a project that is still on disk and possibly mid-run.
    repo("shop", { pushed: true });
    fs.mkdirSync(path.join(session.root, "data", "code-projects", "shop"), { recursive: true });

    const body = await (await DELETE(del({ folder: "shop", kind: "folder", confirm: "shop" }, owned()))).json();
    expect(body.ok).toBe(true);
    expect(body.metadataKeptFor).toBe(path.join(session.root, "data", "code-projects", "shop"));
    expect(deleteSecretsForScope).not.toHaveBeenCalled();
    expect(deleteVercelLink).not.toHaveBeenCalled();
    expect(body.secretsRemoved).toEqual([]);
    expect(body.vercelLinkRemoved).toBe(false);
    // The other project is untouched.
    expect(fs.existsSync(path.join(session.root, "data", "code-projects", "shop"))).toBe(true);
  });

  it("clears the metadata as usual when no other project shares the name", async () => {
    repo("shop", { pushed: true });
    const body = await (await DELETE(del({ folder: "shop", confirm: "shop" }, owned()))).json();
    expect(body.metadataKeptFor).toBeNull();
    expect(deleteSecretsForScope).toHaveBeenCalledWith("shop");
    expect(deleteVercelLink).toHaveBeenCalledWith("shop");
  });

  it("reads the folder from the query when the caller sends no body", async () => {
    const project = repo("shop", { pushed: true });
    const res = await DELETE(new Request(`${URL_BASE}?folder=shop&confirm=shop`, { method: "DELETE", headers: headers(owned()) }));
    expect(res.status).toBe(200);
    expect(fs.existsSync(project)).toBe(false);
  });

  it("refuses a body larger than one project name can be", async () => {
    repo("shop", { pushed: true });
    const res = await DELETE(new Request(URL_BASE, {
      method: "DELETE",
      headers: { ...headers(owned()), "content-length": "99999" },
      body: JSON.stringify({ folder: "shop", confirm: "shop", pad: "x".repeat(50_000) }),
    }));
    expect(res.status).toBe(413);
  });
});
