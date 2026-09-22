import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import nextConfig from "../../../next.config";

/**
 * `data/` is the box's runtime state, and it sits inside the checkout the box
 * builds its own dashboard from. It changes while a build runs — a coding run
 * rotates its stream files under data/coding-agent-streams/, a webapp is
 * created or deleted — and it holds whatever a run left behind. Two updates on
 * one board, 2026-09-23, failed on it:
 *
 *   Symlink [project]/data/coding-agent-artifacts/run-…/venv/bin/python is
 *   invalid, it points out of the filesystem root
 *
 *   Error: ENOENT: no such file or directory, copyfile
 *   '…/data/coding-agent-streams/run-….err' -> '…/.next/standalone/data/…'
 *
 * The build tools must be told to leave it alone. tsconfig.json's exclusion is
 * pinned in tsconfig-excludes-data.test.ts; these are the other two.
 */
const REPO = process.cwd();

describe("next.config keeps data/ out of the traced output", () => {
  const excludes = nextConfig.outputFileTracingExcludes ?? {};

  it("excludes data/ for every route", () => {
    expect(excludes["*"] ?? []).toContain("data/**");
  });

  it("does not spell it with a ./ prefix, which matches nothing", () => {
    // Next matches these globs relative to the tracing root: "./data/**" was
    // accepted without complaint and excluded nothing, and the build went on
    // dying on data/webapps/<app>/index.html whenever a webapp changed mid-build.
    for (const [route, globs] of Object.entries(excludes)) {
      for (const glob of globs) {
        expect(glob, `${route}: ${glob}`).not.toMatch(/^\.\//);
      }
    }
  });
});

describe("eslint ignores data/", () => {
  it("lists data/** among the global ignores", () => {
    // Read as text: importing the flat config pulls in every plugin it names.
    const config = readFileSync(path.join(REPO, "eslint.config.mjs"), "utf-8");
    const ignores = /globalIgnores\(\[([^\]]*)\]\)/.exec(config)?.[1] ?? "";
    expect(ignores).toMatch(/["']data\/\*\*["']/);
  });
});
