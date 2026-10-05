/**
 * Projects → GitHub backup end to end (TASK-1358), with REAL git.
 *
 * Only two things are stood in for: `gh` (an in-memory GitHub that knows
 * which repositories exist and makes a bare repository on this disk for each
 * one it "creates"), and github.com itself — the test's HOME carries
 * `url.<bare repos>.insteadOf = https://github.com/`, so the address the box
 * stores is the real `https://github.com/owner/name.git` while the push lands
 * in a bare repository the test can read. Everything else — init, the merged
 * .gitignore, the check before the commit, the commit, the push, a rejected
 * push — is git doing it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import type { ChildResult, RunChildOptions } from "@/lib/child-run";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const ROOT = `${fs.realpathSync(os.tmpdir())}/clawbox-project-backup-${process.pid}-${Date.now()}`;
const HOME = path.join(ROOT, "home");
const GIT_HOME = path.join(ROOT, "githome");
const GITHUB = path.join(ROOT, "github");
const ELSEWHERE = path.join(ROOT, "elsewhere");
const LOGIN = "demo-owner";
// Never written out whole (see project-backup-safety.test.ts).
const FAKE_GHP = ["ghp", "_", "Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2"].join("");

interface Call { bin: string; args: string[]; env: Record<string, string> }

const h = vi.hoisted(() => ({
  impl: null as null | ((bin: string, args: string[], opts: RunChildOptions) => Promise<ChildResult>),
}));

vi.mock("@/lib/child-run", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/child-run")>();
  return {
    ...actual,
    runChild: (bin: string, args: string[], opts: RunChildOptions) =>
      (h.impl ? h.impl(bin, args, opts) : actual.runChild(bin, args, opts)),
  };
});
vi.mock("@/lib/coding-agent", () => ({ getDefaultDirectory: async () => null }));

type Backup = typeof import("@/lib/project-backup");
type Folders = typeof import("@/lib/project-folders");
type Store = typeof import("@/lib/project-backup-store");
let backup: Backup;
let folders: Folders;
let store: Store;

let calls: Call[] = [];
const gh = { connected: true, privateRepos: true, existing: new Set<string>() };
const saved: Record<string, string | undefined> = {};

const result = (code: number, stdout = "", stderr = ""): ChildResult =>
  ({ code, stdout, stderr, signal: null, timedOut: false, startFailed: false, startError: null });

/** git as the TEST runs it: its own identity, the test HOME. */
function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    // Cast only because this repo's ProcessEnv augmentation insists on NODE_ENV,
    // which git has no use for (the same cast child-run.ts makes).
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: GIT_HOME,
      GIT_AUTHOR_NAME: "Tester", GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "Tester", GIT_COMMITTER_EMAIL: "t@example.invalid",
    } as unknown as NodeJS.ProcessEnv,
    encoding: "utf-8",
  }).trim();
}

function bare(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  sh(dir, "init", "-q", "--bare");
}

/** The stand-in for github.com, answering exactly the gh calls the box makes. */
function fakeGh(args: string[]): ChildResult {
  if (args[0] === "auth" && args[1] === "status") {
    return gh.connected
      ? result(0, "", `github.com\n  ✓ Logged in to github.com account ${LOGIN} (${GIT_HOME}/.config/gh/hosts.yml)`)
      : result(1, "", "You are not logged into any GitHub hosts. Run gh auth login to authenticate.");
  }
  if (args[0] === "api" && args.includes("POST") && args.includes("user/repos")) {
    const name = args.find((a) => a.startsWith("name="))!.slice(5);
    const full = `${LOGIN}/${name}`;
    if (gh.existing.has(full.toLowerCase())) return result(1, "", "gh: Repository creation failed. name already exists on this account (HTTP 422)");
    gh.existing.add(full.toLowerCase());
    bare(path.join(GITHUB, LOGIN, `${name}.git`));
    return result(0, JSON.stringify({ full_name: full, private: gh.privateRepos, html_url: `https://github.com/${full}` }));
  }
  const repo = args[0] === "api" ? /^repos\/([^/]+\/[^/]+)$/.exec(args[1] ?? "") : null;
  if (repo) {
    return gh.existing.has(repo[1].toLowerCase()) ? result(0, JSON.stringify({ full_name: repo[1] })) : result(1, "{}", "gh: Not Found (HTTP 404)");
  }
  return result(1, "", `unexpected gh call: ${args.join(" ")}`);
}

