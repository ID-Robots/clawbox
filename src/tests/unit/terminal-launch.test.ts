/**
 * Which shell a new terminal runs and where it starts (scripts/terminal-launch.mjs),
 * and the web server's copy of the /etc/shells reading (src/lib/terminal-shells.ts)
 * that fills the settings sheet's list. The same table runs against both copies.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import * as launch from "../../../scripts/terminal-launch.mjs";
import * as shells from "@/lib/terminal-shells";

const ETC_SHELLS = `# /etc/shells: valid login shells
/bin/sh
/bin/bash
/usr/bin/bash   # merged /usr
/bin/bash
relative/zsh
/usr/bin/with space
  /usr/bin/zsh
`;

describe.each([
  ["scripts/terminal-launch.mjs", launch],
  ["src/lib/terminal-shells.ts", shells],
])("parseEtcShells (%s)", (_name, mod) => {
  it("keeps absolute paths once each, in order, without comments", () => {
    expect(mod.parseEtcShells(ETC_SHELLS)).toEqual(["/bin/sh", "/bin/bash", "/usr/bin/bash", "/usr/bin/zsh"]);
  });

  it("reads nothing from a missing file", () => {
    expect(mod.readEtcShells("/nonexistent/etc/shells")).toEqual([]);
  });

  it("offers each installed binary once", () => {
    // /bin/sh exists on every test host; a path that is not installed is dropped.
    expect(mod.availableShells(["/bin/sh", "/nonexistent/fish", "/bin/sh"])).toEqual(["/bin/sh"]);
  });
});

describe("resolveShell", () => {
  it("starts the requested shell when /etc/shells lists it and it is installed", () => {
    expect(launch.resolveShell("/bin/sh", ["/bin/sh", "/bin/bash"])).toEqual({ shell: "/bin/sh", refused: null });
  });

  it("starts bash for no request", () => {
    expect(launch.resolveShell("", ["/bin/sh"])).toEqual({ shell: "/bin/bash", refused: null });
    expect(launch.resolveShell(null, ["/bin/sh"])).toEqual({ shell: "/bin/bash", refused: null });
  });

  it("refuses anything /etc/shells does not list, or that is not installed", () => {
    expect(launch.resolveShell("/usr/bin/python3", ["/bin/sh"])).toEqual({ shell: "/bin/bash", refused: "/usr/bin/python3" });
    expect(launch.resolveShell("/nonexistent/fish", ["/nonexistent/fish"])).toEqual({ shell: "/bin/bash", refused: "/nonexistent/fish" });
    expect(launch.resolveShell("sh", ["/bin/sh"])).toEqual({ shell: "/bin/bash", refused: "sh" });
  });
});

describe("resolveCwd", () => {
  let home: string;
  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-launch-"));
    fs.mkdirSync(path.join(home, "projects", "app"), { recursive: true });
    fs.writeFileSync(path.join(home, "notes.txt"), "x");
  });
  afterAll(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("starts in the home folder for nothing, ~ and ~/", () => {
    for (const value of ["", "~", "~/", null, undefined, "   "]) {
      expect(launch.resolveCwd(value, home)).toEqual({ cwd: home, refused: null });
    }
  });

  it("takes ~/x, a relative path and an absolute path to a folder that exists", () => {
    expect(launch.resolveCwd("~/projects", home)).toEqual({ cwd: path.join(home, "projects"), refused: null });
    expect(launch.resolveCwd("projects/app", home)).toEqual({ cwd: path.join(home, "projects", "app"), refused: null });
    expect(launch.resolveCwd(path.join(home, "projects"), home)).toEqual({ cwd: path.join(home, "projects"), refused: null });
  });

  it("refuses a missing folder, a file, and control characters, and starts at home", () => {
    expect(launch.resolveCwd("~/missing", home)).toEqual({ cwd: home, refused: "~/missing" });
    expect(launch.resolveCwd("notes.txt", home)).toEqual({ cwd: home, refused: "notes.txt" });
    expect(launch.resolveCwd("projects\nrm -rf", home)).toEqual({ cwd: home, refused: "projects\nrm -rf" });
    expect(launch.resolveCwd("x".repeat(2000), home).cwd).toBe(home);
  });
});
