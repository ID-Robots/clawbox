/**
 * @vitest-environment node
 *
 * Importing a project into the owner's project folder: a copy of a folder
 * on the box (real fs, real git) and a clone of a GitHub repository (gh
 * stubbed — the network is not under test, the fences and the outcomes are).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";

// Starts real git processes: the 5 s default is not enough on a loaded runner.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const githubStatus = vi.hoisted(() => vi.fn());
vi.mock("@/lib/coding-github", async () => {
  const actual = await vi.importActual<typeof import("@/lib/coding-github")>("@/lib/coding-github");
  return { ...actual, githubStatus };
});

/** What each gh invocation answers, matched on its argv joined by spaces. */
const ghAnswers = vi.hoisted(() => new Map<string, { code: number; stdout?: string; stderr?: string }>());
const ghCalls = vi.hoisted(() => [] as string[][]);
vi.mock("@/lib/child-run", async () => {
  const actual = await vi.importActual<typeof import("@/lib/child-run")>("@/lib/child-run");
  return {
    ...actual,
    runChild: async (bin: string, args: string[], opts: Parameters<typeof actual.runChild>[2]) => {
      if (bin !== "gh") return actual.runChild(bin, args, opts);
      ghCalls.push(args);
      const key = [...ghAnswers.keys()].find((k) => args.join(" ").startsWith(k));
      const a = key ? ghAnswers.get(key)! : { code: 1, stderr: "no answer scripted" };
      // A scripted clone makes the folder the way a real one would.
      if (args[0] === "repo" && args[1] === "clone" && a.code === 0) {
        fs.mkdirSync(path.join(args[3], ".git"), { recursive: true });
        fs.writeFileSync(path.join(args[3], "README.md"), "cloned\n");
      }
      return { code: a.code, stdout: a.stdout ?? "", stderr: a.stderr ?? "", signal: null, timedOut: false, startFailed: false, startError: null };
    },
  };
});

let lib: typeof import("@/lib/project-import");
let base: string;
let home: string;
let projects: string;
let restore: () => void;

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf-8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: home } }).trim();
}

beforeEach(async () => {
  restore = saveEnv("HOME", "CLAWBOX_ROOT");
  base = fs.mkdtempSync(path.join(os.tmpdir(), "project-import-"));
  home = path.join(base, "home");
  projects = path.join(home, "Projects");
  fs.mkdirSync(path.join(home, "clawbox", "data"), { recursive: true });
  fs.mkdirSync(projects, { recursive: true });
  process.env.HOME = home;
  process.env.CLAWBOX_ROOT = path.join(home, "clawbox");
  ghAnswers.clear();
  ghCalls.length = 0;
  githubStatus.mockResolvedValue({ installed: true, connected: true, login: "yalexx", loginCommand: "gh auth login" });
  vi.resetModules();
  lib = await import("@/lib/project-import");
});

afterEach(() => {
  restore();
  fs.rmSync(base, { recursive: true, force: true });
});

describe("importFolderName", () => {
  it("makes a folder name GitHub and the project folder both accept", () => {
    expect(lib.importFolderName("/home/x/My Old Site")).toBe("My-Old-Site");
    expect(lib.importFolderName("tinder-clone.git")).toBe("tinder-clone");
    expect(lib.importFolderName("../../etc")).toBe("etc");
    expect(lib.importFolderName("///")).toBe("project");
    expect(lib.importFolderName("x".repeat(100))).toHaveLength(64);
  });
});

