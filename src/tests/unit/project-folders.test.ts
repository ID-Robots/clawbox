/**
 * The owner's pinned project folders (src/lib/project-folders.ts) — what may
 * be pinned, how the list is kept, and what the Files app is offered.
 *
 * Laid out like the appliance: the browse root is the home folder, the
 * ClawBox checkout (and its data directory) sits inside it, and the agent's
 * workspace lives in `~/.openclaw`, beside the device's credentials.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const HOME = fs.realpathSync(os.tmpdir()) + `/clawbox-project-folders-${process.pid}-${Date.now()}`;
const CHECKOUT = path.join(HOME, "clawbox");
const DATA = path.join(CHECKOUT, "data");

let codingDefaultDir: string | null = null;
vi.mock("@/lib/coding-agent", () => ({ getDefaultDirectory: async () => codingDefaultDir }));

type Lib = typeof import("@/lib/project-folders");
let lib: Lib;
let config: typeof import("@/lib/config-store");

const mk = (rel: string, file?: string) => {
  const dir = path.join(HOME, rel);
  fs.mkdirSync(dir, { recursive: true });
  if (file) fs.writeFileSync(path.join(dir, file), "x");
  return dir;
};

beforeAll(async () => {
  process.env.FILES_ROOT = HOME;
  process.env.CLAWBOX_ROOT = CHECKOUT;
  fs.mkdirSync(DATA, { recursive: true });
  vi.resetModules();
  lib = await import("@/lib/project-folders");
  config = await import("@/lib/config-store");
});

afterAll(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
  delete process.env.FILES_ROOT;
  delete process.env.CLAWBOX_ROOT;
});

beforeEach(async () => {
  codingDefaultDir = null;
  await config.set(lib.PROJECT_FOLDERS_CONFIG_KEY, []);
  for (const name of fs.readdirSync(HOME)) {
    if (name !== "clawbox") fs.rmSync(path.join(HOME, name), { recursive: true, force: true });
  }
  fs.rmSync(path.join(DATA, "code-projects"), { recursive: true, force: true });
});

const code = (fn: () => unknown): string | null => {
  try { fn(); return null; } catch (err) { return (err as { code?: string }).code ?? "threw"; }
};

describe("resolveProjectFolder — what may be pinned", () => {
  it("takes a folder however the owner spells it, and stores it the way the Files app navigates", () => {
    mk("work/app");
    expect(lib.resolveProjectFolder("~/work/app").rel).toBe("work/app");
    expect(lib.resolveProjectFolder(path.join(HOME, "work/app")).rel).toBe("work/app");
    expect(lib.resolveProjectFolder("work/app/").rel).toBe("work/app");
    expect(lib.resolveProjectFolder("  work/./app  ").abs).toBe(path.join(HOME, "work/app"));
  });

  it("opens the agent's own workspace, where the assistant keeps the owner's projects", () => {
    mk(".openclaw/workspace/projects/architektur-review");
    expect(lib.resolveProjectFolder("~/.openclaw/workspace/projects").rel).toBe(".openclaw/workspace/projects");
  });

  it("refuses the home folder itself, anything outside it, and a sibling that only shares its prefix", () => {
    expect(code(() => lib.resolveProjectFolder("~"))).toBe("is_root");
    expect(code(() => lib.resolveProjectFolder("/etc"))).toBe("outside_root");
    expect(code(() => lib.resolveProjectFolder("../"))).toBe("outside_root");
    fs.mkdirSync(HOME + "x", { recursive: true });
    try {
      expect(code(() => lib.resolveProjectFolder(HOME + "x"))).toBe("outside_root");
    } finally {
      fs.rmSync(HOME + "x", { recursive: true, force: true });
    }
  });

  it("refuses the credential stores, the rest of ~/.openclaw, and the data directory's private state — even through a link", () => {
    mk(".ssh");
    mk(".openclaw/agents/main");
    mk("clawbox/data/oauth");
    fs.symlinkSync(path.join(HOME, ".ssh"), path.join(HOME, "keys"));
    expect(code(() => lib.resolveProjectFolder("~/.ssh"))).toBe("protected");
    expect(code(() => lib.resolveProjectFolder("~/.openclaw/agents"))).toBe("protected");
    expect(code(() => lib.resolveProjectFolder("~/clawbox/data/oauth"))).toBe("protected");
    expect(code(() => lib.resolveProjectFolder("~/keys"))).toBe("protected");
  });

  it("refuses what is not a folder, and nothing at all", () => {
    mk("docs", "a.txt");
    expect(code(() => lib.resolveProjectFolder("~/docs/a.txt"))).toBe("not_directory");
    expect(code(() => lib.resolveProjectFolder("~/nope"))).toBe("not_found");
    expect(code(() => lib.resolveProjectFolder(""))).toBe("invalid");
    expect(code(() => lib.resolveProjectFolder(42))).toBe("invalid");
    expect(code(() => lib.resolveProjectFolder("a\0b"))).toBe("invalid");
  });
});

describe("the pinned list", () => {
  it("pins in order, answers the same list for a second pin of one folder, and keeps it in the config store", async () => {
    mk("b-proj");
    mk("a-proj");
    expect((await lib.addProjectFolder("~/b-proj")).added).toBe(true);
    const again = await lib.addProjectFolder(path.join(HOME, "b-proj"));
    expect(again.added).toBe(false);
    const { folder, folders } = await lib.addProjectFolder("a-proj");
    expect(folder).toEqual({ path: "a-proj", name: "a-proj" });
    expect(folders.map((f) => f.path)).toEqual(["b-proj", "a-proj"]);
    expect(await config.get(lib.PROJECT_FOLDERS_CONFIG_KEY)).toEqual([{ path: "b-proj" }, { path: "a-proj" }]);
  });

  it("keeps a folder that has gone as `missing`, so it can still be unpinned", async () => {
    const dir = mk("gone");
    await lib.addProjectFolder("~/gone");
    fs.rmSync(dir, { recursive: true });
    expect(await lib.listProjectFolders()).toEqual([{ path: "gone", name: "gone", missing: true }]);
    const { removed, folders } = await lib.removeProjectFolder("~/gone");
    expect(removed).toBe(true);
    expect(folders).toEqual([]);
  });

  it("stops showing a pin a guard rule now covers, without naming it", async () => {
    const dir = mk("notes");
    await lib.addProjectFolder("~/notes");
    mk(".ssh");
    fs.rmSync(dir, { recursive: true });
    fs.symlinkSync(path.join(HOME, ".ssh"), dir);
    expect(await lib.listProjectFolders()).toEqual([]);
    // …and it still comes off the list when asked.
    expect((await lib.removeProjectFolder("notes")).removed).toBe(true);
  });

  it("unpins by any spelling that resolves to the pin, and says so when there was none", async () => {
    mk("x/y");
    await lib.addProjectFolder("x/y");
    expect((await lib.removeProjectFolder("~/x/z")).removed).toBe(false);
    expect((await lib.removeProjectFolder(path.join(HOME, "x", "y") + "/")).removed).toBe(true);
    await expect(lib.removeProjectFolder(undefined)).rejects.toMatchObject({ code: "invalid" });
  });

  it("ignores a stored list it did not write: absolute paths, escapes, duplicates, junk", async () => {
    mk("ok");
    await config.set(lib.PROJECT_FOLDERS_CONFIG_KEY, [
      { path: "ok" }, { path: "ok/" }, { path: "/etc" }, { path: "../outside" }, "ok", null, { path: 7 },
    ]);
    expect(await lib.listProjectFolders()).toEqual([{ path: "ok", name: "ok" }]);
    await config.set(lib.PROJECT_FOLDERS_CONFIG_KEY, "not a list");
    expect(await lib.listProjectFolders()).toEqual([]);
  });

  it("loses no pin when several land at once", async () => {
    for (let i = 0; i < 6; i += 1) mk(`p${i}`);
    await Promise.all(Array.from({ length: 6 }, (_, i) => lib.addProjectFolder(`p${i}`)));
    expect((await lib.listProjectFolders()).map((f) => f.path).sort()).toEqual(["p0", "p1", "p2", "p3", "p4", "p5"]);
  });

  it("holds at most MAX_PROJECT_FOLDERS pins", async () => {
    for (let i = 0; i < lib.MAX_PROJECT_FOLDERS; i += 1) mk(`many/${i}`);
    await config.set(
      lib.PROJECT_FOLDERS_CONFIG_KEY,
      Array.from({ length: lib.MAX_PROJECT_FOLDERS }, (_, i) => ({ path: `many/${i}` })),
    );
    mk("one-more");
    await expect(lib.addProjectFolder("one-more")).rejects.toMatchObject({ code: "too_many", status: 409 });
    // A folder already on the list is still "pinned", not "too many".
    expect((await lib.addProjectFolder("many/0")).added).toBe(false);
  });
});

describe("suggestedProjectFolders — where this box already keeps projects", () => {
  it("offers the workspace's projects folder, ~/projects, the Coding Agent's folder and the code projects — each only when it holds something", async () => {
    mk(".openclaw/workspace/projects/architektur-review", "SELBSTGUTACHTEN.md");
    mk(".openclaw/workspace-research/projects/paper", "draft.md");
    mk(".openclaw/agents/main/projects", "secret.json");
    mk("Projects", "readme.md");
    mk("projects"); // empty: nothing to show
    mk("code/agent-work", "main.py");
    mk("clawbox/data/code-projects/hello", "index.html");
    codingDefaultDir = path.join(HOME, "code");
    const suggested = (await lib.suggestedProjectFolders()).map((f) => f.path);
    expect([...suggested].sort()).toEqual([
      ".openclaw/workspace-research/projects",
      ".openclaw/workspace/projects",
      "Projects",
      "clawbox/data/code-projects",
      "code",
    ].sort());
    expect(suggested).not.toContain("projects");
    expect(suggested.some((p) => p.includes("agents"))).toBe(false);
  });

  it("leaves out what is pinned already (by any link to it), and a Coding Agent folder outside the home", async () => {
    mk(".openclaw/workspace/projects/a", "x.md");
    fs.symlinkSync(path.join(HOME, ".openclaw/workspace/projects"), path.join(HOME, "projects"));
    codingDefaultDir = "/srv/elsewhere";
    await lib.addProjectFolder("~/projects");
    expect(await lib.suggestedProjectFolders()).toEqual([]);
  });
});
