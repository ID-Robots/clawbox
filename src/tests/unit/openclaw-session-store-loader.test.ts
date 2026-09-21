import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { requireNodeSqlite } from "@/lib/openclaw-session-store";

/**
 * That node:sqlite reaches the STANDALONE BUILD, not only this test runner.
 *
 * The session store loaded the builtin through `createRequire(import.meta.url)`.
 * Every vitest suite passed — vitest does not bundle — while Turbopack, which
 * cannot externalise that shape, compiled the call into a stub that throws
 * "Cannot find module 'node:sqlite': Unsupported external type Url for
 * commonjs reference". On the box, where the builtin exists, every reader of
 * the SQLite store then failed its open() and silently fell back to legacy
 * files OpenClaw 2 no longer writes (F-05): spoken-history recovery, the
 * model-override sweep and Local-only mode were all dead, and 70 journal lines
 * said so to nobody.
 *
 * The real assertion is on the built chunks — scripts/check-bundled-builtins.sh,
 * run by CI right after `bun run build`. What is pinned HERE is the shape of
 * the loader and the wiring of that check, the way instrumentation-transcript-
 * sweep.test.ts pins its boot wiring: a behavioural test cannot see what the
 * bundler does to the source.
 */

const ROOT = process.cwd();
const STORE_FILE = path.join(ROOT, "src", "lib", "openclaw-session-store.ts");

/**
 * The code without its comment LINES — the loader's own JSDoc names the trap.
 * Line-based on purpose: a regex that strips block comments would also swallow
 * everything between a `"image/*"` string literal and the next `*\/`, and a
 * `createRequire(` in that span would go unseen.
 */
function codeLines(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join("\n");
}

const storeCode = codeLines(readFileSync(STORE_FILE, "utf8"));

const tmpRoots: string[] = [];
afterEach(() => {
  for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Every .ts/.tsx under src/ that Next may bundle — the tests are not it. */
function bundledSources(): string[] {
  const srcDir = path.join(ROOT, "src");
  // `encoding` picks the string[] overload; without it @types/node 20 types the
  // result as string[] | Buffer[] and the build's type check fails.
  return readdirSync(srcDir, { recursive: true, encoding: "utf8" })
    .filter((rel) => /\.tsx?$/.test(rel) && !rel.endsWith(".d.ts") && !rel.startsWith(`tests${path.sep}`))
    .map((rel) => path.join(srcDir, rel));
}

describe("the node:sqlite loader survives the Turbopack build", () => {
  it("resolves the builtin through process.getBuiltinModule, which the bundler leaves alone", () => {
    expect(storeCode).toMatch(/getBuiltinModule(\?\.)?\(\s*["']node:sqlite["']\s*\)/);
  });

  it("never reaches it through createRequire, which the bundler turns into a throwing stub", () => {
    expect(storeCode).not.toMatch(/createRequire/);
  });

  it("hands back a DatabaseSync that opens a store", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "clawbox-sqlite-loader-"));
    tmpRoots.push(root);
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(path.join(root, "probe.sqlite"));
    db.exec("CREATE TABLE t (v TEXT)");
    db.prepare("INSERT INTO t (v) VALUES (?)").run("ok");
    expect(db.prepare("SELECT v FROM t").get()).toEqual({ v: "ok" });
    db.close();
  });

  it("is the same module object on every call", () => {
    expect(requireNodeSqlite()).toBe(requireNodeSqlite());
  });
});

describe("no bundled module loads anything through createRequire", () => {
  // Class-wide: the next builtin someone reaches for the same way would build
  // just as cleanly and die just as quietly. The test fixtures may use
  // createRequire freely — vitest never bundles them.
  it("src/ outside the tests is free of createRequire", () => {
    const offenders = bundledSources()
      .filter((file) => /createRequire\s*\(/.test(codeLines(readFileSync(file, "utf8"))))
      .map((file) => path.relative(ROOT, file));
    expect(offenders).toEqual([]);
  });
});

describe("CI reads the built chunks", () => {
  const workflow = readFileSync(path.join(ROOT, ".github", "workflows", "build-identity.yml"), "utf8");
  const script = readFileSync(path.join(ROOT, "scripts", "check-bundled-builtins.sh"), "utf8");

  it("runs the bundled-builtins check right after the build", () => {
    const build = workflow.indexOf("run: bun run build");
    const check = workflow.indexOf("scripts/check-bundled-builtins.sh");
    expect(build).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(build);
  });

  it("looks for the stub's message, not for one module's name", () => {
    expect(script).toContain("Unsupported external type");
    expect(script).toContain("Cannot find module 'node:");
  });

  it("also asserts the loader itself reached the chunks, so a reworded stub cannot pass as clean", () => {
    expect(script).toContain("getBuiltinModule");
  });
});
