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
 * Two things make it more than a grep for a word:
 *
 *  1. Comments and string contents are stripped before the assertion, so a file
 *     that only MENTIONS `bootPersisted` in prose no longer passes.
 *  2. The verdict has to appear near the call it belongs to, not anywhere in
 *     the file. The one legitimate indirection — Settings hands the response to
 *     a helper — is named explicitly, and that helper is itself checked.
 */

const SRC = path.join(process.cwd(), "src");

/** The name of the one helper allowed to stand in for reading the verdict. */
const HOTSPOT_VERDICT_HELPER = "readHotspotVerdict";

/** A call to either tunnel operation. Identifiers, so matched against code. */
const TUNNEL_CALL = /\b(?:start|stop)TunnelService\s*\(/;

/**
 * A POST to the hotspot route. Matched against the ORIGINAL text, because the
 * route path only exists as a string literal and the stripper blanks those.
 */
const HOTSPOT_POST = /fetch\(\s*"\/setup-api\/system\/hotspot"[\s\S]{0,400}?method:\s*"POST"/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (entry === "tests" || entry === "node_modules") continue;
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Blank out comments and string/template contents, keeping every offset intact
 * so a window into the result still lines up with the original source.
 *
 * Deliberately a scanner rather than a parser: it only has to stop prose from
 * satisfying a code assertion, and a character walk does that without pulling a
 * TypeScript AST into a unit test.
 */
function codeOnly(src: string): string {
  const out = src.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k += 1) {
      if (out[k] !== "\n") out[k] = " ";
    }
  };
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === "//") {
      const end = src.indexOf("\n", i);
      const stop = end < 0 ? src.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (two === "/*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? src.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (src[i] === '"' || src[i] === "'" || src[i] === "`") {
      const quote = src[i];
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === quote) { j += 1; break; }
        j += 1;
      }
      blank(i + 1, j - 1);
      i = j;
      continue;
    }
    i += 1;
  }
  return out.join("");
}

const FILES = walk(SRC).map((file) => {
  const text = readFileSync(file, "utf-8");
  return { file, text, code: codeOnly(text) };
});

/** Paths relative to the repo, so a failure names the file to open. */
const rel = (file: string) => path.relative(process.cwd(), file).split(path.sep).join("/");

/**
 * Every window of CODE around a match, so the verdict must sit WITH its call.
 *
 * `haystack` is what the pattern is matched against; `code` is what the window
 * is cut from. Same offsets, because `codeOnly` blanks in place. The two differ
 * only where the pattern needs a string literal that the stripper removes.
 */
function windowsAround(
  haystack: string,
  code: string,
  pattern: RegExp,
  before = 300,
  after = 500,
): string[] {
  const flags = pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g";
  const re = new RegExp(pattern.source, flags);
  const found: string[] = [];
  for (const m of haystack.matchAll(re)) {
    const at = m.index ?? 0;
    found.push(code.slice(Math.max(0, at - before), at + after));
  }
  return found;
}

describe("the tunnel's boot-persist verdict is read AT every call", () => {
  // `systemctl stop` and `systemctl disable` are separate calls, and the second
  // is the one that decides whether the box publishes itself again after a
  // reboot. It used to be swallowed into a console.warn.
  const callers = FILES.filter(
    ({ file, code }) =>
      !file.endsWith(path.join("lib", "cloudflared.ts")) && TUNNEL_CALL.test(code),
  );

  it("has callers at all (the check is not vacuously passing)", () => {
    expect(callers.length).toBeGreaterThan(0);
  });

  it.each(callers.map(({ file, code }) => [rel(file), code] as const))(
    "%s reads bootPersisted at each call, not somewhere else in the file",
    (_name, code) => {
      // Matched on code, not text: the identifier is never inside a string, and
      // a mention in a comment must not conjure a call site that does not exist.
      const windows = windowsAround(code, code, TUNNEL_CALL);
      expect(windows.length).toBeGreaterThan(0);
      for (const w of windows) expect(w).toContain("bootPersisted");
    },
  );
});

describe("the hotspot AP verdict is read at every call", () => {
  // `{ success: true, apRestarted: false }` was the answer to a deliberate
  // deferral, a clean stop AND a toggle that threw. A caller that reads only
  // `apRestarted` still cannot tell the third from the first two.
  const callers = FILES.filter(({ text }) => HOTSPOT_POST.test(text));

  it("has callers at all (the check is not vacuously passing)", () => {
    expect(callers.length).toBeGreaterThan(0);
  });

  it.each(callers.map(({ file, text, code }) => [rel(file), text, code] as const))(
    "%s reads apAction at each POST, directly or through the one helper",
    (_name, text, code) => {
      // 2000 chars of CODE after the call: enough to cover the request, the
      // `!res.ok` branch and the handling of the body, and nowhere near enough
      // to reach an unrelated handler. Comments do not count towards it — they
      // have been blanked — which is the whole point.
      const windows = windowsAround(text, code, HOTSPOT_POST, 0, 2000);
      expect(windows.length).toBeGreaterThan(0);
      for (const w of windows) {
        expect(w.includes("apAction") || w.includes(HOTSPOT_VERDICT_HELPER)).toBe(true);
      }
    },
  );

  it(`${HOTSPOT_VERDICT_HELPER} — the one allowed indirection — actually reads apAction`, () => {
    // Otherwise the escape hatch above would be a hole rather than a helper.
    const decl = `const ${HOTSPOT_VERDICT_HELPER} =`;
    const holder = FILES.find(({ code }) => code.includes(decl));
    expect(holder, `no file defines ${HOTSPOT_VERDICT_HELPER}`).toBeDefined();
    const at = holder!.code.indexOf(decl);
    expect(holder!.code.slice(at, at + 600)).toContain("apAction");
  });
});

describe("the stripper itself", () => {
  // The assertions above are only worth anything if prose really is removed.
  it("removes comments and string contents but keeps offsets", () => {
    const src = 'const a = 1; // bootPersisted\nconst b = "bootPersisted"; const c = bootPersisted;';
    const out = codeOnly(src);
    expect(out).toHaveLength(src.length);
    expect(out.split("\n")[0]).not.toContain("bootPersisted");
    expect(out).toContain("const c = bootPersisted;");
    expect(out.indexOf("const c")).toBe(src.indexOf("const c"));
  });
});
