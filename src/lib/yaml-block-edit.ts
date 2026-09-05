/**
 * A comment-preserving, line-oriented editor for block-style YAML.
 *
 * WHY THIS EXISTS
 *
 * `hermes config set <key> <value>` load/dumps ~/.hermes/config.yaml through a
 * plain YAML serialiser, so it re-writes the whole file from the parsed tree and
 * every comment in it is gone. Measured on a QA box: one call took config.yaml
 * from 3175 bytes / 36 comment lines to 1303 / 0, and saving a local model in
 * the ClawBox UI issues three to five of them. The deleted lines are the only
 * in-product documentation for secret redaction, tirith pre-exec scanning and
 * provider failover, and they never come back.
 *
 * So ClawBox edits that file itself, the way a person would: find the line,
 * change the value, leave every other byte alone. Nothing is re-serialised, so
 * comments, blank lines, key order and quoting style all survive by
 * construction — the output is the input with a known set of line splices.
 *
 * DELIBERATELY NOT A YAML LIBRARY. It understands block mappings of plain
 * scalars, which is what the keys ClawBox SPLICES (`providers.<slug>.base_url`,
 * `.api_key`, `.api_mode`, the single-id `providers.clawlocal.models`,
 * `model.*`) are. Not every key ClawBox owns is one: `providers.clawai.models`
 * is a LIST, written through `hermes config set` because a sequence is a shape
 * this module raises on — so a caller adding a `providers.*` patch must check
 * that the leaf it wants is a scalar first (see `localCatalogueState` in
 * hermes-local-ai.ts for the read that does it).
 * Anything else on the path it is asked to touch — flow style, block scalars,
 * sequences, quoted or duplicate keys, tab indentation, multi-document files,
 * or a quoted value carrying an escape PyYAML itself raises on —
 * raises {@link YamlEditUnsupported} rather than guessing. Callers are expected
 * to fall back to the Hermes CLI on that signal: losing the comments is bad,
 * corrupting the config is worse.
 *
 * That contract belongs to the EDITING half. {@link getTopLevelScalar} is a
 * reader, and a reader may not raise on a construct somewhere else in the file:
 * a sequence, a duplicate key or a nested block is not evidence about the key it
 * was asked for, and a caller would have to turn the refusal into one. It never
 * throws; it answers a third state (`readable: false`) for a value it cannot
 * name — and for a DOCUMENT PYYAML WILL NOT LOAD, which is the one whole-file
 * fact that IS evidence about every key: Hermes' bridge loads config.yaml with
 * PyYAML, so when PyYAML raises the bridge exports nothing and no line in the
 * file describes what the gateway is polling.
 */

export class YamlEditUnsupported extends Error {}

/** `  key: value`, `key:` — plain keys only; anything quoted is unsupported. */
const KEY_RE = /^(\s*)([A-Za-z0-9_][A-Za-z0-9_.\-]*):(\s.*)?$/;
const INDENT_STEP = "  ";

function isBlank(line: string): boolean {
  return line.trim() === "";
}

function isComment(line: string): boolean {
  return /^\s*#/.test(line);
}

function isSkippable(line: string): boolean {
  return isBlank(line) || isComment(line);
}

function indentOf(line: string): number {
  return /^ */.exec(line)![0].length;
}

interface Entry {
  /** Index of the `key:` line itself. */
  line: number;
  key: string;
  /** Text after the colon, trimmed. "" when the key opens a nested block. */
  inline: string;
  /** Lines [childStart, childEnd) — the key's nested block, trailing blank/comment lines excluded. */
  childStart: number;
  childEnd: number;
}

function splitLines(text: string): { lines: string[]; trailingNewline: boolean } {
  const trailingNewline = text.endsWith("\n");
  const body = trailingNewline ? text.slice(0, -1) : text;
  return { lines: body === "" ? [] : body.split("\n"), trailingNewline };
}

function joinLines(lines: string[], trailingNewline: boolean): string {
  if (lines.length === 0) return trailingNewline ? "\n" : "";
  return lines.join("\n") + (trailingNewline ? "\n" : "");
}

/**
 * The mapping entries directly inside [start, end) at exactly `indent` columns.
 *
 * Raises rather than returning a partial view: a line we cannot classify at our
 * own indentation level could be the very key the caller is looking for (a
 * quoted key, a merge key), and missing it would append a duplicate.
 */
