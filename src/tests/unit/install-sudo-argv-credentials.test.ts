import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * No credential-named variable on a sudo command line in the shipped shell:
 * install.sh, install-x64.sh, and every shell script under scripts/ and
 * config/. sudo records its command line, so a credential reaches a command
 * through a file the command reads itself, or on stdin, and only a path goes on
 * the command line.
 *
 * The rule reads NAMES: a variable or `NAME=` assignment whose name says token,
 * secret, password, key, auth, cookie and the like, unless the name ends in
 * _FILE, _PATH or _DIR. A value under a name that says nothing is out of its
 * reach, so review still matters. systemd units are not shell and are not read.
 */

const REPO = path.resolve(__dirname, "../../..");

/** Fragments that mean a credential wherever they sit in a name. */
const STRONG_FRAGMENT = /TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|BEARER|COOKIE|JWT|APIKEY/i;
/** Fragments that mean a credential only as a whole part of a name: KEY, not KEYBOARD. */
const WEAK_PARTS = new Set(["KEY", "AUTH", "PASS", "PSK", "CRED", "CREDS"]);
/** A name for where a credential lives, which is what belongs on a command line. */
const PATH_NAME = /_(?:FILE|PATH|DIR)$|[a-z0-9](?:File|Path|Dir)$/i;

function credentialName(name: string): boolean {
  if (PATH_NAME.test(name)) return false;
  if (STRONG_FRAGMENT.test(name)) return true;
  const parts = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase().split("_");
  return parts.some((part) => WEAK_PARTS.has(part));
}

/** `$NAME` and `${NAME…}`; `$(…)` and positional `$1` are not names. */
const VAR_REF = /\$\{?([A-Za-z_][A-Za-z0-9_]*)/g;
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
const ARRAY_FILL = /([A-Za-z_][A-Za-z0-9_]*)\+?=\(([^)]*)\)/g;
/** An array expanded whole, `${arr[@]}`: the name is group 1. */
const ARRAY_EXPANSION = /\$\{([A-Za-z_][A-Za-z0-9_]*)\[[@*]\]\}/g;
/** A variable or array that holds a command: `NAME="cmd …"`, `NAME=(cmd …)`; the name is group 1, the command group 2. */
const COMMAND_HOLDER = /(?:^|[\s;&(])([A-Za-z_][A-Za-z0-9_]*)=\(?\s*["']?(?:\S*\/)?([A-Za-z_][A-Za-z0-9_]*)(?=[\s"')]|$)/g;
const ASSIGNMENT_WORD = /^([A-Za-z_][A-Za-z0-9_]*)=/;

interface Allowed {
  file: string;
  /** A substring of the logical line, not a line number: line numbers move. */
  line: string;
  /** The credential-named variables the line carries, so a new one on it is not waved through. */
  names: string[];
  reason: string;
  /** YYYY-MM-DD; past it the entry fails, so it is fixed or renewed with a reason. */
  expires: string;
}

/** Each entry needs a reason, an expiry date and exactly one live line. */
const ALLOWED: Allowed[] = [];

interface Line {
  lineNo: number;
  text: string;
}

interface Hit {
  file: string;
  lineNo: number;
  wrapper: string;
  names: string[];
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
  body: string[];
}

/**
 * The file one command line at a time, as bash reads it: backslash
 * continuations and newlines inside quotes, `$(…)`, `$((…))` or backquotes are
 * joined, comments dropped. Quoting nests the way bash nests it, so `'…"…'`
 * inside `"$(…)"` does not end the outer string, and `<<` inside arithmetic is
 * a shift. A heredoc body is dropped, unless its command is a shell: then it is
 * read as shell too. A reader that loses its place throws rather than skipping
 * the rest of the file, which would read as "nothing found".
 */
function logicalLines(text: string, file: string, offset = 0): Line[] {
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
        if (next.feedsShell) out.push(...logicalLines(next.body.join("\n"), file, offset + next.at));
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
          opened.push({ word, strip: opener[1] === "-", at: i + 1, feedsShell: FEEDS_SHELL.test(buf + code), body: [] });
          code += opener[0];
          j += opener[0].length - 1;
          continue;
        }
      }
      code += c;
    }
    // A heredoc body starts on the next line even inside an open `$(…)`.
    heredocs = opened;
    if (stack.length) {
      buf += `${code}\n`;
      continue;
    }
    if (continued) {
      buf += `${code} `;
      continue;
    }
    const line = buf + code;
    buf = "";
    if (line.trim()) out.push({ lineNo: offset + start, text: line });
  }
  const where = (at: number): string => `${file}:${offset + at}`;
  if (stack.length) throw new Error(`${where(stack[0].at)}: ${stack[0].kind} never closes for this reader`);
  if (heredocs.length) throw new Error(`${where(heredocs[0].at)}: heredoc ${heredocs[0].word} never closes for this reader`);
  return out;
}