const project = (rel: string, files: Record<string, string> = { "index.html": "<h1>hi</h1>\n" }) => {
  const dir = path.join(HOME, rel);
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const treeOf = (bareDir: string, ref: string) => sh(bareDir, "ls-tree", "-r", "--name-only", ref).split("\n").filter(Boolean).sort();
const gitCalls = (sub: string) => calls.filter((c) => c.bin === "git" && c.args.includes(sub));

async function refusal(p: Promise<unknown>): Promise<{ code: string; extra: Record<string, unknown> }> {
  try {
    await p;
  } catch (err) {
    if (err instanceof backup.ProjectBackupError) return { code: err.code, extra: err.extra as Record<string, unknown> };
    throw err;
  }
  throw new Error("expected a refusal");
}

beforeAll(async () => {
  for (const key of ["FILES_ROOT", "CLAWBOX_ROOT", "HOME", "GH_TOKEN", "GITHUB_TOKEN"]) saved[key] = process.env[key];
  fs.mkdirSync(path.join(HOME, "clawbox", "data"), { recursive: true });
  fs.mkdirSync(GIT_HOME, { recursive: true });
  fs.mkdirSync(GITHUB, { recursive: true });
  // Pushes to github.com land in the bare repositories the fake gh made.
  fs.writeFileSync(path.join(GIT_HOME, ".gitconfig"), `[url "file://${GITHUB}/"]\n\tinsteadOf = https://github.com/\n[init]\n\tdefaultBranch = master\n`);
  process.env.FILES_ROOT = HOME;
  process.env.CLAWBOX_ROOT = path.join(HOME, "clawbox");
  process.env.HOME = GIT_HOME;
  // A token sitting in the server's own environment must never be handed on.
  process.env.GH_TOKEN = FAKE_GHP;
  process.env.GITHUB_TOKEN = FAKE_GHP;
  vi.resetModules();
  const actual = await vi.importActual<typeof import("@/lib/child-run")>("@/lib/child-run");
  h.impl = async (bin, args, opts) => {
    calls.push({ bin, args: [...args], env: { ...opts.env } });
    if (bin === "gh") return fakeGh(args);
    return actual.runChild(bin, args, opts);
  };
  backup = await import("@/lib/project-backup");
  folders = await import("@/lib/project-folders");
  store = await import("@/lib/project-backup-store");
});

afterAll(() => {
  h.impl = null;
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const name of fs.readdirSync(HOME)) if (name !== "clawbox") fs.rmSync(path.join(HOME, name), { recursive: true, force: true });
  fs.rmSync(GITHUB, { recursive: true, force: true });
  fs.mkdirSync(GITHUB, { recursive: true });
  fs.rmSync(ELSEWHERE, { recursive: true, force: true });
  const config = await import("@/lib/config-store");
  await config.set(folders.PROJECT_FOLDERS_CONFIG_KEY, []);
  await config.set(store.PROJECT_BACKUPS_CONFIG_KEY, []);
  gh.connected = true;
  gh.privateRepos = true;
  gh.existing = new Set();
  backup._resetProjectBackupForTest();
  calls = [];
});

/** Pin and back up a fresh project; answers its folder and the bare repository standing in for GitHub. */
async function backedUp(rel = "projects/site", files?: Record<string, string>) {
  const dir = project(rel, files);
  await folders.addProjectFolder(rel);
  const done = await backup.firstBackup(rel);
  return { dir, done, remote: path.join(GITHUB, `${done.repo}.git`) };
}

