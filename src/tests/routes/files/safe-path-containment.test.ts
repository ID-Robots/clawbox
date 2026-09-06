import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * TASK-742 — the Files API's containment check, and the equivalence that had
 * to hold while its SHAPE changed.
 *
 * `safePath()` refused a path outside the browse root with ONE condition
 * spelling two rules: `resolved !== base && !resolved.startsWith(base +
 * path.sep)`. That is correct and it is not a check the code below it can lean
 * on: the fall-through is reachable through the FIRST term without the prefix
 * test having decided anything, so nothing after the `if` was actually
 * governed by containment. CodeQL says the same thing in its own words — every
 * fs call downstream stayed on the `js/path-injection` list (#523-#528 on
 * beta, the dismissed #247/#248 before them, and #529 for the identical
 * spelling in `code-projects.ts`).
 *
 * Split into two statements, each line is the only way past itself, and the
 * accepted set must not move by a single string — the Files app is where the
 * customer's own documents are, and a rule that got stricter would orphan
 * files that are on the box today with no error anyone could act on.
 *
 * So this file probes the ROUTE (through `{action:"resolve"}`, the one action
 * that answers `safePath`'s verdict directly) against a spelled-out copy of
 * beta's predicate over a few thousand strings — traversal, absolutes,
 * separators, dots, NUL, lone surrogates, trailing newlines, both length
 * bounds — and requires zero divergences. The copy uses the REAL
 * `isProtectedFilePath`, so only the containment half is being compared.
 */

const TEST_ROOT = path.join(fs.realpathSync(os.tmpdir()), `clawbox-files-safepath-${process.pid}-${Date.now()}`);

/**
 * NUL, by code point. A raw one in the source makes git call this file binary
 * — no diff, and nothing for a reviewer or a review bot to read — so every
 * character a path may carry that a text file may not is written this way.
 */
const NUL = String.fromCharCode(0);

type RouteHandler = (req: NextRequest) => Promise<Response>;
let filesPost: RouteHandler;

/**
 * The REAL protection rule, resolved after `CLAWBOX_ROOT` points at this
 * fixture — a static import would bind `file-guard` to the suite-wide root and
 * quietly compare two different `data/` directories, which is a divergence in
 * the harness rather than in the predicate.
 */
let isProtectedFilePath: (abs: string) => boolean;

/** Beta's predicate, verbatim apart from the constant it resolves against. */
function betaSafePath(rel: string): string | null {
  const base = path.resolve(TEST_ROOT);
  const resolved = path.resolve(base, rel);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
  if (isProtectedFilePath(resolved)) return null;
  return resolved;
}

/** What the route answers for one path: the absolute path, or null for a refusal. */
async function routeSafePath(rel: string): Promise<string | null> {
  const req = new NextRequest(new URL("http://localhost/setup-api/files"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "resolve", filePath: rel }),
  });
  const res = await filesPost(req);
  if (res.status === 400) return null;
  expect(res.status).toBe(200);
  return (await res.json()).absPath as string;
}

async function expectAgreement(probes: readonly string[]): Promise<void> {
  const divergences: Array<{ probe: string; beta: string | null; head: string | null }> = [];
  for (const probe of probes) {
    const head = await routeSafePath(probe);
    const beta = betaSafePath(probe);
    if (head !== beta) divergences.push({ probe, beta, head });
  }
  // The whole list, not the first one: a rule that moved has moved for a CLASS
  // of paths, and one example does not say which.
  expect(divergences).toEqual([]);
}

beforeAll(async () => {
  process.env.FILES_ROOT = TEST_ROOT;
  process.env.CLAWBOX_ROOT = TEST_ROOT;
  await fsp.mkdir(TEST_ROOT, { recursive: true });
  vi.resetModules();
  ({ POST: filesPost } = await import("@/app/setup-api/files/route"));
  ({ isProtectedFilePath } = await import("@/lib/file-guard"));
});

afterAll(async () => {
  delete process.env.FILES_ROOT;
  delete process.env.CLAWBOX_ROOT;
  await fsp.rm(TEST_ROOT, { recursive: true, force: true });
});

