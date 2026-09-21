/**
 * The i18n scan: three questions asked of the repository, in one pass.
 *
 * `bun run scripts/i18n-scan.ts`
 *
 * The dictionaries were never the problem. Every locale table in this repo is
 * key-complete and has been for a while, and `translations.test.ts` already
 * guards that. What kept shipping English to a Bulgarian desktop is the other
 * half — a component that never asks the dictionary at all:
 *
 *     title="Connect AI Provider"          // renders English in all ten locales
 *     title={tr("settings.aiConnectTitle", "Connect AI Provider")}   // asks
 *
 * A key that no component looks up is invisible to a test that compares locale
 * tables to each other, which is why `i18n-sweep-catalogue.test.ts` exists as a
 * hand-maintained list of surfaces someone walked through on a real device.
 * That list only ever covers the surfaces somebody remembered to walk.
 *
 * So this reads the SOURCE, not just the tables, and reports three things:
 *
 *   (a) keys a locale is missing (or carries and English does not)
 *   (b) non-English values byte-identical to English, longer than 3 characters
 *   (c) English string literals in src/components and src/app that reach the
 *       screen without passing through `t()` or `tr()`
 *
 * (a) and (c) are DEFECTS and set the exit code. (b) is a judgement call —
 * "Ollama" is identical in Swedish because it is a product name — so it
 * reports and does not block; the legitimate ones are named one by one in
 * scripts/i18n-allowlist.json with a reason each, and anything not named there
 * is a translation someone still owes.
 *
 * (c) is parsed with the TypeScript compiler's own JSX parser rather than
 * matched with a regular expression. The difference is not pedantry: a regex
 * over `.tsx` cannot tell `title="Save"` from the same characters inside a
 * comment, a string, or the `title` of a chart config object, and the false
 * positives are what make a scan like this get switched off in its first week.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { clawkeepTranslations } from "../src/lib/clawkeep-translations";
import { desktopTranslations } from "../src/lib/desktop-translations";
import { editionTranslations } from "../src/lib/edition-translations";
import { translations } from "../src/lib/translations";
import type { Locale } from "../src/lib/i18n";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const LOCALES: Locale[] = ["en", "bg", "de", "es", "fr", "it", "ja", "nl", "sv", "zh"];
export const NON_EN = LOCALES.filter((l): l is Exclude<Locale, "en"> => l !== "en");

/**
 * Every dictionary a component can reach, under the name a reader would use
 * for it.
 *
 * `translations` is the MERGED catalogue the running UI actually reads
 * (setup + desktop + clawkeep + edition), and it is listed alongside its own
 * inputs on purpose: `setupTranslations` is a module-private const inside
 * translations.ts with no export, so the merged table is the only way to see
 * those ~700 keys at all. The overlap means a desktop key that is identical in
 * German is reported twice — once under `desktop-translations`, once under
 * `translations.ts`. That is the honest shape of it: fixing the desktop source
 * clears both, and hiding the duplicate would mean deciding which module "owns"
 * a key, which nothing in the repo records.
 */
const MODULES: { name: string; table: Record<Locale, Record<string, string>> }[] = [
  { name: "desktop-translations", table: desktopTranslations },
  { name: "translations.ts", table: translations },
  { name: "clawkeep-translations", table: clawkeepTranslations },
  { name: "edition-translations", table: editionTranslations },
];

/** Where (c) looks. JSX only lives in `.tsx`, and tests may say what they like. */
const SOURCE_ROOTS = ["src/components", "src/app"];

/**
 * The props whose value is READ BY A HUMAN.
 *
 * Deliberately short. `alt` and `aria-describedby` are human-facing too, but
 * every name added here is a new class of false positive to triage, and these
 * seven are where the misses in this repo actually were.
 */
const HUMAN_PROPS = new Set([
  "title",
  "label",
  "placeholder",
  "aria-label",
  "description",
  "subtitle",
  "hint",
]);

/** Text inside these is code or markup, not copy — never a translation defect. */
const VERBATIM_ELEMENTS = new Set(["code", "pre", "kbd", "samp", "script", "style"]);

/** A value identical across locales is only interesting if it has letters in it. */
const HAS_LETTER = /[A-Za-z]/;

/**
 * Cyrillic, kana + CJK, Hangul — the scripts this product ships in that are not
 * Latin. Text containing any of them has already been translated.
 *
 * Written as escapes rather than as the characters themselves: the CJK range
 * begins at U+3000, the ideographic space, and a literal one sitting inside a
 * character class is invisible in every editor and diff.
 */
const NON_LATIN_SCRIPT = /[\u0400-\u04FF\u3000-\u9FFF\uAC00-\uD7AF]/;

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

