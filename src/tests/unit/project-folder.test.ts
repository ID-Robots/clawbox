/**
 * src/lib/project-folder.ts — the owner's project folder, with ~/Projects in
 * force whenever they have not chosen one, the same for every reader.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { saveEnv } from "@/tests/helpers/env";
import {
  chosenProjectFolderFrom,
  defaultProjectFolder,
  ensureDefaultProjectFolder,
  PROJECT_FOLDER_CONFIG_KEY,
  projectFolderFrom,
} from "@/lib/project-folder";
import { CODING_AGENT_DIR_CONFIG_KEY } from "@/lib/coding-agent";

const require_ = createRequire(import.meta.url);
const { projectFolderOf } = require_("../../../scripts/app-port.js") as { projectFolderOf: (config: unknown) => string };

let home: string;
let restore: () => void;

beforeEach(() => {
  restore = saveEnv("HOME");
  home = fs.mkdtempSync(path.join(os.tmpdir(), "project-folder-"));
  process.env.HOME = home;
});

afterEach(() => {
  restore();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("the project folder in force", () => {
  it("is ~/Projects until the owner chooses one", () => {
    expect(defaultProjectFolder()).toBe(path.join(home, "Projects"));
    for (const unset of [undefined, null, "", "   ", 42, "relative/dir"]) {
      expect(chosenProjectFolderFrom(unset)).toBeNull();
      expect(projectFolderFrom(unset)).toBe(path.join(home, "Projects"));
    }
  });

  it("is the folder the owner chose, never replaced by the default", () => {
    expect(chosenProjectFolderFrom(" /srv/work ")).toBe("/srv/work");
    expect(projectFolderFrom("/srv/work")).toBe("/srv/work");
  });

  it("is read the same by production-server.js's proxy and the public links", () => {
    expect(projectFolderOf(null)).toBe(projectFolderFrom(undefined));
    expect(projectFolderOf({ [PROJECT_FOLDER_CONFIG_KEY]: "" })).toBe(projectFolderFrom(""));
    expect(projectFolderOf({ [PROJECT_FOLDER_CONFIG_KEY]: "/srv/work" })).toBe("/srv/work");
    expect(projectFolderOf({ [PROJECT_FOLDER_CONFIG_KEY]: "relative" })).toBe(projectFolderFrom("relative"));
  });

  it("is stored under the key the Coding Agent's setting writes", () => {
    expect(PROJECT_FOLDER_CONFIG_KEY).toBe(CODING_AGENT_DIR_CONFIG_KEY);
  });
});

describe("ensureDefaultProjectFolder", () => {
  it("makes ~/Projects, 0755 and the owner's, and leaves an existing one and its contents alone", async () => {
    const folder = await ensureDefaultProjectFolder();
    expect(folder).toBe(path.join(home, "Projects"));
    const stat = fs.statSync(folder);
    expect(stat.isDirectory()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o755);
    expect(stat.uid).toBe(fs.statSync(home).uid);

    fs.writeFileSync(path.join(folder, "keep.txt"), "the owner's");
    fs.chmodSync(folder, 0o750);
    await ensureDefaultProjectFolder();
    expect(fs.readFileSync(path.join(folder, "keep.txt"), "utf-8")).toBe("the owner's");
    expect(fs.statSync(folder).mode & 0o777).toBe(0o750);
  });

  it("never throws when the folder cannot be made", async () => {
    fs.writeFileSync(path.join(home, "Projects"), "a file where the folder would go");
    await expect(ensureDefaultProjectFolder()).resolves.toBe(path.join(home, "Projects"));
  });
});
