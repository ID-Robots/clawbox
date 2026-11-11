import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { functionDefs, type Line, logicalLines, sudoWrappers } from "../helpers/shell-reader";

// This file starts no process, but one MUST MISS row holds a `node -e` program
// that names child_process, and test-timeout-hygiene reads that text as a spawn.
// The ceilings cost nothing here and keep that guard's reader simple.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * Root runs nothing from the tree (docs/agents/update-and-install.md): no line
 * of install.sh, which runs as root top to bottom, runs a program out of the
 * service account's directories, its home (the npm prefix and bun live there)
 * or the checkout. The account can rewrite those files, so root running one is
 * the account's code running as root. Ask it as the service account, or read
 * the file as data.
 *
 * Read: install.sh only. install-x64.sh is left for later, and the scripts root
 * runs from config/ and scripts/ have tests of their own.
 *
 * Tainted: CLAWBOX_HOME, PROJECT_DIR, NPM_PREFIX and the literal /home/clawbox;
 * every standalone assignment (bare, local, export, readonly, declare) whose
 * value BEGINS with a tainted expansion, `${a:-$b}` when either side is; an
 * array whose first element is; a for-loop variable over a tainted word; and a
 * function's `$N` when a call passes it a tainted word. A `NAME=value` before a
 * command or after `env` taints nothing, and neither does a value that is a
 * command substitution. `local` and parameter taint stay in their function.
 *
 * A run: a tainted word as a command (after `NAME=value` words, keywords,
 * `exec`, `time`, `command`, `env …` or a root `sudo`), as the script of
 * bash/sh/dash/node/python3/perl, or as the file of `source`/`.`. Every `$(…)`,
 * backquote and `<(…)` is read as root's own command text, inside a wrapper's
 * arguments too: root's shell expands it before the wrapper starts.
 *
 * Not a run: a command whose own command word switches to the service account
 * (as_clawbox, as_clawbox_login, as_user*, runuser, su, `sudo -u`, the git
 * runner, or a function that forwards its arguments through one), which covers
 * that command's own words only; arguments and redirection targets; a script
 * operand after `-`, `-c`, `-e`, `-p`, `-s` or `-m`, where the program is stdin
 * or text root chose; tests; case patterns; comments; single-quoted text;
 * heredoc bodies that are not fed to a shell.
 *
 * Known limits: a wrapper or launcher this file does not name (`nohup`,
 * `xargs`, `find -exec`, `systemd-run`), `eval`, and a heredoc fed to a shell
 * under a wrapper, which reads as root (the safe direction).
 */

const REPO = path.resolve(__dirname, "../../..");
const THIS_FILE = "src/tests/unit/install-root-runs-nothing-from-tree.test.ts";

/** The service account's directories, as install.sh names them. */
const SEEDS = new Set(["CLAWBOX_HOME", "PROJECT_DIR", "NPM_PREFIX"]);
const LITERAL = /^\/home\/clawbox(?=\/|$)/;
/**
 * A rule about a variable, not an allowlist entry, and it does not expire:
 * install.sh assigns SRC_DIR from PROJECT_DIR only when it is not run from the
 * root-owned mirror, which is a run where root already executes the checkout.
 * On every dispatched root step SRC_DIR IS that mirror (docs/root-exec-mirror.md).
 */
const NEVER_TAINTED = new Set(["SRC_DIR"]);
/** Commands that run their arguments as the service account. */
const ACCOUNT_SWITCHES = [
  "as_clawbox",
  "as_clawbox_login",
  "as_user",
  "as_user_runtime",
  "as_user_login",
  "runuser",
  "su",
];
const GIT_RUNNER = /^"?\$\{GIT_RUNNER\[[@*]\]\}"?$/;
/** Interpreters, and the option letters after which the program is text or stdin rather than a file. */
const INTERPRETERS: Record<string, { text: RegExp; takesArg: string; long?: string[] }> = {
  bash: { text: /[cs]/, takesArg: "oO" },
  sh: { text: /[cs]/, takesArg: "oO" },
  dash: { text: /[cs]/, takesArg: "oO" },
  node: { text: /[ep]/, takesArg: "r", long: ["--eval", "--print"] },
  python3: { text: /[cm]/, takesArg: "WX" },
  perl: { text: /[eE]/, takesArg: "" },
};
const PREFIX_KEYWORDS = new Set(["if", "then", "elif", "else", "do", "while", "until", "!"]);
const DECLARATIONS = new Set(["local", "export", "readonly", "declare", "typeset"]);
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?\+?=([\s\S]*)$/;
const REMEDY =
  'Run it as the service account (runuser -u "$CLAWBOX_USER" -- env HOME="$CLAWBOX_HOME" …, or as_clawbox), ' +
  'or read the file as data. Rule: docs/agents/update-and-install.md, "Root runs nothing from the tree".';

/** The reader lost its place: fail closed rather than read "nothing found", and say what to do. */
const lost = (where: string, what: string): Error =>
  new Error(`${where}: ${what} for this reader: check the quoting there, or teach ${THIS_FILE} the construct`);

interface Allowed {
  file: string;
  /** A substring of the logical line, not a line number: line numbers move. */
  line: string;
  word: string;
  reason: string;
  /** YYYY-MM-DD; past it the entry fails, so it is fixed or renewed with a reason. */
  expires: string;
}

/** Each entry needs a reason, an expiry date and exactly one live line. */
const ALLOWED: Allowed[] = [];

interface Word {
  raw: string;
  subs: string[];
}

type Token = { t: "word"; raw: string; subs: string[]; open?: boolean } | { t: "op"; v: string } | { t: "redir" };

interface Command {
  lineNo: number;
  text: string;
  fn: string | null;
  words: Word[];
  /** `for NAME in WORDS`: the loop variable. */
  loopVar?: string;
}