describe("the first backup", () => {
  it("makes a PRIVATE copy named after the folder, leaves secrets and big files out, and puts no token anywhere", async () => {
    const dir = project("projects/My Site", {
      "index.html": "<h1>hi</h1>\n",
      "src/app.js": "console.log('hi')\n",
      ".env": "PASSWORD=hunter2\n",
      "src/config.js": `export const token = "${FAKE_GHP}";\n`,
      "node_modules/x/index.js": "module.exports = 1\n",
    });
    fs.writeFileSync(path.join(dir, "big.bin"), "");
    fs.truncateSync(path.join(dir, "big.bin"), 60 * 1024 * 1024);
    await folders.addProjectFolder("projects/My Site");

    const before = await backup.folderBackupStatus("projects/My Site");
    expect(before).toMatchObject({ state: "not_set_up", isRepo: false, suggestedName: "My-Site", github: { connected: true, login: LOGIN } });
    expect(before.takenName).toBeUndefined();
    expect(fs.existsSync(path.join(dir, ".git"))).toBe(false); // reading never starts a repository

    const done = await backup.firstBackup("projects/My Site", { name: before.suggestedName });
    expect(done).toMatchObject({ ok: true, nothingChanged: false, repo: `${LOGIN}/My-Site`, files: 3 });
    expect(done.leftOut).toEqual(expect.arrayContaining([
      { path: ".env", reason: "secret_name" },
      { path: "src/config.js", reason: "secret_content" },
      { path: "big.bin", reason: "too_large" },
    ]));
    expect(done.leftOut).toHaveLength(3);

    // Created private, by the API, without a push in the same breath.
    const create = calls.find((c) => c.bin === "gh" && c.args.includes("user/repos"))!;
    expect(create.args).toEqual(expect.arrayContaining(["-X", "POST", "name=My-Site", "-F", "private=true"]));

    // What reached "GitHub": the safe files and the merged .gitignore — on main, whatever git's default.
    const remote = path.join(GITHUB, LOGIN, "My-Site.git");
    expect(treeOf(remote, "main")).toEqual([".gitignore", "index.html", "src/app.js"]);
    const ignore = fs.readFileSync(path.join(dir, ".gitignore"), "utf-8");
    for (const p of [".env*", "node_modules/", "*.pem", "*.gguf"]) expect(ignore).toContain(p);
    expect(sh(remote, "log", "-1", "--format=%s", "main")).toMatch(/^Backup from ClawBox, \d{1,2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}$/);

    // The address the box stores is the plain https one; no token in it or anywhere in .git/config.
    // Read from the config: `remote get-url` would apply the test's own insteadOf.
    expect(sh(dir, "config", "--get", "remote.origin.url")).toBe(`https://github.com/${LOGIN}/My-Site.git`);
    const gitConfig = fs.readFileSync(path.join(dir, ".git", "config"), "utf-8");
    expect(gitConfig).not.toContain(FAKE_GHP);
    expect(gitConfig).not.toMatch(/@github\.com|token|password/i);

    // Not in argv, not in the environment of any child, never forced.
    for (const c of calls) {
      expect(c.args.join(" "), c.args.join(" ")).not.toContain(FAKE_GHP);
      expect(Object.keys(c.env)).not.toContain("GH_TOKEN");
      expect(Object.keys(c.env)).not.toContain("GITHUB_TOKEN");
      expect(Object.values(c.env).join(" ")).not.toContain(FAKE_GHP);
    }
    const pushes = gitCalls("push");
    expect(pushes).toHaveLength(1);
    for (const p of pushes) {
      expect(p.args).not.toEqual(expect.arrayContaining(["--force"]));
      expect(p.args.some((a) => a === "-f" || a.startsWith("--force") || a.startsWith("+"))).toBe(false);
      // git asks gh for the credential through the helper — the helper's NAME is on the command line, never a secret.
      expect(p.args).toContain("credential.https://github.com.helper=!gh auth git-credential");
    }

    const status = await backup.folderBackupStatus("projects/My Site");
    expect(status).toMatchObject({
      state: "backed_up",
      repo: { fullName: `${LOGIN}/My-Site`, webUrl: `https://github.com/${LOGIN}/My-Site`, branch: "main" },
      auto: false,
      pending: { files: 0 },
    });
    expect(status.history).toHaveLength(1);
    expect(status.history[0].files).toBe(3);
    expect(status.lastLeftOut).toHaveLength(3);
    // The left-out files are still on the box, untouched.
    expect(fs.readFileSync(path.join(dir, ".env"), "utf-8")).toBe("PASSWORD=hunter2\n");
  });

  it("never pushes into a name GitHub already has: the next free -2 is offered and nothing is created", async () => {
    gh.existing.add(`${LOGIN}/site`);
    const dir = project("projects/site");
    await folders.addProjectFolder("projects/site");

    const status = await backup.folderBackupStatus("projects/site");
    expect(status).toMatchObject({ suggestedName: "site-2", takenName: "site" });

    const out = await refusal(backup.firstBackup("projects/site", { name: "site" }));
    expect(out).toEqual({ code: "name_taken", extra: { takenName: "site", suggestedName: "site-2" } });
    expect(calls.some((c) => c.bin === "gh" && c.args.includes("user/repos"))).toBe(false);
    expect(gitCalls("push")).toHaveLength(0);
    expect(fs.existsSync(path.join(dir, ".git"))).toBe(false);

    const done = await backup.firstBackup("projects/site", { name: "site-2" });
    expect(done.repo).toBe(`${LOGIN}/site-2`);
    expect(fs.existsSync(path.join(GITHUB, LOGIN, "site.git"))).toBe(false);
  });

  it("answers a race on the name (taken between the check and the create) the same way", async () => {
    project("projects/site");
    await folders.addProjectFolder("projects/site");
    // The name is free when asked, and gone by the time the create goes out.
    const realHas = gh.existing.has.bind(gh.existing);
    let asked = 0;
    gh.existing.has = (k: string) => {
      if (k === `${LOGIN}/site` && asked++ === 0) return false;
      return realHas(k) || k === `${LOGIN}/site`;
    };
    const out = await refusal(backup.firstBackup("projects/site"));
    expect(out.code).toBe("name_taken");
    expect(out.extra.suggestedName).toBe("site-2");
    expect(gitCalls("push")).toHaveLength(0);
  });

  it("uploads a folder's own local history as it is, onto a new private copy", async () => {
    const dir = project("projects/notes", { "a.md": "a\n" });
    sh(dir, "init", "-q", "-b", "trunk");
    sh(dir, "add", "a.md");
    sh(dir, "commit", "-q", "-m", "my own first commit");
    await folders.addProjectFolder("projects/notes");
    expect(await backup.folderBackupStatus("projects/notes")).toMatchObject({ state: "not_set_up", isRepo: true });
    const done = await backup.firstBackup("projects/notes");
    const remote = path.join(GITHUB, `${done.repo}.git`);
    expect(sh(remote, "log", "--format=%s", "trunk").split("\n")).toEqual([expect.stringMatching(/^Backup from ClawBox/), "my own first commit"]);
    expect(sh(dir, "symbolic-ref", "--short", "HEAD")).toBe("trunk");
  });

  it("stops before anything is touched when GitHub is not connected", async () => {
    gh.connected = false;
    const dir = project("projects/site");
    await folders.addProjectFolder("projects/site");
    expect((await refusal(backup.firstBackup("projects/site"))).code).toBe("not_connected");
    expect(fs.existsSync(path.join(dir, ".git"))).toBe(false);
  });

  it("uploads nothing when GitHub did not make the copy private", async () => {
    gh.privateRepos = false;
    project("projects/site");
    await folders.addProjectFolder("projects/site");
    expect((await refusal(backup.firstBackup("projects/site"))).code).toBe("not_private");
    expect(gitCalls("push")).toHaveLength(0);
  });
});

