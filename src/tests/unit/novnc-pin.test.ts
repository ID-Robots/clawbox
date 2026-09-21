import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * @novnc/novnc 1.7 is ESM and exports only its public package root. The 1.6
 * private `lib/*` imports were Babel CommonJS; Turbopack emitted their free
 * `exports` reference into a browser chunk and Remote Desktop crashed before
 * it could connect. These tests keep the exact ESM pin and reject any return
 * to private subpaths.
 */

const REPO_ROOT = path.resolve(__dirname, "../../..");
const PACKAGE = "@novnc/novnc";

// The last version that ships `lib/` with no `exports` map. Written literally
// rather than read back from package.json, so loosening the pin cannot make
// this test vacuously agree with itself.
const PINNED_VERSION = "1.7.0";

// Resolve exactly the way the app does — from the repo root, against the
// installed tree. require.resolve honours `exports`, so it refuses on 1.7.0.
const requireFromRepo = createRequire(path.join(REPO_ROOT, "package.json"));

function readJson(...segments: string[]): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, ...segments), "utf8"));
}

const SRC_DIR = path.join(REPO_ROOT, "src");

// Files that actually import the package, which means: application code only.
//
//   - src/tests is skipped because this file names both specifiers in its own
//     comments and vnc-app.test.tsx names one in a vi.mock call.
//   - .d.ts is skipped because a `declare module` is a type shim describing an
//     import made elsewhere, not an import itself. Counting it would let the
//     guard below stay green off novnc.d.ts alone after the real importers had
//     gone — the exact case that guard exists to catch.
//
// What is left is the code whose resolution actually has to work: vnc-keys.ts
// and VNCApp.tsx.
function importingSources(): string[] {
  return readdirSync(SRC_DIR, { recursive: true, encoding: "utf8" })
    .filter(
      (entry) =>
        /\.tsx?$/.test(entry) &&
        !entry.endsWith(".d.ts") &&
        entry.split(path.sep)[0] !== "tests",
    )
    .map((entry) => path.join(SRC_DIR, entry));
}

// Every module specifier in a file, read off the syntax tree. Three node kinds
// carry one, and VNCApp uses all three:
//
//   import RFB from "..."                       ImportDeclaration
//   await import("...")                         CallExpression on ImportKeyword
//   typeof import("...").default                ImportTypeNode (type position)
//
// Matching quoted text instead would count a path named in a comment or held in
// an ordinary string, which is the same hollowness as scanning the tests: the
// guard below could stay green after the real import was deleted.
function moduleSpecifiers(file: string): string[] {
  const text = readFileSync(file, "utf8");

  // Parsing every source file costs seconds; this parses the two that matter.
  if (!text.includes(PACKAGE)) return [];

  const parsed = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];

  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      found.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      found.push(node.arguments[0].text);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      found.push(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  };

  visit(parsed);
  return found;
}

// Discover the specifiers rather than hard-coding them, so a newly added deep
// import is covered by these tests the day it lands instead of the day it breaks.
const NOVNC_SPECIFIERS = [
  ...new Set(
    importingSources()
      .flatMap(moduleSpecifiers)
      .filter((specifier) => specifier === PACKAGE || specifier.startsWith(`${PACKAGE}/`)),
  ),
].sort();

describe("@novnc/novnc pin", () => {
  it("pins an exact version in package.json", () => {
    const dependencies = readJson("package.json").dependencies as Record<string, string>;

    expect(dependencies[PACKAGE]).toBe(PINNED_VERSION);
  });

  it("resolves to the pinned version in bun.lock", () => {
    const lockfile = readFileSync(path.join(REPO_ROOT, "bun.lock"), "utf8");

    // The RESOLUTION entry, not the `workspaces` block at the top — that block
    // is only bun's echo of package.json's range, so asserting it would just
    // restate the test above. This line is what `--frozen-lockfile` installs.
    expect(lockfile).toContain(`"${PACKAGE}": ["${PACKAGE}@${PINNED_VERSION}"`);
  });

  it("has the pinned version installed", () => {
    const installed = readJson("node_modules", "@novnc", "novnc", "package.json");

    expect(installed.version).toBe(PINNED_VERSION);
  });

  it("uses the public ESM entry point and no private subpaths", () => {
    expect(NOVNC_SPECIFIERS).toEqual([PACKAGE]);
  });

  it.each(NOVNC_SPECIFIERS)("resolves %s against the installed copy", (specifier) => {
    expect(() => requireFromRepo.resolve(specifier)).not.toThrow();
  });
});