interface Hit {
  file: string;
  lineNo: number;
  word: string;
  text: string;
}

/**
 * From `i`, just past an opener, to just past its `close`: quotes, `$(…)`,
 * `${…}` and backquotes nest inside. The bodies of command substitutions met on
 * the way go to `subs`, when given. Past the end of `text` when it never closes.
 */
function skip(text: string, i: number, close: string, subs: string[] | null): number {
  let depth = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "`" && close !== "`") {
      const from = i + 1;
      i = skip(text, from, "`", null);
      subs?.push(text.slice(from, i - 1));
      continue;
    }
    if (c === "$" && text[i + 1] === "(") {
      const from = i + 2;
      i = skip(text, from, ")", null);
      // `$((…))` is arithmetic, not a command.
      if (text[from] !== "(") subs?.push(text.slice(from, i - 1));
      continue;
    }
    if (c === "$" && text[i + 1] === "{") {
      i = skip(text, i + 2, "}", subs);
      continue;
    }
    if (close === '"' || close === "`") {
      i += 1;
      if (c === close) return i;
      continue;
    }
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      i = end < 0 ? text.length + 1 : end + 1;
      continue;
    }
    if (c === '"') {
      i = skip(text, i + 1, '"', subs);
      continue;
    }
    if ((c === "(" && close === ")") || (c === "{" && close === "}")) depth += 1;
    i += 1;
    if (c === close) {
      if (!depth) return i;
      depth -= 1;
    }
  }
  return text.length + 1;
}

/**
 * One word from `i`: its text as written, the command substitutions inside it,
 * and whether it runs past the end of `text` (an array whose `)` is on a later line).
 */
function readWord(text: string, i: number): Word & { end: number; open: boolean } {
  const start = i;
  const subs: string[] = [];
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c) || c === ";" || c === "&" || c === "|" || c === ")") break;
    if ((c === "<" || c === ">") && text[i + 1] === "(") {
      const from = i + 2;
      i = skip(text, from, ")", null);
      subs.push(text.slice(from, i - 1));
      continue;
    }
    if (c === "<" || c === ">") break;
    if (c === "(") {
      // `name=(…)`: an array's elements belong to the word.
      if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=$/.test(text.slice(start, i))) break;
      i = skip(text, i + 1, ")", subs);
      continue;
    }
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "'" || (c === "$" && text[i + 1] === "'")) {
      const from = c === "'" ? i + 1 : i + 2;
      let end = from;
      while (end < text.length && text[end] !== "'") end += c === "$" && text[end] === "\\" ? 2 : 1;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      i = skip(text, i + 1, '"', subs);
      continue;
    }
    if (c === "`") {
      const from = i + 1;
      i = skip(text, from, "`", null);
      subs.push(text.slice(from, i - 1));
      continue;
    }
    if (c === "$" && text[i + 1] === "(") {
      const from = i + 2;
      i = skip(text, from, ")", null);
      if (text[from] !== "(") subs.push(text.slice(from, i - 1));
      continue;
    }
    if (c === "$" && text[i + 1] === "{") {
      i = skip(text, i + 2, "}", subs);
      continue;
    }
    i += 1;
  }
  const end = Math.min(i, text.length);
  return { raw: text.slice(start, end), subs, end, open: i > text.length };
}

const REDIRECT = /^(?:&>>|&>|<<<|<<-|<<|<>|<&|>>|>&|>\||<|>)/;

/** Shell tokens: words, control operators (a newline is one) and redirections. */
function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "\n") {
      out.push({ t: "op", v: "\n" });
      i += 1;
      continue;
    }
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    if (c === "#") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    const op = /^(?:;;&|;;|;&|&&|\|\||\|&)/.exec(text.slice(i, i + 3))?.[0];
    if (op) {
      out.push({ t: "op", v: op });
      i += op.length;
      continue;
    }
    const redirect = (c === "<" || c === ">") && text[i + 1] === "(" ? null : REDIRECT.exec(text.slice(i, i + 3));
    if (redirect) {
      out.push({ t: "redir" });
      i += redirect[0].length;
      continue;
    }
    if (";&|()".includes(c)) {
      if (c === "(" && text[i + 1] === "(") {
        // `((…))`: arithmetic, no command in it.
        i = skip(text, i + 1, ")", null);
        out.push({ t: "word", raw: "((", subs: [] });
        continue;
      }
      out.push({ t: "op", v: c });
      i += 1;
      continue;
    }
    const word = readWord(text, i);
    i = word.end > i ? word.end : i + 1;
    // An fd number or `{var}` right before `<` or `>` belongs to the redirection.
    if (/^(?:\d+|\{[A-Za-z_][A-Za-z0-9_]*\})$/.test(word.raw) && (text[i] === "<" || text[i] === ">")) continue;
    if (word.raw === "[[") {
      // A test: nothing in it is a command but its substitutions.
      const subs = [...word.subs];
      while (i < text.length && !/^\]\](?=\s|[;&|)]|$)/.test(text.slice(i))) {
        if (/[\s<>()!&|]/.test(text[i])) i += 1;
        else {
          const inner = readWord(text, i);
          subs.push(...inner.subs);
          i = inner.end > i ? inner.end : i + 1;
        }
      }
      i += 2;
      out.push({ t: "word", raw: "[[", subs });
      continue;
    }
    out.push({ t: "word", raw: word.raw, subs: word.subs, open: word.open });
  }
  return out;
}

/**
 * The reader's lines with an array assignment that spans lines (`NAME=(` …
 * `)`) joined into the line that opens it.
 */
