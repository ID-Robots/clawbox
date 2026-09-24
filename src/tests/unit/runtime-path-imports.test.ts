import { describe, it, expect } from "vitest";
import fs from "node:fs";
import nodePath from "node:path";

import runtimePath, { join, untraced } from "@/lib/runtime-path";

/**
 * Server code takes `path` from src/lib/runtime-path.ts, never from "path".
 *
 * Turbopack spots `path.join` and `path.resolve` by the module they are
 * imported from and turns every call onto a root it cannot know into a glob
 * over the project. One import of the real module in the server graph is
 * enough to put data/ back in the build: its live files in the traces Next
 * copies, and a coding run's venv in the directory walk that panicked on its
 * `bin/python` link (TASK-1102). scripts/check-build-isolation.sh proves the
 * whole build in CI. This is the fast half, and it names the file.
 *
 * Tests are exempt: they are not in the build.
 */
const REPO = nodePath.resolve(__dirname, "../../..");
const SRC = nodePath.join(REPO, "src");
const EXEMPT = new Set([
  nodePath.join(SRC, "lib", "runtime-path.ts"),
]);

const PATH_IMPORT = [
  // `import path from "path"`, `import { join } from "node:path"`, `export … from "path"`.
  // A type-only import is erased and reaches nothing.
  /^\s*(?:import|export)(?!\s+type\b)[^;]*?\sfrom\s+["'](?:node:)?path["']/m,
  /\brequire\(\s*["'](?:node:)?path["']\s*\)/,
  /\bimport\(\s*["'](?:node:)?path["']\s*\)/,
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = nodePath.join(dir, e.name);
    if (e.isDirectory()) {
      if (p !== nodePath.join(SRC, "tests")) out.push(...sourceFiles(p));
    } else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

describe("server code imports path from src/lib/runtime-path", () => {
  it("no file under src/ outside the tests imports Node's path module directly", () => {
    const offenders = sourceFiles(SRC)
      .filter((f) => !EXEMPT.has(f))
      .filter((f) => {
        const text = fs.readFileSync(f, "utf-8");
        return PATH_IMPORT.some((re) => re.test(text));
      })
      .map((f) => nodePath.relative(REPO, f));
    expect(offenders, "import path from \"@/lib/runtime-path\" (or \"./runtime-path\" beside it) instead").toEqual([]);
  });

  it("the guard sees each shape it is meant to catch", () => {
    // A guard whose patterns match nothing passes forever.
    const caught = (text: string) => PATH_IMPORT.some((re) => re.test(text));
    expect(caught('import path from "path";')).toBe(true);
    expect(caught("import path from 'node:path'")).toBe(true);
    expect(caught('import { join, resolve } from "path";')).toBe(true);
    expect(caught('export { join } from "path";')).toBe(true);
    expect(caught('const nodePath = require("path")')).toBe(true);
    expect(caught('const p = await import("node:path")')).toBe(true);
    expect(caught('import type { ParsedPath } from "path";')).toBe(false);
    expect(caught('import path from "@/lib/runtime-path";')).toBe(false);
    expect(caught('import { readFile } from "fs/promises";')).toBe(false);
  });
});

describe("src/lib/runtime-path", () => {
  it("is Node's own path module, so no call behaves differently", () => {
    expect(runtimePath).toBe(nodePath);
    expect(join).toBe(nodePath.join);
    expect(runtimePath.join("/a", "b", "../c")).toBe("/a/c");
  });

  it("untraced hands back the very string it was given", () => {
    const tmp = "/home/clawbox/clawbox/data/config.json.tmp";
    expect(untraced(tmp)).toBe(tmp);
    expect(untraced("")).toBe("");
  });
});
