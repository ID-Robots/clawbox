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

/** Index of the next character that is neither whitespace nor a comment. */
function skipTrivia(text: string, from: number): number {
  let i = from;
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i += 1;
    if (text[i] === "/" && text[i + 1] === "/") {
      const nl = text.indexOf(String.fromCharCode(10), i);
      if (nl < 0) return text.length;
      i = nl + 1;
      continue;
    }
    if (text[i] === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      if (close < 0) return text.length;
      i = close + 2;
      continue;
    }
    return i;
  }
}

/**
 * Where the object the factory RETURNS begins, or -1.
 *
 * Only two shapes count, and picking them apart matters: the direct
 * arrow-expression body `() => ({ … })`, and a block body's own top-level
 * `return { … }`. Taking the first `({` after the arrow instead would read a
 * LOCAL object — `() => { const d = ({ get, set }); return { set }; }` reports
 * both exports and misses that the mock omits one, which is the gate passing
 * over exactly the hole it exists for.
 */
function returnedObjectStart(factory: string, from: number): number {
  const head = skipTrivia(factory, from);
  if (factory[head] === "(") {
    const inner = skipTrivia(factory, head + 1);
    return factory[inner] === "{" ? inner : -1;
  }
  if (factory[head] !== "{") return -1;

  // A block body: find `return` at the body's own depth, not inside a nested
  // function or object.
  let depth = 0;
  for (let i = head; i < factory.length; i += 1) {
    const ch = factory[i];
    if (ch === "/" && (factory[i + 1] === "/" || factory[i + 1] === "*")) {
      i = skipTrivia(factory, i) - 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i += 1;
      while (i < factory.length && factory[i] !== quote) {
        if (factory[i] === "\\") i += 1;
        i += 1;
      }
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") { depth += 1; continue; }
    if (ch === "}" || ch === "]" || ch === ")") { depth -= 1; if (depth === 0) return -1; continue; }
    if (depth !== 1 || ch !== "r" || !/^return\b/.test(factory.slice(i))) continue;
    const after = skipTrivia(factory, i + "return".length);
    if (factory[after] === "{") return after;
    if (factory[after] === "(") {
      const inner = skipTrivia(factory, after + 1);
      return factory[inner] === "{" ? inner : -1;
    }
    return -1;
  }
  return -1;
}

/**
 * The names a mock factory actually EXPORTS — the members of the object it
 * returns, at that object's own level and nowhere else.
 *
 * A regex over the factory text cannot answer this, and both of its failure
 * modes were real (found in review): `({ get: vi.fn(), set })` ends its last
 * member at a `}` rather than a `,` or `)`, so a name-followed-by-punctuation
 * test reports a COMPLETE factory as missing one; and `({ set() { get(); } })`
 * contains the text `get(`, so the same test reports an export the factory does
 * not have. A gate that fails correct code is worse than no gate, and one that
 * passes the hole it exists to catch is pointless.
 *
 * So this walks instead: strings and template literals are skipped whole,
 * bracket depth is counted, and a name is taken only where a member may begin —
 * straight after the object's `{` or after a `,` at that same depth. `async`,
 * and the `get`/`set` accessor keywords, are read as modifiers when another
 * identifier follows them, so `async get() {}` is the member `get` and
 * `get value() {}` is the member `value`.
 *
 * Returns null when the factory's returned object cannot be found, and the
 * caller REPORTS such a factory rather than skipping it: a shape this cannot
 * read is a shape nobody has checked.
 */
function factoryExports(factory: string): Set<string> | null {
  const arrow = factory.indexOf("=>");
  if (arrow < 0) return null;
  const start = returnedObjectStart(factory, arrow + 2);
  if (start < 0) return null;

  const names = new Set<string>();
  let depth = 0;
  let expectKey = false;
  for (let i = start; i < factory.length; i += 1) {
    const ch = factory[i];
    // COMMENTS FIRST, and this is not a nicety: every factory in this repo
    // explains itself between its members, and a comment carrying an
    // apostrophe ("the owner's picks") or a bare word after a comma was read
    // as a string opener and as the next member's name. Both were measured —
    // seven complete factories reported as missing an export, one as
    // unparseable — before this branch existed.
    if (ch === "/" && factory[i + 1] === "/") {
      const nl = factory.indexOf(String.fromCharCode(10), i);
      i = nl < 0 ? factory.length : nl;
      continue;
    }
    if (ch === "/" && factory[i + 1] === "*") {
      const close = factory.indexOf("*/", i + 2);
      i = close < 0 ? factory.length : close + 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      // Skip the literal whole, escapes included. A `{` or a member name inside
      // a string is text, not structure.
      const quote = ch;
      i += 1;
      while (i < factory.length && factory[i] !== quote) {
        if (factory[i] === "\\") i += 1;
        i += 1;
      }
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") {
      depth += 1;
      if (ch === "{" && depth === 1) expectKey = true;
      continue;
    }
    if (ch === "}" || ch === "]" || ch === ")") {
      depth -= 1;
      if (depth === 0) return names;
      continue;
    }
    if (depth === 1 && ch === ",") {
      expectKey = true;
      continue;
    }
    if (!expectKey || depth !== 1) continue;
    if (/\s/.test(ch)) continue;
    const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(factory.slice(i));
    if (!identifier) {
      // A computed key, a spread, a string key — none of them names one of the
      // exports this gate asks about.
      expectKey = false;
      continue;
    }
    const after = factory.slice(i + identifier[0].length).match(/^\s*([A-Za-z_$])?/);
    // `async get()`, `get value()`: a bare identifier followed by another one
    // is a modifier, so keep looking for the member on this same entry.
    if (after?.[1]) {
      i += identifier[0].length - 1;
      continue;
    }
    names.add(identifier[0]);
    i += identifier[0].length - 1;
    expectKey = false;
  }
  return null;
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
    const exported = factoryExports(factory);
    // A factory this cannot read is REPORTED, not skipped: an unreadable shape
    // is one nobody has checked, and the sibling gate above learned the hard
    // way that a mock the scanner cannot see is the one failure a gate must
    // not have.
    const missing = exported === null
      ? ["unparseable factory"]
      : STORE_EXPORTS.filter((name) => !exported.has(name));
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

  it("reads the members a factory exports, in every shape one is written", () => {
    // The predicate itself. Both of the shapes below were false answers from
    // the regex this replaced, and both came out of review rather than out of
    // this file — which is why they are pinned here.
    const exportsOf = (body: string) => factoryExports(mockCall(`vi.mock("${STORE_MODULE}", ${body});`, STORE_MODULE)!);

    // The plain form, and either quote around the module id.
    expect([...exportsOf("() => ({ get: vi.fn(), set: vi.fn() })")!].sort()).toEqual(["get", "set"]);
    expect(factoryExports(mockCall(`vi.mock('${STORE_MODULE}', () => ({ get: vi.fn() }));`, STORE_MODULE)!)!.has("get"))
      .toBe(true);

    // TRAILING SHORTHAND: the last member ends at a `}`, not at a `,` or a `)`.
    expect([...exportsOf("() => ({ get: vi.fn(), set })")!].sort()).toEqual(["get", "set"]);

    // A NESTED CALL is not an export. `get(` appears in the text and the
    // factory does not export it.
    expect([...exportsOf("() => ({ set() { get(); } })")!]).toEqual(["set"]);

    // The object-METHOD form, with and without `async`.
    expect([...exportsOf("() => ({ async get() {}, set() {} })")!].sort()).toEqual(["get", "set"]);

    // An ACCESSOR names the property after the keyword, not the keyword.
    expect([...exportsOf("() => ({ get DATA_DIR() { return d; } })")!]).toEqual(["DATA_DIR"]);

    // The two neighbours that share the prefix are still not it.
    expect([...exportsOf("() => ({ getAll: vi.fn(), getKnown: vi.fn(), setMany: vi.fn() })")!].sort())
      .toEqual(["getAll", "getKnown", "setMany"]);

    // A block body, and a factory shape this cannot read at all.
    expect([...exportsOf("() => { return { get: vi.fn(), set: vi.fn() }; }")!].sort()).toEqual(["get", "set"]);
    expect(factoryExports('vi.mock("x", someHelper)')).toBeNull();

    // A LOCAL object before the return is not what the factory exports. Reading
    // the first `({` after the arrow would answer `get, set` here and miss that
    // the mock omits `get` — the gate passing over the hole it exists for.
    expect([...exportsOf("() => { const d = ({ get: vi.fn(), set: vi.fn() }); return { set: d.set }; }")!])
      .toEqual(["set"]);
    // …and a parenthesised return object is still read.
    expect([...exportsOf("() => { return ({ get: vi.fn(), set: vi.fn() }); }")!].sort()).toEqual(["get", "set"]);

    // And the omission the gate exists for.
    expect([...exportsOf("() => ({ getAll: vi.fn(), setMany: vi.fn() })")!].sort()).toEqual(["getAll", "setMany"]);

    // COMMENTS between members, which every factory in this repo has: an
    // apostrophe in one used to open a "string" that swallowed the rest, and a
    // word after a comma used to be read as the next member's name. Seven
    // complete factories were reported as missing an export before the walker
    // consumed comments.
    const commented = [
      "() => ({",
      "  getAll: vi.fn(),",
      "  // the owner's picks are read through the tri-state reader",
      "  get: vi.fn(),",
      "  /* block form too */",
      "  set: vi.fn(),",
      "})",
    ].join(String.fromCharCode(10));
    expect([...exportsOf(commented)!].sort()).toEqual(["get", "getAll", "set"]);
  });
});
