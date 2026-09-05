/**
 * GET /setup-api/coding-agent/projects — the owner's projects, as the Coding
 * Agent app lists them.
 *
 * A project is a folder directly inside the project folder with a `.git`
 * DIRECTORY of its own: that is what a run leaves behind and what the owner
 * can get back to. Everything else in the folder — plain folders, a symlink
 * out, a worktree pointer file — is not one. A code project under
 * data/code-projects — where the New app wizard's handoff lands — is one
 * too, from its project.json on. Real git, in a temp folder: the subject and
 * date come from `git log`, and a fake would only prove the fake.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";
import { HARNESS_TEST_PROJECT_ID } from "@/lib/coding-agent";

// Starts a real process (bash / python3 / node / git): vitest's 5 s test and
// 10 s hook defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let GET: () => Promise<Response>;
let base: string;
let home: string;
let root: string;
let projectsDir: string;
let codeProjectsDir: string;
let restore: () => void;

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf-8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", HOME: home },
  }).trim();
}

/** A folder with a repository of its own; `commit` records one commit. */
function makeRepo(name: string, opts: { commit?: string; projectName?: string; under?: string } = {}): string {
  const dir = path.join(opts.under ?? projectsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "--quiet");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "user.email", "test@example.com");
  if (opts.projectName) {
    fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify({ projectId: name, name: opts.projectName }));
  }
  if (opts.commit) {
    fs.writeFileSync(path.join(dir, "index.html"), "<h1>hi</h1>");
    git(dir, "add", "-A");
    git(dir, "commit", "--quiet", "-m", opts.commit);
  }
  return dir;
}

/** A code project the way code_project_init leaves one: project.json, no git yet. */
function scaffoldCodeProject(id: string, name: string): string {
  const dir = path.join(codeProjectsDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify({ projectId: id, name }));
  fs.writeFileSync(path.join(dir, "index.html"), "<h1>new</h1>");
  return dir;
}

function writeConfig(cfg: Record<string, unknown>): void {
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "config.json"), JSON.stringify(cfg), "utf-8");
}

