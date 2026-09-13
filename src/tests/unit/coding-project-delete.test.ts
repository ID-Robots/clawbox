/**
 * The guards in front of removing a project folder.
 *
 * The path rules are the interesting half and they are tested against a REAL
 * filesystem rather than a mocked `fs`: every one of them is a statement about
 * what `lstat`, `realpath` and `path.dirname` actually do with a symlink, and a
 * mock would only be testing this file's own idea of that.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const listRuns = vi.hoisted(() => vi.fn(() => [] as unknown[]));
const getDefaultDirectory = vi.hoisted(() => vi.fn(async () => null as string | null));
vi.mock("@/lib/coding-agent", () => ({
  listRuns,
  getDefaultDirectory,
  projectDirectoryOf: (run: { directory: string; worktree?: { project: string } | null }) => run.worktree?.project ?? run.directory,
}));

type Lib = typeof import("@/lib/coding-project-delete");

let lib: Lib;
let root: string;
let owner: string;
let previousRoot: string | undefined;

/** A temp CLAWBOX_ROOT with an owner project folder beside its data/. */
async function load(): Promise<Lib> {
  vi.resetModules();
  return import("@/lib/coding-project-delete");
}

beforeEach(async () => {
  previousRoot = process.env.CLAWBOX_ROOT;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "project-delete-"));
  owner = path.join(root, "Projects");
  fs.mkdirSync(owner, { recursive: true });
  fs.mkdirSync(path.join(root, "data", "code-projects"), { recursive: true });
  process.env.CLAWBOX_ROOT = root;
  listRuns.mockReturnValue([]);
  getDefaultDirectory.mockResolvedValue(owner);
  lib = await load();
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.CLAWBOX_ROOT;
  else process.env.CLAWBOX_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

function roots(): { ownerFolder: string; codeProjects: string; checkout: string } {
  return { ownerFolder: owner, codeProjects: path.join(root, "data", "code-projects"), checkout: root };
}

async function refusal(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    return (err as { code?: string }).code ?? "threw-without-a-code";
  }
  return "no-refusal";
}

describe("isDirectlyInside", () => {
  it("is one level down and no deeper", () => {
    expect(lib.isDirectlyInside("/home/a/Projects/shop", "/home/a/Projects")).toBe(true);
    // The rule the whole feature rests on: `node_modules` is UNDER the root and
    // is not a project in it.
    expect(lib.isDirectlyInside("/home/a/Projects/shop/node_modules", "/home/a/Projects")).toBe(false);
  });

  it("is never the root itself, and never a sibling", () => {
    expect(lib.isDirectlyInside("/home/a/Projects", "/home/a/Projects")).toBe(false);
    expect(lib.isDirectlyInside("/home/a/Other/shop", "/home/a/Projects")).toBe(false);
    expect(lib.isDirectlyInside("/home/a/Projects-evil/shop", "/home/a/Projects")).toBe(false);
  });

  it("normalises traversal and trailing separators before it decides", () => {
    expect(lib.isDirectlyInside("/home/a/Projects/shop/../shop", "/home/a/Projects/")).toBe(true);
    // The traversal that matters: a name that climbs OUT is not directly inside.
    expect(lib.isDirectlyInside("/home/a/Projects/../shop", "/home/a/Projects")).toBe(false);
  });

  it("answers false rather than throwing on an empty path", () => {
    expect(lib.isDirectlyInside("", "/home/a")).toBe(false);
    expect(lib.isDirectlyInside("/home/a/x", "")).toBe(false);
  });
});