function joinArrays(lines: Line[], file: string): Line[] {
  const out: Line[] = [];
  const opens = (text: string): boolean => tokenize(text).some((t) => t.t === "word" && t.open);
  for (let n = 0; n < lines.length; n += 1) {
    const { lineNo } = lines[n];
    let { text } = lines[n];
    while (opens(text)) {
      n += 1;
      if (n === lines.length) throw lost(`${file}:${lineNo}`, "( never closes");
      text += `\n${lines[n].text}`;
    }
    out.push({ lineNo, text });
  }
  return out;
}

interface Frame {
  kind: "{" | "(" | "case";
  lineNo: number;
  fn?: string;
  /** In a case: the next words are a pattern, up to its `)`. */
  pattern?: boolean;
}

const CLOSER: Record<Frame["kind"], string> = { "{": "}", "(": ")", case: "esac" };

interface ParseState {
  frames: Frame[];
  /** A function head read, its body's `{` or `(` not yet. */
  pendingFn: string | null;
}

/**
 * The simple commands of one stretch of shell, each with the function it sits
 * in. `state` carries the open braces, subshells and cases from line to line.
 */
function parse(
  text: string,
  lineNo: number,
  state: ParseState,
  outerFn: string | null,
  out: Command[],
  file: string,
): void {
  const tokens = tokenize(text);
  const fnNow = (): string | null => [...state.frames].reverse().find((f) => f.fn)?.fn ?? outerFn;
  const top = (): Frame | undefined => state.frames[state.frames.length - 1];
  let words: Word[] = [];
  let loop: { name?: string; words: Word[] } | null = null;
  let caseHead: "subject" | "in" | null = null;
  let functionKeyword = false;
  let closed = false;
  let redirected = false;
  const finish = (): void => {
    if (loop?.name) out.push({ lineNo, text, fn: fnNow(), words: loop.words, loopVar: loop.name });
    else if (words.length) out.push({ lineNo, text, fn: fnNow(), words });
    words = [];
    loop = null;
    closed = false;
  };
  const pop = (kind: Frame["kind"]): void => {
    if (top()?.kind !== kind) throw lost(`${file}:${lineNo}`, `${CLOSER[kind]} closes nothing open`);
    state.frames.pop();
  };
  for (let k = 0; k < tokens.length; k += 1) {
    const tok = tokens[k];
    // Root's shell runs every substitution itself, whatever command holds it.
    if (tok.t === "word") {
      for (const sub of tok.subs) parse(sub, lineNo, { frames: [], pendingFn: null }, fnNow(), out, file);
    }
    if (tok.t === "redir") {
      redirected = true;
      continue;
    }
    if (tok.t === "word" && redirected) {
      redirected = false;
      continue;
    }
    const frame = top();
    if (frame?.kind === "case" && frame.pattern) {
      if (tok.t === "word" && tok.raw === "esac") {
        pop("case");
        closed = true;
      } else if (tok.t === "op" && tok.v === ")") frame.pattern = false;
      continue;
    }
    if (tok.t === "op") {
      const next = tokens[k + 1];
      const head = state.pendingFn || (words.length === 1 && NAME.test(words[0].raw));
      if (tok.v === "(" && next?.t === "op" && next.v === ")" && head) {
        // `name ()`, or the `()` of `function name ()`.
        if (!state.pendingFn) state.pendingFn = words[0].raw;
        words = [];
        k += 1;
        continue;
      }
      if (tok.v === "(" && !words.length && !loop) {
        state.frames.push({ kind: "(", lineNo, fn: state.pendingFn ?? undefined });
        state.pendingFn = null;
        continue;
      }
      finish();
      if (tok.v === ")") {
        pop("(");
        closed = true;
      }
      if (tok.v === ";;" || tok.v === ";&" || tok.v === ";;&") {
        const open = top();
        if (open?.kind === "case") open.pattern = true;
      }
      continue;
    }
    if (tok.t !== "word") continue;
    if (caseHead === "subject") {
      caseHead = "in";
      continue;
    }
    if (caseHead === "in") {
      state.frames.push({ kind: "case", lineNo, pattern: true });
      caseHead = null;
      continue;
    }
    if (functionKeyword) {
      state.pendingFn = tok.raw;
      functionKeyword = false;
      continue;
    }
    if (loop) {
      if (!loop.name) loop.name = tok.raw;
      else if (tok.raw !== "in") loop.words.push(tok);
      continue;
    }
    if (closed) continue;
    if (!words.length) {
      const w = tok.raw;
      if (PREFIX_KEYWORDS.has(w)) continue;
      if (w === "{") {
        state.frames.push({ kind: "{", lineNo, fn: state.pendingFn ?? undefined });
        state.pendingFn = null;
        continue;
      }
      if (w === "}" || w === "esac") {
        pop(w === "}" ? "{" : "case");
        closed = true;
        continue;
      }
      if (w === "fi" || w === "done" || w === "[[" || w === "((") {
        closed = true;
        continue;
      }
      if (w === "case") {
        caseHead = "subject";
        continue;
      }
      if (w === "for" || w === "select") {
        loop = { words: [] };
        continue;
      }
      if (w === "function") {
        functionKeyword = true;
        continue;
      }
    }
    words.push(tok);
  }
  finish();
}