function scanBlock(lines: string[], start: number, end: number, indent: number): Entry[] {
  const entries: Entry[] = [];
  for (let i = start; i < end; i += 1) {
    const line = lines[i];
    if (isSkippable(line)) continue;
    if (/^\s*\t/.test(line)) {
      throw new YamlEditUnsupported("tab indentation");
    }
    const lineIndent = indentOf(line);
    if (lineIndent > indent) continue; // belongs to the entry above
    if (lineIndent < indent) break; // the block ended
    if (line.trim() === "---" || line.trim() === "...") {
      throw new YamlEditUnsupported("multi-document file");
    }
    if (/^\s*-(\s|$)/.test(line)) {
      throw new YamlEditUnsupported("sequence where a mapping was expected");
    }
    const m = KEY_RE.exec(line);
    if (!m) {
      throw new YamlEditUnsupported(`unrecognised line: ${line.trim().slice(0, 40)}`);
    }
    const key = m[2];
    if (entries.some((e) => e.key === key)) {
      throw new YamlEditUnsupported(`duplicate key: ${key}`);
    }
    entries.push({
      line: i,
      key,
      inline: (m[3] ?? "").trim(),
      childStart: i + 1,
      childEnd: i + 1,
    });
  }

  // Close each entry's block: everything up to the next sibling (or the end of
  // the parent block), minus the trailing blank/comment lines. Those trail the
  // block visually but belong to whatever comes next — the "── Security ──"
  // banner at the bottom of a Hermes config is exactly that — so keeping them
  // out of the range is what stops an insert from landing below them and a
  // prune from deleting them.
  for (let e = 0; e < entries.length; e += 1) {
    const entry = entries[e];
    const limit = e + 1 < entries.length ? entries[e + 1].line : end;
    let last = entry.line;
    for (let i = entry.line + 1; i < limit; i += 1) {
      if (!isSkippable(lines[i])) last = i;
    }
    entry.childStart = entry.line + 1;
    entry.childEnd = last + 1;
  }

  return entries;
}

function findEntry(lines: string[], start: number, end: number, indent: number, key: string): Entry | null {
  return scanBlock(lines, start, end, indent).find((e) => e.key === key) ?? null;
}

/**
 * Where a quoted scalar ends, scanning from `from`, or -1 when it does not
 * close on this line.
 *
 * Double quotes escape with a backslash, single quotes by doubling — the same
 * two rules {@link parseYamlScalar} undoes. `from` is 1 for the line that OPENS
 * the scalar (past its own opening quote) and 0 for a continuation line, which
 * is how a value that runs over several lines is skipped rather than read as
 * lines of its own.
 */
function closingQuoteIndex(inline: string, from: number, quote: '"' | "'"): number {
  for (let i = from; i < inline.length; i += 1) {
    const ch = inline[i];
    if (quote === '"' && ch === "\\") {
      i += 1;
      continue;
    }
    if (ch !== quote) continue;
    if (quote === "'" && inline[i + 1] === "'") {
      i += 1;
      continue;
    }
    return i;
  }
  return -1;
}

/**
 * Value text plus any trailing `# comment` we must preserve when rewriting.
 *
 * A `#` INSIDE a quoted scalar is data, so the closing quote is found first and
 * only the remainder is searched for a comment. Giving up on the whole line
 * instead — which is what this did, on the grounds that the editor replaces the
 * value anyway — was false in both directions. It cost the EDITOR the comment it
 * exists to preserve, and it made the two READERS below answer
 * `TOKEN: "…"  # main bot` with quotes-plus-comment: for a credential that is a
 * confident "this box has nothing here" over a box that has one, which is the
 * fail-open `telegram-bot-identity.ts` exists to close, reached through the
 * value instead of through the key.
 *
 * `closed` is false only when a quoted run does not end cleanly on this line —
 * an unterminated quote, or text after the closing one. The split cannot be
 * trusted there, and a reader has to treat it as a value it could not name
 * rather than as a value.
 */
