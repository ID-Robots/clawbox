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
 * sequences, quoted or duplicate keys, tab indentation, multi-document files —
 * raises {@link YamlEditUnsupported} rather than guessing. Callers are expected
 * to fall back to the Hermes CLI on that signal: losing the comments is bad,
 * corrupting the config is worse.
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

/** Value text plus any trailing `# comment` we must preserve when rewriting. */
function splitTrailingComment(inline: string): { value: string; comment: string } {
  if (inline.startsWith('"') || inline.startsWith("'")) {
    // A `#` inside a quoted scalar is data, not a comment. Not worth parsing
    // quoting rules for: the caller replaces the whole value anyway.
    return { value: inline, comment: "" };
  }
  const m = /^(.*?)(\s+#.*)$/.exec(inline);
  if (!m) return { value: inline, comment: "" };
  return { value: m[1].trimEnd(), comment: m[2] };
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

/** Inverse of {@link formatYamlScalar}, good enough to read our own writes back. */
function parseYamlScalar(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
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
  return parseYamlScalar(splitTrailingComment(leaf.inline).value);
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
