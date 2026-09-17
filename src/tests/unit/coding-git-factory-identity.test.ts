/**
 * The factory git identity, taken off the box at boot.
 *
 * THE DEFECT THIS PINS. The Jetson golden flash image ships a personal git
 * identity in the clawbox user's own `~/.gitconfig` — `user.name = yalexx`,
 * `user.email = yanko@idrobots.com`. git layers the global file under every
 * project that has no identity of its own, so on a freshly flashed box the
 * coding agent's first commit for its owner was authored
 * `yalexx <yanko@idrobots.com>`: every box in the field committing as a member
 * of staff.
 *
 * What is asserted here is the three things the fix has to be: the factory
 * identity is REMOVED, any other identity is KEPT, and running it again changes
 * nothing. Beside them the two properties that keep it from being a blunt
 * instrument — a repository's own `.git/config` is never touched, and each key
 * is judged on its own value — and the end of the chain it exists for: with the
 * global identity gone, `resolveCodingGitIdentity` falls through to the owner's
 * setting and then to the placeholder, exactly as designed.
 *
 * Real git against a throwaway HOME, like its neighbour
 * coding-git-identity.test.ts: the thing under test is what git stores and what
 * git reads back, and a mocked `git config` would pin this file's idea of that
 * rather than git's.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

// Several real git processes per case, on a Jetson — the ceiling its neighbour
// declares for the same reason.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/** data/config.json, as a plain object the fall-through case sets key by key. */
const stored: Record<string, unknown> = {};
const configGet = vi.hoisted(() => vi.fn());
vi.mock("@/lib/config-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config-store")>()),
  get: configGet,
}));

import {
  clearFactoryGitIdentity,
  FACTORY_GIT_IDENTITY,
  factoryIdentityRemovedLine,
} from "@/lib/coding-git-factory-identity";
import { CODING_GIT_PLACEHOLDER, resolveCodingGitIdentity } from "@/lib/coding-git-identity";

const BOOT_FILE = path.join(process.cwd(), "src", "instrumentation.ts");

let root = "";
let realHome: string | undefined;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-factory-identity-"));
  realHome = process.env.HOME;
});

afterAll(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  for (const key of Object.keys(stored)) delete stored[key];
  configGet.mockReset().mockImplementation(async (key: string) => stored[key]);
});

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
});

/**
 * The environment every git in this file runs in: the temp home, and none of
 * whoever is running the suite.
 *
 * Built from nothing, never spread over `process.env`. `XDG_CONFIG_HOME`,
 * `GIT_CONFIG_GLOBAL` and `GIT_CONFIG` all move what `--global` means, and this
 * suite WRITES global config — inherited, one of them would point these cases
 * at the config of whoever is running them.
 */
function env(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    LANG: "C",
    // This repo's own ProcessEnv augmentation insists on it, and git has no use
    // for it — carried through rather than invented, as child-run.ts notes.
    NODE_ENV: process.env.NODE_ENV,
  };
}

/** A HOME of its own, with whatever the case wants in its global config. A
 *  value given as an array is a key set more than once. */
function homeWith(entries: Record<string, string | string[]> = {}): string {
  const home = fs.mkdtempSync(path.join(root, "home-"));
  for (const [key, value] of Object.entries(entries)) {
    for (const one of Array.isArray(value) ? value : [value]) {
      execFileSync("git", ["config", "--global", "--add", key, one], { env: env(home) });
    }
  }
  return home;
}

/** Every value the GLOBAL config holds for a key; empty when it holds none. */
function globalValues(home: string, key: string): string[] {
  const r = spawnSync("git", ["config", "--global", "--get-all", key], { env: env(home), encoding: "utf-8" });
  return r.status === 0 ? r.stdout.trim().split("\n").filter(Boolean) : [];
}

/** The factory pair, as the flash image ships it. */
function flashedHome(): string {
  return homeWith({ "user.name": FACTORY_GIT_IDENTITY.name, "user.email": FACTORY_GIT_IDENTITY.email });
}

/** A repository with no identity of its own, under the given home. */
function repo(home: string, local?: { name?: string; email?: string }): string {
  const dir = fs.mkdtempSync(path.join(root, "repo-"));
  execFileSync("git", ["init", "-q", "-b", "main", dir], { env: env(home) });
  if (local?.name) execFileSync("git", ["-C", dir, "config", "user.name", local.name], { env: env(home) });
  if (local?.email) execFileSync("git", ["-C", dir, "config", "user.email", local.email], { env: env(home) });
  return dir;
}

