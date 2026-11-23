/**
 * The multi-folder project store (TASK-2757, src/lib/project-folders.ts): one
 * config key, `{ [project]: [{ folder, base? }] }`.
 *
 * What is under test: only git repositories directly inside the owner's
 * project folder can be listed; "create" makes the project's own folder when
 * there is none and refuses a project that already lists folders; "add" on a
 * project with no list starts it with the project's OWN repository first;
 * "remove" back to the project's own folder alone (or nothing) drops the entry,
 * which is what makes it a single-folder project again; a bad base branch, a
 * ninth folder and a hand-edited row are refused or ignored.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";

type Lib = typeof import("@/lib/project-folders");

let lib: Lib;
let base: string;
let projects: string;
let restore: () => void;

function repo(name: string): void {
  fs.mkdirSync(path.join(projects, name, ".git"), { recursive: true });
}

function config(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(base, "data", "config.json"), "utf8")) as Record<string, unknown>;
}

beforeEach(async () => {
  restore = saveEnv("CLAWBOX_ROOT");
  base = fs.mkdtempSync(path.join(os.tmpdir(), "project-folders-"));
  projects = path.join(base, "Projects");
  fs.mkdirSync(path.join(base, "data"), { recursive: true });
  fs.writeFileSync(path.join(base, "data", "config.json"), "{}");
  fs.mkdirSync(projects, { recursive: true });
  process.env.CLAWBOX_ROOT = base;
  for (const name of ["gateway", "dashboard", "docs"]) repo(name);
  fs.mkdirSync(path.join(projects, "plain"));
  vi.resetModules();
  lib = await import("@/lib/project-folders");
});

afterEach(() => {
  restore();
  fs.rmSync(base, { recursive: true, force: true });
});

describe("creating a multi-folder project", () => {
  it("makes the project's own folder and lists exactly the repositories named", async () => {
    const folders = await lib.createFolderProject(projects, "skyhub", ["gateway", { folder: "dashboard", base: "origin/develop" }]);
    expect(folders).toEqual([{ folder: "gateway" }, { folder: "dashboard", base: "develop" }]);
    expect(fs.statSync(path.join(projects, "skyhub")).isDirectory()).toBe(true);
    expect(await lib.readProjectFolders("skyhub")).toEqual(folders);
    expect(config().coding_agent_project_folders).toEqual({ skyhub: folders });
  });

  it("refuses a folder that is not a repository in the project folder, a project that already has a list, and a bad base", async () => {
    await expect(lib.createFolderProject(projects, "skyhub", ["plain"])).rejects.toMatchObject({ code: "not_a_repository" });
    await expect(lib.createFolderProject(projects, "skyhub", ["../gateway"])).rejects.toMatchObject({ code: "invalid_folder" });
    await expect(lib.createFolderProject(projects, "sky hub", ["gateway"])).rejects.toMatchObject({ code: "invalid_project" });
    await expect(lib.createFolderProject(projects, "skyhub", [{ folder: "gateway", base: "-x" }])).rejects.toMatchObject({ code: "invalid_folder" });
    await lib.createFolderProject(projects, "skyhub", ["gateway"]);
    await expect(lib.createFolderProject(projects, "skyhub", ["dashboard"])).rejects.toMatchObject({ code: "exists" });
    expect(await lib.readProjectFolders("skyhub")).toEqual([{ folder: "gateway" }]);
  });

  it("caps a project at eight folders", async () => {
    for (let i = 0; i < 9; i++) repo(`r${i}`);
    await expect(lib.createFolderProject(projects, "big", Array.from({ length: 9 }, (_, i) => `r${i}`))).rejects.toMatchObject({ code: "too_many" });
  });
});

describe("adding and removing a folder on a project's page", () => {
  it("starts a project's list with its own repository, and drops the list when only that is left", async () => {
    expect(await lib.readProjectFolders("gateway")).toBeNull();
    expect(await lib.addProjectFolder(projects, "gateway", "dashboard")).toEqual([{ folder: "gateway" }, { folder: "dashboard" }]);
    expect(await lib.addProjectFolder(projects, "gateway", "docs", "main")).toEqual([{ folder: "gateway" }, { folder: "dashboard" }, { folder: "docs", base: "main" }]);
    expect(await lib.removeProjectFolder("gateway", "docs")).toEqual([{ folder: "gateway" }, { folder: "dashboard" }]);
    expect(await lib.removeProjectFolder("gateway", "dashboard")).toEqual([]);
    expect(await lib.readProjectFolders("gateway")).toBeNull();
    expect(config()).not.toHaveProperty("coding_agent_project_folders");
  });

  it("refuses to remove a folder the project does not list", async () => {
    await expect(lib.removeProjectFolder("gateway", "dashboard")).rejects.toMatchObject({ code: "not_found" });
  });

  it("ignores a hand-edited row it could not have written", async () => {
    fs.writeFileSync(path.join(base, "data", "config.json"), JSON.stringify({
      coding_agent_project_folders: { skyhub: [{ folder: "gateway" }, { folder: "../etc" }, "dashboard", { folder: "gateway" }], "not a name": [{ folder: "x" }] },
    }));
    expect(await lib.readProjectFolders("skyhub")).toEqual([{ folder: "gateway" }]);
    expect(Object.keys(await lib.listProjectFolders())).toEqual(["skyhub"]);
    // Nothing inherited reads as a list.
    expect(await lib.readProjectFolders("constructor")).toBeNull();
  });

  it("forgets a deleted project's list", async () => {
    await lib.createFolderProject(projects, "skyhub", ["gateway", "dashboard"]);
    await lib.deleteProjectFolders("skyhub");
    expect(await lib.readProjectFolders("skyhub")).toBeNull();
  });

  it("takes a deleted folder off every other project's list, and drops a list left with its own folder alone", async () => {
    await lib.createFolderProject(projects, "skyhub", ["gateway", "dashboard", "docs"]);
    await lib.addProjectFolder(projects, "gateway", "dashboard");
    await lib.deleteProjectFolders("dashboard");
    expect(await lib.readProjectFolders("skyhub")).toEqual([{ folder: "gateway" }, { folder: "docs" }]);
    expect(await lib.readProjectFolders("gateway")).toBeNull();
  });
});
