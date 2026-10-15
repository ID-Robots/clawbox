/**
 * No Prime Radiant element asks for a "grab" or "grabbing" cursor. The
 * ClawBox kiosk's cursor theme (DMZ-White, Debian's default) has neither
 * shape, and Chromium then draws no pointer at all: over the Map the mouse
 * simply vanished. Only shapes every theme has: default, pointer, move, text,
 * not-allowed.
 */
import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "../..");

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : /\.(tsx?|css)$/.test(e.name) ? [full] : [];
  });
}

/** Every source file of Prime Radiant's window, its Map and its routes. */
function primeRadiantFiles(): string[] {
  const components = path.join(SRC, "components");
  const files = fs
    .readdirSync(components, { withFileTypes: true })
    .flatMap((e) => {
      const full = path.join(components, e.name);
      if (!/^(PrimeRadiant|prime-radiant)/.test(e.name)) return [];
      return e.isDirectory() ? walk(full) : [full];
    });
  return [...files, ...walk(path.join(SRC, "app", "setup-api", "prime-radiant")), ...walk(path.join(SRC, "lib", "prime-radiant"))];
}

const GRAB = /cursor-grab|grabbing|cursor\s*[:=]\s*["'`]?\s*(?:-webkit-)?grab\b|["'`](?:-webkit-)?grab["'`]/;

describe("Prime Radiant cursors", () => {
  it("covers the Map and the window", () => {
    const names = primeRadiantFiles().map((f) => path.relative(SRC, f));
    expect(names).toContain(path.join("components", "PrimeRadiantMap.tsx"));
    expect(names).toContain(path.join("components", "prime-radiant-map", "view.ts"));
    expect(names).toContain(path.join("components", "PrimeRadiantApp.tsx"));
  });

  it("never asks for grab or grabbing, which the kiosk's cursor theme does not draw", () => {
    const offenders = primeRadiantFiles().flatMap((file) =>
      fs
        .readFileSync(file, "utf8")
        .split("\n")
        .map((line, i) => ({ line, at: `${path.relative(SRC, file)}:${i + 1}` }))
        .filter(({ line }) => GRAB.test(line))
        .map(({ at, line }) => `${at}: ${line.trim()}`),
    );
    expect(offenders).toEqual([]);
  });

  it("would catch one", () => {
    for (const line of ['className="cursor-grab active:cursor-grabbing"', 'canvas.style.cursor = "grab";', "cursor: grab;", 'style={{ cursor: "grabbing" }}']) {
      expect(GRAB.test(line)).toBe(true);
    }
    for (const line of ['canvas.style.cursor = "move";', "cursor-pointer", "cursor-default"]) expect(GRAB.test(line)).toBe(false);
  });
});