export interface IdenticalAllowEntry {
  /** Dictionary key, e.g. "brand". */
  key: string;
  /** `"*"` for every locale, or the specific ones that legitimately match English. */
  locales: "*" | string[];
  reason: string;
}

export interface LiteralAllowEntry {
  /** Repo-relative, forward slashes, e.g. "src/app/portal/subscribe/page.tsx". */
  file: string;
  /** The exact literal, or `"*"` for every finding in that file. */
  text: string;
  reason: string;
}

export interface Allowlist {
  identicalValues: IdenticalAllowEntry[];
  literals: LiteralAllowEntry[];
}

export const ALLOWLIST_PATH = path.join(REPO_ROOT, "scripts", "i18n-allowlist.json");

export function loadAllowlist(file = ALLOWLIST_PATH): Allowlist {
  const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<Allowlist>;
  const identicalValues = raw.identicalValues ?? [];
  const literals = raw.literals ?? [];
  // A reason is the entire point of the file. An entry without one is somebody
  // silencing the scan, and it fails here rather than quietly widening it.
  for (const e of identicalValues) {
    if (!e.key || !e.reason?.trim()) throw new Error(`i18n allowlist: identicalValues entry for "${e.key}" has no reason`);
  }
  for (const e of literals) {
    if (!e.file || !e.reason?.trim()) throw new Error(`i18n allowlist: literals entry for "${e.file}" has no reason`);
  }
  return { identicalValues, literals };
}

// ---------------------------------------------------------------------------
// (a) + (b): the dictionaries
// ---------------------------------------------------------------------------

export interface KeyFinding {
  module: string;
  locale: string;
  key: string;
  /** `missing`: English has it and this locale does not. `orphan`: the reverse. */
  kind: "missing" | "orphan";
}

export interface IdenticalFinding {
  module: string;
  locale: string;
  key: string;
  value: string;
}

export function scanDictionaries(allow: Allowlist): {
  keys: KeyFinding[];
  identical: IdenticalFinding[];
  usedIdenticalEntries: Set<number>;
} {
  const keys: KeyFinding[] = [];
  const identical: IdenticalFinding[] = [];
  const usedIdenticalEntries = new Set<number>();

  const allowedFor = (key: string, locale: string): number | null => {
    for (let i = 0; i < allow.identicalValues.length; i++) {
      const e = allow.identicalValues[i];
      if (e.key !== key) continue;
      if (e.locales === "*" || e.locales.includes(locale)) return i;
    }
    return null;
  };

  for (const { name, table } of MODULES) {
    const en = table.en ?? {};
    for (const locale of NON_EN) {
      const loc = table[locale] ?? {};
      for (const key of Object.keys(en)) {
        if (!(key in loc)) {
          keys.push({ module: name, locale, key, kind: "missing" });
          continue;
        }
        const enValue = en[key];
        const locValue = loc[key];
        // "longer than 3 characters": "OK", "Wi-Fi" and "24/7" are the same word
        // everywhere and would be pure noise.
        if (locValue !== enValue || enValue.trim().length <= 3) continue;
        // No letters at all — "{n} / {total}", "100 MB", "🎉". There is nothing
        // in these for a translator to do, and listing every one of them in the
        // allowlist would bury the entries that carry a real decision.
        if (!HAS_LETTER.test(enValue)) continue;
        // …and neither is there in a value that is ONE interpolation slot.
        // `localModels.runtime.model` is the string "{model}": the letters
        // belong to the placeholder name, which `t()` substitutes away before
        // anything reaches the screen.
        if (/^\{[A-Za-z0-9_]+\}$/.test(enValue.trim())) continue;
        const hit = allowedFor(key, locale);
        if (hit !== null) {
          usedIdenticalEntries.add(hit);
          continue;
        }
        identical.push({ module: name, locale, key, value: enValue });
      }
      for (const key of Object.keys(loc)) {
        if (!(key in en)) keys.push({ module: name, locale, key, kind: "orphan" });
      }
    }
  }

  return { keys, identical, usedIdenticalEntries };
}

// ---------------------------------------------------------------------------
// (c): the source
// ---------------------------------------------------------------------------

export interface LiteralFinding {
  /** Repo-relative, forward slashes. */
  file: string;
  line: number;
  kind: "prop" | "text";
  /** The prop name for `kind: "prop"`; absent for a text node. */
  attribute?: string;
  text: string;
}

/**
 * Does this string literal look like English COPY, as opposed to a technical
 * token that happens to start with a capital?
 *
 * The bar is deliberately structural — capitalisation, letter case, shape —
 * rather than a vocabulary list. A judgement like "ClawBox is a brand so it
 * need not be translated" belongs in the allowlist, next to the reason, where
 * a reviewer can disagree with it. A judgement buried in a regular expression
 * here is invisible and silently shrinks what the scan covers.
 */
