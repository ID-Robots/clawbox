import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { WIN_GROUND, WIN_STRIP_FADE, WIN_STRIP_HEIGHT, win } from "@/lib/window-chrome";

const ROOT = path.resolve(__dirname, "../../..");
const css = readFileSync(path.join(ROOT, "src/app/globals.css"), "utf8");

const START = "/* ═══ WINDOW CHROME";
const END = "/* ═══ end WINDOW CHROME ═══ */";
const squash = (s: string) => s.replace(/\s+/g, "");

function declaration(block: string, prop: string): string {
  const m = block.match(new RegExp(`${prop.replace(/[-]/g, "\\-")}:\\s*([^;]+);`));
  if (!m) throw new Error(`${prop} is not declared in the WINDOW CHROME block`);
  return m[1].trim();
}

describe("window chrome tokens — CSS and TS agree", () => {
  const start = css.indexOf(START);
  const end = css.indexOf(END);
  const block = css.slice(start, end);

  it("declares the block exactly once", () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(css.split(START).length - 1).toBe(1);
    expect(css.split(END).length - 1).toBe(1);
  });

  it("pins the two JS literals to their custom properties", () => {
    expect(block).toContain(`--win-ground: ${WIN_GROUND};`);
    expect(block).toContain(`--win-strip-h: ${WIN_STRIP_HEIGHT}px;`);
    expect(block).toContain("--win-radius: 16px;");
    expect(squash(declaration(block, "--win-strip-fade"))).toBe(squash(WIN_STRIP_FADE));
  });

  it("declares every token the `win` object points at, and the button's focus ring", () => {
    for (const value of Object.values(win)) {
      const name = value.slice("var(".length, -1);
      expect(block).toContain(`${name}:`);
    }
    expect(block).toContain("--win-shadow:");
    expect(block).toContain("--win-shadow-idle:");
    expect(block).toContain(".win-strip-btn:focus-visible");
  });

  it("never blurs — gradients and box-shadows only, for the Jetson iGPU", () => {
    expect(block).not.toMatch(/backdrop-filter|filter:/);
  });

  // Chat drift guard until phase 2. Delete these two assertions when ChatPopup
  // imports @/lib/window-chrome (phase 2) and assert on the import instead.
  it("matches the mascot chat popup, the reference, literal for literal", () => {
    const chat = readFileSync(path.join(ROOT, "src/components/ChatPopup.tsx"), "utf8");
    expect(chat).toContain(`background: '${WIN_GROUND}'`);
    expect(squash(chat)).toContain(squash(WIN_STRIP_FADE));
  });
});
