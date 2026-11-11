import fs from "node:fs";
import path from "node:path";

/**
 * A reader for the shipped shell that the static installer guards share: the
 * files, one logical command line at a time, function bodies, and the calls
 * that go through a wrapper. It is a reader, not a shell: where it cannot see
 * the end of a construct it throws, so a guard never reads "nothing found" off
 * a file it lost its place in.
 */

const REPO = path.resolve(__dirname, "../../..");

/** A heredoc opener and its delimiter word, quoted (group 2 or 3) or bare (group 4). */
const HEREDOC = /^<<(-?)\s*(?:'([^']*)'|"([^"]*)"|\\?([^\s;&|<>()'"`]+))/;
/**
 * A command that reads its script from the heredoc: a shell as the last word
 * before `<<`, with options but no `-c` (`bash -c '…' <<EOF` reads data).
 */
const FEEDS_SHELL = /(?:^|[\s;&|(!`])(?:\S*\/)?(?:ba|da)?sh(?:\s+-(?!c\b)[A-Za-z]+)*\s*$/;
/** A function head: `name()`, `function name`; its opener `{` or `(` (group 3) and the rest of the line (group 4). */
const FUNCTION_HEAD =
  /^\s*(?:function\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(\))?|([A-Za-z_][A-Za-z0-9_]*)\s*\(\))\s*(?:([{(])([\s\S]*))?$/;
/** The caller's arguments: `$@`, `$*`, `$1`…`$9`, `${@}`, `${@:2}`, `${1}`. */
const CALLER_ARGS = /\$\{?(?:[@*]|[1-9])/;
/** An array filled in place, `arr=(…)` or `arr+=(…)`: the name is group 1, the contents group 2. */
export const ARRAY_FILL = /([A-Za-z_][A-Za-z0-9_]*)\+?=\(([^)]*)\)/g;
/** An array expanded whole, `${arr[@]}`: the name is group 1. */
export const ARRAY_EXPANSION = /\$\{([A-Za-z_][A-Za-z0-9_]*)\[[@*]\]\}/g;

export interface Line {
  lineNo: number;
  text: string;
}

type Context =
  | { kind: "'" | '"' | "$'" | "`"; at: number }
  | { kind: "$(" | "(("; at: number; depth: number };

interface Pending {
  word: string;
  strip: boolean;
  at: number;
  feedsShell: boolean;
  /** `<<'EOF'`, `<<"EOF"` or `<<\EOF`: the body is not expanded. */
  quoted: boolean;
  body: string[];
}

export interface ReadOptions {
  /**
   * Also yield the command substitutions in the body of an unquoted heredoc that
   * no shell reads (`cat <<EOF … $(cmd) … EOF`): the shell that opens the heredoc
   * runs them as it expands the body. Off by default; the root-runs guard turns
   * it on.
   */
  heredocSubstitutions?: boolean;
}

/** Where `$(…)` opened before `from` closes: the index of its `)`, or -1. */
function substitutionEnd(text: string, from: number): number {
  let depth = 0;
  let quote: "'" | '"' | null = null;
  for (let j = from; j < text.length; j += 1) {
    const c = text[j];
    if (quote === "'") {
      if (c === "'") quote = null;
      continue;
    }
    if (c === "\\") {
      j += 1;
      continue;
    }
    if (c === "$" && text[j + 1] === "(") {
      const end = substitutionEnd(text, j + 2);
      if (end < 0) return -1;
      j = end;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === "(") depth += 1;
    else if (c === ")") {
      if (!depth) return j;
      depth -= 1;
    }
  }
  return -1;
}

/**
 * The command substitutions in an unquoted heredoc body, each as the logical
 * lines of its command. The body's own text is data, quotes included; only
 * `$(…)` and backquotes run, and a backslash before `$` or a backquote keeps it
 * literal. `$((…))` is arithmetic and is passed over.
 */
function heredocSubstitutions(body: string, file: string, firstLine: number, options: ReadOptions): Line[] {
  const out: Line[] = [];
  const lineOf = (at: number): number => firstLine + (body.slice(0, at).match(/\n/g)?.length ?? 0);
  for (let j = 0; j < body.length; j += 1) {
    const c = body[j];
    if (c === "\\") {
      j += 1;
      continue;
    }
    if (c === "$" && body[j + 1] === "(" && body[j + 2] === "(") {
      j += 2;
      continue;
    }
    let inner: string | null = null;
    let end = j;
    if (c === "$" && body[j + 1] === "(") {
      end = substitutionEnd(body, j + 2);
      if (end >= 0) inner = body.slice(j + 2, end);
    } else if (c === "`") {
      end = body.indexOf("`", j + 1);
      while (end > 0 && body[end - 1] === "\\") end = body.indexOf("`", end + 1);
      if (end >= 0) inner = body.slice(j + 1, end);
    } else continue;
    if (inner === null) {
      throw new Error(
        `${file}:${lineOf(j)}: ${c === "`" ? "`" : "$("} in a heredoc never closes for this reader: ` +
          "check the quoting there, or teach src/tests/helpers/shell-reader.ts the construct",
      );
    }
    out.push(...logicalLines(inner, file, lineOf(j) - 1, options));
    j = end;
  }
  return out;
}

/**
 * The file one command line at a time, as bash reads it: backslash
 * continuations and newlines inside quotes, `$(…)`, `$((…))` or backquotes are
 * joined, comments dropped. Quoting nests the way bash nests it, so `'…"…'`
 * inside `"$(…)"` does not end the outer string, and `<<` inside arithmetic is
 * a shift. A heredoc body is dropped, unless its command is a shell: then it is
 * read as shell too (see ReadOptions for the substitutions of the rest). A
 * reader that loses its place throws rather than skipping the rest of the
 * file, which would read as "nothing found".
 */
export function logicalLines(text: string, file: string, offset = 0, options: ReadOptions = {}): Line[] {
  const out: Line[] = [];
  const lines = text.split("\n");
  const stack: Context[] = [];
  let heredocs: Pending[] = [];
  let buf = "";
  let start = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (heredocs.length) {
      const [next] = heredocs;
      if ((next.strip ? raw.replace(/^\t+/, "") : raw) === next.word) {
        heredocs.shift();
        if (next.feedsShell) out.push(...logicalLines(next.body.join("\n"), file, offset + next.at, options));
        else if (options.heredocSubstitutions && !next.quoted) {
          out.push(...heredocSubstitutions(next.body.join("\n"), file, offset + next.at + 1, options));
        }
      } else {
        next.body.push(raw);
      }
      continue;
    }
    if (!buf && !stack.length) start = i + 1;
    let code = "";
    let continued = false;
    const opened: Pending[] = [];
    for (let j = 0; j < raw.length; j += 1) {
      const c = raw[j];
      const top = stack[stack.length - 1];
      const kind = top ? top.kind : "code";
      if (kind === "'") {
        code += c;
        if (c === "'") stack.pop();
        continue;
      }
      if (c === "\\") {
        if (kind !== "$'" && j === raw.length - 1) {
          continued = true;
          break;
        }
        code += c + (raw[j + 1] ?? "");
        j += 1;
        continue;
      }
      if (kind === "$'") {
        code += c;
        if (c === "'") stack.pop();
        continue;
      }
      if (c === "$" && raw[j + 1] === "(") {
        const arithmetic = raw[j + 2] === "(";
        stack.push({ kind: arithmetic ? "((" : "$(", at: i + 1, depth: 0 });
        code += arithmetic ? "$((" : "$(";
        j += arithmetic ? 2 : 1;
        continue;
      }
      if (c === "`") {
        if (kind === "`") stack.pop();
        else stack.push({ kind: "`", at: i + 1 });
        code += c;
        continue;
      }
      if (kind === '"') {
        code += c;
        if (c === '"') stack.pop();
        continue;
      }
      if (top?.kind === "((") {
        // Arithmetic: `<<` is a shift and nothing here is quoted or commented.
        if (c === "(") top.depth += 1;
        if (c === ")") {
          if (top.depth) top.depth -= 1;
          else {
            stack.pop();
            if (raw[j + 1] === ")") {
              code += ")";
              j += 1;
            }
          }
        }
        code += c;
        continue;
      }
      // Unquoted: top level, inside `$(…)` or inside backquotes.
      if (c === "#" && (j === 0 || /[\s;&|(]/.test(raw[j - 1]))) break;
      if (c === "'" || c === '"') {
        stack.push({ kind: c, at: i + 1 });
        code += c;
        continue;
      }
      if (c === "$" && raw[j + 1] === "'") {
        stack.push({ kind: "$'", at: i + 1 });
        code += "$'";
        j += 1;
        continue;
      }
      if (c === "(" && raw[j + 1] === "(") {
        stack.push({ kind: "((", at: i + 1, depth: 0 });
        code += "((";
        j += 1;
        continue;
      }
      if (top?.kind === "$(" && c === "(") top.depth += 1;
      if (top?.kind === "$(" && c === ")") {
        if (top.depth) top.depth -= 1;
        else stack.pop();
      }
      if (c === "<" && raw[j + 1] === "<" && raw[j + 2] !== "<" && raw[j - 1] !== "<") {
        const opener = HEREDOC.exec(raw.slice(j));
        if (opener) {
          const word = opener[2] ?? opener[3] ?? opener[4];
          opened.push({
            word,
            strip: opener[1] === "-",
            at: i + 1,
            feedsShell: FEEDS_SHELL.test(buf + code),
            quoted: opener[4] === undefined || opener[0].includes("\\"),
            body: [],
          });
          code += opener[0];
          j += opener[0].length - 1;
          continue;
        }
      }
      code += c;
    }
    // A heredoc body starts on the next line even inside an open `$(…)`.
    heredocs = opened;
    // A continuation joins with a space inside an open `$(…)` too: there it
    // is not the newline that would end a command.
    if (continued) {
      buf += `${code} `;
      continue;
    }
    if (stack.length) {
      buf += `${code}\n`;
      continue;
    }
    const line = buf + code;
    buf = "";
    if (line.trim()) out.push({ lineNo: offset + start, text: line });
  }
  const where = (at: number): string => `${file}:${offset + at}`;
  const next = "check the quoting there, or teach src/tests/helpers/shell-reader.ts the construct";
  if (stack.length) throw new Error(`${where(stack[0].at)}: ${stack[0].kind} never closes for this reader: ${next}`);
  if (heredocs.length) {
    throw new Error(`${where(heredocs[0].at)}: heredoc ${heredocs[0].word} never closes for this reader: ${next}`);
  }
  return out;
}

/** The contents of the single-quoted strings in `text`, as `[start, end)` offsets; a `'` inside `"…"` opens none. */
export function singleQuotedSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  let state: "code" | "'" | '"' = "code";
  let from = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (state === "'") {
      if (c === "'") {
        spans.push([from, i]);
        state = "code";
      }
      continue;
    }
    if (c === "\\") {
      i += 1;
      continue;
    }
    if (state === '"' && c === '"') state = "code";
    else if (state === "code" && c === '"') state = '"';
    else if (state === "code" && c === "'") {
      state = "'";
      from = i + 1;
    }
  }
  if (state === "'") spans.push([from, text.length]);
  return spans;
}

/** `text` with the contents of single-quoted strings blanked: nothing in them is expanded. */
export function blankSingleQuoted(text: string): string {
  const out = text.split("");
  for (const [start, end] of singleQuotedSpans(text)) out.fill(" ", start, end);
  return out.join("");
}

/**
 * The words of the wrapper's own command, up to the first `;`, `|` or `&`
 * outside quotes and substitutions, with quote characters removed. A word that
 * opens with a single quote is literal text, a program more often than not.
 */
export function ownWords(rest: string): { text: string; literal: boolean }[] {
  const words: { text: string; literal: boolean }[] = [];
  const stack: string[] = [];
  let current = "";
  let literal = false;
  let started = false;
  const end = (): void => {
    if (started) words.push({ text: current, literal });
    current = "";
    literal = false;
    started = false;
  };
  for (let i = 0; i < rest.length; i += 1) {
    const c = rest[i];
    const top = stack[stack.length - 1];
    if (top === "'") {
      if (c === "'") stack.pop();
      else current += c;
      continue;
    }
    if (c === "\\") {
      current += rest[i + 1] ?? "";
      started = true;
      i += 1;
      continue;
    }
    if (c === "$" && rest[i + 1] === "(") {
      stack.push(")");
      current += "$(";
      started = true;
      i += 1;
      continue;
    }
    if (top === '"') {
      if (c === '"') stack.pop();
      else current += c;
      continue;
    }
    if (c === "'" || c === '"') {
      if (!started) literal = c === "'";
      started = true;
      stack.push(c);
      continue;
    }
    if (top === ")") {
      if (c === "(") stack.push(")");
      else if (c === ")") stack.pop();
      current += c;
      continue;
    }
    if (/\s/.test(c)) {
      end();
      continue;
    }
    if (c === ";" || c === "|" || c === "&") break;
    current += c;
    started = true;
  }
  end();
  return words;
}

/** A single-quoted string that can only be a command word: a name or a path, nothing to expand. */
const QUOTED_COMMAND = /^[A-Za-z0-9_./-]+$/;

/**
 * Every call through `wrapper` on a line, each with its own text: up to the
 * next call. The calls of the line itself are found with its single-quoted
 * strings blanked (which keeps every offset), so a wrapper's name inside one
 * never cuts an outer call's text short. A single-quoted string is often a
 * program a shell runs (`trap '…'`, `bash -c '…'`, a variable that holds one),
 * so each is read for calls too, every call up to the next one in it or its
 * closing quote.
 */
export function wrapperCalls(text: string, wrapper: RegExp): { name: string; rest: string }[] {
  const re = new RegExp(wrapper.source, "g");
  const spans = singleQuotedSpans(text);
  const calls: { at: number; name: string; rest: string }[] = [];
  /** The calls found in `searched`, which is text[from…] as written or with strings blanked. */
  const read = (searched: string, from: number): void => {
    const found = [...searched.matchAll(re)];
    found.forEach((m, n) => {
      const at = from + (m.index ?? 0);
      calls.push({ at, name: m[1], rest: text.slice(at + m[0].length, from + (found[n + 1]?.index ?? searched.length)) });
    });
  };
  // A quoted word that is only a command name (`'sudo' -n …`) is that command, so it is not blanked.
  const line = text.split("");
  for (const [start, end] of spans) if (!QUOTED_COMMAND.test(text.slice(start, end))) line.fill(" ", start, end);
  read(line.join(""), 0);
  for (const [start, end] of spans) read(text.slice(start, end), start);
  return calls.sort((a, b) => a.at - b.at).map(({ name, rest }) => ({ name, rest }));
}


const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A call through one of `names`, `su`, or a variable or array holding one of
 * them (`holders`). Group 1 names it. Every name is escaped, and each is a
 * shell name read from this repository's own scripts.
 */
export function wrapperPattern(names: Set<string>, holders: Set<string> = new Set()): RegExp {
  const alternatives = [
    ...[...names].map(escapeRe),
    "su",
    ...[...holders].flatMap((h) => [`\\$\\{${escapeRe(h)}\\[[@*]\\]\\}`, `\\$\\{?${escapeRe(h)}\\}?`]),
  ].join("|");
  return new RegExp(`(?:^|[\\s;&|(\`!{"'/\\\\])(${alternatives})["']?(?=\\s)`);
}

const indentOf = (text: string): number => /^\s*/.exec(text)?.[0].length ?? 0;

export interface FunctionDef {
  name: string;
  /** The function's own body lines: up to its closer, without the bodies of functions defined inside it. */
  body: string[];
}

export function functionDefs(lines: Line[]): FunctionDef[] {
  const defs: FunctionDef[] = [];
  lines.forEach((line, k) => {
    const head = FUNCTION_HEAD.exec(line.text);
    if (!head) return;
    const name = head[1] ?? head[2];
    let opener = head[3];
    let rest = head[4] ?? "";
    let from = k + 1;
    if (!opener) {
      // `name()` alone, its `{` on the next line.
      const next = lines[k + 1]?.text.trimStart() ?? "";
      if (next[0] !== "{" && next[0] !== "(") return;
      opener = next[0];
      rest = next.slice(1);
      from = k + 2;
    }
    const closer = opener === "{" ? "}" : ")";
    const oneLiner = (text: string, close: string): boolean => new RegExp(`\\${close}\\s*;?\\s*$`).test(text);
    const body = [rest];
    if (!oneLiner(rest, closer)) {
      const indent = indentOf(line.text);
      let nested: { indent: number; closer: string } | null = null;
      for (const inner of lines.slice(from)) {
        const trimmed = inner.text.trim();
        if (nested) {
          if (trimmed === nested.closer && indentOf(inner.text) <= nested.indent) nested = null;
          continue;
        }
        if (trimmed === closer && indentOf(inner.text) <= indent) break;
        // A function defined inside this one is judged on its own.
        const innerHead = FUNCTION_HEAD.exec(inner.text);
        if (innerHead) {
          const innerCloser = innerHead[3] === "(" ? ")" : "}";
          if (innerHead[3] && !oneLiner(innerHead[4], innerCloser)) {
            nested = { indent: indentOf(inner.text), closer: innerCloser };
          }
          continue;
        }
        body.push(inner.text);
      }
    }
    defs.push({ name, body });
  });
  return defs;
}

/**
 * sudo, the installers' own sudo helpers, and every function that passes its
 * own arguments on through one of them or `su`, directly, by position or
 * through an array filled from them: their call sites are sudo command lines
 * too. Given `seeds`, the same closure over those names instead.
 */
export function sudoWrappers(
  defs: FunctionDef[],
  seeds: Iterable<string> = ["sudo", "as_clawbox", "as_clawbox_login", "as_user", "as_user_runtime", "oc_config_set"],
): Set<string> {
  const names = new Set(seeds);
  for (let grew = true; grew; ) {
    grew = false;
    const wrapper = wrapperPattern(names);
    for (const { name, body } of defs) {
      if (names.has(name)) continue;
      const argArrays = new Set(
        body.flatMap((text) => [...text.matchAll(ARRAY_FILL)].filter((a) => CALLER_ARGS.test(a[2])).map((a) => a[1])),
      );
      const forwards = body.some((text) =>
        wrapperCalls(text, wrapper).some(
          ({ rest }) => CALLER_ARGS.test(rest) || [...rest.matchAll(ARRAY_EXPANSION)].some((a) => argArrays.has(a[1])),
        ),
      );
      if (forwards) {
        names.add(name);
        grew = true;
      }
    }
  }
  return names;
}

/** install.sh, install-x64.sh and every shell script under scripts/ and config/, with or without a `.sh` name. */
export function shellFiles(root = REPO): string[] {
  const found = ["install.sh", "install-x64.sh"].filter((f) => fs.existsSync(path.join(root, f)));
  const walk = (dir: string): void => {
    if (!fs.existsSync(path.join(root, dir))) return;
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (!entry.isFile()) continue;
      else if (entry.name.endsWith(".sh")) found.push(rel);
      else if (!entry.name.includes(".")) {
        const firstLine = fs.readFileSync(path.join(root, rel), "utf-8").split("\n", 1)[0];
        if (/^#!.*\b(?:ba|da)?sh\b/.test(firstLine)) found.push(rel);
      }
    }
  };
  walk("scripts");
  walk("config");
  return found;
}
