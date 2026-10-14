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
 * Only the one-line `className="… fixed inset-0 …"` shape is scanned — it is
 * the shape every scrim on the desktop takes today.
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

const CENTRED_SCRIM = (line: string) =>
  line.includes("fixed inset-0") && line.includes("items-center") && line.includes("justify-center");

describe("modal scrims centre on the main monitor", () => {
  it("every centred full-screen scrim wears main-screen-scrim", () => {
    const offenders: string[] = [];
    for (const f of [...sourceFiles(nodePath.join(SRC, "components")), ...sourceFiles(nodePath.join(SRC, "app"))]) {
      const lines = fs.readFileSync(f, "utf-8").split("\n");
      lines.forEach((line, i) => {
        if (CENTRED_SCRIM(line) && !line.includes("main-screen-scrim")) {
          offenders.push(`${nodePath.relative(REPO, f)}:${i + 1}`);
        }
      });
    }
    expect(offenders, "add `main-screen-scrim` to the scrim's className (see globals.css)").toEqual([]);
  });

  it("the scan recognises the shape it guards", () => {
    expect(CENTRED_SCRIM('className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75"')).toBe(true);
    expect(CENTRED_SCRIM('className="fixed inset-0 z-[9999] flex bg-black/65"')).toBe(false);
    const sites = [...sourceFiles(nodePath.join(SRC, "components")), ...sourceFiles(nodePath.join(SRC, "app"))]
      .flatMap((f) => fs.readFileSync(f, "utf-8").split("\n"))
      .filter(CENTRED_SCRIM).length;
    expect(sites).toBeGreaterThan(20);
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
  });
});