describe("Back up now, on a copy ClawBox made", () => {
  it("commits what changed with a dated message, adds it to History, and sends nothing when nothing changed", async () => {
    const { dir, remote } = await backedUp();
    fs.writeFileSync(path.join(dir, "index.html"), "<h1>changed</h1>\n");
    fs.writeFileSync(path.join(dir, "page.html"), "<p>new</p>\n");
    expect((await backup.folderBackupStatus("projects/site")).pending).toEqual({ files: 2, leftOut: [] });

    const done = await backup.backUpNow("projects/site");
    expect(done).toMatchObject({ ok: true, nothingChanged: false, files: 2 });
    expect(treeOf(remote, "main")).toContain("page.html");
    expect(sh(remote, "log", "-1", "--format=%s", "main")).toMatch(/^Backup from ClawBox, /);
    expect((await backup.folderBackupStatus("projects/site")).history.map((e) => e.files)).toEqual([2, 2]);

    calls = [];
    const again = await backup.backUpNow("projects/site");
    expect(again).toMatchObject({ nothingChanged: true, files: 0 });
    expect(gitCalls("push")).toHaveLength(0);
    expect(gitCalls("commit")).toHaveLength(0);
  });

  it("finishes an upload that failed last time", async () => {
    const { dir, remote } = await backedUp();
    fs.writeFileSync(path.join(dir, "later.txt"), "x\n");
    // GitHub unreachable for one push: the commit is made, the upload is not.
    fs.renameSync(remote, `${remote}.away`);
    expect((await refusal(backup.backUpNow("projects/site"))).code).toMatch(/push_auth|failed|gh_unreachable/);
    fs.renameSync(`${remote}.away`, remote);
    expect(treeOf(remote, "main")).not.toContain("later.txt");
    const done = await backup.backUpNow("projects/site");
    expect(done.nothingChanged).toBe(false);
    expect(treeOf(remote, "main")).toContain("later.txt");
  });

  it("keeps a token added to a file later out of the copy", async () => {
    const { dir, remote } = await backedUp();
    fs.writeFileSync(path.join(dir, "settings.js"), `const key = "${FAKE_GHP}";\n`);
    fs.writeFileSync(path.join(dir, "ok.txt"), "fine\n");
    const done = await backup.backUpNow("projects/site");
    expect(done.leftOut).toEqual([{ path: "settings.js", reason: "secret_content" }]);
    expect(treeOf(remote, "main")).toContain("ok.txt");
    expect(treeOf(remote, "main")).not.toContain("settings.js");
  });
});

