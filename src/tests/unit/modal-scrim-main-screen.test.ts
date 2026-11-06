import { describe, it, expect } from "vitest";
import fs from "node:fs";
import nodePath from "node:path";

/**
 * Every full-screen modal scrim centres its panel on the MAIN monitor.
 *
 * In monitor mode the desktop is one window over a row of monitors, so a
 * `fixed inset-0 flex items-center justify-center` scrim centres its dialog on
 * the seam between two of them: the Force full update confirmation opened
 * there, half on each monitor, and the owner did not see it. The fix is one
 * class, `main-screen-scrim` (globals.css), fed by the root variables
 * `applyMainInsetVars` writes (src/lib/desktop-screens.ts). This test holds
 * every such scrim to the class, so the next dialog cannot forget it, and
 * holds the class to the four variables.
 *
 * Two shapes are scanned, over each file's whole text rather than line by
 * line, so a className wrapped across lines or written as a template literal
 * is still seen: a `className` whose classes are `fixed inset-0 …
 * items-center … justify-center`, and an inline `style={{ position: "fixed",
 * inset: 0, … alignItems: "center", justifyContent: "center" }}` — the shape
 * the overlays portalled out of the chat take.
 */
const REPO = nodePath.resolve(__dirname, "../../..");
const SRC = nodePath.join(REPO, "src");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = nodePath.join(dir, e.name);
    if (e.isDirectory()) {
      if (p !== nodePath.join(SRC, "tests")) out.push(...sourceFiles(p));
    } else if (/\.tsx$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

const CENTRED_SCRIM = (classes: string) =>
  classes.includes("fixed inset-0") && classes.includes("items-center") && classes.includes("justify-center");

const CENTRED_STYLE = (body: string) =>
  /\bposition:\s*["']fixed["']/.test(body) && /\binset:\s*0\b/.test(body)
  && /\balignItems:\s*["']center["']/.test(body) && /\bjustifyContent:\s*["']center["']/.test(body);

// `className="…"`, `className={"…"}`, `className={'…'}` or `className={`…`}`.
const CLASS_NAME = /className=(?:"([^"]*)"|\{\s*"([^"]*)"\s*\}|\{\s*'([^']*)'\s*\}|\{\s*`([^`]*)`\s*\})/g;
const STYLE_OBJECT = /style=\{\{([\s\S]*?)\}\}/g;

/** The opening tag a style object sits in, from its `<` to its `>`. */
function openingTag(text: string, start: number, end: number): string {
  const rest = text.slice(end);
  // The first `>` that is not an arrow's — including one straight after `}}`.
  const close = /(?:^|[^=])>/.exec(rest);
  return text.slice(text.lastIndexOf("<", start), end + (close ? close.index + close[0].length : rest.length));
}

type Scrim = { file: string; line: number; text: string; offset: number; tag: string };

function centredScrims(text: string, file: string): Scrim[] {
  const line = (offset: number) => text.slice(0, offset).split("\n").length;
  const found: Scrim[] = [];
  for (const m of text.matchAll(CLASS_NAME)) {
    const classes = m[1] ?? m[2] ?? m[3] ?? m[4] ?? "";
    if (CENTRED_SCRIM(classes)) found.push({ file, line: line(m.index), text, offset: m.index, tag: classes });
  }
  for (const m of text.matchAll(STYLE_OBJECT)) {
    if (CENTRED_STYLE(m[1])) {
      found.push({ file, line: line(m.index), text, offset: m.index, tag: openingTag(text, m.index, m.index + m[0].length) });
    }
  }
  return found;
}

const SCRIMS = sourceFiles(SRC).flatMap((f) => centredScrims(fs.readFileSync(f, "utf-8"), nodePath.relative(REPO, f)));

describe("modal scrims centre on the main monitor", () => {
  it("every centred full-screen scrim wears main-screen-scrim", () => {
    const offenders = SCRIMS.filter((s) => !s.tag.includes("main-screen-scrim")).map((s) => `${s.file}:${s.line}`);
    expect(offenders, "add `main-screen-scrim` to the scrim's className (see globals.css)").toEqual([]);
  });

  it("the scan recognises the shapes it guards", () => {
    expect(CENTRED_SCRIM("fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75")).toBe(true);
    expect(CENTRED_SCRIM("fixed inset-0 z-[9999] flex bg-black/65")).toBe(false);
    // A className wrapped across lines in a template literal…
    const wrapped = centredScrims('<div className={`fixed inset-0 z-50\n  flex items-center justify-center ${open ? "" : "hidden"}`}>', "x.tsx");
    expect(wrapped.map((s) => s.line)).toEqual([1]);
    // …and the inline-style shape, with the class on either side of the style.
    const inline = '<div\n  onClick={() => close()}\n  style={{ position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}\n>';
    expect(centredScrims(inline, "x.tsx").map((s) => [s.line, s.tag.includes("main-screen-scrim")])).toEqual([[3, false]]);
    const classed = inline.replace("<div", '<div className="main-screen-scrim"');
    expect(centredScrims(classed, "x.tsx").map((s) => s.tag.includes("main-screen-scrim"))).toEqual([true]);
    expect(centredScrims(inline.replace("\n>", ' className="main-screen-scrim">'), "x.tsx").map((s) => s.tag.includes("main-screen-scrim"))).toEqual([true]);
    expect(centredScrims('<div style={{ position: "fixed", inset: 0, display: "flex" }}>', "x.tsx")).toEqual([]);
    // A tag closed straight after its style ends there: the class of the
    // panel inside it is not the scrim's.
    const tight = '<div style={{ position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}><div className="main-screen-scrim" onClick={() => go()}>';
    expect(centredScrims(tight, "x.tsx").map((s) => s.tag.includes("main-screen-scrim"))).toEqual([false]);
    // Both shapes are found in the tree.
    expect(SCRIMS.length).toBeGreaterThan(20);
    expect(SCRIMS.some((s) => s.file.endsWith("VoiceTunnelDialog.tsx"))).toBe(true);
  });

  it("a scrim's panel is sized against the scrim, not the viewport", () => {
    // `max-h-[85vh]` is 85% of the whole ROW's height: in a 2560x1440 +
    // 1920x1080 row it is 1224px, taller than the main monitor the panel is
    // centred on, and the panel runs past its top and bottom edges. A
    // percentage of the scrim's box — `max-h-[85%]`, `max-h-full` — is a
    // percentage of the main monitor, and the same as before on one screen.
    const VIEWPORT_UNIT = /\d(?:d|s|l)?v[hw]\b|\b(?:min-|max-)?[hw]-(?:screen|[dsl]v[hw])\b/;
    const offenders: string[] = [];
    for (const s of SCRIMS) {
      const lines = s.text.slice(s.offset).split("\n").slice(0, 20);
      const hit = lines.findIndex((l) => !/^\s*(\/\/|\{?\/\*|\*)/.test(l) && VIEWPORT_UNIT.test(l));
      if (hit >= 0) offenders.push(`${s.file}:${s.line + hit}`);
    }
    expect(offenders, "size the panel in % of the scrim (see globals.css .main-screen-scrim)").toEqual([]);
  });

  it("the class spends the four root variables as a transparent border", () => {
    const css = fs.readFileSync(nodePath.join(SRC, "app", "globals.css"), "utf-8");
    const rule = css.match(/\.main-screen-scrim\s*\{([^}]*)\}/);
    expect(rule, "globals.css defines .main-screen-scrim").not.toBeNull();
    const body = rule![1];
    expect(body).toContain("border-color: transparent");
    for (const [side, name] of [["top", "--desk-main-top"], ["right", "--desk-main-right"], ["bottom", "--desk-main-bottom"], ["left", "--desk-main-left"]]) {
      expect(body).toContain(`border-${side}-width: var(${name}, 0px)`);
    }
    // The scrim's own dim paints under that border (background-clip stays
    // border-box), so every monitor is still dimmed: the class leaves the
    // background alone.
    expect(body).not.toMatch(/background/);
  });
});