describe("removing the factory identity", () => {
  it("takes both halves off a freshly flashed box", async () => {
    const home = flashedHome();

    const result = await clearFactoryGitIdentity({ home, log: () => {} });

    expect(result.removed).toEqual(["user.name", "user.email"]);
    expect(result.outcomes).toEqual({ "user.name": "removed", "user.email": "removed" });
    expect(result.failures).toEqual([]);
    expect(globalValues(home, "user.name")).toEqual([]);
    expect(globalValues(home, "user.email")).toEqual([]);
  });

  it("logs what it removed, naming the key and the value", async () => {
    const home = flashedHome();
    const lines: string[] = [];

    await clearFactoryGitIdentity({ home, log: (m) => lines.push(m) });

    expect(lines).toContain(factoryIdentityRemovedLine("user.name", FACTORY_GIT_IDENTITY.name));
    expect(lines).toContain(factoryIdentityRemovedLine("user.email", FACTORY_GIT_IDENTITY.email));
  });

  it("reads the clawbox user's own HOME when it is not told one", async () => {
    // The web server runs as that user (clawbox-setup.service: User=clawbox),
    // so the boot call passes nothing and the default has to be right.
    const home = flashedHome();
    process.env.HOME = home;

    await clearFactoryGitIdentity({ log: () => {} });

    expect(globalValues(home, "user.email")).toEqual([]);
  });

  it("removes a re-typed or padded copy of the same identity", async () => {
    const home = homeWith({ "user.name": "Yalexx", "user.email": "  Yanko@IDRobots.com  " });

    const result = await clearFactoryGitIdentity({ home, log: () => {} });

    expect(result.removed).toEqual(["user.name", "user.email"]);
    expect(globalValues(home, "user.name")).toEqual([]);
    expect(globalValues(home, "user.email")).toEqual([]);
  });
});

describe("leaving every other identity alone", () => {
  it("keeps the owner's own name and address", async () => {
    const home = homeWith({ "user.name": "Ada Lovelace", "user.email": "ada@example.com" });

    const result = await clearFactoryGitIdentity({ home, log: () => {} });

    expect(result.removed).toEqual([]);
    expect(result.outcomes).toEqual({ "user.name": "kept", "user.email": "kept" });
    expect(globalValues(home, "user.name")).toEqual(["Ada Lovelace"]);
    expect(globalValues(home, "user.email")).toEqual(["ada@example.com"]);
  });

  it.each([
    ["a longer handle", "yalexx2", "yanko@idrobots.com.example"],
    ["a colleague at the same domain", "someone", "someone@idrobots.com"],
    ["the address as part of a bigger one", "yalexxx", "not-yanko@idrobots.com"],
  ])("keeps %s", async (_label, name, email) => {
    const home = homeWith({ "user.name": name, "user.email": email });

    const result = await clearFactoryGitIdentity({ home, log: () => {} });

    expect(result.removed).toEqual([]);
    expect(globalValues(home, "user.name")).toEqual([name]);
    expect(globalValues(home, "user.email")).toEqual([email]);
  });

  it("judges each key on its own value", async () => {
    // A box where the owner replaced the address and the staff name stayed. The
    // name is no less wrong for being half of it, and their address is no less
    // theirs for sitting beside it.
    const home = homeWith({ "user.name": FACTORY_GIT_IDENTITY.name, "user.email": "owner@example.com" });

    const result = await clearFactoryGitIdentity({ home, log: () => {} });

    expect(result.removed).toEqual(["user.name"]);
    expect(result.outcomes).toEqual({ "user.name": "removed", "user.email": "kept" });
    expect(globalValues(home, "user.name")).toEqual([]);
    expect(globalValues(home, "user.email")).toEqual(["owner@example.com"]);
  });

  it("leaves a key holding the factory value BESIDE another one", async () => {
    // `--unset-all` would take the owner's value with it, and this job removes
    // a known string rather than a config it does not understand.
    const home = homeWith({ "user.email": [FACTORY_GIT_IDENTITY.email, "owner@example.com"] });

    const result = await clearFactoryGitIdentity({ home, log: () => {} });

    expect(result.removed).toEqual([]);
    expect(result.outcomes["user.email"]).toBe("kept");
    expect(globalValues(home, "user.email")).toEqual([FACTORY_GIT_IDENTITY.email, "owner@example.com"]);
  });

  it("never touches a repository's own config", async () => {
    // The owner's project, and its history's identity is their business — even
    // when it is the same string. Only the global file is this job's to change.
    const home = flashedHome();
    const dir = repo(home, { name: FACTORY_GIT_IDENTITY.name, email: FACTORY_GIT_IDENTITY.email });

    await clearFactoryGitIdentity({ home, log: () => {} });

    const local = execFileSync("git", ["-C", dir, "config", "--local", "--get", "user.email"], {
      env: env(home),
      encoding: "utf-8",
    }).trim();
    expect(local).toBe(FACTORY_GIT_IDENTITY.email);
    expect(globalValues(home, "user.email")).toEqual([]);
  });
});

