import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * `data/` must never be type-checked.
 *
 * It is the device's runtime directory, and a coding-agent run writes into it:
 * `data/coding-agent-artifacts/<runId>/` is that run's evidence folder, and a
 * run is free to save whatever it produced there — including TypeScript.
 *
 * tsconfig.json includes `**\/*.ts`, so before this exclusion those files were
 * part of the project. `next build` type-checks the project, so one scratch file
 * a run left behind failed the build:
 *
 *   data/coding-agent-artifacts/run-cds5h5f6/_verify-logic.ts(1,25):
 *     error TS2307: Cannot find module './src/data/forests'
 *
 * That is not a cosmetic failure. `do_rebuild` runs `bun run build`, so the box
 * could no longer build — and therefore could no longer UPDATE ITSELF. Observed
 * on hardware 2026-09-04: an in-app update reached the rebuild step and exited
 * 1, leaving the device with no web server until it was repaired by hand.
 *
 * CI cannot catch it: a fresh checkout has no artifacts, so the same commit
 * builds green in the pipeline and fails on any box where a run has saved a
 * `.ts` file. The exclusion is the only thing standing between the two.
 */
const REPO = process.cwd();

/** tsconfig.json permits comments; strip them before parsing. */
function tsconfig(): { include?: string[]; exclude?: string[] } {
  const raw = readFileSync(path.join(REPO, "tsconfig.json"), "utf-8");
  return JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ""));
}

describe("tsconfig keeps the runtime data directory out of the project", () => {
  it("excludes data/", () => {
    expect(tsconfig().exclude ?? []).toContain("data");
  });

  it("still includes the source it is meant to check", () => {
    // The exclusion must not have been achieved by narrowing `include` — the
    // whole point is that src/ is still type-checked.
    expect(tsconfig().include ?? []).toContain("**/*.ts");
  });

  it("keeps the exclusions that were already there", () => {
    // A regression here would quietly re-admit node_modules or the MCP tree,
    // which is a slow build at best and a wall of errors at worst.
    const exclude = tsconfig().exclude ?? [];
    for (const dir of ["node_modules", "mcp", "code-source-code", "bench"]) {
      expect(exclude, `${dir} must stay excluded`).toContain(dir);
    }
  });
});