describe("a folder that already uses git with its own remote", () => {
  /** A project cloned from a remote that is not ClawBox's, on a branch called trunk. */
  function cloned(rel = "work/lib") {
    const origin = path.join(ELSEWHERE, "lib.git");
    bare(origin);
    const seed = path.join(ELSEWHERE, "seed");
    fs.mkdirSync(seed, { recursive: true });
    sh(seed, "init", "-q", "-b", "trunk");
    fs.writeFileSync(path.join(seed, "lib.py"), "print(1)\n");
    sh(seed, "add", ".");
    sh(seed, "commit", "-q", "-m", "seed");
    sh(seed, "remote", "add", "origin", origin);
    sh(seed, "push", "-q", "-u", "origin", "trunk");
    const dir = path.join(HOME, rel);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    sh(path.dirname(dir), "clone", "-q", "-b", "trunk", origin, path.basename(dir));
    return { dir, origin, seed };
  }

  it("never changes the remote or the branch: Back up now commits and pushes to them, never forced", async () => {
    const { dir, origin } = cloned();
    await folders.addProjectFolder("work/lib");
    const status = await backup.folderBackupStatus("work/lib");
    expect(status).toMatchObject({ state: "existing_git", remote: { branch: "trunk", webUrl: null } });
    expect(status.remote!.label).toContain("elsewhere/lib");
    expect(status.history).toEqual([]);

    fs.writeFileSync(path.join(dir, "lib.py"), "print(2)\n");
    fs.writeFileSync(path.join(dir, ".env"), "SECRET=1\n");
    const done = await backup.backUpNow("work/lib");
    expect(done).toMatchObject({ ok: true, files: 1, leftOut: [{ path: ".env", reason: "secret_name" }] });

    expect(sh(origin, "show", "trunk:lib.py")).toBe("print(2)");
    expect(sh(dir, "remote", "get-url", "origin")).toBe(origin);
    expect(sh(dir, "remote")).toBe("origin");
    expect(sh(dir, "symbolic-ref", "--short", "HEAD")).toBe("trunk");
    // The owner's tracked files are not edited: the safe list went to .git/info/exclude.
    expect(fs.existsSync(path.join(dir, ".gitignore"))).toBe(false);
    expect(fs.readFileSync(path.join(dir, ".git", "info", "exclude"), "utf-8")).toContain(".env*");
    // No gh involved in a push to a remote that is not ClawBox's, and no helper override either.
    for (const p of gitCalls("push")) {
      expect(p.args.some((a) => a.startsWith("credential."))).toBe(false);
      expect(p.args.some((a) => a === "-f" || a.startsWith("--force") || a.startsWith("+"))).toBe(false);
    }
    expect(gitCalls("remote").some((c) => c.args.includes("add") || c.args.includes("set-url") || c.args.includes("remove"))).toBe(false);
    const after = await backup.folderBackupStatus("work/lib");
    expect(after.state).toBe("existing_git");
    expect(after.history).toHaveLength(1);
  });

  it("explains a push the remote rejects (it moved on) and stops: nothing forced, the remote keeps its history", async () => {
    const { dir, origin, seed } = cloned();
    await folders.addProjectFolder("work/lib");
    // Someone pushes from another computer.
    fs.writeFileSync(path.join(seed, "other.py"), "x\n");
    sh(seed, "add", ".");
    sh(seed, "commit", "-q", "-m", "from another computer");
    sh(seed, "push", "-q", "origin", "trunk");
    const theirs = sh(origin, "rev-parse", "trunk");

    fs.writeFileSync(path.join(dir, "mine.py"), "y\n");
    const out = await refusal(backup.backUpNow("work/lib"));
    expect(out.code).toBe("remote_ahead");
    expect(String(out.extra.detail)).toMatch(/rejected|fetch first|non-fast-forward/);
    expect(sh(origin, "rev-parse", "trunk")).toBe(theirs);
    // The owner's change is safe in a local version, and nothing tried to merge or rewrite.
    expect(sh(dir, "log", "-1", "--format=%s")).toMatch(/^Backup from ClawBox/);
    for (const c of calls.filter((x) => x.bin === "git")) {
      expect(c.args.some((a) => ["pull", "merge", "rebase", "fetch", "reset", "checkout", "switch"].includes(a)), c.args.join(" ")).toBe(false);
    }
  });

  it("shows where the remote is without the password the address carries", async () => {
    const dir = project("work/site");
    sh(dir, "init", "-q", "-b", "main");
    sh(dir, "add", ".");
    sh(dir, "commit", "-q", "-m", "x");
    sh(dir, "remote", "add", "origin", `https://someone:${FAKE_GHP}@example.invalid/acme/site.git`);
    await folders.addProjectFolder("work/site");
    const status = await backup.folderBackupStatus("work/site");
    expect(status.remote).toEqual({ label: "example.invalid/acme/site", webUrl: null, branch: "main" });
    expect(JSON.stringify(status)).not.toContain(FAKE_GHP);
    expect(JSON.stringify(status)).not.toContain("someone");
    const overview = await backup.backupOverview();
    expect(overview.folders).toEqual([{ path: "work/site", state: "existing_git", lastBackupAt: null, auto: false }]);
  });
});