describe("resolveProjectTarget", () => {
  it("finds a folder project and a code project", async () => {
    fs.mkdirSync(path.join(owner, "shop"));
    fs.mkdirSync(path.join(root, "data", "code-projects", "site"));

    expect(await lib.resolveProjectTarget({ folder: "shop" }, roots())).toMatchObject({
      folder: "shop",
      kind: "folder",
      directory: path.join(owner, "shop"),
    });
    expect(await lib.resolveProjectTarget({ folder: "site" }, roots())).toMatchObject({
      folder: "site",
      kind: "codeProject",
    });
  });

  it("refuses a name that is a path rather than one folder", async () => {
    for (const folder of ["../etc", "a/b", "..", ".", "", "   ", "a\0b"]) {
      expect(await refusal(() => lib.resolveProjectTarget({ folder }, roots())), folder).toBe("invalid");
    }
    expect(await refusal(() => lib.resolveProjectTarget({ folder: 42 }, roots()))).toBe("invalid");
  });

  it("refuses a name nothing answers to", async () => {
    expect(await refusal(() => lib.resolveProjectTarget({ folder: "nope" }, roots()))).toBe("not_found");
  });

  it("refuses a FILE directly inside a root — a project is a folder", async () => {
    fs.writeFileSync(path.join(owner, "notes.txt"), "hello");
    expect(await refusal(() => lib.resolveProjectTarget({ folder: "notes.txt" }, roots()))).toBe("not_found");
  });

  it("refuses a symlink, whether it points out of the roots or inside them", async () => {
    const outside = path.join(root, "elsewhere");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(owner, "escape"));
    expect(await refusal(() => lib.resolveProjectTarget({ folder: "escape" }, roots()))).toBe("path_escape");

    // A link pointing at a real project beside it is refused too: moving the
    // link would take the NAME and leave the folder, which is not what the
    // dialog promised.
    fs.mkdirSync(path.join(owner, "real"));
    fs.symlinkSync(path.join(owner, "real"), path.join(owner, "alias"));
    expect(await refusal(() => lib.resolveProjectTarget({ folder: "alias" }, roots()))).toBe("path_escape");
    expect(fs.existsSync(path.join(owner, "real"))).toBe(true);
  });

  it("refuses a dangling symlink rather than reading it as absent", async () => {
    fs.symlinkSync(path.join(root, "gone"), path.join(owner, "broken"));
    expect(await refusal(() => lib.resolveProjectTarget({ folder: "broken" }, roots()))).toBe("path_escape");
  });

  it("follows a LINKED ROOT and still resolves the project inside it", async () => {
    // The legitimate case the fence must not break: `~/Projects` is itself a
    // link (an external disk), so the real path of a project in it is not under
    // the root as spelled — but it IS directly inside the root's real path.
    const realHome = path.join(root, "disk", "Projects");
    fs.mkdirSync(path.join(realHome, "shop"), { recursive: true });
    const linkedOwner = path.join(root, "LinkedProjects");
    fs.symlinkSync(realHome, linkedOwner);

    const resolved = await lib.resolveProjectTarget({ folder: "shop" }, { ...roots(), ownerFolder: linkedOwner });
    expect(resolved.directory).toBe(path.join(linkedOwner, "shop"));
    expect(resolved.real).toBe(fs.realpathSync(path.join(realHome, "shop")));
  });

  it("refuses ClawBox's own checkout even when it sits directly inside a root", async () => {
    // The order that matters: the checkout here IS a folder directly inside the
    // owner's project folder, so every earlier guard passes it.
    const holder = path.join(root, "Holder");
    fs.mkdirSync(path.join(holder, "clawbox", "data"), { recursive: true });
    const checkout = path.join(holder, "clawbox");
    expect(await refusal(() => lib.resolveProjectTarget({ folder: "clawbox" }, {
      ownerFolder: holder,
      codeProjects: path.join(checkout, "data", "code-projects"),
      checkout,
    }))).toBe("protected_checkout");
    expect(fs.existsSync(checkout)).toBe(true);
  });

  it("says so when there is no owner folder and no code project of that name", async () => {
    expect(await refusal(() => lib.resolveProjectTarget({ folder: "shop" }, { ...roots(), ownerFolder: null })))
      .toBe("not_found");
  });

  it("honours an explicit kind rather than guessing across the two roots", async () => {
    fs.mkdirSync(path.join(owner, "twin"));
    fs.mkdirSync(path.join(root, "data", "code-projects", "twin"));
    expect((await lib.resolveProjectTarget({ folder: "twin" }, roots())).kind).toBe("folder");
    expect((await lib.resolveProjectTarget({ folder: "twin", kind: "codeProject" }, roots())).kind).toBe("codeProject");
    // An owner folder that is not set leaves only one place a "folder" kind
    // could be, so the lookup finds nothing rather than falling through.
    expect(await refusal(() => lib.resolveProjectTarget({ folder: "twin", kind: "folder" }, { ...roots(), ownerFolder: null })))
      .toBe("outside_roots");
  });
});

