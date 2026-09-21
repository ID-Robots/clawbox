import { describe, expect, it, vi } from "vitest";
import {
  loadAllowlist,
  looksLikeEnglishCopy,
  looksLikeEnglishSentence,
  scan,
  scanSourceFile,
  exitCodeFor,
  type ScanResult,
} from "../../../scripts/i18n-scan";

/**
 * The scan, run against this repository, on every `bun run test`.
 *
 * `scripts/i18n-scan.ts` is wired into the CI workflow as its own step, so this
 * file is not the only thing standing between a hard-coded literal and `beta`.
 * It is here because the workflow step fails a PR at the END of a job, with a
 * log to scroll, while this fails in the same run as everything else a
 * developer already runs locally — and because the heuristics themselves
 * deserve cases. A scan that over-reports gets switched off in its first week,
 * so `looksLikeEnglishCopy` and `looksLikeEnglishSentence` are pinned here
 * against the shapes that were actually mistaken for copy on this codebase.
 *
 * Reading ~400 .tsx files through the TypeScript parser and four dictionaries
 * takes longer than vitest's 5 s default on a loaded runner, so this file
 * declares its own ceilings. See test-timeout-hygiene.test.ts for why that is
 * done per file rather than by widening the defaults.
 */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const format = (result: ScanResult): string =>
  [
    ...result.keys.map((f) => `${f.kind} key: ${f.module} ${f.locale} ${f.key}`),
    ...result.identical.map((f) => `identical: ${f.module} ${f.locale} ${f.key} = ${JSON.stringify(f.value)}`),
    ...result.literals.map(
      (f) => `literal: ${f.file}:${f.line} ${f.kind === "prop" ? `${f.attribute}=` : "text"} ${JSON.stringify(f.text)}`,
    ),
    ...result.stale.map((e) => `stale allowlist entry: ${"key" in e ? e.key : `${e.file} :: ${e.text}`}`),
  ].join("\n");

describe("i18n scan", () => {
  // One scan for the whole file: it parses every .tsx under src/components and
  // src/app and walks four dictionaries, and running that once per case turned
  // a 4 s file into a 20 s one.
  const result = scan();

  it("reports nothing at all", () => {
    // The single assertion that matters, and it prints the findings rather
    // than a bare count — a failure here is a list of things to fix, and
    // "expected 3 to be 0" sends the reader to run the script by hand.
    expect(format(result), "the i18n scan found problems").toBe("");
  });

  it("leaves no locale short of a key", () => {
    expect(result.keys).toEqual([]);
  });

  it("leaves no non-English value sitting on the English one", () => {
    expect(result.identical).toEqual([]);
  });

  it("leaves no English literal outside t()/tr() in src/components or src/app", () => {
    expect(result.literals).toEqual([]);
  });

  it("keeps the allowlist free of entries nothing matches", () => {
    // An allowlist nobody prunes is how the identical-value check becomes
    // decoration: the entry outlives the translation it excused, and the next
    // regression on that key is waved straight through.
    expect(result.stale).toEqual([]);
  });

  it("exits zero only when all three questions came back empty", () => {
    expect(exitCodeFor(result)).toBe(0);
    expect(exitCodeFor({ keys: [{ module: "m", locale: "de", key: "k", kind: "missing" }], identical: [], literals: [], stale: [] })).toBe(1);
    expect(exitCodeFor({ keys: [], identical: [], literals: [{ file: "f.tsx", line: 1, kind: "text", text: "x" }], stale: [] })).toBe(1);
    expect(exitCodeFor({ keys: [], identical: [], literals: [], stale: [{ key: "k", locales: "*", reason: "r" }] })).toBe(1);
    // (b) alone does NOT block — whether "Ollama" should read differently in
    // Swedish is a judgement, and a judgement that fails CI gets answered by
    // widening the allowlist rather than by translating anything.
    expect(exitCodeFor({ keys: [], identical: [{ module: "m", locale: "de", key: "k", value: "v" }], literals: [], stale: [] })).toBe(0);
  });
});