describe("which folders", () => {
  it("refuses the box's own state folders, the same rule as a pin", async () => {
    expect((await refusal(backup.firstBackup("clawbox/data"))).code).toBe("protected");
    expect((await refusal(backup.folderBackupStatus("clawbox/data"))).code).toBe("protected");
    expect((await refusal(backup.backUpNow("clawbox"))).code).toBe("protected");
  });

  it("backs up pinned project folders only, and nothing outside the home folder", async () => {
    project("projects/loose");
    expect((await refusal(backup.firstBackup("projects/loose"))).code).toBe("not_pinned");
    expect((await refusal(backup.folderBackupStatus("../outside"))).code).toBe("not_pinned");
    expect((await refusal(backup.firstBackup(42))).code).toBe("invalid");
    expect((await refusal(backup.firstBackup("projects/gone"))).code).toBe("missing");
  });

  it("refuses a folder inside a bigger project, and allows one its parent ignores", async () => {
    const big = project("big", { "README.md": "x\n", ".gitignore": "scratch/\n", "sub/a.txt": "a\n", "scratch/proj/b.txt": "b\n" });
    sh(big, "init", "-q");
    sh(big, "add", ".");
    sh(big, "commit", "-q", "-m", "x");
    await folders.addProjectFolder("big/sub");
    await folders.addProjectFolder("big/scratch/proj");
    expect(await backup.folderBackupStatus("big/sub")).toMatchObject({ state: "refused", refusal: { code: "inside_repo", parent: "big" } });
    expect((await refusal(backup.firstBackup("big/sub"))).code).toBe("inside_repo");
    expect(fs.existsSync(path.join(big, "sub", ".git"))).toBe(false);
    expect((await backup.folderBackupStatus("big/scratch/proj")).state).toBe("not_set_up");
  });

  it("carries the backup along when the folder is renamed", async () => {
    await backedUp("projects/site");
    fs.renameSync(path.join(HOME, "projects/site"), path.join(HOME, "projects/website"));
    await folders.followMovedProjectFolders([{ from: "projects/site", to: "projects/website" }]);
    expect((await store.getBackupRecord("projects/website"))?.repo).toBe(`${LOGIN}/site`);
    expect(await store.getBackupRecord("projects/site")).toBeNull();
    expect((await backup.folderBackupStatus("projects/website")).state).toBe("backed_up");
  });
});