describe("running it on every boot", () => {
  it("changes nothing the second time, and nothing after that", async () => {
    const home = flashedHome();
    const configFile = path.join(home, ".gitconfig");

    await clearFactoryGitIdentity({ home, log: () => {} });
    const afterFirst = fs.readFileSync(configFile, "utf-8");

    const second = await clearFactoryGitIdentity({ home, log: () => {} });
    const third = await clearFactoryGitIdentity({ home, log: () => {} });

    expect(second.removed).toEqual([]);
    expect(second.outcomes).toEqual({ "user.name": "absent", "user.email": "absent" });
    expect(second.failures).toEqual([]);
    expect(third.removed).toEqual([]);
    expect(fs.readFileSync(configFile, "utf-8")).toBe(afterFirst);
  });

  it("is quiet on a box that has no global config at all", async () => {
    const home = homeWith();

    const lines: string[] = [];
    const result = await clearFactoryGitIdentity({ home, log: (m) => lines.push(m) });

    expect(result.outcomes).toEqual({ "user.name": "absent", "user.email": "absent" });
    expect(result.failures).toEqual([]);
    expect(lines).toEqual([]);
    expect(fs.existsSync(path.join(home, ".gitconfig"))).toBe(false);
  });

  it("keeps every other setting in the file", async () => {
    // The image's `.gitconfig` is not only an identity, and a boot job that
    // took the rest of it with the two keys would be its own defect.
    const home = homeWith({
      "user.name": FACTORY_GIT_IDENTITY.name,
      "user.email": FACTORY_GIT_IDENTITY.email,
      "init.defaultBranch": "main",
      "credential.https://github.com.helper": "!gh auth git-credential",
    });

    await clearFactoryGitIdentity({ home, log: () => {} });

    expect(globalValues(home, "init.defaultBranch")).toEqual(["main"]);
    expect(globalValues(home, "credential.https://github.com.helper")).toEqual(["!gh auth git-credential"]);
  });
});

describe("what the coding agent then commits as", () => {
  it("authored a fresh box's commits as the member of staff until this ran", async () => {
    // The defect itself, end to end: a project with no identity of its own, on
    // a box flashed from the golden image.
    const home = flashedHome();
    process.env.HOME = home;
    const dir = repo(home);

    const before = await resolveCodingGitIdentity(dir);
    expect(before).toEqual({
      ok: true,
      identity: { name: FACTORY_GIT_IDENTITY.name, email: FACTORY_GIT_IDENTITY.email, source: "git" },
    });
  });

  it("falls through to the owner's configured identity once it is gone", async () => {
    const home = flashedHome();
    process.env.HOME = home;
    const dir = repo(home);
    stored.coding_agent_git_name = "Box Owner";
    stored.coding_agent_git_email = "owner@example.com";

    await clearFactoryGitIdentity({ home, log: () => {} });

    expect(await resolveCodingGitIdentity(dir)).toEqual({
      ok: true,
      identity: { name: "Box Owner", email: "owner@example.com", source: "config" },
    });
  });

  it("falls through to the placeholder on a box nobody has told anything", async () => {
    const home = flashedHome();
    process.env.HOME = home;
    const dir = repo(home);

    await clearFactoryGitIdentity({ home, log: () => {} });

    expect(await resolveCodingGitIdentity(dir)).toEqual({
      ok: true,
      identity: { ...CODING_GIT_PLACEHOLDER, source: "placeholder" },
    });
  });

  it("leaves a project that has its own identity exactly where it was", async () => {
    const home = flashedHome();
    process.env.HOME = home;
    const dir = repo(home, { name: "Ada Lovelace", email: "ada@example.com" });

    await clearFactoryGitIdentity({ home, log: () => {} });

    expect(await resolveCodingGitIdentity(dir)).toEqual({
      ok: true,
      identity: { name: "Ada Lovelace", email: "ada@example.com", source: "git" },
    });
  });
});

describe("boot clears the factory identity before anything can commit", () => {
  const source = fs.readFileSync(BOOT_FILE, "utf8");
  const call = source.indexOf("await clearFactoryGitIdentity(");

  it("runs it, awaited, from the real module", () => {
    expect(call).toBeGreaterThan(-1);
    const tryStart = source.lastIndexOf("try {", call);
    expect(source.slice(tryStart, call)).toMatch(/require\(['"]\.\/lib\/coding-git-factory-identity['"]\)/);
  });

  it("comes before the coding runs are reconciled and resumed", () => {
    // Awaited and ahead of them, so no run this server picks back up can reach
    // git while the factory identity is still in the file.
    const coding = source.indexOf("require('./lib/coding-agent')");
    expect(coding).toBeGreaterThan(-1);
    expect(call).toBeLessThan(coding);
  });

  it("keeps it behind the Node-runtime guard and in its own catch", () => {
    const guard = source.indexOf("NEXT_RUNTIME === 'edge'");
    expect(guard).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(guard);
    const catchStart = source.indexOf("} catch (err) {", call);
    expect(catchStart).toBeGreaterThan(call);
    expect(source.slice(catchStart, catchStart + 200)).toMatch(/Could not clear the factory git identity/);
  });
});