function splitTrailingComment(inline: string): { value: string; comment: string; closed: boolean } {
  const quote = inline[0];
  if (quote === '"' || quote === "'") {
    const end = closingQuoteIndex(inline, 1, quote);
    if (end === -1) return { value: inline, comment: "", closed: false };
    const rest = inline.slice(end + 1);
    if (rest === "") return { value: inline, comment: "", closed: true };
    // No space needed before the `#`: the flow scalar ended at the quote, and
    // PyYAML — what Hermes' own bridge loads config.yaml with — reads
    // `KEY: "tok"# c` as `tok`. Requiring one made that line "we could not
    // look", which is a permanent 503 on the approvals gate over a config that
    // is fine. A separator is put BACK on the way out, because the editor
    // rewrites the value and `newvalue# c` is a value, not a comment.
    if (!/^[ \t]*#/.test(rest)) return { value: inline, comment: "", closed: false };
    const comment = rest.startsWith("#") ? ` ${rest}` : rest;
    return { value: inline.slice(0, end + 1), comment, closed: true };
  }
  const m = /^(.*?)(\s+#.*)$/.exec(inline);
  if (!m) return { value: inline, comment: "", closed: true };
  return { value: m[1].trimEnd(), comment: m[2], closed: true };
}

/**
 * Render a scalar the way a hand-written config would: plain when that is
 * unambiguous, double-quoted otherwise. `http://host/path` stays plain (the
 * `:` is only a mapping separator when followed by a space), a value with a
 * `#`, a leading indicator character or surrounding space gets quoted.
 */
export function formatYamlScalar(value: string): string {
  const plainSafe =
    value.length > 0
    && value === value.trim()
    && !/[#"'`,{}[\]&*!|>%@\\]/.test(value)
    && !/:\s/.test(value)
    && !value.endsWith(":")
    && !/^[-?]/.test(value)
    && !/[\r\n\t]/.test(value);
  if (plainSafe) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`;
}

/**
 * YAML 1.2's double-quoted escapes, exactly as PyYAML's `ESCAPE_REPLACEMENTS`
 * resolves them — PyYAML being what Hermes' own env bridge loads config.yaml
 * with, so it decides what the gateway ends up polling.
 *
 * HARNESS FIRST, and the reason it is a port rather than a call: the box ships
 * the authoritative resolver (python3 + PyYAML, the very library the bridge
 * imports), and asking it would be the native mechanism. It is not used because
 * this reader must never throw and is on an authenticated 3-second poll — a
 * python spawn per read, on a Jetson, for a value that is one line of a file
 * this module already has open. The tables below are therefore checked against
 * the box's own `yaml.scanner.Scanner.ESCAPE_REPLACEMENTS` / `ESCAPE_CODES`
 * rather than written from the spec, and the unit suite asserts the value
 * PyYAML returns for each one.
 */
const DOUBLE_QUOTED_ESCAPES: Record<string, string> = {
  "0": "\0",
  a: "\x07",
  b: "\b",
  t: "\t",
  "\t": "\t",
  n: "\n",
  v: "\v",
  f: "\f",
  r: "\r",
  e: "\x1b",
  " ": " ",
  '"': '"',
  "/": "/",
  "\\": "\\",
  N: "\x85",
  _: "\xa0",
  L: "\u2028",
  P: "\u2029",
};

/** `\xNN`, `\uNNNN`, `\UNNNNNNNN` — PyYAML's `ESCAPE_CODES`, in hex digits. */
const ESCAPE_CODE_WIDTHS: Record<string, number> = { x: 2, u: 4, U: 8 };

/**
 * The text between double quotes, unescaped, or null for an escape PyYAML
 * would RAISE on.
 *
 * Undoing only the four escapes {@link formatYamlScalar} emits left every other
 * one as its own literal text: `"111111:\x41AH…"` came back with the backslash
 * still in it, `BOT_TOKEN_RE` rejected that, and the answer was a confident
 * "this box has no bot" over a box that has one — and `"11111\x30:…"` named a
 * DIFFERENT bot than the gateway polls. An escape PyYAML raises on is a file
 * that does not load at all, so any value invented for it is nobody's: null
 * here, `readable: false` at the reader, which is this module's own rule.
 */
function unescapeDoubleQuoted(body: string): string | null {
  let out = "";
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const escape = body[i + 1];
    if (escape === undefined) return null; // a line continuation, not a value
    const replacement = DOUBLE_QUOTED_ESCAPES[escape];
    if (replacement !== undefined) {
      out += replacement;
      i += 1;
      continue;
    }
    const width = ESCAPE_CODE_WIDTHS[escape];
    if (width === undefined) return null;
    const digits = body.slice(i + 2, i + 2 + width);
    if (digits.length !== width || !/^[0-9A-Fa-f]+$/.test(digits)) return null;
    const code = parseInt(digits, 16);
    // Python's chr() has no character above this, so PyYAML raises there too.
    if (code > 0x10ffff) return null;
    out += String.fromCodePoint(code);
    i += 1 + width;
  }
  return out;
}

/**
 * One flow scalar, unquoted the way PyYAML unquotes it — null when it holds an
 * escape this reader may not resolve (see {@link unescapeDoubleQuoted}).
 *
 * Single quotes have exactly ONE escape, `''`; a backslash is ordinary data
 * there, and decoding it would invent a value PyYAML never produced.
 */
function parseYamlScalar(raw: string): string | null {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return unescapeDoubleQuoted(value.slice(1, -1));
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function assertPath(path: string[]): void {
  if (path.length === 0) throw new YamlEditUnsupported("empty key path");
  for (const segment of path) {
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.\-]*$/.test(segment)) {
      throw new YamlEditUnsupported(`unsupported key segment: ${segment}`);
    }
  }
}

/** Walk as far down `path` as the file already goes. */
function descend(
  lines: string[],
  path: string[],
): { matched: Entry[]; start: number; end: number; indent: number } {
  const matched: Entry[] = [];
  let start = 0;
  // Trailing blank/comment lines are excluded from the top-level block for the
  // same reason they are excluded from a nested one: a new top-level key
  // belongs after the last real entry, not underneath the closing comment
  // banner that documents something else.
  let end = lines.length;
  while (end > 0 && isSkippable(lines[end - 1])) end -= 1;
  let indent = 0;

  for (let depth = 0; depth < path.length; depth += 1) {
    const entry = findEntry(lines, start, end, indent, path[depth]);
    if (!entry) break;
    matched.push(entry);
    if (depth < path.length - 1 && entry.inline !== "") {
      // `providers: {}` / `model: null` / a block scalar — descending into it
      // would mean rewriting a value we do not understand.
      throw new YamlEditUnsupported(`cannot descend into inline value at ${path.slice(0, depth + 1).join(".")}`);
    }
    start = entry.childStart;
    end = entry.childEnd;
    indent += INDENT_STEP.length;
  }

  return { matched, start, end, indent };
}

/** Read one dotted path. Returns null when any segment is missing. */
export function getYamlPath(text: string, path: string[]): string | null {
  assertPath(path);
  const { lines } = splitLines(text);
  const { matched } = descend(lines, path);
  if (matched.length !== path.length) return null;
  const leaf = matched[matched.length - 1];
  if (leaf.inline === "") return null;
  const value = parseYamlScalar(splitTrailingComment(leaf.inline).value);
  // The editing half's rule: a shape this module cannot resolve is refused, not
  // guessed at. Returning the literal escape text instead would make the
  // read-back verification in `patchHermesConfig` pass over a value PyYAML
  // reads differently — or, on `hermes-shell-scan`, report a setting nobody
  // wrote. Callers fall back to the Hermes CLI on this signal.
  if (value === null) {
    throw new YamlEditUnsupported(`${path.join(".")} holds an escape this reader cannot resolve`);
  }
  return value;
}

/** `{}` / `[ ]` — a collection written inline with no members in it. */
const EMPTY_FLOW_RE = /^(?:\{\s*\}|\[\s*\])$/;

/**
 * Is the path THERE, and — when it is a scalar — what does it say?
 *
 *   "value"   — a scalar this reader can name.
 *   "present" — the key is there in a shape that is not a scalar: a nested
 *               block, a sequence, an empty flow collection, a bare `key:`, a
 *               quoted value carrying an escape PyYAML resolves and this
 *               reader does not.
 *   "absent"  — the file parsed and the key is not in it.
 *
 * Separate from {@link getYamlPath} because that answers a different question
 * — "give me the scalar to splice" — and gets THIS one wrong in both
 * directions.
 *
 * It returns `null` for a key whose value is a block or a list, so a surviving
 * `providers.clawlocal.models:` catalogue (the shape Hermes' own model
 * discovery writes) reads as "not there". And it THROWS as soon as any segment
 * on the way down carries an inline value — the empty flow mapping `{}`
 * included, which is what PyYAML emits for a mapping it has just emptied. As
 * `hermes config unset` is what empties one, `{}` is the ordinary shape of a
 * removal that fully SUCCEEDED, and refusing over it turns that success into
 * "we could not look".
 *
 * So an empty flow collection on the way down is an ANSWER here: a mapping
 * with no members cannot hold a member by that name. Anything else inline is
 * not — `clawlocal: {base_url: …}` may well hold the key, and this reader
 * cannot say — and still raises, which the caller reads as "we could not
 * look" rather than as a fact about the key.
 */
export type YamlPathRead =
  | { state: "value"; value: string }
  | { state: "present" }
  | { state: "absent" };

export function readYamlPath(text: string, path: string[]): YamlPathRead {
  assertPath(path);
  const { lines } = splitLines(text);
  let start = 0;
  let end = lines.length;
  while (end > 0 && isSkippable(lines[end - 1])) end -= 1;
  let indent = 0;

  for (let depth = 0; depth < path.length; depth += 1) {
    const entry = findEntry(lines, start, end, indent, path[depth]);
    if (!entry) return { state: "absent" };

    if (depth === path.length - 1) {
      // A key with no inline text opens a block, a sequence, or nothing at all;
      // whichever it is, the key IS written in this file.
      if (entry.inline === "" || EMPTY_FLOW_RE.test(entry.inline)) return { state: "present" };
      const split = splitTrailingComment(entry.inline);
      if (!split.closed) return { state: "present" };
      const value = parseYamlScalar(split.value);
      return value === null ? { state: "present" } : { state: "value", value };
    }

    if (entry.inline !== "") {
      if (EMPTY_FLOW_RE.test(entry.inline)) return { state: "absent" };
      throw new YamlEditUnsupported(`cannot descend into inline value at ${path.slice(0, depth + 1).join(".")}`);
    }
    start = entry.childStart;
    end = entry.childEnd;
    indent += INDENT_STEP.length;
  }

  // Unreachable — the last iteration always returns — and thrown rather than
  // answered so a future edit that makes it reachable cannot invent an
  // "absent" nobody proved.
  throw new YamlEditUnsupported(`could not resolve ${path.join(".")}`);
}

/** One top-level entry as {@link getTopLevelScalar} reads it. */
export interface TopLevelScalar {
  /** The key's top-level scalar, or null when it has none we can read. */
  value: string | null;
  /**
   * False when this reader could not LOOK, which is two facts and never "the
   * key is not defined":
   *
   *  - a line at column 0 defines the key with a value it cannot resolve to a
   *    scalar — a block scalar (`|`, `>`), a tag, an anchor or alias, a flow
   *    collection, or a quote that does not close; or
   *  - the DOCUMENT is one PyYAML refuses to load, in which case the key may be
   *    absent, present, or anything at all — nothing in a file the Hermes bridge
   *    cannot load is evidence about what the gateway is polling.
   *
   * `value` is null either way, and this is the only one of the two states a
   * save gate may act on.
   */
  readable: boolean;
}

/** Value shapes whose first character changes what the value IS. */
const OPAQUE_VALUE_RE = /^[|>!&*{[]/;

/**
 * Any `key:` line, whatever its depth: indent in `[1]`, inline value in `[2]`.
 *
 * The colon has to be followed by a SPACE or the end of the line, which is
 * PyYAML's `check_value` in block context: `KEY:111111:AAH` opens no mapping at
 * all, it is a plain scalar document. A tab there is not a separator either —
 * PyYAML raises on `KEY:<TAB>value` and on `KEY<TAB>: value`, both measured on
 * 6.0.1 and on the 5.4.1 the Hermes box ships — so a line spelled that way is
 * not a mapping entry this reader may answer a bot out of.
 */
const ANY_KEY_RE = /^( *)(?:"[^"]*"|'[^']*'|[^\s#"'][^:#]*?) *:(?: (.*))?$/;

/** A `#` opens a comment only when a token has just ENDED in front of it. */
const COMMENT_OPENERS = new Set([" ", '"', "'", "]", "}"]);

/**
 * Does this STRUCTURE line carry a TAB PyYAML would refuse?
 *
 * Measured against PyYAML 6.0.1 rather than read off the spec, because the spec
 * is more permissive than the library the box actually loads config.yaml with:
 * `Scanner.scan_to_next_token` skips only `' '`, so a tab reached anywhere a
 * token may start raises `ScannerError` and the WHOLE document fails to load.
 * Tabs survive in exactly three places — inside a quoted scalar, inside a
 * comment, and inside a block scalar's content, which the caller handles
 * because only it knows the block's indent.
 *
 * A `#` opens a comment only when the token in front of it has ENDED — the rule
 * {@link splitTrailingComment} already states 260 lines up, and for the reason
 * written there: `other: "x"#c` is a comment because the flow scalar closed at
 * the quote, while `other: x#c` is the plain scalar `x#c`. Requiring a SPACE
 * made `"x"#c<TAB>d` "we could not look", which is a permanent 503 on the
 * approvals gate over a config PyYAML loads. A TAB in front of a `#` is not
 * that ending: PyYAML raises on the tab before it ever reaches the `#`, which
 * is why the tab test comes first and `KEY: value<TAB># note` is a refusal
 * rather than a comment question.
 *
 * A quote only OPENS at the start of a token, so it is recognised only at the
 * start of the line or after a space. `other: don't stop` is a plain scalar
 * with an apostrophe in it, and treating that as an opening quote would swallow
 * the rest of the line and miss a tab further along.
 *
 * What that costs, so it is not re-derived: a quote character in the MIDDLE of
 * a plain scalar, after a space (`other: a 'b<TAB>c`), still opens one here and
 * the tab behind it is read as quoted data — PyYAML raises on that document and
 * this answers a bot out of it. Fail-open on a shape nothing writes, and the
 * alternative — tracking real value positions across a line — is the parser
 * this module exists not to be.
 */
function refusesTab(line: string): boolean {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote === '"') {
      if (ch === "\\") i += 1;
      else if (ch === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (ch !== "'") continue;
      if (line[i + 1] === "'") i += 1;
      else quote = null;
      continue;
    }
    if (ch === "\t") return true;
    // The rest of the line is a comment; PyYAML reads no tokens out of it.
    if (ch === "#" && (i === 0 || COMMENT_OPENERS.has(line[i - 1]))) return false;
    if ((ch === '"' || ch === "'") && (i === 0 || line[i - 1] === " ")) quote = ch;
  }
  return false;
}

/** A sequence item: indent in `[1]`, whatever it puts in the value position in `[2]`. */
const SEQ_ITEM_RE = /^( *)-(?: +(.*))?$/;

/** A document start or end marker on a line of its own. */
const DOC_MARKER_RE = /^(?:---|\.\.\.)(?:\s|$)/;

/**
 * A block scalar header PyYAML accepts: the indicator, then a chomping sign
 * and/or an indentation digit in either order, then only spaces and a comment.
 *
 * `scan_block_scalar_indicators` raises on anything else, which makes a value
 * that merely LOOKS like a header — `other: >=1.0`, `other: |pipe` — a document
 * that does not load rather than a block. Both are ordinary things to write
 * (a version range, a word) and both used to leave the reader confidently
 * naming this box's bot out of a file the bridge exports nothing from.
 */
const BLOCK_HEADER_RE = /^[|>](?:[+-][1-9]?|[1-9][+-]?)? *(?:#.*)?$/;

/** The explicit indentation indicator in a block header, or 0 for "measure it". */
function blockHeaderIndent(header: string): number {
  const digit = /^[|>][+-]?([1-9])/.exec(header);
  return digit ? Number(digit[1]) : 0;
}

/**
 * The indent a block scalar's content must sit DEEPER than, when this line
 * opens one — or -1 when it opens none.
 *
 * {@link ANY_KEY_RE} models only the key shapes this reader may answer a VALUE
 * out of, and a block can be opened by three it deliberately excludes: a value
 * carrying a tag or an anchor (`notes: !!str |`, `notes: &n |`), and a key with
 * a `#` or a `:` inside it (`a#b:`, `a:b:`). A block's content is TEXT, so
 * reading it as structure is how a tab, or a `|pipe`, in a command somebody
 * pasted into a `- |` item turned a config.yaml the gateway loads happily into
 * "we could not look" — a 503 on the approvals-bot save with no way out of it.
 *
 * Deliberately looser than the value rules above, because it decides only what
 * to SKIP and never what to answer: a false positive costs a few skipped lines
 * of somebody else's subtree, a false negative costs the fail-open it exists to
 * close. The header must still be the FIRST token after the colon, so
 * `other: a |` — a plain scalar that merely ends in a pipe — opens nothing.
 */
function blockOpenerIndent(line: string): number {
  const indent = indentOf(line);
  let rest = line.slice(indent);
  for (let dash = /^- +/.exec(rest); dash; dash = /^- +/.exec(rest)) rest = rest.slice(dash[0].length);
  const key = /^(?:"[^"]*"|'[^']*'|[^\s#"'].*?): +/.exec(rest);
  if (key) rest = rest.slice(key[0].length);
  for (let mark = /^[!&]\S* +/.exec(rest); mark; mark = /^[!&]\S* +/.exec(rest)) rest = rest.slice(mark[0].length);
  return BLOCK_HEADER_RE.test(rest) ? indent : -1;
}

/**
 * The file's lines, minus the CONTINUATION lines of a multi-line quoted value.
 *
 * A flow scalar may run over several lines and PyYAML does not require its
 * continuation to be indented, so a line INSIDE one can be `key:`-shaped and
 * sit at column 0. Read as a line of its own it answers confidently about a key
 * nobody wrote — as the last match (`notes: "…\nTELEGRAM_BOT_TOKEN: DECOY\n"`
 * named DECOY as this box's bot) and as the shallowest indent, which pulled the
 * root mapping's own indent below itself and made the real key line "somebody
 * else's".
 *
 * A BLOCK scalar's content is skipped the same way and for a stronger reason:
 * it is TEXT, not YAML, so a quote or an apostrophe in it opens nothing. A
 * persona, a system prompt or a pasted command in a `|` block routinely carries
 * one — `path: 'C:/tmp`, or `# don't edit this file` — and reading it as an
 * opener swallowed the real key line after it (a confident "no bot"), or left a
 * quote open to the end of the file (a permanent "we could not look"). PyYAML
 * loads both of those documents without complaint.
 *
 * `unterminated` is true when a quote is still open at the end of the file,
 * which after the above can only be a genuine FLOW scalar — and PyYAML does
 * raise on the whole document there, so the lines beyond it are not evidence of
 * anything and swallowing the key line among them would be a confident "no bot"
 * invented out of a missing quote. The caller degrades instead.
 *
 * `loadable` is false when the document is one PyYAML REFUSES outright, and it
 * is the same fact as `unterminated` reached by the two other routes a
 * hand-edited config.yaml takes: a TAB where a token may start, and a SECOND
 * document. The bridge then exports nothing at all and the gateway polls no
 * bot — so a token read out of such a file is a bot that does not exist, named
 * confidently, which is what makes `/telegram/status` print a username for a
 * dead box and the configure route's same-bot guard refuse a token that was
 * fine. `readable: false` costs a degraded panel the owner can act on.
 *
 * KNOWN LIMITS, measured against PyYAML 6.0.1 rather than guessed at. A flow
 * scalar is recognised in the two value positions a line can carry one — after
 * `key:` and after a sequence item's `-` — but not when it is CLOSED by a later
 * line this reader did not know it was inside. And `loadable` is a LINE-level
 * check, so four classes of unloadable document are still read rather than
 * refused: a block nested at an indentation its parent cannot hold; a `----`
 * line; a `---` carrying content on the same line; and a tab that follows a
 * quote character INSIDE a plain scalar (`other: a 'b<TAB>c`), which the quote
 * rule in {@link refusesTab} reads as quoted data. All four are fail-open and
 * none is a shape a config.yaml grows in ordinary use; closing them needs the
 * indentation stack this module exists not to have.
 */
function documentLines(lines: string[]): { lines: string[]; unterminated: boolean; loadable: boolean } {
  const kept: string[] = [];
  let open: '"' | "'" | null = null;
  let blockIndent: number | null = null;
  let contentIndent: number | null = null;
  let sawContent = false;
  let sawDirective = false;
  let documentEnded = false;
  let loadable = true;
  for (const raw of lines) {
    if (blockIndent !== null) {
      // Content of the block scalar above: everything indented deeper than the
      // key that opened it, blank lines included.
      if (isBlank(raw) || indentOf(raw) > blockIndent) {
        if (contentIndent === null && !isBlank(raw)) contentIndent = indentOf(raw);
        // A tab is TEXT once the block's own indentation is behind it (`  a\tb`
        // loads), and a refusal while it is still being measured (`\tx`, and a
        // line shallower than the indent already established). Measured on
        // PyYAML 6.0.1, which scans that indentation with spaces only.
        const tab = raw.indexOf("\t");
        if (tab !== -1 && /^ *$/.test(raw.slice(0, tab)) && (contentIndent === null || tab < contentIndent)) {
          loadable = false;
        }
        continue;
      }
      blockIndent = null;
      contentIndent = null;
    }
    if (open !== null) {
      // A `---` or `...` at column 0 ends the document even from inside a flow
      // scalar — PyYAML's `scan_flow_scalar_breaks` raises "found unexpected
      // document separator" — so these swallowed lines are still worth this one
      // test.
      if (DOC_MARKER_RE.test(raw)) loadable = false;
      const close = closingQuoteIndex(raw, 0, open);
      if (close !== -1) {
        open = null;
        // Past the closing quote the line is structure again, tabs included.
        if (refusesTab(raw.slice(close + 1))) loadable = false;
      }
      continue;
    }
    if (refusesTab(raw)) loadable = false;
    if (/^%/.test(raw)) {
      // A `%YAML` / `%TAG` directive is not content: the `---` that MUST follow
      // it opens THIS document rather than a second one, and PyYAML raises
      // `ParserError` when it is missing.
      sawDirective = true;
      kept.push(raw);
      continue;
    }
    if (DOC_MARKER_RE.test(raw)) {
      // `safe_load` raises on a stream holding more than one document, so a
      // second `---` (or anything after a `...`) is a file that loads nowhere —
      // while this reader, which does not scan the document, would answer the
      // LAST document's value: a different bot, named confidently.
      if (raw.startsWith("---")) {
        if (sawContent) loadable = false;
        sawContent = true;
        sawDirective = false;
      } else {
        documentEnded = true;
      }
    } else if (!isBlank(raw) && !/^ *#/.test(raw)) {
      if (documentEnded || sawDirective) loadable = false;
      sawContent = true;
    }
    kept.push(raw);
    const m = ANY_KEY_RE.exec(raw);
    // A SEQUENCE ITEM is a value position too, and a flow scalar opened there
    // runs over the following lines exactly as a mapping value's does — so a
    // `TELEGRAM_BOT_TOKEN:` line inside one was read as a line of its own and
    // named a decoy as this box's bot, on a document PyYAML loads happily.
    const item = m ? null : SEQ_ITEM_RE.exec(raw);
    const inline = m ? m[2] : item?.[2];
    const value = (inline ?? "").trim();
    if ((m || item) && /^[|>]/.test(value)) {
      // A header PyYAML would raise on is only a refusal in a value position we
      // are SURE of — a key line or a sequence item — never on the loose match
      // below, which is allowed to be wrong about what a line is.
      if (!BLOCK_HEADER_RE.test(value)) loadable = false;
      blockIndent = m ? m[1].length : item![1].length;
      contentIndent = blockHeaderIndent(value) ? blockIndent + blockHeaderIndent(value) : null;
      continue;
    }
    // ...and the openers those two do not model: a tag, an anchor, a key with a
    // `#` or a `:` in it. Skipping only, never a refusal.
    const opener = blockOpenerIndent(raw);
    if (opener !== -1) {
      blockIndent = opener;
      contentIndent = null;
      continue;
    }
    if (!m && !item) continue;
    const quote = value[0];
    if ((quote === '"' || quote === "'") && closingQuoteIndex(value, 1, quote) === -1) {
      open = quote;
    }
  }
  return { lines: kept, unterminated: open !== null, loadable };
}

/**
 * The indent of the document's ROOT mapping — 0 for every file a machine wrote.
 *
 * "A top-level key is a line at column 0" is very nearly true and not quite:
 * YAML lets the whole root mapping sit at one uniform indent, and PyYAML reads
 * `  TELEGRAM_BOT_TOKEN: …\n  other: 1\n` as a top-level key. Anchoring at
 * column 0 answered a confident "this box has no bot" for that file — the same
 * fail-open as missing a quoted key, one spelling further out.
 *
 * The shallowest `key:` line in the file is that indent, because a nested key
 * is by definition deeper than its parent. Only real lines are considered (see
 * {@link documentLines}): block-scalar content sits deeper than the key that
 * opens it, a comment-only line matches nothing here, and a quoted value's
 * continuation is not a line.
 */
function rootIndentWidth(lines: string[]): number {
  let width: number | null = null;
  for (const raw of lines) {
    const m = ANY_KEY_RE.exec(raw);
    if (!m) continue;
    if (m[1].length === 0) return 0;
    if (width === null || m[1].length < width) width = m[1].length;
  }
  return width ?? 0;
}

/** One inline value, as {@link getTopLevelScalar} resolves it. */
function readInlineScalar(inline: string): TopLevelScalar {
  // `KEY:` and `KEY: # note` are both a YAML null, which Hermes' bridge does
  // not export — confidently nothing, not "we could not look".
  if (inline === "" || inline.startsWith("#")) return { value: null, readable: true };
  if (OPAQUE_VALUE_RE.test(inline)) return { value: null, readable: false };
  const split = splitTrailingComment(inline);
  if (!split.closed) return { value: null, readable: false };
  // An escape PyYAML would raise on is a value this reader may not name: the
  // literal text is not what the bridge exports, and inventing one is the
  // confident "no bot" this module exists to close.
  const value = parseYamlScalar(split.value);
  if (value === null) return { value: null, readable: false };
  return { value, readable: true };
}

/**
 * Read a TOP-LEVEL scalar without parsing anything else in the file.
 *
 * {@link getYamlPath} scans the whole enclosing block and REFUSES any shape the
 * line editor does not model — a sequence, a duplicate key somewhere else
 * entirely, a nested block. For an editing pass that refusal is right (it falls
 * back to the CLI). For a reader answering "does this file define KEY", it is
 * not: none of those constructs is evidence about KEY, and treating them as "we
 * could not look" is what a caller then has to turn into a refusal.
 *
 * The one whole-file fact that IS evidence about every key is a document PyYAML
 * will not load, because Hermes' bridge loads config.yaml with PyYAML: when it
 * raises, the bridge exports nothing and the gateway polls no bot, so a token
 * answered out of such a file is a bot that does not exist. That — a second
 * document, and a tab where a token may start — comes back `readable: false`
 * with everything else (see {@link documentLines}).
 *
 * The question is answerable without them, because a top-level key is a line at
 * the ROOT MAPPING'S OWN INDENT — column 0 in every file a machine wrote, and
 * whatever uniform indent a hand-edited one uses (see rootIndentWidth). Quoted
 * spellings count — PyYAML, which is what Hermes' own env
 * bridge loads the file with, reads `"KEY":` and `'KEY':` as the same key, and
 * missing them would answer a confident "not defined" over a defined one. The
 * LAST occurrence wins, as PyYAML's mapping constructor does. A key that opens
 * a nested block reads as no value at all: Hermes' bridge exports only scalars,
 * so there is nothing there for it to export either.
 *
 * What it will NOT do is guess. A value shape it cannot resolve — a block
 * scalar, a tag, an anchor, a flow collection — still reaches the gateway
 * through the bridge, so answering `null` for one would be the same confident
 * "nothing here" that missing a quoted key was. Those come back `readable:
 * false` and the caller degrades instead of deciding.
 */
export function getTopLevelScalar(text: string, key: string): TopLevelScalar {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // A space or the end of the line after the colon, exactly as ANY_KEY_RE and
  // as PyYAML's block-context `check_value`; a tab on either side of the colon
  // makes PyYAML raise on the whole document, so it is not a key line here.
  const line = new RegExp(`^( *)(?:"${escaped}"|'${escaped}'|${escaped}) *:(?: (.*))?$`);
  const { lines, unterminated, loadable } = documentLines(text.split(/\r\n|\r|\n/));
  // A quote that never closes swallows every line after it, and this key's own
  // line may be one of them — "we could not look", never "there is no bot".
  // A document PyYAML refuses outright is the same answer for the same reason:
  // the bridge exports nothing out of it, so nothing in it is evidence about
  // the bot this box polls.
  if (unterminated || !loadable) return { value: null, readable: false };
  const root = rootIndentWidth(lines);
  let found: TopLevelScalar = { value: null, readable: true };
  for (const raw of lines) {
    const m = line.exec(raw);
    // Deeper than the root mapping is somebody else's key — a skills block may
    // legitimately carry its own TELEGRAM_BOT_TOKEN, and the bridge exports
    // only top-level scalars.
    if (!m || m[1].length !== root) continue;
    found = readInlineScalar((m[2] ?? "").trim());
  }
  return found;
}

/**
 * Is the key PRESENT, whatever its value?
 *
 * `getYamlPath` answers `null` both for "no such key" and for a key written with
 * an empty value (`foo:`), and those are different facts: YAML reads the second
 * as a null VALUE, which a reader has to tell apart from an absent key or it
 * silently substitutes its own default for something somebody actually wrote.
 * Only a caller that applies defaults needs this; the editing functions do not.
 */
export function hasYamlPath(text: string, path: string[]): boolean {
  assertPath(path);
  const { lines } = splitLines(text);
  return descend(lines, path).matched.length === path.length;
}

/**
 * Set one dotted path to a scalar, creating any missing parents.
 *
 * Every other line of the file comes through untouched.
 */
export function setYamlPath(text: string, path: string[], value: string): string {
  assertPath(path);
  const { lines, trailingNewline } = splitLines(text);
  const { matched, end, indent } = descend(lines, path);

  if (matched.length === path.length) {
    const leaf = matched[matched.length - 1];
    if (leaf.childEnd > leaf.childStart) {
      // The key currently opens a nested block; replacing it with a scalar
      // would silently delete that subtree.
      throw new YamlEditUnsupported(`${path.join(".")} holds a block, not a scalar`);
    }
    const { comment } = splitTrailingComment(leaf.inline);
    const pad = " ".repeat(indentOf(lines[leaf.line]));
    const next = [...lines];
    next[leaf.line] = `${pad}${path[path.length - 1]}: ${formatYamlScalar(value)}${comment}`;
    return joinLines(next, trailingNewline);
  }

  // Missing tail: emit it as a fresh nested block, inserted at the end of the
  // deepest block that does exist (before that block's trailing comments).
  const missing = path.slice(matched.length);
  const block: string[] = [];
  missing.forEach((segment, i) => {
    const pad = " ".repeat(indent + i * INDENT_STEP.length);
    block.push(
      i === missing.length - 1
        ? `${pad}${segment}: ${formatYamlScalar(value)}`
        : `${pad}${segment}:`,
    );
  });

  const next = [...lines];
  next.splice(end, 0, ...block);
  return joinLines(next, trailingNewline);
}

/**
 * Remove one dotted path, then prune any parent it just emptied.
 *
 * Pruning matters: `hermes config unset` drops the whole `providers:` block
 * when its last child goes, and a stranded `providers:` with no children reads
 * back as null, which is not the same config.
 */
export function unsetYamlPath(text: string, path: string[]): string {
  assertPath(path);
  const { lines, trailingNewline } = splitLines(text);
  const { matched } = descend(lines, path);
  if (matched.length !== path.length) return text; // already absent

  const next = [...lines];
  let victim = matched[matched.length - 1];
  let from = victim.line;
  let to = Math.max(victim.childEnd, victim.line + 1);

  // Walk up while removing the child leaves the parent with no content of its
  // own. `depth` indexes `matched`, so matched[depth - 1] is the parent.
  for (let depth = matched.length - 1; depth > 0; depth -= 1) {
    const parent = matched[depth - 1];
    let siblingContent = false;
    for (let i = parent.childStart; i < parent.childEnd; i += 1) {
      if (i >= from && i < to) continue;
      if (!isSkippable(next[i])) {
        siblingContent = true;
        break;
      }
    }
    if (siblingContent) break;
    victim = parent;
    from = parent.line;
    to = Math.max(parent.childEnd, parent.line + 1);
  }

  next.splice(from, to - from);
  return joinLines(next, trailingNewline);
}