/** Put an icon where the icon route reads it, the way project-icon.ts does. */
function giveIcon(id: string): void {
  const dir = path.join(root, "data", "icons");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.png`), Buffer.from("89504e470d0a1a0a", "hex"));
}

/** Register a folder as a desktop web app the way deployWebapp does. */
function putOnDesktop(id: string): void {
  const dir = path.join(root, "data", "webapps", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ name: id, color: "#f97316", icon: "" }));
}

async function body() {
  const res = await GET();
  expect(res.status).toBe(200);
  return await res.json() as { directory: string | null; projects: Array<Record<string, unknown>> };
}

beforeEach(async () => {
  restore = saveEnv("HOME", "CLAWBOX_ROOT");
  base = fs.mkdtempSync(path.join(os.tmpdir(), "coding-projects-"));
  home = path.join(base, "home");
  root = path.join(home, "clawbox");
  projectsDir = path.join(home, "Projects");
  codeProjectsDir = path.join(root, "data", "code-projects");
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.mkdirSync(projectsDir, { recursive: true });
  process.env.HOME = home;
  process.env.CLAWBOX_ROOT = root;
  writeConfig({ coding_agent_default_directory: projectsDir });
  vi.resetModules();
  GET = (await import("@/app/setup-api/coding-agent/projects/route")).GET;
});

afterEach(() => {
  restore();
  fs.rmSync(base, { recursive: true, force: true });
});

describe("GET projects", () => {
  it("lists only the folders with a git history of their own, newest commit first", async () => {
    makeRepo("site", { commit: "Coding agent: add a dark mode toggle", projectName: "My Site" });
    makeRepo("scratch");
    fs.mkdirSync(path.join(projectsDir, "notes"));
    fs.mkdirSync(path.join(projectsDir, ".hidden", ".git"), { recursive: true });
    putOnDesktop("site");

    const { directory, projects } = await body();
    expect(directory).toBe(projectsDir);
    expect(projects.map((p) => p.folder)).toEqual(["site", "scratch"]);

    const [site, scratch] = projects;
    expect(site.name).toBe("My Site");
    expect(site.kind).toBe("folder");
    expect(site.directory).toBe(path.join(projectsDir, "site"));
    expect(site.onDesktop).toBe(true);
    // No picture drawn for it yet, which is every project on a fresh box: the
    // row draws its lettered placeholder rather than a broken image.
    expect(site.iconUrl).toBeNull();
    expect(site.latestRun).toBeNull();
    const commit = site.lastCommit as { subject: string; date: number };
    expect(commit.subject).toBe("Coding agent: add a dark mode toggle");
    expect(Math.abs(commit.date - Date.now())).toBeLessThan(60_000);

    // No project.json: the folder's own name. No commit yet: says so.
    expect(scratch.name).toBe("scratch");
    expect(scratch.lastCommit).toBeNull();
    expect(scratch.onDesktop).toBe(false);
  });

  it("points at the picture the box drew for a project, once there is one", async () => {
    makeRepo("site", { commit: "first" });
    giveIcon("site");
    const { projects } = await body();
    expect(projects[0].iconUrl).toBe("/setup-api/apps/icon/site");
  });

  it("lists a folder a run has worked in even before it has a history of its own", async () => {
    // Every run happens in a folder inside the project folder, and the owner
    // asked for every such folder to be listed — the run is how they get
    // back to it. A folder a run named but that is gone is not listed.
    const base = fs.realpathSync(projectsDir);
    fs.mkdirSync(path.join(projectsDir, "scratch-app"));
    fs.writeFileSync(
      path.join(root, "data", "coding-agent-runs.json"),
      JSON.stringify([
        { id: "run-scratch01", status: "completed", startedAt: 5, completedAt: 6, task: "make it", directory: path.join(base, "scratch-app"), source: "agent" },
        { id: "run-gone00001", status: "completed", startedAt: 3, completedAt: 4, task: "gone", directory: path.join(base, "deleted-app"), source: "agent" },
      ]),
    );
    vi.resetModules();
    GET = (await import("@/app/setup-api/coding-agent/projects/route")).GET;
    const { projects } = await body();
    const names = projects.map((p: Record<string, unknown>) => p.folder);
    expect(names).toContain("scratch-app");
    expect(names).not.toContain("deleted-app");
    const scratch = projects.find((p: Record<string, unknown>) => p.folder === "scratch-app") as Record<string, unknown>;
    expect(scratch).toMatchObject({ kind: "folder", name: "scratch-app", lastCommit: null });
    expect(scratch.latestRun).toMatchObject({ id: "run-scratch01" });
  });

  it("attaches the newest run that worked in the folder", async () => {
    const dir = makeRepo("site", { commit: "first" });
    const real = fs.realpathSync(dir);
    const run = (id: string, status: string, startedAt: number) => ({
      id, status, startedAt, task: `task ${id}`, directory: real, completedAt: null, source: "agent",
    });
    // Newest first, as the store keeps them; the older one must not win.
    fs.writeFileSync(
      path.join(root, "data", "coding-agent-runs.json"),
      JSON.stringify([run("run-newest00", "running", 2_000), run("run-older000", "completed", 1_000)]),
    );
    vi.resetModules();
    GET = (await import("@/app/setup-api/coding-agent/projects/route")).GET;

    const { projects } = await body();
    expect(projects).toHaveLength(1);
    expect(projects[0].latestRun).toEqual({
      id: "run-newest00", status: "running", task: "task run-newest00", startedAt: 2_000, completedAt: null,
    });
  });

  describe("code projects", () => {
    it("lists them beside the owner's folder, from their project.json on, and marks which they are", async () => {
      makeRepo("site", { commit: "Coding agent: first pass" });
      makeRepo("timer", { commit: "Coding agent: build the timer", projectName: "Pomodoro timer", under: codeProjectsDir });
      // Just scaffolded — code_project_init has written project.json and no
      // run has committed yet. Listed all the same: this is the moment the
      // owner is watching the list for the app they asked for.
      scaffoldCodeProject("notes", "Notes");
      // A folder under data/code-projects with neither is not a project.
      fs.mkdirSync(path.join(codeProjectsDir, "leftover"));
      putOnDesktop("timer");

      const { directory, projects } = await body();
      expect(directory).toBe(projectsDir);
      expect(projects.map((p) => [p.folder, p.kind])).toEqual([
        ["timer", "codeProject"], ["site", "folder"], ["notes", "codeProject"],
      ]);
      const timer = projects[0];
      expect(timer.name).toBe("Pomodoro timer");
      expect(timer.directory).toBe(path.join(codeProjectsDir, "timer"));
      expect(timer.onDesktop).toBe(true);
      expect((timer.lastCommit as { subject: string }).subject).toBe("Coding agent: build the timer");
      expect(projects[2]).toMatchObject({ name: "Notes", lastCommit: null, onDesktop: false, latestRun: null });
    });

    it("leaves out the Test-harness button's scratch project", async () => {
      // The app inits it for its own smoke run; the run is listed on the home
      // face like any run, the project is not one the owner made.
      scaffoldCodeProject(HARNESS_TEST_PROJECT_ID, "Harness Test");
      scaffoldCodeProject("notes", "Notes");
      const { projects } = await body();
      expect(projects.map((p) => p.folder)).toEqual(["notes"]);
    });

    it("does not read a project.json past the bound, and names the folder instead", async () => {
      // A delegated run writes whatever it likes into its folder, and the app
      // polls this listing: a project.json grown to gigabytes must not be
      // read into memory on every poll. Over the bound it is still a code
      // project — it just has no name the listing will trust.
      const bloated = path.join(codeProjectsDir, "bloated");
      fs.mkdirSync(bloated, { recursive: true });
      fs.writeFileSync(
        path.join(bloated, "project.json"),
        JSON.stringify({ projectId: "bloated", name: "Huge", padding: "x".repeat(80 * 1024) }),
      );
      // Under the bound, the name is read as before — the bound is not tight.
      const roomy = path.join(codeProjectsDir, "roomy");
      fs.mkdirSync(roomy, { recursive: true });
      fs.writeFileSync(
        path.join(roomy, "project.json"),
        JSON.stringify({ projectId: "roomy", name: "Roomy", padding: "x".repeat(48 * 1024) }),
      );

      const { projects } = await body();
      expect(projects.map((p) => [p.folder, p.kind, p.name])).toEqual([
        ["bloated", "codeProject", "bloated"],
        ["roomy", "codeProject", "Roomy"],
      ]);
    });

    it("never reports the checkout's own history as a git-less project's", async () => {
      // data/code-projects sits inside the ClawBox checkout. `git log` in a
      // folder with no repository of its own walks up to the nearest one —
      // and would answer with the OS's last commit.
      git(root, "init", "--quiet");
      git(root, "config", "user.name", "Test");
      git(root, "config", "user.email", "test@example.com");
      fs.writeFileSync(path.join(root, "README"), "clawbox");
      git(root, "add", "-A");
      git(root, "commit", "--quiet", "-m", "feat: the whole OS");
      scaffoldCodeProject("notes", "Notes");

      const { projects } = await body();
      expect(projects).toHaveLength(1);
      expect(projects[0].lastCommit).toBeNull();
    });

    it("attaches the run that was given the project's id", async () => {
      scaffoldCodeProject("notes", "Notes");
      fs.writeFileSync(
        path.join(root, "data", "coding-agent-runs.json"),
        JSON.stringify([{
          id: "run-byid00000", status: "running", startedAt: 3_000, task: "build it",
          directory: "/somewhere/it/was/resolved/to", projectId: "notes", completedAt: null, source: "agent",
        }]),
      );
      vi.resetModules();
      GET = (await import("@/app/setup-api/coding-agent/projects/route")).GET;
      const { projects } = await body();
      expect(projects[0].latestRun).toMatchObject({ id: "run-byid00000", status: "running" });
    });

    it("lists them even when the owner has set no project folder", async () => {
      writeConfig({});
      scaffoldCodeProject("notes", "Notes");
      vi.resetModules();
      GET = (await import("@/app/setup-api/coding-agent/projects/route")).GET;
      const { directory, projects } = await body();
      expect(directory).toBeNull();
      expect(projects.map((p) => p.folder)).toEqual(["notes"]);
    });

    it("lists each project once when the project folder has been pointed at them by hand", async () => {
      // config.json is a file the owner can edit; the route does not
      // re-validate the folder, it reads it.
      writeConfig({ coding_agent_default_directory: codeProjectsDir });
      makeRepo("timer", { commit: "one", projectName: "Timer", under: codeProjectsDir });
      vi.resetModules();
      GET = (await import("@/app/setup-api/coding-agent/projects/route")).GET;
      const { projects } = await body();
      expect(projects.map((p) => [p.folder, p.kind])).toEqual([["timer", "folder"]]);
    });
  });

  it("answers an empty list, naming the folder, when the project folder does not exist", async () => {
    const missing = path.join(home, "Nowhere");
    writeConfig({ coding_agent_default_directory: missing });
    vi.resetModules();
    GET = (await import("@/app/setup-api/coding-agent/projects/route")).GET;
    expect(await body()).toEqual({ directory: missing, projects: [] });
  });

  it("answers a null folder when none is set, so the app can say so in words", async () => {
    writeConfig({});
    vi.resetModules();
    GET = (await import("@/app/setup-api/coding-agent/projects/route")).GET;
    expect(await body()).toEqual({ directory: null, projects: [] });
  });

  describe("path safety", () => {
    it("never splices a folder name into a path under data/webapps, and never quotes it for a shell", async () => {
      // A name git and the filesystem accept but the desktop's app-id rule
      // does not. It is listed verbatim — the folder is real — but a
      // meta.json planted where a naive join would look is not evidence it
      // is on the desktop, and `git log` ran on it through argv.
      const hostile = "my app; touch $(pwned)";
      makeRepo(hostile, { commit: "hello" });
      putOnDesktop(hostile);
      const { projects } = await body();
      expect(projects).toHaveLength(1);
      expect(projects[0].folder).toBe(hostile);
      expect(projects[0].onDesktop).toBe(false);
      expect((projects[0].lastCommit as { subject: string }).subject).toBe("hello");
      expect(fs.existsSync(path.join(projectsDir, "pwned"))).toBe(false);
    });

    it("does not follow a symlink out of the project folder", async () => {
      const outside = path.join(home, "elsewhere");
      fs.mkdirSync(outside, { recursive: true });
      git(outside, "init", "--quiet");
      fs.symlinkSync(outside, path.join(projectsDir, "linked"));
      const { projects } = await body();
      expect(projects).toEqual([]);
    });

    it("does not count a .git FILE — a pointer into somebody else's repository", async () => {
      const dir = path.join(projectsDir, "worktree");
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, ".git"), "gitdir: /somewhere/else/.git/worktrees/worktree\n");
      const { projects } = await body();
      expect(projects).toEqual([]);
    });
  });
});