describe("the trash and its retention rule", () => {
  const day = 24 * 60 * 60_000;

  it("moves a folder rather than deleting it, under a timestamped name", async () => {
    const project = path.join(owner, "shop");
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, "index.html"), "hi");

    const at = Date.parse("2026-09-13T12:00:00.000Z");
    const moved = await lib.moveProjectToTrash(project, at);

    expect(moved.trashName).toBe("shop--20260913T120000Z");
    expect(fs.existsSync(project)).toBe(false);
    expect(fs.readFileSync(path.join(moved.trashPath, "index.html"), "utf8")).toBe("hi");
    expect(lib.trashEntryTime(moved.trashName)).toBe(at);
  });

  it("never writes over an entry that is already there", async () => {
    const at = Date.parse("2026-09-13T12:00:00.000Z");
    for (const n of [1, 2]) {
      const project = path.join(owner, "shop");
      fs.mkdirSync(project);
      fs.writeFileSync(path.join(project, "n"), String(n));
      const moved = await lib.moveProjectToTrash(project, at);
      expect(fs.readFileSync(path.join(moved.trashPath, "n"), "utf8")).toBe(String(n));
    }
    expect(fs.readdirSync(lib.projectTrashDir()).sort()).toEqual(["shop--20260913T120000Z", "shop-2--20260913T120000Z"]);
  });

  it("prunes on age, oldest first, and leaves what is still in date", async () => {
    const now = Date.parse("2026-09-13T12:00:00.000Z");
    const trash = lib.projectTrashDir();
    fs.mkdirSync(trash, { recursive: true });
    const old = `old--${new Date(now - 31 * day).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}`;
    const fresh = `fresh--${new Date(now - 2 * day).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}`;
    fs.mkdirSync(path.join(trash, old));
    fs.mkdirSync(path.join(trash, fresh));

    expect(await lib.pruneProjectTrash(now)).toEqual([old]);
    expect(fs.existsSync(path.join(trash, fresh))).toBe(true);
  });

  it("prunes on the count bound too, and never touches a folder it did not name", async () => {
    const now = Date.parse("2026-09-13T12:00:00.000Z");
    const trash = lib.projectTrashDir();
    fs.mkdirSync(trash, { recursive: true });
    for (let i = 0; i < lib.MAX_TRASH_ENTRIES + 3; i += 1) {
      const at = new Date(now - i * 60_000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
      fs.mkdirSync(path.join(trash, `p${i}--${at}`));
    }
    // Somebody's own folder, put there by hand. It carries no stamp, so the
    // prune must leave it alone however full the trash is.
    fs.mkdirSync(path.join(trash, "keep-me-please"));

    const removed = await lib.pruneProjectTrash(now);
    expect(removed).toHaveLength(3);
    expect(fs.readdirSync(trash).filter((n) => n.includes("--"))).toHaveLength(lib.MAX_TRASH_ENTRIES);
    expect(fs.existsSync(path.join(trash, "keep-me-please"))).toBe(true);
  });

  it("reads a name it did not write as having no time, so the prune skips it", () => {
    expect(lib.trashEntryTime("shop")).toBeNull();
    expect(lib.trashEntryTime("shop--nonsense")).toBeNull();
    expect(lib.trashEntryTime("a--b--20260913T120000Z")).toBe(Date.parse("2026-09-13T12:00:00.000Z"));
  });
});

describe("directorySize", () => {
  it("counts files and bytes without following a link out of the folder", async () => {
    const project = path.join(owner, "shop");
    fs.mkdirSync(path.join(project, "src"), { recursive: true });
    fs.writeFileSync(path.join(project, "a.txt"), "12345");
    fs.writeFileSync(path.join(project, "src", "b.txt"), "1234567890");
    const big = path.join(root, "big");
    fs.mkdirSync(big);
    fs.writeFileSync(path.join(big, "huge"), "x".repeat(5000));
    fs.symlinkSync(big, path.join(project, "link"));

    expect(await lib.directorySize(project)).toEqual({ bytes: 15, files: 2, truncated: false });
  });

  it("answers zero for a folder it cannot read rather than throwing", async () => {
    expect(await lib.directorySize(path.join(owner, "nope"))).toEqual({ bytes: 0, files: 0, truncated: false });
  });
});

describe("liveRunsInProject", () => {
  const target = () => ({
    folder: "shop",
    kind: "folder" as const,
    directory: path.join(owner, "shop"),
    real: path.join(owner, "shop"),
  });

  it("finds a run in the folder, in a sub-folder, and in its own copy of it", () => {
    listRuns.mockReturnValue([
      { id: "run-a", task: "t", status: "running", projectId: null, directory: path.join(owner, "shop") },
      { id: "run-b", task: "t", status: "running", projectId: null, directory: path.join(owner, "shop", "api") },
      {
        id: "run-c",
        task: "t",
        status: "running",
        projectId: null,
        directory: path.join(owner, "shop", ".clawbox", "worktrees", "run-c"),
        worktree: { project: path.join(owner, "shop") },
      },
    ]);
    expect(lib.liveRunsInProject(target()).map((r) => r.id)).toEqual(["run-a", "run-b", "run-c"]);
  });

  it("ignores a settled run, and a live one in a project whose name merely starts the same", () => {
    listRuns.mockReturnValue([
      { id: "run-done", task: "t", status: "completed", projectId: null, directory: path.join(owner, "shop") },
      { id: "run-else", task: "t", status: "running", projectId: null, directory: path.join(owner, "shop-two") },
      { id: "run-paused", task: "t", status: "paused", projectId: null, directory: path.join(owner, "shop") },
    ]);
    expect(lib.liveRunsInProject(target())).toEqual([]);
  });

  it("matches a code project by its id, which is where its runs are filed", () => {
    listRuns.mockReturnValue([
      { id: "run-cp", task: "t", status: "running", projectId: "site", directory: "/somewhere/else" },
    ]);
    const codeProject = {
      folder: "site",
      kind: "codeProject" as const,
      directory: path.join(root, "data", "code-projects", "site"),
      real: path.join(root, "data", "code-projects", "site"),
    };
    expect(lib.liveRunsInProject(codeProject).map((r) => r.id)).toEqual(["run-cp"]);
  });
});
