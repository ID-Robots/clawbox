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

  it("never trims a folder name into a DIFFERENT project", async () => {
    // A trailing space is legal in a folder name and the listing hands it to
    // the app as it found it. Trimming here resolved "shop " to "shop": the
    // dialog named one folder and the box would have moved another.
    fs.mkdirSync(path.join(owner, "shop"));
    fs.mkdirSync(path.join(owner, "shop "));
    expect((await lib.resolveProjectTarget({ folder: "shop " }, roots())).directory)
      .toBe(path.join(owner, "shop "));
    expect((await lib.resolveProjectTarget({ folder: "shop" }, roots())).directory)
      .toBe(path.join(owner, "shop"));
  });

  it("still refuses a name that is nothing but whitespace", async () => {
    for (const folder of ["", " ", "\t", "  \n "]) {
      expect(await refusal(() => lib.resolveProjectTarget({ folder }, roots())), JSON.stringify(folder)).toBe("invalid");
    }
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

  it("refuses a folder that HOLDS the checkout, not only the checkout itself", async () => {
    // A project folder set a level above the box's own repository — config.json
    // is a file the owner can edit — makes the folder containing the running OS
    // an ordinary row with a Delete button on it. The equality check alone let
    // it through, and only the kernel's refusal to move a folder into its own
    // descendant stopped it.
    const holder = path.join(root, "Holder");
    const checkout = path.join(holder, "dev", "clawbox");
    fs.mkdirSync(path.join(checkout, "data", "code-projects"), { recursive: true });
    expect(await refusal(() => lib.resolveProjectTarget({ folder: "dev" }, {
      ownerFolder: holder,
      codeProjects: path.join(checkout, "data", "code-projects"),
      checkout,
    }))).toBe("protected_checkout");
    expect(fs.existsSync(checkout)).toBe(true);
  });

  it("still allows a project that merely SITS BESIDE the checkout", async () => {
    // The mirror of the rule above: containment is one-directional. A code
    // project lives INSIDE the checkout and must stay removable.
    const holder = path.join(root, "Holder2");
    const checkout = path.join(holder, "clawbox");
    fs.mkdirSync(path.join(checkout, "data"), { recursive: true });
    fs.mkdirSync(path.join(holder, "shop"));
    expect(await lib.resolveProjectTarget({ folder: "shop" }, {
      ownerFolder: holder,
      codeProjects: path.join(checkout, "data", "code-projects"),
      checkout,
    })).toMatchObject({ folder: "shop", kind: "folder" });
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
    const moved = await lib.moveProjectToTrash(project, owner, at);

    expect(moved.trashName).toBe("shop--20260913T120000Z");
    expect(fs.existsSync(project)).toBe(false);
    expect(fs.readFileSync(path.join(moved.trashPath, "index.html"), "utf8")).toBe("hi");
    expect(lib.trashEntryTime(moved.trashName)).toBe(at);
  });

  it("puts the trash in the project's OWN root, which is what makes the rename atomic", async () => {
    // The whole safety argument of this module: a project is directly inside
    // its root, so a folder beside it in that root is on the same filesystem,
    // so `rename` cannot be a copy. If this ever moves back under `data/` the
    // cross-device fallback — and the file it lost — come back with it.
    const project = path.join(owner, "shop");
    fs.mkdirSync(project);
    const moved = await lib.moveProjectToTrash(project, owner, Date.parse("2026-09-13T12:00:00.000Z"));

    expect(path.dirname(moved.trashPath)).toBe(lib.projectTrashDir(owner));
    expect(path.dirname(path.dirname(moved.trashPath))).toBe(owner);
    // Same filesystem, stated as the kernel sees it rather than as a hope.
    expect(fs.statSync(moved.trashPath).dev).toBe(fs.statSync(owner).dev);
  });

  it("never writes over an entry that is already there", async () => {
    const at = Date.parse("2026-09-13T12:00:00.000Z");
    for (const n of [1, 2]) {
      const project = path.join(owner, "shop");
      fs.mkdirSync(project);
      fs.writeFileSync(path.join(project, "n"), String(n));
      const moved = await lib.moveProjectToTrash(project, owner, at);
      expect(fs.readFileSync(path.join(moved.trashPath, "n"), "utf8")).toBe(String(n));
    }
    expect(fs.readdirSync(lib.projectTrashDir(owner)).sort()).toEqual(["shop--20260913T120000Z", "shop-2--20260913T120000Z"]);
  });

  it("refuses a rename it cannot do, leaving the project exactly where it was", async () => {
    // There is no copy-then-remove any more. EXDEV — which only a project
    // folder that is itself a mount point can still produce — is answered the
    // same way as any other errno: nothing is removed, and the message says so.
    // The old fallback is the exact path an audit lost a file down.
    const project = path.join(owner, "shop");
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, "index.html"), "hi");
    vi.spyOn(fs.promises, "rename").mockRejectedValue(Object.assign(new Error("EXDEV"), { code: "EXDEV" }));
    const cp = vi.spyOn(fs.promises, "cp");

    await expect(lib.moveProjectToTrash(project, owner, Date.parse("2026-09-13T12:00:00.000Z")))
      .rejects.toMatchObject({ code: "trash_failed", message: expect.stringContaining("nothing was removed") });
    expect(fs.readFileSync(path.join(project, "index.html"), "utf8")).toBe("hi");
    expect(fs.readdirSync(lib.projectTrashDir(owner))).toEqual([]);
    // The point of the change, not a detail of it: no copy is ever attempted.
    expect(cp).not.toHaveBeenCalled();
  });

  it("refuses the trash folder's own name as a project", async () => {
    // It is a folder directly inside a root, so every path guard passes it.
    expect(await refusal(() => lib.resolveProjectTarget({ folder: lib.TRASH_DIR_NAME }, roots()))).toBe("invalid");
  });

  /** A trash entry named the way this module names one, `ms` ago. */
  const stamped = (name: string, now: number, ms: number) =>
    `${name}--${new Date(now - ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}`;

  it("prunes on age, oldest first, and leaves what is still in date", async () => {
    const now = Date.parse("2026-09-13T12:00:00.000Z");
    const trash = lib.projectTrashDir(owner);
    fs.mkdirSync(trash, { recursive: true });
    const old = stamped("old", now, 31 * day);
    const fresh = stamped("fresh", now, 2 * day);
    fs.mkdirSync(path.join(trash, old));
    fs.mkdirSync(path.join(trash, fresh));

    // Expired, and reported as expired — nobody was promised those.
    expect(await lib.pruneProjectTrash(roots(), now)).toEqual({ removed: [old], expired: [old], early: [] });
    expect(fs.existsSync(path.join(trash, fresh))).toBe(true);
  });

  it("prunes on the count bound too, and never touches a folder it did not name", async () => {
    const now = Date.parse("2026-09-13T12:00:00.000Z");
    const trash = lib.projectTrashDir(owner);
    fs.mkdirSync(trash, { recursive: true });
    for (let i = 0; i < lib.MAX_TRASH_ENTRIES + 3; i += 1) {
      fs.mkdirSync(path.join(trash, stamped(`p${i}`, now, i * 60_000)));
    }
    // Somebody's own folder, put there by hand. It carries no stamp, so the
    // prune must leave it alone however full the trash is.
    fs.mkdirSync(path.join(trash, "keep-me-please"));

    const pruned = await lib.pruneProjectTrash(roots(), now);
    expect(pruned.removed).toHaveLength(3);
    // Reported as EARLY, not expired: these were inside their thirty days and
    // went only because the shelf was full. That distinction is what the dialog
    // needs in order not to lie about "kept for 30 days".
    expect(pruned.early).toHaveLength(3);
    expect(pruned.expired).toEqual([]);
    expect(fs.readdirSync(trash).filter((n) => n.includes("--"))).toHaveLength(lib.MAX_TRASH_ENTRIES);
    expect(fs.existsSync(path.join(trash, "keep-me-please"))).toBe(true);
  });

  it("says which entry ONE MORE removal would delete early, before it happens", async () => {
    const now = Date.parse("2026-09-13T12:00:00.000Z");
    const trash = lib.projectTrashDir(owner);
    fs.mkdirSync(trash, { recursive: true });
    // Exactly full, all well inside their thirty days.
    for (let i = 0; i < lib.MAX_TRASH_ENTRIES; i += 1) {
      fs.mkdirSync(path.join(trash, stamped(`p${i}`, now, i * 60_000)));
    }
    const oldest = stamped(`p${lib.MAX_TRASH_ENTRIES - 1}`, now, (lib.MAX_TRASH_ENTRIES - 1) * 60_000);

    expect(await lib.trashPurgedByOneMore(roots(), now)).toEqual({ count: lib.MAX_TRASH_ENTRIES, early: [oldest] });
    // Nothing has been touched: this is a question, not an act.
    expect(fs.readdirSync(trash)).toHaveLength(lib.MAX_TRASH_ENTRIES);
  });

  it("warns about nothing while the shelf has room", async () => {
    const now = Date.parse("2026-09-13T12:00:00.000Z");
    const trash = lib.projectTrashDir(owner);
    fs.mkdirSync(trash, { recursive: true });
    for (let i = 0; i < lib.MAX_TRASH_ENTRIES - 1; i += 1) {
      fs.mkdirSync(path.join(trash, stamped(`p${i}`, now, i * 60_000)));
    }
    expect(await lib.trashPurgedByOneMore(roots(), now)).toEqual({ count: lib.MAX_TRASH_ENTRIES - 1, early: [] });
  });

  it("counts an EXPIRED entry as room rather than as an early loss", async () => {
    // A full shelf where one entry is already past its thirty days: the
    // arriving folder takes that one's place, and nothing goes early.
    const now = Date.parse("2026-09-13T12:00:00.000Z");
    const trash = lib.projectTrashDir(owner);
    fs.mkdirSync(trash, { recursive: true });
    fs.mkdirSync(path.join(trash, stamped("ancient", now, 40 * day)));
    for (let i = 0; i < lib.MAX_TRASH_ENTRIES - 1; i += 1) {
      fs.mkdirSync(path.join(trash, stamped(`p${i}`, now, i * 60_000)));
    }
    expect((await lib.trashPurgedByOneMore(roots(), now)).early).toEqual([]);
  });

  it("counts one shelf ONCE when both roots are the same folder", async () => {
    // config.json is a file the owner can edit, so the project folder can be
    // pointed at `data/code-projects` by hand — the arrangement `listProjects`
    // already defends against by describing each real folder once. There is
    // then ONE trash, and reading it per-root counted every entry twice: the
    // shelf reported full at half the stated bound, so `trash_full` refused
    // early and the prune took recoverable projects before their time. That is
    // the same consent defect the count bound was stated to fix, arriving by
    // the back door.
    const now = Date.parse("2026-09-13T12:00:00.000Z");
    const code = path.join(root, "data", "code-projects");
    const both = { ownerFolder: code, codeProjects: code, checkout: root };
    const trash = lib.projectTrashDir(code);
    fs.mkdirSync(trash, { recursive: true });
    const half = Math.floor(lib.MAX_TRASH_ENTRIES / 2);
    for (let i = 0; i < half; i += 1) fs.mkdirSync(path.join(trash, stamped(`p${i}`, now, i * 60_000)));

    // Half a shelf is half a shelf, and nothing is at risk on it.
    expect(await lib.trashPurgedByOneMore(both, now)).toEqual({ count: half, early: [] });
    // And the prune takes nothing, rather than reporting each entry twice.
    expect(await lib.pruneProjectTrash(both, now)).toEqual({ removed: [], expired: [], early: [] });
    expect(fs.readdirSync(trash)).toHaveLength(half);

    // The same folder reached by a LINK counts once too — two spellings that
    // `path.resolve` cannot tell apart, which is why the dedupe is by real path
    // the way `listProjects` dedupes its own listing.
    const linked = path.join(root, "LinkedProjects");
    fs.symlinkSync(code, linked);
    expect(await lib.trashPurgedByOneMore({ ...both, ownerFolder: linked }, now))
      .toEqual({ count: half, early: [] });
  });

  it("counts the shelf ACROSS both roots, because the promise is one number for the box", async () => {
    // There is a trash per root now. If the bounds were applied per root, a box
    // with two roots would keep twice what "the {max} most recently removed
    // projects" says it keeps — the dialog's sentence would be wrong by a
    // factor, which is the same class of untruth the count bound was stated to
    // fix in the first place.
    const now = Date.parse("2026-09-13T12:00:00.000Z");
    const ownerTrash = lib.projectTrashDir(owner);
    const codeTrash = lib.projectTrashDir(path.join(root, "data", "code-projects"));
    fs.mkdirSync(ownerTrash, { recursive: true });
    fs.mkdirSync(codeTrash, { recursive: true });
    // Exactly full BETWEEN them, half in each.
    for (let i = 0; i < lib.MAX_TRASH_ENTRIES; i += 1) {
      const where = i % 2 === 0 ? ownerTrash : codeTrash;
      fs.mkdirSync(path.join(where, stamped(`p${i}`, now, i * 60_000)));
    }
    const oldest = stamped(`p${lib.MAX_TRASH_ENTRIES - 1}`, now, (lib.MAX_TRASH_ENTRIES - 1) * 60_000);

    expect(await lib.trashPurgedByOneMore(roots(), now)).toEqual({ count: lib.MAX_TRASH_ENTRIES, early: [oldest] });
    // And the prune reaches into the root the doomed entry actually lives in.
    const pruned = await lib.pruneProjectTrash(roots(), now);
    expect(pruned.removed).toEqual([]);
    expect(fs.readdirSync(ownerTrash).length + fs.readdirSync(codeTrash).length).toBe(lib.MAX_TRASH_ENTRIES);
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
