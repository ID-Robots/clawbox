import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  blankSingleQuoted,
  functionDefs,
  type Line,
  logicalLines,
  singleQuotedSpans,
  sudoWrappers,
} from "../helpers/shell-reader";

// This file starts no process, but one sample row holds a `node -e` program
// that names child_process, and test-timeout-hygiene reads that text as a spawn.
// The ceilings cost nothing here and keep that guard's reader simple.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * Root runs nothing from the tree (docs/agents/update-and-install.md): no line
 * of install.sh, which runs as root top to bottom, runs a program out of the
 * service account's directories, its home (the npm prefix and bun live there)
 * or the checkout. Those files belong to the service account. Ask it as the
 * service account, or read the file as data.
 *
 * Read: install.sh only; the scripts root runs from config/ and scripts/ have
 * tests of their own.
 *
 * Tainted: CLAWBOX_HOME, PROJECT_DIR, NPM_PREFIX and the literal /home/clawbox;
 * every standalone assignment (bare, local, export, readonly, declare) whose
 * value BEGINS with a tainted expansion, `${a:-$b}` when either side is, or
 * with a substitution, `$(…)` or backquoted, that keeps a tainted path
 * (`dirname`, `readlink`, `realpath`, `cd … && pwd`); an array whose first
 * element is; a for-loop variable over a tainted word; and a function's `$N`
 * when a call passes it a tainted word. A `NAME=value` before a command or
 * after `env` taints nothing, and neither does any other command substitution.
 * `local` and parameter taint stay in their function.
 *
 * A run: a tainted word as a command (after `NAME=value` words, keywords,
 * `exec`, `time`, `command`, `builtin`, `env …`, a root `sudo`, or a runuser,
 * su or `sudo -u` whose target is root), as the script of
 * bash/sh/dash/node/python3/perl, as a module node preloads (`-r`, `--require`,
 * `--import`), or as the file of `source`/`.`. Before the script, any word that
 * starts with `-` is an option (`-0777`, `-i.bak`); a value-taking option's
 * value is skipped when it is a letter this file lists or one of the long
 * options it lists for node and bash. A program handed over as text (`bash -c`,
 * `node -e`/`-p`, `python3 -c`, `perl -e`, a root `su -c`/`-lc`, and
 * `python3 -cTEXT`/`perl -eTEXT` glued) is a run when it names the account's
 * directories: a `$NAME` of one outside single quotes (escaped or not), or the
 * literal home anywhere in it. The guard does not read that text as its
 * language, so it cannot tell a run there from a read. A trap's text is read as
 * shell where the trap is set, with the `$…` that the setting shell expands
 * judged as expansions even between single quotes inside double ones. Every
 * `$(…)`, backquote and `<(…)` is read as root's own command text, inside a
 * wrapper's arguments and in the body of an unquoted heredoc too: root's shell
 * expands it before the wrapper starts, and while it writes the heredoc.
 *
 * Not a run: a command whose own command word switches to the service account
 * (as_clawbox, as_clawbox_login, as_user*, runuser, su and `sudo -u` with a
 * target other than root, the git runner, or a function that forwards its
 * arguments through one), which covers that command's own words only; arguments
 * and redirection targets; a program on stdin (`-`, `-s`) or a module (`-m`); a
 * program given as text that names none of the account's directories; tests;
 * case patterns; comments; other single-quoted text; the text of a heredoc body
 * that is not fed to a shell, and all of a quoted one (`<<'EOF'`).
 *
 * Known limits: a wrapper or launcher this file does not name (`nohup`,
 * `xargs`, `find -exec`, `systemd-run`), `eval`, what a program given as text
 * does with its arguments or environment, a long option this file does not list
 * whose value is the next word (that value is read as the script), program text
 * held in a variable whose value does not begin with the account's path, a
 * heredoc fed to a shell under a wrapper, which reads as root (the safe
 * direction), a switch target known only at run time, which is taken to be the
 * account it names (a name the file ever sets to root, or a `${X:-root}`
 * default, reads as root), and a path is judged where it is run: the guard does
 * not follow it through a copy (`install`, `cp`).
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
interface Interpreter {
  /** Option letters whose operand is the program as text (a shell's `-c` takes its first operand). */
  program: string;
  /** Option letters after which there is no script file: stdin, a module. */
  none: string;
  /** Option letters that take a value. */
  takesArg: string;
  /** Long options whose value is the program as text. */
  long?: string[];
  /** Long options that take a value, as the next word unless glued with `=`. */
  longArgs?: string[];
  /** A shell: `-c` takes no value of its own; the program is the first operand. */
  shell?: boolean;
  /** The program letter takes the rest of its word when there is any (`python3 -cTEXT`, `perl -eTEXT`). */
  glues?: boolean;
}

