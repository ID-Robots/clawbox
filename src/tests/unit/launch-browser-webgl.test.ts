import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The desktop's Chromium (the one the VNC shows and the coding agent drives)
 * has no GPU worth the name over VNC. `--disable-gpu` used to switch the whole
 * GPU process off — and Chromium's software WebGL (SwiftShader, via ANGLE)
 * runs INSIDE that process, so every <canvas> WebGL context failed: the coding
 * agent's own Three.js game reported "WebGL not supported" on the box that
 * built it. Compositing stays in software; WebGL gets a GPU process running
 * SwiftShader, and the switch recent Chromium requires before handing a page
 * a software context. This pins the three flags and the absence of the
 * one that undid them.
 */
const script = fs.readFileSync(path.resolve(__dirname, "../../../scripts/launch-browser.sh"), "utf8");
const flags = script.split("\n").filter((l) => /^\s+--[a-z-]+/.test(l)).map((l) => l.trim().replace(/ \\$/, ""));

describe("the desktop Chromium's WebGL", () => {
  it("runs SwiftShader in a GPU process instead of switching the process off", () => {
    expect(flags).toContain("--use-gl=angle");
    expect(flags).toContain("--use-angle=swiftshader");
    expect(flags).toContain("--enable-unsafe-swiftshader");
    expect(flags).toContain("--disable-gpu-compositing");
    expect(flags).not.toContain("--disable-gpu");
  });
});