describe("importFolder", () => {
  function makeSource(name: string, opts: { git?: boolean; nodeModules?: boolean } = {}): string {
    const dir = path.join(home, name);
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "index.js"), "console.log(1)\n");
    fs.writeFileSync(path.join(dir, "README.md"), "# hi\n");
    if (opts.nodeModules) {
      fs.mkdirSync(path.join(dir, "node_modules", "left-pad"), { recursive: true });
      fs.writeFileSync(path.join(dir, "node_modules", "left-pad", "index.js"), "x");
    }
    if (opts.git) {
      git(dir, "init", "--quiet");
      git(dir, "config", "user.name", "T");
      git(dir, "config", "user.email", "t@example.com");
      git(dir, "add", "-A");
      git(dir, "commit", "--quiet", "-m", "theirs");
    }
    return dir;
  }

  it("copies the folder into the project folder, leaves node_modules behind and gives it a repository", async () => {
    const src = makeSource("old-site", { nodeModules: true });
    const out = await lib.importFolder({ source: src, projectsRoot: projects });
    expect(out).toMatchObject({ ok: true, folder: "old-site", directory: path.join(projects, "old-site"), initialized: true, skipped: ["node_modules"] });
    expect(fs.readFileSync(path.join(projects, "old-site", "src", "index.js"), "utf-8")).toBe("console.log(1)\n");
    expect(fs.existsSync(path.join(projects, "old-site", "node_modules"))).toBe(false);
    expect(git(path.join(projects, "old-site"), "log", "--oneline")).toMatch(/Imported from /);
    // The source is exactly as it was.
    expect(fs.existsSync(path.join(src, "node_modules", "left-pad", "index.js"))).toBe(true);
  });

  it("keeps a folder's own history rather than starting one", async () => {
    const src = makeSource("with-git", { git: true });
    const out = await lib.importFolder({ source: src, projectsRoot: projects });
    expect(out).toMatchObject({ ok: true, initialized: false });
    expect(git(path.join(projects, "with-git"), "log", "--oneline")).toMatch(/theirs/);
  });

  it("expands ~ the way the Terminal would", async () => {
    makeSource("tilde");
    const out = await lib.importFolder({ source: "~/tilde", projectsRoot: projects });
    expect(out).toMatchObject({ ok: true, folder: "tilde" });
  });

  it("refuses without a project folder, a relative path, a missing folder and a file", async () => {
    const src = makeSource("s");
    expect(await lib.importFolder({ source: src, projectsRoot: null })).toMatchObject({ ok: false, reason: "no_project_folder" });
    expect(await lib.importFolder({ source: "old-site", projectsRoot: projects })).toMatchObject({ ok: false, reason: "invalid" });
    expect(await lib.importFolder({ source: path.join(home, "nope"), projectsRoot: projects })).toMatchObject({ ok: false, reason: "not_found" });
    expect(await lib.importFolder({ source: path.join(src, "README.md"), projectsRoot: projects })).toMatchObject({ ok: false, reason: "not_a_folder" });
  });

  it("refuses the ClawBox checkout, its data folder, the project folder itself, a project in it, and a parent of it", async () => {
    const checkout = path.join(home, "clawbox");
    fs.mkdirSync(path.join(checkout, "src"), { recursive: true });
    expect(await lib.importFolder({ source: checkout, projectsRoot: projects })).toMatchObject({ ok: false, reason: "refused" });
    expect(await lib.importFolder({ source: path.join(checkout, "data"), projectsRoot: projects })).toMatchObject({ ok: false, reason: "refused" });
    expect(await lib.importFolder({ source: projects, projectsRoot: projects })).toMatchObject({ ok: false, reason: "refused" });
    fs.mkdirSync(path.join(projects, "already"), { recursive: true });
    expect(await lib.importFolder({ source: path.join(projects, "already"), projectsRoot: projects })).toMatchObject({ ok: false, reason: "refused" });
    expect(await lib.importFolder({ source: home, projectsRoot: projects })).toMatchObject({ ok: false, reason: "refused" });
    // The credential stores are never a project.
    fs.mkdirSync(path.join(home, ".ssh"), { recursive: true });
    expect(await lib.importFolder({ source: path.join(home, ".ssh"), projectsRoot: projects })).toMatchObject({ ok: false, reason: "refused" });
  });

  it("never merges into a name already taken", async () => {
    const src = makeSource("taken");
    fs.mkdirSync(path.join(projects, "taken"));
    fs.writeFileSync(path.join(projects, "taken", "keep.txt"), "mine");
    expect(await lib.importFolder({ source: src, projectsRoot: projects })).toMatchObject({ ok: false, reason: "exists" });
    expect(fs.readFileSync(path.join(projects, "taken", "keep.txt"), "utf-8")).toBe("mine");
    expect(fs.existsSync(path.join(projects, "taken", "README.md"))).toBe(false);
  });

  it("copies a link inside the source as a link, never as what it points at", async () => {
    const src = makeSource("linky");
    fs.symlinkSync(path.join(home, "clawbox"), path.join(src, "escape"));
    const out = await lib.importFolder({ source: src, projectsRoot: projects });
    expect(out.ok).toBe(true);
    expect(fs.lstatSync(path.join(projects, "linky", "escape")).isSymbolicLink()).toBe(true);
  });
});

