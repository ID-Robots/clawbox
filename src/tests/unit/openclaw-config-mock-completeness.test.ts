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
 *
 * Either quote form, and any whitespace after the paren: nothing in this
 * repo's eslint config pins a quote style, so a single-quoted mock would
 * otherwise be INVISIBLE here rather than an offender — the gate would skip it
 * and stay green, which is the one failure a gate must not have.
 */
function mockCall(text: string, moduleId: string): string | null {
  const opening = new RegExp(
    `vi\\.mock\\(\\s*["']${moduleId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`,
  ).exec(text);
  if (!opening) return null;
  const start = opening.index;
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

  it("sees a mock in either quote form", () => {
    // A mock the scanner cannot SEE is skipped, not reported — the gate stays
    // green over the exact hole it exists to close, which is worse than an
    // offender. Nothing in this repo pins a quote style, so both forms are
    // pinned here rather than left to convention.
    const single = `vi.mock('${MOCKED_MODULE}', () => ({ restartGateway: vi.fn() }));`;
    const double = `vi.mock("${MOCKED_MODULE}", () => ({ restartGateway: vi.fn() }));`;
    expect(mockCall(single, MOCKED_MODULE)).toBe(single.slice(0, -1));
    expect(mockCall(double, MOCKED_MODULE)).toBe(double.slice(0, -1));
    expect(mockCall(`vi.mock("@/lib/not-it", () => ({}));`, MOCKED_MODULE)).toBeNull();
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

/**
 * The same hole, one module over: `@/lib/config-store`.
 *
 * `@/lib/clawai-credential-refusal` reads and writes the persisted ClawBox AI
 * credential refusal through that store, and BOTH of its calls sit inside a
 * `try` whose `catch` answers a default — deliberately, because "the store
 * could not be read" is not "the credential was refused". That makes a missing
 * export worse here than in the module above: `get` being `undefined` does not
 * crash a test, it makes `clawaiCredentialRefusalOnRecord()` answer `false`
 * for every case in the file, so the image-ops gate is never exercised and
 * nothing says so. A green suite over an untested gate.
 *
 * #755 fixed exactly that by hand in three files. #756 opened it again in a
 * fourth on the same day, and fixed it by hand too. That is the point at which
 * a rule earns a gate.
 *
 * THE SCOPE IS THE HAZARD, not the import graph. Nearly every route in this
 * repo reaches this reader transitively — the whole-graph rule the sibling
 * above uses reports fifty files here, which is a list nobody acts on. What
 * makes a file able to hit the wrong answer is that its own subject calls the
 * reader, so the scope is one hop: a test that imports a module which imports
 * `@/lib/clawai-credential-refusal` itself.
 */
const STORE_MODULE = "@/lib/config-store";
const SILENT_STORE_READER = "@/lib/clawai-credential-refusal";
/** What that reader takes off the store, and therefore what a factory must name. */
const STORE_EXPORTS = ["get", "set"] as const;

/**
 * Does this factory name that export, in any of the forms a factory writes one?
 *
 * `get: vi.fn()`, `get,` (shorthand), `get)` (last entry) — and `get()` /
 * `async get()`, the object-METHOD form. The last one is why the opening paren
 * is in the class: without it a perfectly complete factory written with methods
 * would be reported as missing, and a gate whose failure mode is a false
 * positive is one nobody trusts. `\b` anchors the start, so `getAll:` and
 * `getKnown:` — both live in this repo's factories — never match `get`.
 */
function storeExportNamed(name: string): RegExp {
  return new RegExp(`\\b${name}\\s*[:,)(]`);
}

describe(`every ${STORE_MODULE} mock in front of a ${SILENT_STORE_READER} caller carries its store functions`, () => {
  const readerFile = resolveAlias(SILENT_STORE_READER);

  // The modules that call the reader directly. Their own suites, and the
  // suites of anything that imports them, are what can silently take the
  // default answer.
  const callers = new Set(
    files.filter((f) => f !== readerFile && aliasImports(read.get(f)!).includes(SILENT_STORE_READER)),
  );
  const exposed = new Set<string>(callers);
  for (const caller of callers) {
    for (const importer of importers.get(caller) ?? []) exposed.add(importer);
  }

  const offenders: string[] = [];
  for (const file of exposed) {
    if (!/\.test\.tsx?$/.test(file)) continue;
    const factory = mockCall(read.get(file)!, STORE_MODULE);
    if (!factory) continue;
    if (factory.includes("importActual") || factory.includes("importOriginal")) continue;
    const missing = STORE_EXPORTS.filter((name) => !storeExportNamed(name).test(factory));
    if (missing.length > 0) offenders.push(`${path.relative(SRC, file)} (${missing.join(", ")})`);
  }

  it("has no factory missing them", () => {
    expect(
      offenders.sort(),
      `These suites mock ${STORE_MODULE} with a factory that omits ${STORE_EXPORTS.join("/")}, and they exercise a module that reads the persisted ClawBox AI credential refusal through it. ` +
        `Those reads are wrapped in a catch that answers a DEFAULT, so the omission does not fail the suite — it silently makes every case take the "no refusal on record" branch. ` +
        `Add \`get\`/\`set\` to the factory (see src/tests/routes/ai-models/configure-images.test.ts), or make it a partial mock over importActual.`,
    ).toEqual([]);
  });

  it("is actually watching something", () => {
    // Without this, a rename of the reader would empty every set above and the
    // gate would pass by finding nothing — the one failure a gate must not
    // have. Both ends are pinned: the reader resolves, and it has callers whose
    // suites mock the store.
    expect(readerFile).not.toBeNull();
    expect(callers.size).toBeGreaterThan(1);
    expect(
      [...exposed].filter((f) => /\.test\.tsx?$/.test(f) && mockCall(read.get(f)!, STORE_MODULE) !== null).length,
    ).toBeGreaterThan(3);
  });

  it("reports a factory that omits them, in either quote form", () => {
    // The predicate itself, over the two shapes: the sibling above learned the
    // hard way that a mock the scanner cannot SEE is skipped rather than
    // reported.
    const omits = `vi.mock('${STORE_MODULE}', () => ({ getAll: vi.fn(), setMany: vi.fn() }));`;
    const carries = `vi.mock("${STORE_MODULE}", () => ({ get: vi.fn(), set: vi.fn() }));`;
    // The object-METHOD form of the same complete factory: a gate that reported
    // this as missing would fail a PR over correct code.
    const methods = `vi.mock("${STORE_MODULE}", () => ({ async get() {}, async set() {} }));`;
    const seen = mockCall(omits, STORE_MODULE);
    expect(seen).not.toBeNull();
    expect(STORE_EXPORTS.filter((n) => !storeExportNamed(n).test(seen!))).toEqual(["get", "set"]);
    expect(STORE_EXPORTS.filter((n) => !storeExportNamed(n).test(mockCall(carries, STORE_MODULE)!))).toEqual([]);
    expect(STORE_EXPORTS.filter((n) => !storeExportNamed(n).test(mockCall(methods, STORE_MODULE)!))).toEqual([]);
    // …and the two neighbours that share the prefix are still not it.
    const prefixes = `vi.mock("${STORE_MODULE}", () => ({ getAll: vi.fn(), getKnown: vi.fn(), setMany: vi.fn() }));`;
    expect(STORE_EXPORTS.filter((n) => !storeExportNamed(n).test(mockCall(prefixes, STORE_MODULE)!)))
      .toEqual(["get", "set"]);
  });
});