const bare = (raw: string): string => raw.replace(/["'\\]/g, "");

interface Shape {
  /** The word in run position: the command, an interpreter's script, the file of `source`. */
  candidate?: Word;
  wrapped: boolean;
  assigns: { name: string; value: string; local: boolean }[];
  /** Names a `local` declares, assigned or not. */
  locals: string[];
  call?: { name: string; args: Word[] };
}

/** The script operand of an interpreter's argv, or nothing when the program is text or stdin. */
function scriptOperand(spec: (typeof INTERPRETERS)[string], args: Word[]): Word | undefined {
  for (let j = 0; j < args.length; j += 1) {
    const r = bare(args[j].raw);
    if (r === "-") return undefined;
    if (r === "--") return args[j + 1];
    if (r.startsWith("--")) {
      if (spec.long?.includes(r.split("=")[0])) return undefined;
      continue;
    }
    if (/^[-+][A-Za-z]+$/.test(r)) {
      if (spec.text.test(r.slice(1))) return undefined;
      if (spec.takesArg.includes(r[r.length - 1])) j += 1;
      continue;
    }
    return args[j];
  }
  return undefined;
}

function shapeOf(command: Command, wrappers: Set<string>, functions: Set<string>): Shape {
  const shape: Shape = { wrapped: false, assigns: [], locals: [] };
  const { words } = command;
  if (command.loopVar) return shape;
  let k = 0;
  while (k < words.length && ASSIGNMENT.test(words[k].raw)) k += 1;
  if (k === words.length) {
    // Standalone assignments; a `NAME=value` before a command taints nothing.
    for (const w of words) {
      const [, name, value] = ASSIGNMENT.exec(w.raw) ?? [];
      shape.assigns.push({ name, value, local: false });
    }
    return shape;
  }
  for (;;) {
    const word = bare(words[k]?.raw ?? "");
    if (word === "exec" || word === "time" || word === "command") {
      k += 1;
      if (word === "command" && /^-[vV]/.test(words[k]?.raw ?? "")) return shape;
      while (/^-[pP]$/.test(words[k]?.raw ?? "")) k += 1;
      continue;
    }
    if (word === "env" || word.endsWith("/env")) {
      k += 1;
      while (k < words.length) {
        const r = bare(words[k].raw);
        if (/^(?:-[uCS]|--unset|--chdir|--split-string)$/.test(r)) k += 2;
        else if (r.startsWith("-") || ASSIGNMENT.test(words[k].raw)) k += 1;
        else break;
      }
      continue;
    }
    if (word === "sudo") {
      k += 1;
      let user = false;
      while (k < words.length && bare(words[k].raw).startsWith("-")) {
        const r = bare(words[k].raw);
        k += 1;
        if (r === "--") break;
        if (/^-[A-Za-z]*u$/.test(r) || r === "--user") {
          user = true;
          k += 1;
        } else if (/^-[A-Za-z]*u./.test(r) || r.startsWith("--user=")) user = true;
        else if (/^-[A-Za-z]*[gCDhprtUT]$/.test(r)) k += 1;
      }
      // `sudo -u <user>` switches; a bare sudo runs its command as root.
      if (user) {
        shape.wrapped = true;
        return shape;
      }
      continue;
    }
    break;
  }
  const cmd = words[k];
  if (!cmd) return shape;
  const name = bare(cmd.raw);
  if (ACCOUNT_SWITCHES.includes(name) || GIT_RUNNER.test(cmd.raw)) {
    shape.wrapped = true;
    return shape;
  }
  // A function that forwards its arguments through a switch is a wrapped call,
  // but its body can run another argument as root: its call is still recorded,
  // so the body is judged with what it was passed.
  if (wrappers.has(name)) shape.wrapped = true;
  if (DECLARATIONS.has(name)) {
    // `declare` and `typeset` in a function are local too, unless `-g`.
    const global = name === "export" || name === "readonly" || words.some((w) => /^-[a-zA-Z]*g/.test(w.raw));
    const local = name === "local" || (!!command.fn && !global);
    for (const w of words.slice(k + 1)) {
      const m = ASSIGNMENT.exec(w.raw);
      if (m) shape.assigns.push({ name: m[1], value: m[2], local });
      if (local && (m || NAME.test(w.raw))) shape.locals.push(m ? m[1] : w.raw);
    }
    return shape;
  }
  const interpreter = INTERPRETERS[name.replace(/^.*\//, "")];
  if (interpreter) {
    shape.candidate = scriptOperand(interpreter, words.slice(k + 1));
    return shape;
  }
  if (name === "source" || name === ".") {
    shape.candidate = words[k + 1];
    return shape;
  }
  shape.candidate = cmd;
  if (functions.has(name)) shape.call = { name, args: words.slice(k + 1) };
  return shape;
}

interface Taint {
  global: Set<string>;
  /** Per function: its tainted locals and positional parameters. */
  local: Map<string, Set<string>>;
  /** Per function: the names it declares local, which hide a global of the same name. */
  declared: Map<string, Set<string>>;
}

function isTainted(name: string, fn: string | null, taint: Taint): boolean {
  if (NEVER_TAINTED.has(name)) return false;
  if (fn && taint.local.get(fn)?.has(name)) return true;
  // `$1` outside a function is the installer's own argument.
  if (/^[1-9]$/.test(name)) return false;
  if (fn && taint.declared.get(fn)?.has(name)) return false;
  return SEEDS.has(name) || taint.global.has(name);
}

/** Whether a word, as written, begins with the service account's directory. */
function beginsTainted(raw: string, fn: string | null, taint: Taint): boolean {
  const text = raw.replace(/^["']/, "");
  if (LITERAL.test(text)) return true;
  if (raw.startsWith("'")) return false;
  const plain = /^\$(?:([A-Za-z_][A-Za-z0-9_]*)|([1-9@*]))/.exec(text);
  if (plain) return isTainted(plain[1] ?? positional(plain[2]), fn, taint);
  if (!text.startsWith("${")) return false;
  const inner = text.slice(2, skip(text, 2, "}", null) - 1);
  const m = /^([A-Za-z_][A-Za-z0-9_]*|[1-9@*])([\s\S]*)$/.exec(inner);
  if (!m) return false;
  if (isTainted(/^[A-Za-z_]/.test(m[1]) ? m[1] : positional(m[1]), fn, taint)) return true;
  // `${a:-$b}`, `${a=$b}`, `${a:+$b}`: the other side can be the value.
  const other = /^:?[-=+]([\s\S]*)$/.exec(m[2]);
  return !!other && beginsTainted(other[1], fn, taint);
}

/** `$@` and `$*` begin with `$1`. */
const positional = (p: string): string => (p === "@" || p === "*" ? "1" : p);

function valueTainted(value: string, fn: string | null, taint: Taint): boolean {
  if (!value.startsWith("(")) return beginsTainted(value, fn, taint);
  const first = value.slice(1).trimStart();
  return !!first && beginsTainted(readWord(first, 0).raw, fn, taint);
}

function scan(sources: { file: string; text: string }[]): {
  lines: number;
  tainted: Set<string>;
  wrapped: number;
  hits: Hit[];
} {
  const hits: Hit[] = [];
  const tainted = new Set<string>();
  let lines = 0;
  let wrapped = 0;
  for (const { file, text } of sources) {
    const logical = logicalLines(text, file);
    lines += logical.length;
    const wrappers = sudoWrappers(functionDefs(logical), ACCOUNT_SWITCHES);
    const commands: Command[] = [];
    const state: ParseState = { frames: [], pendingFn: null };
    for (const line of joinArrays(logical, file)) parse(line.text, line.lineNo, state, null, commands, file);
    const open = state.frames[0];
    if (open) throw lost(`${file}:${open.lineNo}`, `${open.kind} never closes`);
    const functions = new Set(commands.map((c) => c.fn).filter((f): f is string => !!f));
    const shapes = commands.map((c) => shapeOf(c, wrappers, functions));
    const taint: Taint = { global: new Set(), local: new Map(), declared: new Map() };
    const fnSet = (map: Map<string, Set<string>>, fn: string): Set<string> =>
      map.get(fn) ?? map.set(fn, new Set()).get(fn)!;
    shapes.forEach((s, n) => {
      const { fn } = commands[n];
      if (fn) for (const name of s.locals) fnSet(taint.declared, fn).add(name);
    });
    for (let grew = true; grew; ) {
      grew = false;
      const add = (set: Set<string>, name: string): void => {
        if (NEVER_TAINTED.has(name) || set.has(name)) return;
        set.add(name);
        grew = true;
      };
      shapes.forEach((s, n) => {
        const { fn, loopVar, words } = commands[n];
        if (loopVar) {
          // A loop variable is the loop's: kept in its function, like a local.
          const over = words.some((w) => beginsTainted(w.raw, fn, taint));
          if (over) add(fn ? fnSet(taint.local, fn) : taint.global, loopVar);
          return;
        }
        for (const { name, value, local } of s.assigns) {
          if (!valueTainted(value, fn, taint)) continue;
          const scoped = fn && (local || taint.declared.get(fn)?.has(name) || /^"?\$\{?[1-9@*]/.test(value));
          add(scoped ? fnSet(taint.local, fn) : taint.global, name);
        }
        if (s.call) {
          s.call.args.slice(0, 9).forEach((arg, j) => {
            if (beginsTainted(arg.raw, fn, taint)) add(fnSet(taint.local, s.call!.name), String(j + 1));
          });
        }
      });
    }
    for (const name of [...taint.global, ...[...taint.local.values()].flatMap((s) => [...s])]) {
      if (NAME.test(name)) tainted.add(name);
    }
    const seen = new Set<string>();
    shapes.forEach((s, n) => {
      const { fn, lineNo, text: line } = commands[n];
      if (s.wrapped) wrapped += 1;
      if (!s.candidate || !beginsTainted(s.candidate.raw, fn, taint)) return;
      const key = `${lineNo} ${s.candidate.raw}`;
      if (seen.has(key)) return;
      seen.add(key);
      hits.push({ file, lineNo, word: s.candidate.raw, text: line.trim() });
    });
  }
  return { lines, tainted, wrapped, hits };
}

const tree = (): ReturnType<typeof scan> =>
  scan([{ file: "install.sh", text: fs.readFileSync(path.join(REPO, "install.sh"), "utf-8") }]);

const allowedFor = (hit: Hit): Allowed | undefined =>
  ALLOWED.find((a) => a.file === hit.file && a.word === hit.word && hit.text.includes(a.line));

const message = (h: Hit): string =>
  `${h.file}:${h.lineNo}: root runs ${h.word} from the service account's directories. ${REMEDY}`;

/** Assignments the rows lean on, made the way install.sh makes them. */
const PREAMBLE = [
  'BUN="$CLAWBOX_HOME/.bun/bin/bun"',
  'OPENCLAW_BIN="$NPM_PREFIX/bin/openclaw"',
  'GATEWAY_DIST="$NPM_PREFIX/lib/node_modules/openclaw/dist"',
];

const rowHits = (rows: string[]): [number, string][] =>
  scan([{ file: "sample.sh", text: [...PREAMBLE, ...rows].join("\n") }]).hits.map((h) => [
    h.lineNo - PREAMBLE.length,
    h.word,
  ]);

/**
 * Each row, the line in it that runs (1-based) and the word run. The first six
 * are install.sh's former text, verbatim, with what they lean on.
 */
const MUST_HIT: [string, string[], number, string][] = [
  [
    "the core's version, asked of the npm prefix",
    [`    v=$("$NPM_PREFIX/bin/openclaw" --version 2>/dev/null | grep -oE '20[0-9]{2}\\.[0-9]+\\.[0-9]+' | head -1)`],
    1,
    '"$NPM_PREFIX/bin/openclaw"',
  ],
  [
    "the build identity script, from the checkout through a parameter",
    [
      "verify_build_present() {",
      '  local project_dir="$1"',
      '  if ! bash "$project_dir/scripts/verify-build-identity.sh" --project-dir "$project_dir" --quiet; then',
      "    return 1",
      "  fi",
      "}",
      '  verify_build_present "$PROJECT_DIR" || exit 1',
    ],
    3,
    '"$project_dir/scripts/verify-build-identity.sh"',
  ],
  [
    "the launcher probe of the harness swap",
    ['  if said="$("$OPENCLAW_BIN" --version 2>&1 >/dev/null)"; then', "    return 0", "  fi"],
    1,
    '"$OPENCLAW_BIN"',
  ],
  [
    "the installed core's version",
    ['    INSTALLED=$("$OPENCLAW_BIN" --version 2>/dev/null || echo "none")'],
    1,
    '"$OPENCLAW_BIN"',
  ],
  [
    "the staged core's version",
    [
      "step_openclaw_install() {",
      '    local _oc_stage="$NPM_PREFIX/.openclaw-stage"',
      '    if ! _oc_version_out="$("$_oc_stage/bin/openclaw" --version 2>&1)"; then',
      "      return 1",
      "    fi",
      "}",
    ],
    3,
    '"$_oc_stage/bin/openclaw"',
  ],
  [
    "the TTS probe's fallback to the checkout's copy, through a parameter",
    [
      "tts_write_local_provider_definition() {",
      '  local TTS_HOME="$1" TTS_SCRIPT="$2" TTS_PROBE="${3:-$2}"',
      "  local TTS_TIMEOUT_MS",
      '  TTS_TIMEOUT_MS=$(bash "$TTS_PROBE" --provider-timeout-ms 2>/dev/null || echo "")',
      "}",
      "step_openclaw_tts() {",
      '  local TTS_SCRIPT="$PROJECT_DIR/scripts/openclaw/clawbox-tts.sh"',
      '  local TTS_SCRIPT_SRC="$SRC_DIR/scripts/openclaw/clawbox-tts.sh"',
      '  if ! tts_write_local_provider_definition "$TTS_HOME" "$TTS_SCRIPT" "$TTS_SCRIPT_SRC"; then',
      "    return 1",
      "  fi",
      "}",
    ],
    4,
    '"$TTS_PROBE"',
  ],
  ["a pipeline's first stage", ['"$NPM_PREFIX/bin/x" | y'], 1, '"$NPM_PREFIX/bin/x"'],
  ["a pipeline's later stage", ['x | "$BUN" y'], 1, '"$BUN"'],
  ["a later stage after a wrapped one", ['as_clawbox x | "$OPENCLAW_BIN" y'], 1, '"$OPENCLAW_BIN"'],
  ["a command after a wrapped one", ['as_clawbox x && "$OPENCLAW_BIN" y'], 1, '"$OPENCLAW_BIN"'],
  ["a substitution in a wrapper's arguments", ['as_clawbox tool "$("$OPENCLAW_BIN" --version)"'], 1, '"$OPENCLAW_BIN"'],
  ["a script of bash", ['bash "$PROJECT_DIR/scripts/a.sh"'], 1, '"$PROJECT_DIR/scripts/a.sh"'],
  ["a script after options", ['bash -e -o pipefail "$PROJECT_DIR/scripts/a.sh"'], 1, '"$PROJECT_DIR/scripts/a.sh"'],
  ["a script of python3 -I", ['python3 -I "$PROJECT_DIR/scripts/a.py"'], 1, '"$PROJECT_DIR/scripts/a.py"'],
  ["a script of node", ['node "$GATEWAY_DIST/index.js" --help'], 1, '"$GATEWAY_DIST/index.js"'],
  ["a sourced file", ['. "$CLAWBOX_HOME/.profile"'], 1, '"$CLAWBOX_HOME/.profile"'],
  ["source", ['source "$PROJECT_DIR/scripts/lib.sh"'], 1, '"$PROJECT_DIR/scripts/lib.sh"'],
  ["a substitution", ['v=$("$OPENCLAW_BIN" --version)'], 1, '"$OPENCLAW_BIN"'],
  ["a backquote", ['v=`"$OPENCLAW_BIN" --version`'], 1, '"$OPENCLAW_BIN"'],
  ["a process substitution", ['while read -r l; do :; done < <("$OPENCLAW_BIN" plugins list)'], 1, '"$OPENCLAW_BIN"'],
  [
    "an unquoted substitution inside echo text",
    ['echo "v: $($OPENCLAW_BIN --version 2>/dev/null || echo unknown)"'],
    1,
    "$OPENCLAW_BIN",
  ],
  [
    "a negated test of a local",
    ["probe() {", '  local shim="$CLAWBOX_HOME/.local/bin/hermes"', '  if ! "$shim" --help; then', "    return 1", "  fi", "}"],
    3,
    '"$shim"',
  ],
  ["a call through a parameter", ['run_probe() { "$1" --version; }', 'run_probe "$OPENCLAW_BIN"'], 1, '"$1"'],
  [
    "a parameter run by root in a function that also forwards through a wrapper",
    ['both() { as_clawbox mkdir -p "$1"; "$2" --version; }', 'both /tmp "$OPENCLAW_BIN"'],
    1,
    '"$2"',
  ],
  ["after env", ['env A=1 "$OPENCLAW_BIN" x'], 1, '"$OPENCLAW_BIN"'],
  ["after exec", ['exec "$OPENCLAW_BIN" gateway'], 1, '"$OPENCLAW_BIN"'],
  ["after a root sudo", ['sudo "$OPENCLAW_BIN" --version'], 1, '"$OPENCLAW_BIN"'],
  ["after a prefix assignment", ['NODE_OPTIONS=x "$OPENCLAW_BIN" --version'], 1, '"$OPENCLAW_BIN"'],
  ["in a subshell", ['( cd /tmp && "$OPENCLAW_BIN" --version )'], 1, '"$OPENCLAW_BIN"'],
  ["the literal home", ["/home/clawbox/.local/bin/tool --version"], 1, "/home/clawbox/.local/bin/tool"],
  ["a default expansion", ['"${OPENCLAW:-$OPENCLAW_BIN}" --version'], 1, '"${OPENCLAW:-$OPENCLAW_BIN}"'],
  ["an array's first element", ['probe=("$OPENCLAW_BIN" --version)', '"${probe[@]}"'], 2, '"${probe[@]}"'],
  ["a loop variable", ['for bin in "$NPM_PREFIX"/bin/*; do "$bin" --version; done'], 1, '"$bin"'],
  ["in a case arm", ['case "$x" in', '  a) "$OPENCLAW_BIN" --version ;;', "esac"], 2, '"$OPENCLAW_BIN"'],
];

/** Rows that run nothing from the service account's directories as root. */
const MUST_MISS: [string, string[]][] = [
  ["a test", ['[ -x "$OPENCLAW_BIN" ]']],
  ["a [[ test", ['[[ -x "$OPENCLAW_BIN" && "$OPENCLAW_BIN" == *openclaw ]]']],
  ["echo text", ['echo "($OPENCLAW_BIN)"']],
  ["an argument", ['as_clawbox tool "$OPENCLAW_BIN"', 'cp "$PROJECT_DIR/a" /tmp/b']],
  ["redirection targets", ['echo x > "$PROJECT_DIR/x"', 'sort < "$PROJECT_DIR/in"', 'exec {fd}>>"$CLAWBOX_HOME/lock"']],
  ["command -v", ['command -v "$OPENCLAW_BIN"']],
  ["runuser", ['runuser -u "$CLAWBOX_USER" -- "$OPENCLAW_BIN" --version']],
  ["as_clawbox with options", ['as_clawbox -H "$OPENCLAW_BIN" x']],
  ["as_user_runtime", ['as_user_runtime "$OPENCLAW_BIN" x']],
  ["sudo -u", ['sudo -u "$CLAWBOX_USER" "$OPENCLAW_BIN" x', 'sudo -E -H -u "$CLAWBOX_USER" "$BUN" x']],
  ["su", ['su - "$CLAWBOX_USER" -c "$OPENCLAW_BIN x"']],
  ["a forwarding function", ['as_owner() { runuser -u "$CLAWBOX_USER" -- "$@"; }', 'as_owner "$OPENCLAW_BIN" x']],
  ["the git runner", ['"${GIT_RUNNER[@]}" git -C "$PROJECT_DIR" status']],
  [
    "a continuation under a wrapper",
    ["as_clawbox -H env A=1 \\", '  "$OPENCLAW_BIN" config get x']],
  [
    "a continuation under a wrapper inside a substitution",
    ['out=$(as_clawbox env A="$A" \\', '  "$OPENCLAW_BIN" doctor --fix 2>&1) || true']],
  [
    "a continued path argument inside a substitution",
    [
      `v="$(python3 -c 'import sys; print(sys.argv[1])' \\`,
      '  "$NPM_PREFIX/lib/node_modules/openclaw/package.json" 2>/dev/null || true)"',
    ],
  ],
  [
    "the mirror, although assigned from the checkout",
    ['SRC_DIR="$PROJECT_DIR"', 'bash "$SRC_DIR/scripts/a.sh"', 'P="$SRC_DIR/scripts/b.sh"', 'bash "$P"']],
  ["a function on a path", ['ENV_FILE="$PROJECT_DIR/.env"', 'HF=$(get_env "$ENV_FILE" K)']],
  [
    "a path inside a single-quoted node program",
    [`node -e 'require("child_process").execFileSync("/home/clawbox/.npm-global/bin/openclaw")'`]],
  [
    "a manifest read by a program from stdin",
    [
      `    v=$(python3 -I - "$NPM_PREFIX/lib/node_modules/openclaw/package.json" 2>/dev/null <<'PY' || true`,
      "import json, sys",
      'print(json.load(open(sys.argv[1])).get("version", ""))',
      "PY",
      ")",
    ],
  ],
  ["python3 -", ['python3 - "$PROJECT_DIR/package.json"']],
  ["python3 -c", ['X_FILE="$PROJECT_DIR/x.json"', `python3 -c 'import sys; print(sys.argv[1])' "$X_FILE"`]],
  ["node -e", [`node -e 'console.log(process.argv[1])' "$PROJECT_DIR/x"`]],
  ["bash -c", [`bash -c 'cat "$1"' sh "$PROJECT_DIR/x"`]],
  ["a case pattern", ['case "$d" in', '  "$CLAWBOX_HOME"/*) echo inside ;;', "  *) echo outside ;;", "esac"]],
  [
    "the TTS probe's own assignment",
    [
      "write_def() {",
      '  local TTS_HOME="$1" TTS_SCRIPT="$2" TTS_PROBE="${3:-$2}"',
      '  echo "$TTS_PROBE"',
      "}",
      'write_def "$HOME" "$PROJECT_DIR/scripts/a.sh"',
    ],
  ],
  [
    "a wrapped build whose separators are text",
    ['if as_clawbox_login "cd $PROJECT_DIR && $BUN run build" 2>&1 | tee "$log"; then', "  :", "fi"]],
  ["a wrapped install", ['as_clawbox_login "cd $PROJECT_DIR && $BUN install"']],
  [
    "a wrapped script in a substitution",
    ['dir="$(as_clawbox_login "cd $PROJECT_DIR || exit 1; $script" 2>/dev/null | tail -n 1)" || dir=""']],
  ["the swap probe as the account", ['runuser -u "$CLAWBOX_USER" -- env HOME="$CLAWBOX_HOME" "$OPENCLAW_BIN" --version']],
  [
    "the swap probe as the account, captured",
    [
      'if said="$(runuser -u "$CLAWBOX_USER" -- env HOME="$CLAWBOX_HOME" "$OPENCLAW_BIN" --version 2>&1 >/dev/null)"; then',
      "  :",
      "fi",
    ],
  ],
  [
    "the installed version as the account",
    ['INSTALLED=$(runuser -u "$CLAWBOX_USER" -- env HOME="$CLAWBOX_HOME" "$OPENCLAW_BIN" --version 2>/dev/null || echo "none")']],
  [
    "the staged version as the account",
    [
      "stage() {",
      '  local _oc_stage="$NPM_PREFIX/.openclaw-stage"',
      '  if ! _oc_version_out="$(runuser -u "$CLAWBOX_USER" -- env HOME="$CLAWBOX_HOME" "$_oc_stage/bin/openclaw" --version 2>&1)"; then',
      "    return 1",
      "  fi",
      "}",
    ],
  ],
  [
    "the build identity script as the account",
    [
      "verify() {",
      '  local project_dir="$1"',
      '  if ! runuser -u "$CLAWBOX_USER" -- env HOME="$CLAWBOX_HOME" \\',
      '      bash "$project_dir/scripts/verify-build-identity.sh" --project-dir "$project_dir" --quiet; then',
      "    return 1",
      "  fi",
      "}",
      'verify "$PROJECT_DIR"',
    ],
  ],
  [
    "the TTS probe with no fallback",
    [
      "write_def() {",
      '  local TTS_HOME="$1" TTS_SCRIPT="$2" TTS_PROBE="${3:-}"',
      '  TTS_TIMEOUT_MS=$(bash "$TTS_PROBE" --provider-timeout-ms 2>/dev/null || echo "")',
      "}",
      'write_def "$TTS_HOME" "$PROJECT_DIR/scripts/a.sh" "$SRC_DIR/scripts/a.sh"',
    ],
  ],
  ["HOME set for one command", ['HOME="$CLAWBOX_HOME" true', 'env HOME="$CLAWBOX_HOME" true', '"$HOME/.local/bin/x" --version']],
  [
    "a local of the same name elsewhere",
    ['one() { local dir="$PROJECT_DIR/x"; echo "$dir"; }', 'two() { local dir="/usr/lib"; "$dir/run"; }']],
  ["a parameter of another function", ['keep() { local bin="$1"; echo "$bin"; }', 'keep "$OPENCLAW_BIN"', 'other() { "$bin" x; }']],
  [
    "a loop variable read as data",
    ['for stamp in "$PROJECT_DIR/.next/build-info.json"; do [ -f "$stamp" ] && cat "$stamp"; done']],
  ["an array used as data", ['paths=("$NPM_PREFIX/bin/openclaw" "$NPM_PREFIX/lib")', 'rm -rf "${paths[@]}"']],
  ["a value from a substitution", ['V="$(dirname "$PROJECT_DIR")"', '"$V/bin/x"']],
];

describe("root runs nothing from the service account's directories in install.sh", () => {
  it("reads install.sh whole, so an empty result means something", () => {
    const { lines, tainted, wrapped } = tree();
    expect(lines).toBeGreaterThan(1000);
    for (const name of ["OPENCLAW_BIN", "BUN", "GATEWAY_DIST", "project_dir"]) {
      expect(tainted.has(name), name).toBe(true);
    }
    // Commands run through a switch to the service account: install.sh had 160
    // when this was written.
    expect(wrapped).toBeGreaterThan(120);
  });

  it.each(MUST_HIT)("finds %s", (_name, rows, line, word) => {
    expect(rowHits(rows)).toEqual([[line, word]]);
  });

  it.each(MUST_MISS)("passes %s", (_name, rows) => {
    expect(rowHits(rows)).toEqual([]);
  });

  it("says where it found a run and what to do", () => {
    const [hit] = scan([{ file: "sample.sh", text: 'bash "$PROJECT_DIR/scripts/a.sh"' }]).hits;
    expect(message(hit)).toBe(
      'sample.sh:1: root runs "$PROJECT_DIR/scripts/a.sh" from the service account\'s directories. ' +
        'Run it as the service account (runuser -u "$CLAWBOX_USER" -- env HOME="$CLAWBOX_HOME" …, or as_clawbox), ' +
        'or read the file as data. Rule: docs/agents/update-and-install.md, "Root runs nothing from the tree".',
    );
  });

  it.each([
    ["an unclosed quote", "echo 'never closed\n", /sample\.sh:1: ' never closes for this reader: check the quoting there/],
    ["an unclosed heredoc", "cat <<'EOF'\nnever closed\n", /sample\.sh:1: heredoc EOF never closes for this reader: check/],
    ["a heredoc fed to a shell with an unclosed quote", "bash <<EOF\necho 'never closed\nEOF\n", /' never closes .*: check/],
    ["an unclosed brace", "f() {\n  true\n", /sample\.sh:1: \{ never closes for this reader: check the quoting there/],
    ["a stray closer", "true\n}\n", /sample\.sh:2: \} closes nothing open for this reader/],
  ])("fails closed on %s", (_name, text, error) => {
    expect(() => scan([{ file: "sample.sh", text }])).toThrow(error);
  });

  it("finds no run of a program from the service account's directories in a root line", () => {
    const unexpected = tree()
      .hits.filter((hit) => !allowedFor(hit))
      .map(message);
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
      expect(hits.filter((h) => allowedFor(h) === entry).length, where).toBe(1);
    }
  });
});