describe("the allowlist", () => {
  const allow = loadAllowlist();

  it("gives every entry a reason", () => {
    for (const e of allow.identicalValues) expect(e.reason.trim().length, e.key).toBeGreaterThan(0);
    for (const e of allow.literals) expect(e.reason.trim().length, e.file).toBeGreaterThan(0);
  });

  it("names the locales for a word a language merely happens to share", () => {
    // `"*"` is for brands, product names and technical tokens — things no
    // locale will ever translate. A word that German happens to spell the
    // English way must NOT be starred, or the day Dutch regresses to English
    // on that key the scan stays quiet about it.
    const starred = allow.identicalValues.filter((e) => e.locales === "*").map((e) => e.key);
    expect(starred).not.toContain("settings.kernel");
    expect(starred).toContain("app.openclaw");
  });

  it("rejects an entry with no reason", () => {
    expect(() => loadAllowlist("/nonexistent/i18n-allowlist.json")).toThrow();
  });
});

describe("looksLikeEnglishCopy", () => {
  it("accepts a capitalised human-facing string", () => {
    for (const s of ["Connect AI Provider", "Settings", "Refresh now", "Go back to home"]) {
      expect(looksLikeEnglishCopy(s), s).toBe(true);
    }
  });

  it("rejects the shapes that are not copy", () => {
    for (const s of [
      "URL", // an acronym reads the same everywhere
      "AI",
      "visibility_off", // a Material Symbols ligature
      "/home/clawbox/Projects", // a path
      "https://t.me/BotFather", // a URL
      "clawbox-crab.png", // a filename
      "text-sm font-bold", // not capitalised: a class list
      "Настройки", // already translated
      "設定",
    ]) {
      expect(looksLikeEnglishCopy(s), s).toBe(false);
    }
  });
});

describe("looksLikeEnglishSentence", () => {
  it("accepts three or more words of prose", () => {
    for (const s of ["App not found:", "Files will be saved to Downloads", "👋 Welcome to ClawBox"]) {
      expect(looksLikeEnglishSentence(s), s).toBe(true);
    }
  });

  it("rejects a single token, however many words it looks like", () => {
    // The commonest false positive on this codebase by a wide margin: every
    // icon in the UI is a Material Symbols ligature rendered as text.
    for (const s of ["open_in_new", "power_settings_new", "create_new_folder", "Ctrl+Shift+V", "discord.com/developers"]) {
      expect(looksLikeEnglishSentence(s), s).toBe(false);
    }
  });

  it("rejects short fragments and already-translated text", () => {
    for (const s of ["", "·", "Save", "and paste", "ホームに戻る"]) {
      expect(looksLikeEnglishSentence(s), s).toBe(false);
    }
  });
});

describe("scanSourceFile", () => {
  it("finds a hard-coded prop and ignores the translated one beside it", () => {
    const src = `
      export function C() {
        return <Card title="Connect AI Provider" description={t("ai.description")} />;
      }
    `;
    const found = scanSourceFile("x.tsx", src);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: "prop", attribute: "title", text: "Connect AI Provider" });
  });

  it("reports BOTH arms of a reveal-button ternary", () => {
    // `showPassword ? "Hide password" : "Show password"` — the shape that hid
    // nine findings across five components, because only one arm is on screen
    // at a time and a one-value check would report at most one of them.
    const src = `export function C() { return <button aria-label={x ? "Hide password" : "Show password"} />; }`;
    expect(scanSourceFile("x.tsx", src).map((f) => f.text)).toEqual(["Hide password", "Show password"]);
  });

  it("ignores a literal in a prop nobody reads", () => {
    const src = `export function C() { return <div className="Flex Row" data-name="Some Thing" />; }`;
    expect(scanSourceFile("x.tsx", src)).toEqual([]);
  });

  it("ignores text inside <code> and <pre>", () => {
    const src = `export function C() { return <div><code>npm run build now</code><pre>rm -rf the thing</pre></div>; }`;
    expect(scanSourceFile("x.tsx", src)).toEqual([]);
  });

  it("does not mistake a comment or a non-JSX string for copy", () => {
    const src = `
      // Connect AI Provider was hard-coded here until the scan found it.
      const note = "Files will be saved to Downloads";
      export function C() { return <p>{note}</p>; }
    `;
    expect(scanSourceFile("x.tsx", src)).toEqual([]);
  });

  it("finds a sentence split across a JSX expression", () => {
    const src = `export function C() { return <p>The device is called <b>{name}</b> and it is ready now.</p>; }`;
    expect(scanSourceFile("x.tsx", src).map((f) => f.text)).toEqual([
      "The device is called",
      "and it is ready now.",
    ]);
  });
});
