/**
 * runChild starts only allowlisted bare commands or absolute, non-shell
 * programs; runScript runs a script FILE under bash with argv, never a string.
 */
import { describe, expect, it } from "vitest";
import { resolveBin, runChild, runScript } from "@/lib/child-run";

const ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C" };

describe("resolveBin", () => {
  it("allows the fixed bare commands", () => {
    for (const b of ["git", "gh", "ffmpeg", "pdftotext", "libreoffice", "ss"]) expect(resolveBin(b)).toBe(b);
  });
  it("allows absolute non-shell programs", () => {
    expect(resolveBin(process.execPath)).toBe(process.execPath);
    expect(resolveBin("/usr/bin/python3")).toBe("/usr/bin/python3");
  });
  it("refuses shells, unknown names, relative and odd paths", () => {
    for (const b of ["sh", "bash", "/bin/sh", "/usr/bin/bash", "/usr/bin/env", "curl", "node", "./git", "git; rm -rf /",
      "/usr/bin/../bin/sh", "", "/usr/bin/git\n", "constructor", "__proto__", "toString"]) {
      expect(resolveBin(b)).toBeNull();
    }
  });
});

describe("runChild", () => {
  it("refuses a shell without starting it", async () => {
    const r = await runChild("sh", ["-c", "echo pwned"], { timeoutMs: 5_000, env: ENV });
    expect(r.startFailed).toBe(true);
    expect(r.code).toBeNull();
    expect(r.stdout).toBe("");
  });
  it("passes a hostile argument through as plain argv", async () => {
    const evil = "$(echo pwned); `id` | cat";
    const r = await runChild(process.execPath, ["-e", "process.stdout.write(process.argv[1])", evil], { timeoutMs: 10_000, env: ENV });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(evil);
  });
});

describe("runScript", () => {
  it("refuses a relative script path", async () => {
    const r = await runScript("x.sh", [], { timeoutMs: 5_000, env: ENV });
    expect(r.startFailed).toBe(true);
  });
});