describe("disconnect, daily backup", () => {
  it("disconnect takes off the remote ClawBox added; the copy on GitHub and the local history stay", async () => {
    const { dir, remote } = await backedUp();
    const out = await backup.disconnectFolder("projects/site");
    expect(out).toEqual({ removedRemote: true });
    expect(sh(dir, "remote")).toBe("");
    expect(fs.existsSync(path.join(dir, ".git"))).toBe(true);
    expect(fs.existsSync(remote)).toBe(true);
    expect(calls.some((c) => c.bin === "gh" && c.args.some((a) => /DELETE|delete/.test(a)))).toBe(false);
    expect(await store.getBackupRecord("projects/site")).toBeNull();
    expect(await backup.folderBackupStatus("projects/site")).toMatchObject({ state: "not_set_up", isRepo: true });
  });

  it("disconnect never touches a remote the folder brought", async () => {
    const dir = project("work/lib");
    sh(dir, "init", "-q", "-b", "main");
    sh(dir, "add", ".");
    sh(dir, "commit", "-q", "-m", "x");
    const origin = path.join(ELSEWHERE, "lib.git");
    bare(origin);
    sh(dir, "remote", "add", "origin", origin);
    await folders.addProjectFolder("work/lib");
    await backup.backUpNow("work/lib");
    await backup.disconnectFolder("work/lib");
    expect(sh(dir, "remote", "get-url", "origin")).toBe(origin);
  });

  it("runs once a day per folder, only when it is switched on and only when something changed", async () => {
    const { dir, remote } = await backedUp();
    expect((await refusal(backup.setAutoBackup("projects/site", "yes"))).code).toBe("invalid");
    expect(await backup.runDueAutoBackups(Date.now() + 2 * 86_400_000)).toBe(0); // off by default
    expect(await backup.setAutoBackup("projects/site", true)).toEqual({ auto: true });

    expect(await backup.runDueAutoBackups(Date.now())).toBe(0); // backed up a moment ago: not due

    calls = [];
    expect(await backup.runDueAutoBackups(Date.now() + 25 * 3_600_000)).toBe(1);
    expect(gitCalls("push")).toHaveLength(0); // nothing changed, nothing sent
    const looked = await store.getBackupRecord("projects/site");
    expect(looked?.lastAutoRunAt).toBeGreaterThan(0);
    expect(looked?.history).toHaveLength(1);

    fs.writeFileSync(path.join(dir, "daily.txt"), "x\n");
    expect(await backup.runDueAutoBackups(Date.now() + 50 * 3_600_000)).toBe(1);
    expect(treeOf(remote, "main")).toContain("daily.txt");
    expect((await store.getBackupRecord("projects/site"))?.history).toHaveLength(2);
  });

  it("records why a daily backup could not run, for the panel to say", async () => {
    await backedUp();
    await backup.setAutoBackup("projects/site", true);
    gh.connected = false;
    expect(await backup.runDueAutoBackups(Date.now() + 25 * 3_600_000)).toBe(1);
    expect((await store.getBackupRecord("projects/site"))?.lastAutoError?.code).toBe("not_connected");
  });

  it("only offers the daily switch for a copy ClawBox made", async () => {
    project("projects/plain");
    await folders.addProjectFolder("projects/plain");
    expect((await refusal(backup.setAutoBackup("projects/plain", true))).code).toBe("not_set_up");
  });
});

describe("the overview the Projects list reads", () => {
  it("names each pinned folder's state from the box's records, and the suggestion's dismissal", async () => {
    await backedUp("projects/site");
    project("projects/plain");
    await folders.addProjectFolder("projects/plain");
    await store.dismissSuggestion(1_000);
    const overview = await backup.backupOverview();
    expect(overview.github).toEqual({ installed: true, connected: true, login: LOGIN });
    expect(overview.suggestionDismissedAt).toBe(1_000);
    expect(overview.folders).toEqual([
      { path: "projects/site", state: "backed_up", lastBackupAt: expect.any(Number), auto: false },
      { path: "projects/plain", state: "none", lastBackupAt: null, auto: false },
    ]);
  });
});