/** `text` with the contents of single-quoted strings blanked: nothing in them is expanded. */
function blankSingleQuoted(text: string): string {
  let out = "";
  let state: "code" | "'" | '"' = "code";
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (state === "'") {
      if (c === "'") state = "code";
      out += c === "'" ? c : " ";
      continue;
    }
    if (c === "\\") {
      out += c + (text[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (state === '"' && c === '"') state = "code";
    else if (state === "code" && (c === "'" || c === '"')) state = c;
    out += c;
  }
  return out;
}

/**
 * The words of the wrapper's own command, up to the first `;`, `|` or `&`
 * outside quotes and substitutions, with quote characters removed. A word that
 * opens with a single quote is literal text, a program more often than not.
 */
function ownWords(rest: string): { text: string; literal: boolean }[] {
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

/** The credential names a stretch of command text carries: `NAME=` words of its own command, and `$NAME` references. */
function credentialsIn(rest: string): string[] {
  const assigned = ownWords(rest)
    .filter((w) => !w.literal)
    .map((w) => ASSIGNMENT_WORD.exec(w.text)?.[1])
    .filter((n): n is string => !!n);
  const referenced = [...blankSingleQuoted(rest).matchAll(VAR_REF)].map((m) => m[1]);
  return [...assigned, ...referenced].filter(credentialName);
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A call through one of `names`, `su`, or a variable or array holding one of
 * them (`holders`). Group 1 names it. Every name is escaped, and each is a
 * shell name read from this repository's own scripts.
 */
function wrapperPattern(names: Set<string>, holders: Set<string> = new Set()): RegExp {
  const alternatives = [
    ...[...names].map(escapeRe),
    "su",
    ...[...holders].flatMap((h) => [`\\$\\{${escapeRe(h)}\\[[@*]\\]\\}`, `\\$\\{?${escapeRe(h)}\\}?`]),
  ].join("|");
  return new RegExp(`(?:^|[\\s;&|(\`!{"'/\\\\])(${alternatives})["']?(?=\\s)`);
}

const indentOf = (text: string): number => /^\s*/.exec(text)?.[0].length ?? 0;

interface FunctionDef {
  name: string;
  /** The function's own body lines: up to its closer, without the bodies of functions defined inside it. */
  body: string[];
}

function functionDefs(lines: Line[]): FunctionDef[] {
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
 * too.
 */
function sudoWrappers(defs: FunctionDef[]): Set<string> {
  const names = new Set(["sudo", "as_clawbox", "as_clawbox_login", "as_user", "as_user_runtime", "oc_config_set"]);
  for (let grew = true; grew; ) {
    grew = false;
    const wrapper = wrapperPattern(names);
    for (const { name, body } of defs) {
      if (names.has(name)) continue;
      const argArrays = new Set(
        body.flatMap((text) => [...text.matchAll(ARRAY_FILL)].filter((a) => CALLER_ARGS.test(a[2])).map((a) => a[1])),
      );
      const forwards = body.some((text) => {
        const call = wrapper.exec(text);
        if (!call) return false;
        const rest = text.slice(call.index + call[0].length);
        return CALLER_ARGS.test(rest) || [...rest.matchAll(ARRAY_EXPANSION)].some((a) => argArrays.has(a[1]));
      });
      if (forwards) {
        names.add(name);
        grew = true;
      }
    }
  }
  return names;
}

function scan(sources: { file: string; text: string }[]): { wrappers: Set<string>; calls: number; hits: Hit[] } {
  const read = sources.map(({ file, text }) => ({ file, lines: logicalLines(text, file) }));
  const all = read.flatMap(({ lines }) => lines);
  const wrappers = sudoWrappers(read.flatMap(({ lines }) => functionDefs(lines)));
  const named = wrapperPattern(wrappers);
  // Variables and arrays that hold a sudo command, and arrays filled with a credential.
  const holders = new Set<string>();
  const credentialArrays = new Map<string, string[]>();
  for (const { text } of all) {
    for (const m of text.matchAll(COMMAND_HOLDER)) if (wrappers.has(m[2]) || m[2] === "su") holders.add(m[1]);
    for (const m of text.matchAll(ARRAY_FILL)) {
      const names = credentialsIn(m[2]);
      if (names.length) credentialArrays.set(m[1], [...(credentialArrays.get(m[1]) ?? []), ...names]);
    }
  }
  const wrapper = holders.size ? wrapperPattern(wrappers, holders) : named;
  const hits: Hit[] = [];
  let calls = 0;
  for (const { file, lines } of read) {
    for (const { lineNo, text } of lines) {
      const call = wrapper.exec(text);
      if (!call) continue;
      calls += 1;
      const rest = text.slice(call.index + call[0].length);
      const fromArrays = [...rest.matchAll(ARRAY_EXPANSION)].flatMap((m) => credentialArrays.get(m[1]) ?? []);
      const names = [...new Set([...credentialsIn(rest), ...fromArrays])];
      if (names.length) hits.push({ file, lineNo, wrapper: call[1], names, text: text.trim() });
    }
  }
  return { wrappers, calls, hits };
}

/** install.sh, install-x64.sh and every shell script under scripts/ and config/, with or without a `.sh` name. */
function shellFiles(root = REPO): string[] {
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

const tree = (): { wrappers: Set<string>; calls: number; hits: Hit[] } =>
  scan(shellFiles().map((file) => ({ file, text: fs.readFileSync(path.join(REPO, file), "utf-8") })));

const allowedFor = (hit: Hit): Allowed | undefined =>
  ALLOWED.find((a) => a.file === hit.file && hit.text.includes(a.line));

describe("no credential-named variable reaches a sudo command line in the shipped shell", () => {
  let fixture: string;

  beforeEach(() => {
    fixture = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-shell-files-"));
  });

  afterEach(() => {
    fs.rmSync(fixture, { recursive: true, force: true });
  });

  it("reads install.sh, install-x64.sh and the shell under scripts/ and config/, named .sh or not", () => {
    const put = (rel: string, text: string): void => {
      fs.mkdirSync(path.dirname(path.join(fixture, rel)), { recursive: true });
      fs.writeFileSync(path.join(fixture, rel), text);
    };
    put("install.sh", "#!/bin/bash\n");
    put("scripts/a.sh", "true\n");
    put("scripts/deep/b", "#!/usr/bin/env bash\n");
    put("scripts/c", "#!/usr/bin/python3\n");
    put("scripts/d.py", "#!/bin/sh\n");
    put("config/e.sh", "true\n");
    put("config/f.service", "[Unit]\n");
    put("other/g.sh", "true\n");

    expect(shellFiles(fixture).sort()).toEqual(["config/e.sh", "install.sh", "scripts/a.sh", "scripts/deep/b"]);
  });

  it("finds sudo calls in the tree, so an empty result means something", () => {
    const { calls, wrappers } = tree();
    expect(shellFiles()).toEqual(expect.arrayContaining(["install.sh", "install-x64.sh"]));
    expect(calls).toBeGreaterThan(100);
    expect(wrappers.has("as_clawbox")).toBe(true);
  });

  it("finds the shapes it exists for", () => {
    const sample = [
      `as_clawbox env TG_TOKEN="$TG_TOKEN" CFG="$CFG" node - <<'NODE'`,
      "console.log(process.env.TG_TOKEN)",
      "NODE",
      'as_user "$BIN" config set gateway.auth.token "${GW_TOKEN}"',
      "sudo -u clawbox env \\",
      '  API_KEY="$api_key" tool',
      'su - clawbox -c "tool --password $PASSWORD"',
      'oc_config_set some.path "$CLAWBOX_AI_KEY"',
      "x=$(as_clawbox python3 -c '",
      "print(1)",
      `' "$TG_TOKEN")`,
      'bash -c "sudo -u clawbox tool $BOT_TOKEN"',
      '/usr/bin/sudo -u clawbox env SESSION_SECRET="$SESSION_SECRET" tool',
      "# a comment that ends in a backslash does not continue \\",
      'as_clawbox tool "$OTHER_SECRET"',
      'echo "a <<NODE inside a string opens nothing"',
      'as_clawbox tool "$THIRD_SECRET"',
      'v="$(sed -n \'s/"\\{0,1\\}x//p\' "$f")"',
      'as_clawbox tool "$FOURTH_SECRET"',
      "pass_on() {",
      '  as_clawbox tool "$@"',
      "}",
      'pass_on "$DB_PASSWORD"',
      'one_line() { as_clawbox env HOME="$HOME" tool "$@"; }',
      'one_line "$SIGNING_KEY"',
      'su clawbox -c "tool $ROOT_PASS"',
      'as_clawbox env TG_TOKEN="$tg" tool',
      'as_clawbox env TG_TOKEN="$(cat "$f")" tool',
      "function braced {",
      '  sudo -u clawbox tool "${@:2}"',
      "}",
      'braced x "$API_TOKEN"',
      "through_array() {",
      '  local args=("$@")',
      '  as_clawbox tool "${args[@]}"',
      "}",
      'through_array "$WIFI_PSK"',
      'as_clawbox env "QUOTED_TOKEN=$tg" node -',
      'first_arg() { as_clawbox tool "$1"; }',
      'first_arg "$FIRST_SECRET"',
      'cmd=(env ARRAY_TOKEN="$t" node -)',
      'as_clawbox "${cmd[@]}"',
      'SUDO="sudo -u clawbox"',
      '$SUDO tool "$HELD_SECRET"',
      "run=(sudo -u clawbox)",
      '"${run[@]}" tool "$HELD_ARRAY_SECRET"',
      '\\sudo -u clawbox tool "$ESCAPED_SECRET"',
      "next_line_brace()",
      "{",
      '  as_clawbox tool "$@"',
      "}",
      'next_line_brace "$BRACE_SECRET"',
      "subshell_body() (",
      '  as_clawbox tool "$@"',
      ")",
      'subshell_body "$SUBSHELL_SECRET"',
      "bash <<EOF",
      "sudo -u clawbox tool $HEREDOC_SECRET",
      "EOF",
      "n=$(( 1 << bits ))",
      'as_clawbox tool "$AFTER_SHIFT_SECRET"',
      "bits",
      "cat <<'END-SCRIPT'",
      "it's a body with an apostrophe",
      "END-SCRIPT",
      'as_clawbox tool "$AFTER_DASHED_SECRET"',
      // Clean: a comment, paths only, a key on stdin, an option name, a
      // separate command, an array of the function's own, a function that only
      // defines a forwarder inside itself, names for where a credential lives,
      // names that only look like one, and a single-quoted program.
      '# as_clawbox env TG_TOKEN="$TG_TOKEN"',
      'as_clawbox env CFG="$CLAWBOX_CONFIG" node -',
      'printf "%s\\n" "$KEY" | as_clawbox tool --from-stdin',
      "as_clawbox tool --api-key=from-a-file",
      "as_clawbox tool; SESSION_TOKEN=x other",
      "own_array() {",
      "  local opts=(--quiet)",
      '  as_clawbox tool "${opts[@]}"',
      "}",
      'own_array "$WIFI_PASS"',
      "outer() {",
      "  inner() {",
      '    as_clawbox tool "$@"',
      "  }",
      "  inner fixed",
      "}",
      'outer "$SESSION_COOKIE"',
      'as_clawbox openclaw config set --batch-file "$KEY_FILE"',
      'as_clawbox tool --token-file "$TOKEN_FILE" --dir "$AUTH_DIR"',
      'as_clawbox env KEYBOARD_LAYOUT=us tool "$PASSTHROUGH_ARGS" --author="$AUTHOR"',
      "as_clawbox python3 -c 'KEY=1; print($KEY)'",
    ].join("\n");
    const { wrappers, hits } = scan([{ file: "sample.sh", text: sample }]);
    for (const name of ["pass_on", "one_line", "braced", "through_array", "first_arg", "next_line_brace", "subshell_body", "inner"]) {
      expect(wrappers.has(name), name).toBe(true);
    }
    expect(wrappers.has("own_array")).toBe(false);
    expect(wrappers.has("outer")).toBe(false);
    expect(hits.map((h) => [h.lineNo, h.wrapper, h.names])).toEqual([
      [1, "as_clawbox", ["TG_TOKEN"]],
      [4, "as_user", ["GW_TOKEN"]],
      [5, "sudo", ["API_KEY", "api_key"]],
      [7, "su", ["PASSWORD"]],
      [8, "oc_config_set", ["CLAWBOX_AI_KEY"]],
      [9, "as_clawbox", ["TG_TOKEN"]],
      [12, "sudo", ["BOT_TOKEN"]],
      [13, "sudo", ["SESSION_SECRET"]],
      [15, "as_clawbox", ["OTHER_SECRET"]],
      [17, "as_clawbox", ["THIRD_SECRET"]],
      [19, "as_clawbox", ["FOURTH_SECRET"]],
      [23, "pass_on", ["DB_PASSWORD"]],
      [25, "one_line", ["SIGNING_KEY"]],
      [26, "su", ["ROOT_PASS"]],
      [27, "as_clawbox", ["TG_TOKEN"]],
      [28, "as_clawbox", ["TG_TOKEN"]],
      [32, "braced", ["API_TOKEN"]],
      [37, "through_array", ["WIFI_PSK"]],
      [38, "as_clawbox", ["QUOTED_TOKEN"]],
      [40, "first_arg", ["FIRST_SECRET"]],
      [42, "as_clawbox", ["ARRAY_TOKEN"]],
      [44, "$SUDO", ["HELD_SECRET"]],
      [46, "${run[@]}", ["HELD_ARRAY_SECRET"]],
      [47, "sudo", ["ESCAPED_SECRET"]],
      [52, "next_line_brace", ["BRACE_SECRET"]],
      [56, "subshell_body", ["SUBSHELL_SECRET"]],
      [58, "sudo", ["HEREDOC_SECRET"]],
      [61, "as_clawbox", ["AFTER_SHIFT_SECRET"]],
      [66, "as_clawbox", ["AFTER_DASHED_SECRET"]],
    ]);
  });

  it.each([
    ["a heredoc", "cat <<'EOF'\nnever closed\n", /heredoc EOF never closes/],
    ["a quote", "echo 'never closed\n", /' never closes/],
    ["a heredoc fed to a shell", "bash <<EOF\necho 'never closed\nEOF\n", /' never closes/],
  ])("fails closed on %s it cannot see the end of", (_name, text, error) => {
    expect(() => scan([{ file: "sample.sh", text }])).toThrow(error);
  });

  it("finds no credential-named variable on a sudo, su or sudo-wrapper line", () => {
    const unexpected = tree()
      .hits.filter((hit) => !allowedFor(hit))
      .map((h) => `${h.file}:${h.lineNo} ${h.wrapper} carries $${h.names.join(", $")}: ${h.text}`);
    expect(unexpected).toEqual([]);
  });

  it("keeps every allowlist entry live, exact, reasoned and unexpired", () => {
    const today = new Date().toISOString().slice(0, 10);
    const { hits } = tree();
    for (const entry of ALLOWED) {
      const where = `${entry.file}: ${entry.line}`;
      expect(entry.reason.trim().length, where).toBeGreaterThan(40);
      expect(entry.expires, where).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(entry.expires >= today, `${where}: expired ${entry.expires}: ${entry.reason}`).toBe(true);
      // Exactly one live line: an entry that matches nothing hides the next line
      // that reuses its text, and one that matches two waves a copy through.
      const matched = hits.filter((h) => allowedFor(h) === entry);
      expect(matched.map((h) => h.names), where).toEqual([entry.names]);
    }
  });
});