const SHELL: Interpreter = {
  program: "c",
  none: "s",
  takesArg: "oO",
  longArgs: ["--rcfile", "--init-file"],
  shell: true,
};
const INTERPRETERS: Record<string, Interpreter> = {
  bash: SHELL,
  sh: SHELL,
  dash: SHELL,
  node: {
    program: "ep",
    none: "",
    takesArg: "rC",
    long: ["--eval", "--print"],
    longArgs: [
      "--require",
      "--import",
      "--loader",
      "--experimental-loader",
      "--env-file",
      "--title",
      "--conditions",
      "--input-type",
    ],
  },
  python3: { program: "c", none: "m", takesArg: "WX", glues: true },
  perl: { program: "eE", none: "", takesArg: "", glues: true },
};
const PREFIX_KEYWORDS = new Set(["if", "then", "elif", "else", "do", "while", "until", "!"]);
const DECLARATIONS = new Set(["local", "export", "readonly", "declare", "typeset"]);
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?\+?=([\s\S]*)$/;
const RULE = 'Rule: docs/agents/update-and-install.md, "Root runs nothing from the tree".';
const REMEDY =
  'Run it as the service account (runuser -u "$CLAWBOX_USER" -- env HOME="$CLAWBOX_HOME" …, or as_clawbox), ' +
  `or read the file as data. ${RULE}`;
/** This guard does not read the program's language, so it cannot tell a run from a read there. */
const PROGRAM_REMEDY =
  "If the program only reads the file as data, pass the path to it as an argument; if it runs or loads " +
  `it, run the program as the service account (runuser -u "$CLAWBOX_USER" -- env HOME="$CLAWBOX_HOME" …, ` +
  `or as_clawbox). ${RULE}`;

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
  /** The word is a program handed over as text, not a file run by name. */
  program: boolean;
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
  /** Modules node loads before its program: `-r`, `--require`, `--import`. */
  preloads: Word[];
  /** A program root hands an interpreter, or a root `su -c`, as text. */
  programs: Word[];
  /** Text a trap hands root's own shell, read as shell where it is set. */
  shellText: Word[];
  wrapped: boolean;
  assigns: { name: string; value: string; local: boolean }[];
  /** Names a `local` declares, assigned or not. */
  locals: string[];
  call?: { name: string; args: Word[] };
}

/** The script file an interpreter's argv names, or the program it hands it as text; neither for stdin or a module. */
function operands(spec: Interpreter, args: Word[]): { script?: Word; program?: Word } {
  let text = false;
  const operand = (w: Word | undefined): { script?: Word; program?: Word } => (text ? { program: w } : { script: w });
  for (let j = 0; j < args.length; j += 1) {
    const r = bare(args[j].raw);
    if (r === "-") return {};
    if (r === "--") return operand(args[j + 1]);
    if (r.startsWith("--")) {
      const name = r.split("=")[0];
      if (spec.long?.includes(name)) return { program: r.includes("=") ? gluedValue(args[j]) : args[j + 1] };
      if (spec.longArgs?.includes(name) && !r.includes("=")) j += 1;
      continue;
    }
    if (/^-./.test(r) || /^\+[A-Za-z]/.test(r)) {
      // An option, never the script, whatever follows its dash (`-0777`). Its
      // leading letters are read the way the interpreter reads them: the first
      // letter that takes a value or the program takes the rest of the word
      // (`-cTEXT`, `-i.bak`), or the next word when nothing follows.
      const word = /^[-+]/.test(args[j].raw) ? args[j].raw : r;
      const letters = /^[-+]([A-Za-z]*)/.exec(word)?.[1] ?? "";
      for (let n = 0; n < letters.length; n += 1) {
        const l = letters[n];
        const glued = word.slice(n + 2);
        if (spec.none.includes(l)) return {};
        if (spec.program.includes(l) && !spec.shell) {
          return { program: glued && spec.glues ? { raw: glued, subs: [] } : args[j + 1] };
        }
        if (spec.program.includes(l)) text = true;
        else if (spec.takesArg.includes(l)) {
          if (!glued) j += 1;
          break;
        }
      }
      continue;
    }
    return operand(args[j]);
  }
  return {};
}