export function looksLikeEnglishCopy(raw: string): boolean {
  const s = raw.trim();
  if (s.length < 2) return false;
  // "capitalised English text" — a lowercase value is a CSS keyword, an enum
  // member or an id far more often than it is a sentence.
  if (!/^[A-Z]/.test(s)) return false;
  // An all-caps run is an acronym: "URL", "CPU", "AI", "RAM". Those read the
  // same in every locale this ships in.
  if (!/[a-z]/.test(s)) return false;
  // Already translated, or not Latin script at all.
  if (NON_LATIN_SCRIPT.test(s)) return false;
  // Paths, URLs, selectors, filenames, identifiers, MIME types, template
  // fragments — the shape gives them away and none of them is copy.
  if (/^https?:\/\//.test(s)) return false;
  if (/[/\\]/.test(s)) return false;
  if (/^[\w.-]+\.(png|jpe?g|svg|webp|ico|json|ts|tsx|js|mjs|css|sh|py|md|txt|wav|mp3)$/i.test(s)) return false;
  if (/^[A-Za-z][\w$]*$/.test(s) && /[_$]/.test(s)) return false;
  return true;
}

/** A JSX text node is copy when it reads as a sentence: three or more words. */
export function looksLikeEnglishSentence(raw: string): boolean {
  const s = raw.replace(/\s+/g, " ").trim();
  if (!s) return false;
  if (NON_LATIN_SCRIPT.test(s)) return false;
  // A sentence has spaces between its words. Without this rule the single
  // commonest text node in this repo reports as one: Material Symbols are
  // rendered as ligatures, so every icon in the UI is literally
  // `<span className="material-symbols-rounded">open_in_new</span>` — three
  // "words" of English that no locale should ever translate, because the font
  // draws them as a glyph. It also settles "Ctrl+Shift+V", "discord.com/developers"
  // and "~/.config/clawbox-browser/" on the same principle: one token, not copy.
  if (!/\s/.test(s)) return false;
  const words = s.match(/[A-Za-z][A-Za-z'’]*/g) ?? [];
  if (words.length < 3) return false;
  // All-caps is a heading style or an acronym run, not a sentence to translate.
  if (!/[a-z]/.test(s)) return false;
  // At least one word long enough to carry meaning; "a b c" is not a sentence.
  return words.some((w) => w.length >= 3);
}

/**
 * Every value this attribute can put on screen that is a constant string.
 *
 * `title={t("x")}` yields nothing — it asks the dictionary, which is the whole
 * point. `title="X"` and `title={"X"}` yield "X".
 *
 * BOTH arms of a ternary, because both reach the screen and only one is
 * rendered at a time: `showPassword ? "Hide password" : "Show password"` is the
 * single commonest shape of this bug in this repo (nine findings across five
 * components), and reporting one arm would leave the other to be found again
 * on the next pass. A mixed `cond ? t("a") : "B"` still reports "B".
 */
function constantStringsOf(node: ts.Node): string[] {
  if (ts.isJsxExpression(node)) return node.expression ? constantStringsOf(node.expression) : [];
  if (ts.isConditionalExpression(node)) {
    return [...constantStringsOf(node.whenTrue), ...constantStringsOf(node.whenFalse)];
  }
  if (ts.isStringLiteral(node)) return [node.text];
  if (ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  return [];
}

function enclosingTagName(node: ts.Node): string | null {
  const parent = node.parent;
  if (parent && ts.isJsxElement(parent)) return parent.openingElement.tagName.getText();
  return null;
}

export function scanSourceFile(relFile: string, source: string): LiteralFinding[] {
  const findings: LiteralFinding[] = [];
  const sf = ts.createSourceFile(relFile, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node) && node.initializer) {
      const name = node.name.getText(sf);
      if (HUMAN_PROPS.has(name)) {
        for (const value of constantStringsOf(node.initializer)) {
          if (looksLikeEnglishCopy(value)) {
            findings.push({ file: relFile, line: lineOf(node), kind: "prop", attribute: name, text: value.trim() });
          }
        }
      }
    }
    if (ts.isJsxText(node)) {
      const tag = enclosingTagName(node);
      if (!tag || !VERBATIM_ELEMENTS.has(tag)) {
        const text = node.text.replace(/\s+/g, " ").trim();
        if (looksLikeEnglishSentence(text)) {
          findings.push({ file: relFile, line: lineOf(node), kind: "text", text });
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sf, visit);
  return findings;
}

function walkTsx(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTsx(full, out);
      continue;
    }
    if (!entry.name.endsWith(".tsx")) continue;
    if (entry.name.endsWith(".test.tsx")) continue;
    out.push(full);
  }
}

export function scanSources(allow: Allowlist, repoRoot = REPO_ROOT): {
  literals: LiteralFinding[];
  usedLiteralEntries: Set<number>;
} {
  const files: string[] = [];
  for (const root of SOURCE_ROOTS) {
    const full = path.join(repoRoot, root);
    if (fs.existsSync(full)) walkTsx(full, files);
  }
  files.sort();

  const literals: LiteralFinding[] = [];
  const usedLiteralEntries = new Set<number>();

  for (const full of files) {
    const rel = path.relative(repoRoot, full).split(path.sep).join("/");
    for (const finding of scanSourceFile(rel, fs.readFileSync(full, "utf-8"))) {
      let allowed = false;
      for (let i = 0; i < allow.literals.length; i++) {
        const e = allow.literals[i];
        if (e.file !== finding.file) continue;
        if (e.text !== "*" && e.text !== finding.text) continue;
        usedLiteralEntries.add(i);
        allowed = true;
        break;
      }
      if (!allowed) literals.push(finding);
    }
  }

  return { literals, usedLiteralEntries };
}

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

export interface ScanResult {
  keys: KeyFinding[];
  identical: IdenticalFinding[];
  literals: LiteralFinding[];
  /** Allowlist entries that no longer match anything — the file has gone stale. */
  stale: (IdenticalAllowEntry | LiteralAllowEntry)[];
}

export function scan(repoRoot = REPO_ROOT): ScanResult {
  const allow = loadAllowlist(path.join(repoRoot, "scripts", "i18n-allowlist.json"));
  const { keys, identical, usedIdenticalEntries } = scanDictionaries(allow);
  const { literals, usedLiteralEntries } = scanSources(allow, repoRoot);
  const stale = [
    ...allow.identicalValues.filter((_, i) => !usedIdenticalEntries.has(i)),
    ...allow.literals.filter((_, i) => !usedLiteralEntries.has(i)),
  ];
  return { keys, identical, literals, stale };
}

function groupCount<T>(rows: T[], by: (row: T) => string): string {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(by(row), (counts.get(by(row)) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, n]) => `${k} ${n}`)
    .join(", ");
}

function report(result: ScanResult): void {
  const { keys, identical, literals, stale } = result;

  console.log("=== (a) keys missing from a locale ===");
  if (keys.length === 0) {
    console.log("  none — every locale carries every key in every module.");
  } else {
    for (const f of keys.slice(0, 200)) {
      console.log(`  ${f.module} ${f.locale} ${f.kind === "missing" ? "missing" : "orphan  "} ${f.key}`);
    }
    if (keys.length > 200) console.log(`  ... and ${keys.length - 200} more`);
    console.log(`  total ${keys.length} (${groupCount(keys, (f) => f.locale)})`);
  }

  console.log("\n=== (b) non-English values identical to English ===");
  if (identical.length === 0) {
    console.log("  none — every value over 3 characters differs from English or is allowlisted.");
  } else {
    for (const f of identical) {
      const v = f.value.length > 70 ? `${f.value.slice(0, 67)}...` : f.value;
      console.log(`  ${f.module} ${f.locale} ${f.key}: "${v}"`);
    }
    console.log(`  total ${identical.length} (${groupCount(identical, (f) => f.locale)})`);
  }

  console.log("\n=== (c) English literals that never reach t()/tr() ===");
  if (literals.length === 0) {
    console.log("  none — every human-facing literal in src/components and src/app is translated.");
  } else {
    for (const f of literals) {
      const where = f.kind === "prop" ? `${f.attribute}=` : "text";
      console.log(`  ${f.file}:${f.line} ${where} "${f.text}"`);
    }
    console.log(`  total ${literals.length} (${groupCount(literals, (f) => f.file)})`);
  }

  if (stale.length > 0) {
    console.log("\n=== stale allowlist entries (nothing matches them any more) ===");
    for (const e of stale) {
      console.log(`  ${"key" in e ? e.key : `${e.file} :: ${e.text}`}`);
    }
  }

  console.log(
    `\nsummary: ${keys.length} missing keys, ${identical.length} identical values, ` +
      `${literals.length} untranslated literals, ${stale.length} stale allowlist entries`,
  );
}

/**
 * (a) and (c) block; (b) does not.
 *
 * A missing key and an untranslated literal are both facts — the string cannot
 * possibly render in that locale — so they are safe to gate a build on. Whether
 * "Ollama" should read differently in Swedish is a judgement, and a judgement
 * that fails CI gets answered by widening the allowlist rather than by
 * translating anything. Stale entries block too: an allowlist nobody prunes is
 * how (b) becomes decoration.
 */
export function exitCodeFor(result: ScanResult): number {
  return result.keys.length > 0 || result.literals.length > 0 || result.stale.length > 0 ? 1 : 0;
}

if (import.meta.main) {
  const result = scan();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    report(result);
  }
  process.exit(exitCodeFor(result));
}
