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

  it("refuses a folder that is not directly inside either root", async () => {
    // A folder one level deeper than a project. `isInside` would call it
    // contained; "directly inside" is what the guard actually asks.
    const project = repo("shop", { pushed: true });
    fs.mkdirSync(path.join(project, "packages"), { recursive: true });
    const res = await DELETE(del({ folder: "packages", confirm: "packages" }, owned()));
    expect(res.status).toBe(404);
    expect(fs.existsSync(path.join(project, "packages"))).toBe(true);
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
    });
    // IT IS A MOVE, NOT A DELETE. The folder is gone from the project root and
    // its contents are readable where the answer says they are.
    expect(fs.existsSync(project)).toBe(false);
    expect(body.trashPath.startsWith(path.join(session.root, "data", "deleted-projects"))).toBe(true);
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
    const trash = path.join(session.root, "data", "deleted-projects");
    fs.mkdirSync(trash, { recursive: true });
    const long = new Date(Date.now() - 60 * 24 * 60 * 60_000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    fs.mkdirSync(path.join(trash, `ancient--${long}`));

    const body = await (await DELETE(del({ folder: "shop", confirm: "shop" }, owned()))).json();
    expect(body.pruned).toEqual([`ancient--${long}`]);
    expect(fs.existsSync(path.join(trash, `ancient--${long}`))).toBe(false);
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
