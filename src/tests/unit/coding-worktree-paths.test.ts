/**
 * Paths as a run in a worktree must say them (src/lib/coding-worktree-paths.ts):
 * a worker is told its worktree as its only folder, every project path it is
 * given is said inside it, and a refusal on `<project>/<rel>` whose
 * `<worktree>/<rel>` is there is answered with where it meant to go.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { BOX_NOTE_PREFIX } from "@/lib/coding-run-messages";
import {
  hintInFolder,
  toFolderPaths,
  worktreeCounterpart,
  worktreeHintFor,
  worktreeHintText,
  worktreeProject,
} from "@/lib/coding-worktree-paths";

const P = "/home/clawbox/Projects/site";
const W = `${P}/.clawbox/worktrees/t1-1`;

describe("worktreeProject", () => {
  it("answers the project of a team's or a run's worktree", () => {
    expect(worktreeProject(W)).toBe(P);
    expect(worktreeProject(`${P}/.clawbox/worktrees/run-ab12cd34/`)).toBe(P);
  });

  it("is null for a folder that is not one", () => {
    for (const dir of [P, `${P}/.clawbox/worktrees`, `${P}/.clawbox/worktrees/t1-1/src`, "/.clawbox/worktrees/t1-1", "relative/.clawbox/worktrees/t1-1", ""]) {
      expect(worktreeProject(dir), dir).toBeNull();
    }
  });
});

describe("toFolderPaths", () => {
  it("says the project path, and a path in it, inside the folder", () => {
    expect(toFolderPaths(`Edit ${P}/styles.css and ${P}/src/app.js`, P, W)).toBe(`Edit ${W}/styles.css and ${W}/src/app.js`);
    expect(toFolderPaths(`Work in ${P}.`, P, W)).toBe(`Work in ${W}.`);
    expect(toFolderPaths(`"${P}"`, P, W)).toBe(`"${W}"`);
    expect(toFolderPaths(P, P, W)).toBe(W);
  });

  it("says a sibling's worktree — and the folder's own — as the folder", () => {
    expect(toFolderPaths(`Wrote ${P}/.clawbox/worktrees/t2-1/index.html.`, P, W)).toBe(`Wrote ${W}/index.html.`);
    expect(toFolderPaths(`See ${P}/.clawbox/worktrees/t2-1.`, P, W)).toBe(`See ${W}.`);
    expect(toFolderPaths(`${W}/a.js`, P, W)).toBe(`${W}/a.js`);
  });

  it("leaves a longer name that only starts like the project, and a path the project sits inside, alone", () => {
    for (const text of [`${P}2/a.js`, `${P}.old/a.js`, `${P}-old`, `${P}_bak`, `/x${P}/a.js`, "nothing here", ""]) {
      expect(toFolderPaths(text, P, W), text).toBe(text);
    }
  });

  it("takes worktree paths back to the project for a reader in the project itself", () => {
    expect(toFolderPaths(`Built ${P}/.clawbox/worktrees/t1-1/index.html; open ${P}/index.html`, P, P)).toBe(`Built ${P}/index.html; open ${P}/index.html`);
  });

  it("does nothing without absolute folders, or for the root", () => {
    expect(toFolderPaths(`${P}/a`, "site", W)).toBe(`${P}/a`);
    expect(toFolderPaths(`${P}/a`, P, "t1-1")).toBe(`${P}/a`);
    expect(toFolderPaths("/a/b", "/", W)).toBe("/a/b");
  });
});

describe("hintInFolder", () => {
  it("gives a relative hint, or one in the project, as an absolute path in the folder", () => {
    expect(hintInFolder("styles.css", P, W)).toBe(`${W}/styles.css`);
    expect(hintInFolder("./src/", P, W)).toBe(`${W}/src/`);
    expect(hintInFolder("src/lib/a.ts", P, W)).toBe(`${W}/src/lib/a.ts`);
    expect(hintInFolder(`${P}/index.html`, P, W)).toBe(`${W}/index.html`);
    expect(hintInFolder(" styles.css ", P, W)).toBe(`${W}/styles.css`);
  });

  it("leaves a hint that was never the worker's to find in its folder as written", () => {
    expect(hintInFolder("../other/a.js", P, W)).toBe("../other/a.js");
    expect(hintInFolder("/etc/hosts", P, W)).toBe("/etc/hosts");
    expect(hintInFolder("~/notes.md", P, W)).toBe("~/notes.md");
    expect(hintInFolder("", P, W)).toBe("");
  });
});

describe("worktreeCounterpart and worktreeHintFor", () => {
  let base: string;
  let project: string;
  let worktree: string;

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "worktree-paths-")));
    project = path.join(base, "site");
    worktree = path.join(project, ".clawbox", "worktrees", "t1-1");
    fs.mkdirSync(path.join(worktree, "src"), { recursive: true });
    fs.writeFileSync(path.join(worktree, "styles.css"), "body {}");
    fs.writeFileSync(path.join(project, "styles.css"), "body {}");
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("answers the same path in the worktree when it is there — for a write, when its folder is", () => {
    expect(worktreeCounterpart(`${project}/styles.css`, worktree)).toBe(`${worktree}/styles.css`);
    expect(worktreeCounterpart(`${project}/src`, worktree)).toBe(`${worktree}/src`);
    expect(worktreeCounterpart(project, worktree)).toBe(worktree);
    // A new file: nothing to read there yet, but the folder it goes in is.
    expect(worktreeCounterpart(`${project}/src/new.ts`, worktree)).toBeNull();
    expect(worktreeCounterpart(`${project}/src/new.ts`, worktree, true)).toBe(`${worktree}/src/new.ts`);
    expect(worktreeCounterpart(`${project}/src/../styles.css`, worktree)).toBe(`${worktree}/styles.css`);
  });

  it("is null for what is not the worktree's to be pointed at", () => {
    // Not in the worktree, and no folder for it either.
    expect(worktreeCounterpart(`${project}/missing.css`, worktree)).toBeNull();
    expect(worktreeCounterpart(`${project}/nope/new.ts`, worktree, true)).toBeNull();
    // Outside the project; the project's own .clawbox (a sibling's worktree, this one).
    expect(worktreeCounterpart(`${base}/other/styles.css`, worktree)).toBeNull();
    expect(worktreeCounterpart(`${project}/../site2/styles.css`, worktree)).toBeNull();
    expect(worktreeCounterpart(`${project}/.clawbox/worktrees/t2-1/styles.css`, worktree)).toBeNull();
    expect(worktreeCounterpart(`${project}/.clawbox`, worktree)).toBeNull();
    // A run that is not in a worktree, and a relative target.
    expect(worktreeCounterpart(`${project}/styles.css`, project)).toBeNull();
    expect(worktreeCounterpart("styles.css", worktree)).toBeNull();
  });

  it("does not follow a link out of the worktree to decide", () => {
    fs.symlinkSync("/nonexistent-target-for-this-test", path.join(worktree, "dangling"));
    // The link itself is there, whatever it points at: the hint names the worktree path, nothing beyond it.
    expect(worktreeCounterpart(`${project}/dangling`, worktree)).toBe(`${worktree}/dangling`);
  });

  it("reads the path a file tool was pointed at, and never guesses at a shell command", () => {
    expect(worktreeHintFor(worktree, "Read", { file_path: `${project}/styles.css` })).toBe(`${worktree}/styles.css`);
    expect(worktreeHintFor(worktree, "Edit", { file_path: `${project}/styles.css`, old_string: "a", new_string: "b" })).toBe(`${worktree}/styles.css`);
    expect(worktreeHintFor(worktree, "Write", { file_path: `${project}/src/new.ts`, content: "x" })).toBe(`${worktree}/src/new.ts`);
    expect(worktreeHintFor(worktree, "Glob", { pattern: "**/*.css", path: project })).toBe(worktree);
    expect(worktreeHintFor(worktree, "Grep", { pattern: "body", path: `${project}/src` })).toBe(`${worktree}/src`);
    expect(worktreeHintFor(worktree, "NotebookEdit", { notebook_path: `${project}/styles.css` })).toBe(`${worktree}/styles.css`);
    // A read of a file that is not there has nothing to point at.
    expect(worktreeHintFor(worktree, "Read", { file_path: `${project}/src/new.ts` })).toBeNull();
    for (const [tool, input] of [
      ["Bash", { command: `cat ${project}/styles.css` }],
      ["WebFetch", { url: "https://example.com" }],
      ["Read", {}],
      ["Read", { file_path: 42 }],
      ["Read", null],
      [undefined, { file_path: `${project}/styles.css` }],
      ["toString", { file_path: `${project}/styles.css` }],
    ] as Array<[unknown, unknown]>) {
      expect(worktreeHintFor(worktree, tool, input), String(tool)).toBeNull();
    }
    // A run working in the project itself is never pointed anywhere.
    expect(worktreeHintFor(project, "Read", { file_path: `${project}/styles.css` })).toBeNull();
  });
});

describe("worktreeHintText", () => {
  it("is the box's note: the worktree as the only folder, the path to retry, and never the project's own path", () => {
    const text = worktreeHintText("Read", W, `${W}/styles.css`);
    expect(text.startsWith(`${BOX_NOTE_PREFIX} Your Read was refused`)).toBe(true);
    expect(text).toContain(`Your folder is ${W}`);
    expect(text).toContain(`that path is ${W}/styles.css: retry with that path`);
    expect(text.split(W).join("")).not.toContain(P);
  });
});