describe("the Files API containment check judges every path beta accepted", () => {
  it("agrees on the shapes a traversal is spelled with", async () => {
    const base = path.resolve(TEST_ROOT);
    await expectAgreement([
      "..",
      "../",
      "../..",
      "../../etc/passwd",
      "./..",
      "a/../..",
      "a/b/../../..",
      "a/./b",
      "a//b",
      "a/b/",
      ".",
      "./",
      "/",
      "//",
      "///etc/passwd",
      "/etc/passwd",
      "/etc/../etc/passwd",
      `${base}`,
      `${base}/`,
      `${base}/Documents`,
      `${base}/../${path.basename(base)}x`,
      `${base}x`,
      `${base}x/inside`,
      // A NAME that starts with dots is an ordinary entry, not a traversal —
      // the case `isInside()`'s `rel.startsWith("..")` gets wrong and the
      // reason this predicate was not rewritten in terms of it.
      "..hidden",
      "..hidden/child",
      "...",
      ".hidden",
      "a/..hidden",
      String.fromCharCode(92),
      `..${String.fromCharCode(92)}..`,
      `a${String.fromCharCode(92)}b`,
    ]);
  });

  it("agrees on the values a string can carry that a path cannot", async () => {
    await expectAgreement([
      NUL,
      `a${NUL}b`,
      `a${NUL}/../..`,
      "a\n",
      "a\r\n",
      "\n..",
      "a\t b",
      " ",
      "  /  ",
      "a ",
      " a",
      "\ud800",
      "\udfff",
      "a\ud800b",
      "😀",
      "😀/😀",
      "café/naïve",
      "Документы/файл.txt",
      // U+202E RIGHT-TO-LEFT OVERRIDE, spelled by code point: a raw one in
      // this file would be a bidi override in the repository's own source.
      String.fromCharCode(0x202e) + "gnp.exe",
      "a".repeat(255),
      "a".repeat(4096),
      `${"a/".repeat(400)}b`,
    ]);
  });

  it("agrees on the box's own stores, which are inside the browse root", async () => {
    await expectAgreement([
      "data",
      "data/config.json",
      "data/.session-secret",
      ".ssh",
      ".ssh/id_ed25519",
      ".openclaw",
      ".openclaw/openclaw.json",
      ".config",
      ".config/gh/hosts.yml",
      "Documents/notes.txt",
      "Downloads",
      "a/data/config.json",
    ]);
  });

  it("agrees over a few thousand generated paths", async () => {
    // A deterministic corpus — a failure has to be reproducible to be worth
    // anything — built from the pieces that decide this predicate: separators,
    // dot runs, the base's own prefix, and the characters that break naive
    // string handling.
    const pieces = [
      "..", ".", "a", "bb", "ccc", "", "/", "//", String.fromCharCode(92),
      " ", "\t", "\n", NUL, "\ud800", "😀", "é", "Ω",
      ".hidden", "..hidden", "data", ".ssh", path.resolve(TEST_ROOT), "~",
    ];
    let seed = 0x5eed742;
    const next = () => {
      // xorshift32 — a generator whose whole state is in this file, so the
      // corpus is the same on every machine and in every re-run.
      seed ^= seed << 13; seed >>>= 0;
      seed ^= seed >>> 17;
      seed ^= seed << 5; seed >>>= 0;
      return seed;
    };
    const probes: string[] = [];
    for (let i = 0; i < 3000; i++) {
      const parts = 1 + (next() % 5);
      let probe = "";
      for (let p = 0; p < parts; p++) {
        probe += pieces[next() % pieces.length];
        if (p + 1 < parts && next() % 2 === 0) probe += "/";
      }
      // `""` is not probeable through this door — the route answers 400
      // `filePath required` before `safePath` is asked — and the empty path is
      // covered by the base-directory cases above.
      if (probe !== "") probes.push(probe);
    }
    await expectAgreement(probes);
  });
});

describe("the containment check is one statement of its own", () => {
  // A source pin, not a taste one: re-merging the two rules into a single
  // condition restores exactly the shape that kept #523-#529 open, and every
  // behavioural test above would still pass.
  const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

  function bodyOf(source: string, anchor: string): string {
    const start = source.indexOf(anchor);
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf(`${String.fromCharCode(10)}}`, start);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
  }

  it("holds the prefix test alone in the Files route", () => {
    const body = bodyOf(read("src/app/setup-api/files/route.ts"), "function safePath(rel: string)");
    expect(body).toContain("if (!resolved.startsWith(base + path.sep)) return null;");
    expect(body).not.toMatch(/resolved !== base &&/);
    // The base's own answer is the constant this module built, not the
    // request's spelling of it.
    expect(body).toContain("if (resolved === base) return isProtectedFilePath(base) ? null : base;");
  });

  it("holds the prefix test alone in the code-project store", () => {
    const body = bodyOf(read("src/lib/code-projects.ts"), "function safePath(projectId: string");
    expect(body).toContain("if (resolved === dir) return dir;");
    expect(body).toContain("if (!resolved.startsWith(dir + path.sep)) {");
    expect(body).not.toMatch(/&& resolved !== dir/);
  });
});