describe("listGitHubRepos", () => {
  const page = (rows: unknown[]) => JSON.stringify(rows);
  const repo = (full: string, extra: Record<string, unknown> = {}) => ({
    full_name: full, name: full.split("/")[1], owner: { login: full.split("/")[0] }, private: false, pushed_at: "2026-09-01T00:00:00Z", default_branch: "main", ...extra,
  });

  it("lists what the account can see, newest push first, and flags the ClawBox apps", async () => {
    ghAnswers.set("api user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member&page=1", {
      code: 0, stdout: page([repo("yalexx/tinder-clone", { description: "Swipe", private: true }), repo("ID-Robots/clawbox"), { junk: true }]),
    });
    ghAnswers.set("api -X GET search/code", {
      code: 0, stdout: JSON.stringify({ items: [{ name: "clawbox.json", path: "clawbox.json", repository: { full_name: "yalexx/tinder-clone" } }, { name: "clawbox.json", path: "fixtures/clawbox.json", repository: { full_name: "ID-Robots/clawbox" } }] }),
    });
    const out = await lib.listGitHubRepos();
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(out.login).toBe("yalexx");
    expect(out.truncated).toBe(false);
    expect(out.repos).toEqual([
      { fullName: "yalexx/tinder-clone", name: "tinder-clone", owner: "yalexx", description: "Swipe", private: true, pushedAt: "2026-09-01T00:00:00Z", defaultBranch: "main", clawboxApp: true, folder: "tinder-clone" },
      // A clawbox.json three folders deep is a fixture, not the manifest.
      { fullName: "ID-Robots/clawbox", name: "clawbox", owner: "ID-Robots", description: null, private: false, pushedAt: "2026-09-01T00:00:00Z", defaultBranch: "main", clawboxApp: false, folder: "clawbox" },
    ]);
    // One search over every owner in the listing.
    const search = ghCalls.find((c) => c.includes("search/code"))!;
    expect(search.join(" ")).toContain("q=filename:clawbox.json user:yalexx user:ID-Robots");
  });

  it("says null for the app flag when the code search would not answer", async () => {
    ghAnswers.set("api user/repos", { code: 0, stdout: page([repo("yalexx/a")]) });
    ghAnswers.set("api -X GET search/code", { code: 1, stderr: "rate limited" });
    const out = await lib.listGitHubRepos();
    if (!out.ok) throw new Error("unreachable");
    expect(out.repos[0].clawboxApp).toBeNull();
  });

  it("answers the account's state before asking GitHub anything", async () => {
    githubStatus.mockResolvedValueOnce({ installed: true, connected: false, login: null, loginCommand: "x" });
    expect(await lib.listGitHubRepos()).toMatchObject({ ok: false, reason: "not_connected" });
    githubStatus.mockResolvedValueOnce({ installed: false, connected: false, login: null, loginCommand: "x", reason: "not_installed" });
    expect(await lib.listGitHubRepos()).toMatchObject({ ok: false, reason: "no_gh" });
    githubStatus.mockResolvedValueOnce({ installed: true, connected: false, login: null, loginCommand: "x", reason: "unreachable" });
    expect(await lib.listGitHubRepos()).toMatchObject({ ok: false, reason: "gh_unreachable" });
    expect(ghCalls).toEqual([]);
  });
});

describe("importGitHubRepo", () => {
  it("clones into the project folder under the repository's name", async () => {
    ghAnswers.set("repo clone yalexx/tinder-clone", { code: 0 });
    const out = await lib.importGitHubRepo({ fullName: "yalexx/tinder-clone", projectsRoot: projects });
    expect(out).toMatchObject({ ok: true, folder: "tinder-clone", directory: path.join(projects, "tinder-clone"), initialized: false });
    expect(ghCalls[0]).toEqual(["repo", "clone", "yalexx/tinder-clone", path.join(projects, "tinder-clone"), "--", "--quiet"]);
  });

  it("refuses a name that is not owner/name, a taken folder, and a disconnected account", async () => {
    expect(await lib.importGitHubRepo({ fullName: "../etc", projectsRoot: projects })).toMatchObject({ ok: false, reason: "invalid" });
    expect(await lib.importGitHubRepo({ fullName: "yalexx/../x", projectsRoot: projects })).toMatchObject({ ok: false, reason: "invalid" });
    fs.mkdirSync(path.join(projects, "taken"));
    expect(await lib.importGitHubRepo({ fullName: "yalexx/taken", projectsRoot: projects })).toMatchObject({ ok: false, reason: "exists" });
    githubStatus.mockResolvedValueOnce({ installed: true, connected: false, login: null, loginCommand: "x" });
    expect(await lib.importGitHubRepo({ fullName: "yalexx/a", projectsRoot: projects })).toMatchObject({ ok: false, reason: "not_connected" });
    expect(ghCalls).toEqual([]);
  });

  it("leaves nothing behind when the clone fails", async () => {
    ghAnswers.set("repo clone yalexx/gone", { code: 1, stderr: "GraphQL: Could not resolve to a Repository" });
    const out = await lib.importGitHubRepo({ fullName: "yalexx/gone", projectsRoot: projects });
    expect(out).toMatchObject({ ok: false, reason: "failed" });
    if (out.ok) throw new Error("unreachable");
    expect(out.detail).toContain("Could not resolve");
    expect(fs.existsSync(path.join(projects, "gone"))).toBe(false);
  });
});