/** The value of a glued `--option=value` word, as written. */
const gluedValue = (w: Word): Word => ({ raw: w.raw.slice(w.raw.indexOf("=") + 1), subs: [] });

/** The text of `su -c TEXT`, `-lc TEXT`, `-cTEXT` or `--command TEXT` (runuser's su form too). */
function commandOption(args: Word[]): Word | undefined {
  for (let j = 0; j < args.length; j += 1) {
    const r = bare(args[j].raw);
    if (r === "--command" || r === "--session-command") return args[j + 1];
    if (/^--(?:session-)?command=/.test(r)) return gluedValue(args[j]);
    const cluster = /^-[lmpfP]*c/.exec(args[j].raw);
    if (cluster) {
      const glued = args[j].raw.slice(cluster[0].length);
      return glued ? { raw: glued, subs: [] } : args[j + 1];
    }
  }
  return undefined;
}

/** The account's home written out anywhere in a word, not only at its start. */
const LITERAL_ANYWHERE = /\/home\/clawbox(?![A-Za-z0-9_.-])/;

/**
 * Whether a program handed over as text names the service account's
 * directories: the literal home anywhere in it, or a tainted expansion where
 * root's shell expands it (outside single quotes; a `'` inside `"…"` is a
 * character). The guard does not read node, python or a `-c` shell program as
 * its language, so naming the path there counts as running it.
 */
function namesTainted(raw: string, fn: string | null, taint: Taint): boolean {
  if (LITERAL_ANYWHERE.test(raw)) return true;
  const expanded = blankSingleQuoted(raw);
  for (let i = expanded.indexOf("$"); i >= 0; i = expanded.indexOf("$", i + 1)) {
    if (beginsTainted(expanded.slice(i), fn, taint)) return true;
  }
  return false;
}

/**
 * Double-quoted text with its `'…'` pairs read as `"…"`. To the shell that
 * sets a trap they are characters, and what it expands lands between them
 * (`trap "'$BIN' x" EXIT` runs the value of BIN), so the `$…` inside must stay
 * expansions for the reader. A pair that holds a `"`, or a lone `'`, is left
 * as written.
 */
function openSingleQuotes(text: string): string {
  const out = text.split("");
  for (const [start, end] of singleQuotedSpans(text)) {
    if (end >= text.length || text.slice(start, end).includes('"')) continue;
    out[start - 1] = '"';
    out[end] = '"';
  }
  return out.join("");
}

