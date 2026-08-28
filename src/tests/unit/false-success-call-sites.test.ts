import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * The rule these three fixes have in common, encoded so the next call site
 * cannot quietly opt out of it.
 *
 * Every one of them was the same shape: an operation that reports the fact a
 * call RETURNED rather than what it returned. Fixing the lib and the one route
 * named in the bug report is not enough — what has repeatedly gone wrong in
 * this repo is a correct fix with an unguarded sibling, so the check is over
 * EVERY caller, not the one that was reported.
 *
 * File granularity on purpose: coarse enough to survive refactoring, precise
 * enough that a new caller which ignores the verdict fails here rather than on
 * a customer's box.
 */

const SRC = path.join(process.cwd(), "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (entry === "tests" || entry === "node_modules") continue;
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const FILES = walk(SRC).map((file) => ({ file, text: readFileSync(file, "utf-8") }));

/** Paths relative to the repo, so a failure names the file to open. */
const rel = (file: string) => path.relative(process.cwd(), file).split(path.sep).join("/");

describe("the tunnel's boot-persist verdict reaches every caller", () => {
  // `systemctl stop` and `systemctl disable` are separate calls, and the second
  // is the one that decides whether the box publishes itself again after a
  // reboot. It used to be swallowed into a console.warn.
  const callers = FILES.filter(
    ({ file, text }) =>
      !file.endsWith(path.join("lib", "cloudflared.ts"))
      && /\b(start|stop)TunnelService\s*\(/.test(text),
  );

  it("has callers at all (the check is not vacuously passing)", () => {
    expect(callers.length).toBeGreaterThan(0);
  });

  it.each(callers.map(({ file, text }) => [rel(file), text] as const))(
    "%s reads the verdict rather than assuming it",
    (_name, text) => {
      expect(text).toContain("bootPersisted");
    },
  );
});

describe("the hotspot AP verdict reaches every caller", () => {
  // `{ success: true, apRestarted: false }` was the answer to a deliberate
  // deferral, a clean stop AND a toggle that threw. A caller that reads only
  // `apRestarted` still cannot tell the third from the first two.
  const callers = FILES.filter(({ text }) =>
    /fetch\(\s*"\/setup-api\/system\/hotspot"[\s\S]{0,400}?method:\s*"POST"/.test(text),
  );

  it("has callers at all (the check is not vacuously passing)", () => {
    expect(callers.length).toBeGreaterThan(0);
  });

  it.each(callers.map(({ file, text }) => [rel(file), text] as const))(
    "%s reads apAction rather than only apRestarted",
    (_name, text) => {
      expect(text).toContain("apAction");
    },
  );
});
