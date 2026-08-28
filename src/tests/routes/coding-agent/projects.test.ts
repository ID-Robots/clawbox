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
    expect(site.latestRun).toBeNull();
    const commit = site.lastCommit as { subject: string; date: number };
    expect(commit.subject).toBe("Coding agent: add a dark mode toggle");
    expect(Math.abs(commit.date - Date.now())).toBeLessThan(60_000);

    // No project.json: the folder's own name. No commit yet: says so.
    expect(scratch.name).toBe("scratch");
    expect(scratch.lastCommit).toBeNull();
    expect(scratch.onDesktop).toBe(false);
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