/** A word's text as the shell that runs it reads it: quotes removed, escapes resolved, `$…` kept as written. */
function unquote(raw: string): string {
  let out = "";
  let i = 0;
  while (i < raw.length) {
    const c = raw[i];
    if (c === "'" || (c === "$" && raw[i + 1] === "'")) {
      const from = c === "'" ? i + 1 : i + 2;
      const end = raw.indexOf("'", from);
      out += raw.slice(from, end < 0 ? raw.length : end);
      i = end < 0 ? raw.length : end + 1;
    } else if (c === '"') {
      const end = skip(raw, i + 1, '"', null);
      out += openSingleQuotes(raw.slice(i + 1, end - 1).replace(/\\([$`"\\])/g, "$1"));
      i = end;
    } else if (c === "\\") {
      out += raw[i + 1] ?? "";
      i += 2;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/** node's preload operands: they run at startup even when the program is `-e` text. */
function preloadOperands(args: Word[]): Word[] {
  const out: Word[] = [];
  for (let j = 0; j < args.length; j += 1) {
    const r = bare(args[j].raw);
    if (r === "--" || !r.startsWith("-")) break;
    if (r === "-r" || r === "--require" || r === "--import") {
      if (args[j + 1]) out.push(args[j + 1]);
      j += 1;
    } else {
      const glued = /^(?:-r|--require=|--import=)(.+)$/.exec(args[j].raw.replace(/^["']/, ""));
      if (glued) out.push({ raw: glued[1], subs: [] });
    }
  }
  return out;
}

/** A switch target that is root after all: `-u root`, `-u 0`, sudo's `-u '#0'`. */
const ROOT_TARGET = /^(?:root|#?0)$/;
/** `NAME=root`, `local NAME="0"`: a name the file sets to root somewhere. */
const ROOT_ASSIGNMENT = /(?:^|[\s;&|(])([A-Za-z_][A-Za-z0-9_]*)=(["']?)(?:root|#?0)\2(?=$|[\s;&|)])/g;

/** The names a file ever assigns a literal root to. */
function rootValued(lines: Line[]): Set<string> {
  const names = new Set<string>();
  for (const { text } of lines) for (const m of blankSingleQuoted(text).matchAll(ROOT_ASSIGNMENT)) names.add(m[1]);
  return names;
}

/**
 * Whether a switch target is root: the literal, a variable the file ever sets
 * to root, or a default that is root (`${RUN_AS:-root}`). A target known only
 * at run time (`$owner` from stat, checked against root before use) is taken
 * to be the account it names.
 */
function isRootTarget(target: string, rootNames: Set<string>): boolean {
  if (ROOT_TARGET.test(target)) return true;
  const m = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)(?::?[-=](root|#?0))?\}?$/.exec(target);
  return !!m && (rootNames.has(m[1]) || m[2] !== undefined);
}
/** runuser and su options that take a value, alone or after their flags that take none (`-lc`). */
const SWITCH_VALUE_OPTION =
  /^(?:-[lmpfP]*[gGcsw]|--(?:group|supp-group|command|session-command|shell|whitelist-environment))$/;

/**
 * Who runuser or su runs as, and where its command starts. `-u USER [--] cmd`
 * names both. su's positional USER is followed by arguments to a shell, so
 * there is no command word to read. No target at all means root.
 */
function switchOf(args: Word[]): { target?: string; command?: number } {
  let target: string | undefined;
  let byOption = false;
  for (let j = 0; j < args.length; j += 1) {
    const r = bare(args[j].raw);
    if (r === "-u" || r === "--user") {
      target = bare(args[j + 1]?.raw ?? "");
      byOption = true;
      j += 1;
    } else if (/^-u./.test(r) || r.startsWith("--user=")) {
      target = r.replace(/^(?:-u|--user=)/, "");
      byOption = true;
    } else if (r === "--") {
      if (byOption) return { target, command: j + 1 };
    } else if (SWITCH_VALUE_OPTION.test(r)) j += 1;
    else if (r.startsWith("-")) continue;
    else if (byOption) return { target, command: j };
    else return { target: r };
  }
  return { target };
}

function shapeOf(command: Command, wrappers: Set<string>, functions: Set<string>, rootNames: Set<string>): Shape {
  const shape: Shape = { wrapped: false, assigns: [], locals: [], preloads: [], programs: [], shellText: [] };
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
    if (word === "exec" || word === "time" || word === "command" || word === "builtin") {
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
      let target: string | undefined;
      while (k < words.length && bare(words[k].raw).startsWith("-")) {
        const r = bare(words[k].raw);
        k += 1;
        if (r === "--") break;
        if (/^-[A-Za-z]*u$/.test(r) || r === "--user") {
          target = bare(words[k]?.raw ?? "");
          k += 1;
        } else if (/^-[A-Za-z]*u./.test(r) || r.startsWith("--user=")) {
          target = r.replace(/^(?:-[A-Za-z]*u|--user=)/, "");
        } else if (/^-[A-Za-z]*[gCDhprtUT]$/.test(r)) k += 1;
      }
      // `sudo -u <user>` switches; a bare sudo, or `-u root`, runs its command as root.
      if (target !== undefined && !isRootTarget(target, rootNames)) {
        shape.wrapped = true;
        return shape;
      }
      continue;
    }
    if (word === "runuser" || word === "su") {
      const args = words.slice(k + 1);
      const { target, command: at } = switchOf(args);
      if (target !== undefined && !isRootTarget(target, rootNames)) {
        shape.wrapped = true;
        return shape;
      }
      // Root after all: read the command it runs, or the `-c` text it hands a shell.
      if (at === undefined) {
        const text = commandOption(args);
        if (text) shape.programs.push(text);
        return shape;
      }
      k += 1 + at;
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
  if (name === "trap") {
    const args = words.slice(k + 1);
    const from = bare(args[0]?.raw ?? "") === "--" ? 1 : 0;
    const text = args[from];
    // `trap - SIG`, `trap -p` and a lone operand set no text.
    if (text && args.length > from + 1 && !text.raw.startsWith("-")) shape.shellText.push(text);
    return shape;
  }
  const interpreter = INTERPRETERS[name.replace(/^.*\//, "")];
  if (interpreter) {
    const { script, program } = operands(interpreter, words.slice(k + 1));
    shape.candidate = script;
    if (program) shape.programs.push(program);
    if (interpreter === INTERPRETERS.node) shape.preloads = preloadOperands(words.slice(k + 1));
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

/**
 * Commands whose output is a path made from their operand: its directory, its
 * resolved form. Taken as the account's path when the operand is one, which
 * errs toward a hit (`dirname "$CLAWBOX_HOME"` is /home).
 */
const PATH_KEEPERS = new Set(["dirname", "readlink", "realpath"]);

/**
 * Whether a command substitution prints a path made from one in the service
 * account's directories: `dirname`, `readlink` or `realpath` of a tainted
 * path, or `cd` into one and then `pwd`.
 */
function keepsPath(command: string, fn: string | null, taint: Taint): boolean {
  const tokens = tokenize(command);
  const words: Word[] = [];
  let k = 0;
  for (; k < tokens.length; k += 1) {
    const tok = tokens[k];
    if (tok.t === "op") break;
    if (tok.t === "redir") k += 1;
    else words.push(tok);
  }
  const name = bare(words[0]?.raw ?? "");
  const operand = words.slice(1).find((w) => !bare(w.raw).startsWith("-"));
  if (!operand || !beginsTainted(operand.raw, fn, taint)) return false;
  if (PATH_KEEPERS.has(name)) return true;
  // `cd DIR && pwd`, `cd DIR; pwd`, `cd DIR || exit; pwd`: a later command is pwd.
  const later = tokens.slice(k);
  return name === "cd" && later.some((t, n) => t.t === "word" && bare(t.raw) === "pwd" && later[n - 1]?.t === "op");
}

/** Whether a word, as written, begins with the service account's directory. */
function beginsTainted(raw: string, fn: string | null, taint: Taint): boolean {
  const text = raw.replace(/^["']/, "");
  if (LITERAL.test(text)) return true;
  if (raw.startsWith("'")) return false;
  if (text.startsWith("$(") && text[2] !== "(") return keepsPath(text.slice(2, skip(text, 2, ")", null) - 1), fn, taint);
  if (text.startsWith("`")) return keepsPath(text.slice(1, skip(text, 1, "`", null) - 1), fn, taint);
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

/** Shell text read as lines in `at`'s function, its commands added to `out`; it fails closed like a file. */
function readText(text: string, at: Command, out: Command[], file: string): void {
  const state: ParseState = { frames: [], pendingFn: null };
  const lines = joinArrays(logicalLines(text, file, at.lineNo - 1, { heredocSubstitutions: true }), file);
  for (const line of lines) parse(line.text, line.lineNo, state, at.fn, out, file);
  const open = state.frames[0];
  if (open) throw lost(`${file}:${open.lineNo}`, `${open.kind} never closes`);
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
    const logical = logicalLines(text, file, 0, { heredocSubstitutions: true });
    lines += logical.length;
    const wrappers = sudoWrappers(functionDefs(logical), ACCOUNT_SWITCHES);
    const commands: Command[] = [];
    const state: ParseState = { frames: [], pendingFn: null };
    for (const line of joinArrays(logical, file)) parse(line.text, line.lineNo, state, null, commands, file);
    const open = state.frames[0];
    if (open) throw lost(`${file}:${open.lineNo}`, `${open.kind} never closes`);
    const functions = new Set(commands.map((c) => c.fn).filter((f): f is string => !!f));
    const rootNames = rootValued(logical);
    const shapes: Shape[] = [];
    // A trap's text is root's shell too, run later in the same function: its
    // commands join the list, read like any other line.
    for (let n = 0; n < commands.length; n += 1) {
      shapes.push(shapeOf(commands[n], wrappers, functions, rootNames));
      for (const text of shapes[n].shellText) readText(unquote(text.raw), commands[n], commands, file);
    }
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
      const runs = [s.candidate, ...s.preloads].filter((w): w is Word => !!w && beginsTainted(w.raw, fn, taint));
      const programs = s.programs.filter((w) => namesTainted(w.raw, fn, taint));
      for (const [run, program] of [...runs.map((w) => [w, false] as const), ...programs.map((w) => [w, true] as const)]) {
        const key = `${lineNo} ${run.raw}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push({ file, lineNo, word: run.raw, text: line.trim(), program });
      }
    });
  }
  return { lines, tainted, wrapped, hits };
}

const tree = (): ReturnType<typeof scan> =>
  scan([{ file: "install.sh", text: fs.readFileSync(path.join(REPO, "install.sh"), "utf-8") }]);

const allowedFor = (hit: Hit): Allowed | undefined =>
  ALLOWED.find((a) => a.file === hit.file && a.word === hit.word && hit.text.includes(a.line));

const message = (h: Hit): string =>
  h.program
    ? `${h.file}:${h.lineNo}: root hands ${h.word} to a program as text, and it names the service account's ` +
      `directories. ${PROGRAM_REMEDY}`
    : `${h.file}:${h.lineNo}: root runs ${h.word} from the service account's directories. ${REMEDY}`;

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
  [
    "a substitution in an unquoted heredoc nothing runs",
    ["cat > /tmp/v <<EOF", 'v=$("$OPENCLAW_BIN" --version)', "EOF"],
    2,
    '"$OPENCLAW_BIN"',
  ],
  ["a backquote in an unquoted heredoc", ["cat <<EOF", 'v=`"$OPENCLAW_BIN" --version`', "EOF"], 2, '"$OPENCLAW_BIN"'],
  ["a node preload before -e text", [`node -r "$PROJECT_DIR/hook.cjs" -e '0'`], 1, '"$PROJECT_DIR/hook.cjs"'],
  ["a glued node preload", ['node --require="$PROJECT_DIR/hook.cjs" -e 0'], 1, '"$PROJECT_DIR/hook.cjs"'],
  ["runuser to root", ['runuser -u root -- "$OPENCLAW_BIN" --version'], 1, '"$OPENCLAW_BIN"'],
  ["runuser to uid 0, through env", ['runuser -u 0 -- env HOME=/root "$OPENCLAW_BIN" x'], 1, '"$OPENCLAW_BIN"'],
  ["sudo -u root", ['sudo -u root "$OPENCLAW_BIN" --version'], 1, '"$OPENCLAW_BIN"'],
  [
    "a function that forwards to root",
    ['as_root() { runuser -u root -- "$@"; }', 'as_root "$OPENCLAW_BIN" x'],
    1,
    '"$@"',
  ],
  ["a target the file sets to root", ["target=root", 'runuser -u "$target" -- "$OPENCLAW_BIN" --version'], 2, '"$OPENCLAW_BIN"'],
  ["a sudo target that defaults to root", ['sudo -u "${RUN_AS:-root}" "$OPENCLAW_BIN" x'], 1, '"$OPENCLAW_BIN"'],
  ["a double-quoted bash -c program", ['bash -c "\\"$OPENCLAW_BIN\\" --version"'], 1, '"\\"$OPENCLAW_BIN\\" --version"'],
  ["a root sudo's sh -c program", ['sudo sh -c "$OPENCLAW_BIN --version"'], 1, '"$OPENCLAW_BIN --version"'],
  ["su to root with a -c program", ['su root -c "$OPENCLAW_BIN x"'], 1, '"$OPENCLAW_BIN x"'],
  ["su with no user and a glued program", ['su --command="$BUN x"'], 1, '"$BUN x"'],
  ["su -lc to root", ['su -lc "\\"$OPENCLAW_BIN\\" x"'], 1, '"\\"$OPENCLAW_BIN\\" x"'],
  ["runuser -lc to root", ['runuser -lc "\\"$OPENCLAW_BIN\\" x"'], 1, '"\\"$OPENCLAW_BIN\\" x"'],
  ["su - -c to root", ['su - -c "$BUN x"'], 1, '"$BUN x"'],
  ["su with -c glued to its program", ['su -c"\\"$OPENCLAW_BIN\\" x"'], 1, '"\\"$OPENCLAW_BIN\\" x"'],
  [
    "a node -e program after --require and its value",
    [`node --require /usr/lib/a.js -e "require('$PROJECT_DIR/x.js')"`],
    1,
    `"require('$PROJECT_DIR/x.js')"`,
  ],
  ["a node script after --import and its value", ['node --import /usr/lib/a.mjs "$PROJECT_DIR/app.js"'], 1, '"$PROJECT_DIR/app.js"'],
  ["a bash -c program after --rcfile and its value", ['bash --rcfile /etc/bash.bashrc -c "\\"$OPENCLAW_BIN\\" x"'], 1, '"\\"$OPENCLAW_BIN\\" x"'],
  ["a perl -e program after -i.bak", [`perl -i.bak -e "do '$PROJECT_DIR/x.pl'" /etc/x`], 1, `"do '$PROJECT_DIR/x.pl'"`],
  ["a python3 program glued to -c", [`python3 -c"exec(open('$PROJECT_DIR/x').read())"`], 1, `"exec(open('$PROJECT_DIR/x').read())"`],
  ["a perl program glued to -e", [`perl -e"do '$PROJECT_DIR/x.pl'"`], 1, `"do '$PROJECT_DIR/x.pl'"`],
  ["a perl -e program after an option that starts with a digit", [`perl -0777 -e "do '$PROJECT_DIR/x.pl'"`], 1, `"do '$PROJECT_DIR/x.pl'"`],
  [
    "a python3 -c program after an option that starts with a digit",
    [`python3 -1 -c "exec(open('$PROJECT_DIR/x').read())"`],
    1,
    `"exec(open('$PROJECT_DIR/x').read())"`,
  ],
  ["a script after an option that starts with a digit", ['perl -00 "$PROJECT_DIR/x.pl"'], 1, '"$PROJECT_DIR/x.pl"'],
  ["a glued node --eval program", [`node --eval="require('$PROJECT_DIR/x.js')"`], 1, `"require('$PROJECT_DIR/x.js')"`],
  ["a node -p program", [`node -p "require('$NPM_PREFIX/lib/x.js')"`], 1, `"require('$NPM_PREFIX/lib/x.js')"`],
  ["a perl -e program", [`perl -e "do '$PROJECT_DIR/x.pl'"`], 1, `"do '$PROJECT_DIR/x.pl'"`],
  ["an unquoted -c operand", ["bash -c $OPENCLAW_BIN"], 1, "$OPENCLAW_BIN"],
  [
    "a parameter inside a double-quoted program",
    ['probe() { bash -c "\\"$1\\" --version"; }', 'probe "$OPENCLAW_BIN"'],
    1,
    '"\\"$1\\" --version"',
  ],
  ["a node -e program that loads a path", [`node -e "require('$PROJECT_DIR/x.js')"`], 1, `"require('$PROJECT_DIR/x.js')"`],
  [
    "a python3 -c program that runs a file",
    [`python3 -c "exec(open('$PROJECT_DIR/x.py').read())"`],
    1,
    `"exec(open('$PROJECT_DIR/x.py').read())"`,
  ],
  [
    "the literal home inside a single-quoted node program",
    [`node -e 'require("child_process").execFileSync("/home/clawbox/.npm-global/bin/openclaw")'`],
    1,
    `'require("child_process").execFileSync("/home/clawbox/.npm-global/bin/openclaw")'`,
  ],
  ["single-quoted trap text", [`trap '"$OPENCLAW_BIN" x' EXIT`], 1, '"$OPENCLAW_BIN"'],
  ["double-quoted trap text", ['trap -- "\\"$BUN\\" x" EXIT'], 1, '"$BUN"'],
  ["a path in single quotes inside double-quoted trap text", [`trap "'$OPENCLAW_BIN' x" EXIT`], 1, '"$OPENCLAW_BIN"'],
  ["a script in single quotes inside double-quoted trap text", [`trap "bash '$PROJECT_DIR/a.sh'" EXIT`], 1, '"$PROJECT_DIR/a.sh"'],
  ["trap text through builtin", [`builtin trap '"$OPENCLAW_BIN" x' EXIT`], 1, '"$OPENCLAW_BIN"'],
  ["a value from dirname", ['V="$(dirname "$PROJECT_DIR")"', '"$V/bin/x"'], 2, '"$V/bin/x"'],
  ["a value from readlink -f", ['B="$(readlink -f "$OPENCLAW_BIN")"', '"$B" x'], 2, '"$B"'],
  ["a value from realpath", ['R="$(realpath "$NPM_PREFIX/bin/openclaw")"', '"$R" --version'], 2, '"$R"'],
  ["a value from a backquoted dirname", ['V=`dirname "$PROJECT_DIR"`', '"$V/bin/x"'], 2, '"$V/bin/x"'],
  ["a value from cd, a fallback and pwd", ['D="$(cd "$PROJECT_DIR" || exit 1; pwd)"', 'bash "$D/a.sh"'], 2, '"$D/a.sh"'],
  ["a value from cd and pwd", ['D="$(cd "$PROJECT_DIR/scripts" && pwd)"', 'bash "$D/a.sh"'], 2, '"$D/a.sh"'],
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
  ["su -lc to the account", ['su -lc "\\"$OPENCLAW_BIN\\" x" "$CLAWBOX_USER"', 'su -l "$CLAWBOX_USER" -c "$BUN x"']],
  ["node with a root-held --require value", ["node --require /usr/lib/a.js /usr/lib/app.js"]],
  ["a perl program that only reads a path after -0777", [`perl -0777 -ne 'print' "$PROJECT_DIR/x"`]],
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
  ["a double-quoted program that names no path", [`python3 -c "import sys; print(sys.argv[1])" "$PROJECT_DIR/x"`]],
  ["a -c program as the account", ['runuser -u "$CLAWBOX_USER" -- bash -c "\\"$OPENCLAW_BIN\\" x"']],
  [
    "trap text that runs as the account, resets or names a function",
    [
      `trap 'as_clawbox rm -rf -- "$dir" || echo "  WARN: could not remove $dir" >&2' EXIT`,
      "trap - EXIT",
      "trap cleanup EXIT",
      `trap "rm -rf '$tmp'" RETURN`,
    ],
  ],
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
  ["a value from a substitution that keeps no path", ['V="$(stat -c %U "$PROJECT_DIR")"', '"$V" --version']],
  ["a quoted heredoc", ["cat <<'EOF'", 'v=$("$OPENCLAW_BIN" --version)', "EOF"]],
  ["an escaped substitution in a heredoc", ["cat <<EOF", 'v=\\$("$OPENCLAW_BIN" --version)', "EOF"]],
  ["a heredoc's own text, quotes and all", ["cat <<EOF", `it's "$OPENCLAW_BIN", not run`, "EOF"]],
  ["a substitution in a heredoc that runs as the account", ["cat <<EOF", '$(as_clawbox "$OPENCLAW_BIN" --version)', "EOF"]],
  ["a node preload root holds", ["node -r /usr/lib/clawbox/hook.cjs -e 0"]],
  ["runuser and sudo to a named account", ['runuser -u clawbox -- "$OPENCLAW_BIN" x', 'sudo -u "$u_user" "$BUN" x']],
  [
    "a target known only at run time",
    ['owner="$(stat -c %U "$dir")"', '[ "$owner" != root ] || exit 0', 'runuser -u "$owner" -- "$OPENCLAW_BIN" x']],
  ["a word root in quoted text", ["echo 'target=root'", 'runuser -u "$target" -- "$OPENCLAW_BIN" x']],
];

describe("root runs nothing from the service account's directories in install.sh", () => {
  it("reads install.sh whole, so an empty result means something", () => {
    const { lines, tainted, wrapped } = tree();
    expect(lines).toBeGreaterThan(1000);
    // One name per way a path travels, so a reader that stops following it
    // fails here: an assignment from NPM_PREFIX, one from CLAWBOX_HOME, a
    // function parameter (verify_build_present's) and a `readlink -f` of a
    // tainted path.
    for (const name of ["OPENCLAW_BIN", "BUN", "project_dir", "managed_real"]) {
      expect(
        tainted.has(name),
        `${name}: this self-check expects install.sh to hold a path under the service account's directories in ` +
          `${name}. If a change renamed or removed ${name}, put a name here that install.sh still sets the same way.`,
      ).toBe(true);
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

  it("says what to do when a program's text names the service account's directories", () => {
    const [hit] = scan([{ file: "sample.sh", text: `python3 -c "print(open('$PROJECT_DIR/x').read())"` }]).hits;
    expect(message(hit)).toBe(
      `sample.sh:1: root hands "print(open('$PROJECT_DIR/x').read())" to a program as text, and it names the ` +
        "service account's directories. If the program only reads the file as data, pass the path to it as an " +
        "argument; if it runs or loads it, run the program as the service account " +
        '(runuser -u "$CLAWBOX_USER" -- env HOME="$CLAWBOX_HOME" …, or as_clawbox). ' +
        'Rule: docs/agents/update-and-install.md, "Root runs nothing from the tree".',
    );
  });

  it.each([
    ["an unclosed quote", "echo 'never closed\n", /sample\.sh:1: ' never closes for this reader: check the quoting there/],
    ["an unclosed heredoc", "cat <<'EOF'\nnever closed\n", /sample\.sh:1: heredoc EOF never closes for this reader: check/],
    ["a heredoc fed to a shell with an unclosed quote", "bash <<EOF\necho 'never closed\nEOF\n", /' never closes .*: check/],
    ["an unclosed brace", "f() {\n  true\n", /sample\.sh:1: \{ never closes for this reader: check the quoting there/],
    ["a stray closer", "true\n}\n", /sample\.sh:2: \} closes nothing open for this reader/],
    ["trap text with an unclosed quote", "trap 'echo \"never closed' EXIT\n", /sample\.sh:1: " never closes for this reader: check/],
    ["trap text with an unclosed brace", "trap '{ true' EXIT\n", /sample\.sh:1: \{ never closes for this reader: check/],
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
