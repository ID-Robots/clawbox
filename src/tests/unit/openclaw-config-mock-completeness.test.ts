import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * A standing hole in this suite, closed by making it loud.
 *
 * Fifty-nine test files replace `@/lib/openclaw-config` with a hand-written
 * factory. A factory is a WHOLE-module replacement: any export it does not list
 * is `undefined` at runtime. That is harmless until a route narrows on one of
 * them — `err instanceof GatewayNotReadyError` — because `instanceof undefined`
 * throws a `TypeError`, the route's outer catch turns it into a 500, and the
 * amber "saved, the gateway is still coming back" notice the owner should have
 * seen is gone. Worse, it is LATENT: a factory whose `restartGateway` never
 * rejects stays green, so the file passes for years and fails the day someone
 * adds the first rejecting case.
 *
 * TASK-608 fixed this by hand four times. Hand-fixing does not scale to the
 * next export or the next narrowing route, so this test does the enumeration
 * instead: every test file that mocks the module AND can reach a module that
 * narrows on `GatewayNotReadyError` must either provide the real class or use a
 * partial mock over `importActual`.
 */

const SRC = path.resolve(__dirname, "..", "..");
const MOCKED_MODULE = "@/lib/openclaw-config";
const NARROWED_EXPORT = "GatewayNotReadyError";

/** Every .ts/.tsx file under src/, as absolute paths. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      sourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** `@/x/y` → the file it resolves to under src/, or null. */
function resolveAlias(spec: string): string | null {
  const base = path.join(SRC, spec.slice(2));
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "route.ts"),
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** The `@/…` specifiers a file imports, statically or with `await import()`. */
function aliasImports(text: string): string[] {
  const specs = new Set<string>();
  for (const m of text.matchAll(/["'](@\/[^"']+)["']/g)) specs.add(m[1]);
  return [...specs];
}

/**
 * The body of `vi.mock("<module>", …)`, matched by counting parentheses so a
 * factory containing its own `}))` cannot cut the block short.
 */
function mockCall(text: string, moduleId: string): string | null {
  const start = text.indexOf(`vi.mock("${moduleId}"`);
  if (start === -1) return null;
  let depth = 0;
  for (let i = text.indexOf("(", start); i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text.slice(start);
}

const files = sourceFiles(SRC);
const read = new Map<string, string>(files.map((f) => [f, fs.readFileSync(f, "utf8")]));

// Which modules narrow on the export. `openclaw-config` itself is excluded on
// purpose: it is the module being REPLACED, so its own narrowing never runs
// under a mock, and counting it would taint all 59 files instead of the ones
// that can actually hit the TypeError.
const narrowing = new Set(
  files.filter(
    (f) =>
      f !== path.join(SRC, "lib", "openclaw-config.ts") &&
      read.get(f)!.includes(`instanceof ${NARROWED_EXPORT}`),
  ),
);

// Taint flows from a narrowing module to everything that imports it, directly
// or through any chain of `@/` imports — a component test that renders a panel
// that calls a narrowing route is exposed exactly like the route's own suite.
const importers = new Map<string, string[]>();
for (const file of files) {
  for (const spec of aliasImports(read.get(file)!)) {
    const target = resolveAlias(spec);
    if (!target) continue;
    const list = importers.get(target);
    if (list) list.push(file);
    else importers.set(target, [file]);
  }
}
const reaches = new Set(narrowing);
const queue = [...narrowing];
while (queue.length > 0) {
  for (const importer of importers.get(queue.pop()!) ?? []) {
    if (reaches.has(importer)) continue;
    reaches.add(importer);
    queue.push(importer);
  }
}

describe(`every ${MOCKED_MODULE} mock that can reach an ${NARROWED_EXPORT} narrowing carries the class`, () => {
  const offenders: string[] = [];
  for (const file of files) {
    if (!/\.test\.tsx?$/.test(file)) continue;
    const factory = mockCall(read.get(file)!, MOCKED_MODULE);
    if (!factory) continue;
    // `importActual` spreads the real module in, so nothing can be missing.
    if (factory.includes("importActual")) continue;
    if (factory.includes(NARROWED_EXPORT)) continue;
    if (!reaches.has(file)) continue;
    offenders.push(path.relative(SRC, file));
  }

  it("has no factory missing it", () => {
    expect(
      offenders,
      `These suites mock ${MOCKED_MODULE} with a factory that omits ${NARROWED_EXPORT}, and they import a module that runs \`instanceof ${NARROWED_EXPORT}\`. ` +
        `The first test that makes the mocked restart REJECT will get a TypeError and a 500 instead of the pending-gateway answer. ` +
        `Add the real class to the factory (see src/tests/routes/local-ai/exclusive.test.ts), or make it a partial mock over importActual.`,
    ).toEqual([]);
  });

  it("is actually watching something — the scan found the narrowing routes and the mocks", () => {
    // Without this, a rename of the export or a change to the mock spelling
    // would empty both sets and the gate above would pass by finding nothing.
    expect(narrowing.size).toBeGreaterThan(3);
    expect(
      files.filter((f) => /\.test\.tsx?$/.test(f) && mockCall(read.get(f)!, MOCKED_MODULE) !== null).length,
    ).toBeGreaterThan(20);
  });
});
