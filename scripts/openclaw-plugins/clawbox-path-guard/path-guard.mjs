// The rule behind ClawBox's protected-path deny, as pure functions.
//
// Split out of index.mjs for the same reason email-directives.mjs is: this half
// has no dependency on the plugin SDK, so the parity test can import it and run
// the same case table through it that it runs through the Hermes glob list.
//
// THE TABLE IS NOT HERE. config/protected-paths.json is the definition; this
// file only decides. See that file for which paths are protected and why, and
// for the tokens that count as destroying something.

import { readFileSync } from "node:fs";
import os from "node:os";

/**
 * The floor this module falls back to when the table cannot be read.
 *
 * NOT a second copy of the rule — the parity test asserts it is a SUBSET of the
 * shipped JSON — but the answer to a question this module cannot duck:
 * `mcp/lib/guard.ts` imports it, and that module's import graph IS the ClawBox
 * MCP server's startup. A throw here would take every device tool off the box,
 * the read-only ones included, over a truncated JSON file. Losing the
 * carve-outs and the exotic verbs is the safe direction to lose things in.
 */
const FLOOR = {
  pathRoots: ["/clawbox", "/llamacpp/models", "/embed/models"],
  writableSubpaths: [],
  pathTerminators: "/ ;&|'\")",
  tokenBoundary: "!a-z0-9_-",
  verbFirstTokens: ["rm ", "mv "],
  pathFirstTokens: ["rm ", "mv "],
  redirectionPrefixes: [">~", "> ~"],
};

/**
 * The table, from whichever of the two layouts this module is sitting in:
 * beside the plugin once gateway-pre-start.sh has copied it into
 * ~/.openclaw/extensions/clawbox-path-guard/, or at config/ in a checkout.
 *
 * Read at first USE rather than at import, so a module that merely imports this
 * file cannot fail to load because of it.
 */
let table;
function loadTable() {
  if (table) return table;
  for (const url of [
    new URL("./protected-paths.json", import.meta.url),
    new URL("../../../config/protected-paths.json", import.meta.url),
  ]) {
    try {
      const parsed = JSON.parse(readFileSync(url, "utf-8"));
      if (Array.isArray(parsed?.pathRoots) && parsed.pathRoots.length > 0) {
        table = parsed;
        return table;
      }
    } catch {
      // Try the other layout, then the floor.
    }
  }
  table = FLOOR;
  return table;
}

/** Exported so the parity test can prove the floor is a subset of the table. */
export function protectedPathTable() {
  return loadTable();
}
export const COMPILED_IN_FLOOR = FLOOR;

/**
 * The tool ids whose parameters name a file they are about to write.
 *
 * `read` is deliberately absent: the ruling forbids destroying these paths, not
 * looking at them. `exec` is handled by the command rules below instead, and
 * `apply_patch` is here because the host derives its target paths for us
 * (`event.derivedPaths`) while its command-shaped envelope carries none — the
 * core's own `tools.exec.applyPatch.workspaceOnly` already confines that tool
 * to the workspace by default, so this arm is a backstop for a box that has
 * turned it off rather than the only thing holding it.
 */
export const FILE_MUTATING_TOOLS = new Set(["write", "edit", "apply_patch"]);

/**
 * The tool ids whose parameters carry a command line, a script, or input for a
 * shell that is already running.
 *
 * `process` and `terminal` are the two that matter most and the two a shorter
 * list misses: `exec({command:"bash", pty:true, background:true})` names no
 * protected path, and `process({action:"write", data:"rm -rf …"})` then types
 * the delete into that session. The core's own exec description steers a model
 * there ("then process for logs/status/input/intervention"), and its security
 * notes name this exact drift — "mutating filesystem tools denied while
 * exec/process stay available". `bash` is the documented alias of `exec`.
 */
export const COMMAND_TOOLS = new Set(["exec", "bash", "code_execution", "process", "terminal"]);

/**
 * Fold an absolute home prefix into `~`, the way Hermes' own
 * `_normalize_command_for_detection` does before it matches a deny glob
 * (`tools/approval.py`, `_rewrite_resolved_user_home`).
 *
 * NOT cosmetic, and not only for parity: the appliance's home directory is
 * `/home/clawbox`, so the literal string `/home/clawbox/tmp/x` contains the
 * root `/clawbox` followed by a `/`. Without this fold every path in the
 * agent's home would match the ClawBox-tree rule and the guard would refuse
 * most of the box.
 *
 * `$HOME/clawbox/x` is NOT folded, here or in Hermes — neither side expands
 * shell variables — so that spelling reaches the root test unchanged and only
 * the OpenClaw `workdir` rule below can catch it.
 */
export function foldHome(text, home = os.homedir()) {
  if (typeof text !== "string" || !text) return "";
  if (typeof home !== "string" || home.length < 2) return text;
  // Only where the home prefix ends a path segment, so `/home/clawbox2/x` is
  // left alone rather than turned into `~2/x`.
  const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`${escaped}(?=[/\\s'"\`;|&<>()]|$)`, "g"), "~");
}

/** True when `text` at `at` starts a protected root that ends a path segment. */
function rootAt(text, at, root) {
  if (!text.startsWith(root, at)) return false;
  const next = text[at + root.length];
  return next === undefined || new Set([...loadTable().pathTerminators]).has(next);
}

/**
 * The first protected root in `text` at or after `from`, or null.
 *
 * The root must END a path segment: `~/clawbox` and `~/clawbox/data` are the
 * tree, `~/clawbox-notes.txt` is a file that merely starts the same way — so a
 * hit that does not end there is skipped and the search goes on.
 */
function findRoot(text, from = 0) {
  for (const root of loadTable().pathRoots) {
    let at = text.indexOf(root, from);
    while (at >= 0) {
      if (rootAt(text, at, root)) return { root, end: at + root.length };
      at = text.indexOf(root, at + 1);
    }
  }
  return null;
}

/**
 * The first index at or after `from` where `token` appears as a WORD — start of
 * string, or preceded by something that is not a word character or a dash — or
 * -1.
 *
 * The trailing space in `"rm "` keeps it out of `rmdir`; this keeps it out of
 * `confirm the models`, `xterm -e ls ~/clawbox` and `grep -rn "rm " scripts`,
 * every one of which the substring form refused. The Hermes side gets the same
 * boundary as an fnmatch negated class; `tokenBoundary` in the table is the one
 * definition of it.
 */
function indexOfToken(text, token, from = 0) {
  // `tokenBoundary` is written in fnmatch's syntax, because the Hermes side
  // splices it straight into a glob; `!` is fnmatch's negation and `^` is
  // JavaScript's, so the one character is translated here rather than the class
  // being written out twice.
  const boundary = new RegExp(`[${loadTable().tokenBoundary.replace(/^!/, "^")}]`);
  let at = text.indexOf(token, from);
  while (at >= 0) {
    if (at === 0 || boundary.test(text[at - 1])) return at;
    at = text.indexOf(token, at + 1);
  }
  return -1;
}

/**
 * Why this command line is refused, or null.
 *
 * The three rules are the ones the Hermes deny globs express, in the same
 * order, so that one case table can hold both sides to the same answer:
 *
 *   A  a destroying token, then a protected root
 *   B  a protected root, then a destroying token
 *   C  a redirection straight into a protected root
 *
 * Matching is case-insensitive on both sides. Rules A and B are substring rules
 * over the WHOLE command line, so a compound command that destroys something
 * elsewhere and merely mentions a protected path in its other half —
 * `rm /tmp/x && du -sh ~/clawbox/data` — is refused too. That is the cost of a
 * rule that cannot parse a shell, and it is paid deliberately: the refusal text
 * names the rule, so the agent can re-issue the two halves separately.
 *
 * THE WRITABLE CARVE-OUTS DO NOT APPLY HERE, only to paths. A shell `rm` inside
 * the tree is what cost a customer a 3.2 GB download; a code project's files
 * are written by file tools, never by `rm`. Keeping commands exempt-free is
 * also what keeps the two harnesses answering identically, since fnmatch cannot
 * express an exception at all.
 */
export function commandDenyReason(command, home = os.homedir()) {
  if (typeof command !== "string" || !command) return null;
  const t = loadTable();
  const text = foldHome(command, home).toLowerCase();

  for (const token of t.verbFirstTokens) {
    const at = indexOfToken(text, token.toLowerCase());
    if (at < 0) continue;
    const hit = findRoot(text, at + token.length);
    if (hit) return `\`${token.trim()}\` targeting ${hit.root}`;
  }

  const rootHit = findRoot(text);
  if (rootHit) {
    for (const token of t.pathFirstTokens) {
      if (indexOfToken(text, token.toLowerCase(), rootHit.end) >= 0) {
        return `\`${token.trim()}\` after ${rootHit.root}`;
      }
    }
  }

  // Every occurrence, not the first: `echo a > ~/clawbox-backup/x; echo b >
  // ~/clawbox/data/config.json` truncates a protected file after a look-alike
  // sibling, and stopping at the first hit let it through here while the Hermes
  // globs — which have no such notion of "first" — denied it.
  for (const prefix of t.redirectionPrefixes) {
    for (const root of t.pathRoots) {
      let at = text.indexOf(prefix + root);
      while (at >= 0) {
        if (rootAt(text, at + prefix.length, root)) return `a redirection into ${root}`;
        at = text.indexOf(prefix + root, at + 1);
      }
    }
  }

  return null;
}

/**
 * Why this PATH may not be written, or null.
 *
 * The carve-outs live here rather than in the command rules: `data/` is inside
 * the checkout on a shipped box, so `/clawbox` covers every one of the subtrees
 * `src/lib/file-guard.ts` declares public — and `code_project_init` hands the
 * agent absolute paths under `data/code-projects` with "edit them with your own
 * file tools", there being no `code_file_write` tool. Denying those would have
 * taken multi-file web apps off the OpenClaw edition.
 */
export function pathDenyReason(candidate, home = os.homedir()) {
  if (typeof candidate !== "string" || !candidate) return null;
  const text = foldHome(candidate, home).toLowerCase().replace(/\/+$/, "");
  for (const allowed of loadTable().writableSubpaths) {
    const at = text.indexOf(allowed.toLowerCase());
    if (at < 0) continue;
    const next = text[at + allowed.length];
    if (next === undefined || next === "/") return null;
  }
  const hit = findRoot(text);
  return hit ? hit.root : null;
}

/** True when this directory is, or is inside, a protected path. */
export function isProtectedDirectory(dir, home = os.homedir()) {
  return pathDenyReason(dir, home) !== null;
}

/**
 * The destroying token this text uses, or null — the half of the command rules
 * that asks nothing about paths.
 *
 * It exists because two callers already know the path: the `workdir` rule below
 * and ClawBox's own `bash` tool, which is handed a `cwd`. For them the question
 * is only "does this command destroy something", and answering it by splicing a
 * protected path onto the end of the command and re-running the full matcher —
 * which is what that code did first — is a trick, not a rule.
 */
export function destructiveToken(text, home = os.homedir()) {
  if (typeof text !== "string" || !text) return null;
  const t = loadTable();
  const lower = foldHome(text, home).toLowerCase();
  for (const token of [...t.verbFirstTokens, ...t.pathFirstTokens]) {
    if (indexOfToken(lower, token.toLowerCase()) >= 0) return token.trim();
  }
  return null;
}

function stringParams(params) {
  if (!params || typeof params !== "object") return [];
  return Object.values(params).filter((value) => typeof value === "string");
}

/**
 * The string parameter values that can be naming a file.
 *
 * By SHAPE, not by key name: the core's own parameter names for `write` and
 * `edit` are not in the published tool reference, and a guard pinned to a name
 * that is later spelled differently is a guard that silently stops guarding.
 * A path never contains a newline, so dropping multi-line values keeps a patch
 * body or a file's contents from being read as a target.
 *
 * ONLY when the host told us nothing. `derivedPaths` is the host's own answer
 * to "what will this touch", and where it exists this shape-guess is not just
 * unnecessary but wrong: it also refuses a single-line `edit` whose replacement
 * text merely NAMES the tree — a PATH line in `~/.bashrc`, a note citing the
 * model folder.
 */
function* pathLikeValues(params) {
  if (!params || typeof params !== "object") return;
  for (const value of Object.values(params)) {
    if (typeof value !== "string" || !value || value.includes("\n")) continue;
    yield value;
  }
}

/**
 * Why this tool call is refused, or null.
 *
 * `event` is the core's `before_tool_call` event: `toolName`, `params`, and the
 * optional host-derived `derivedPaths` (documented as best-effort and possibly
 * over-approximate — over-approximate is the safe direction for a deny).
 */
export function toolCallDenyReason(event, home = os.homedir()) {
  const toolName = typeof event?.toolName === "string" ? event.toolName : "";
  const params = event?.params;

  if (FILE_MUTATING_TOOLS.has(toolName)) {
    const derived = Array.isArray(event?.derivedPaths)
      ? event.derivedPaths.filter((p) => typeof p === "string")
      : [];
    const candidates = derived.length > 0 ? derived : [...pathLikeValues(params)];
    for (const candidate of candidates) {
      const root = pathDenyReason(candidate, home);
      if (root) return `\`${toolName}\` writing inside ${root}`;
    }
    return null;
  }

  if (!COMMAND_TOOLS.has(toolName)) return null;

  // Every string parameter, for the same reason pathLikeValues takes them all:
  // `exec` documents `command`, `process` carries its input as `data`,
  // `literal` or `text` depending on the action, and `code_execution` does not
  // publish the key its script arrives under.
  for (const value of stringParams(params)) {
    const reason = commandDenyReason(value, home);
    if (reason) return reason;
  }

  // WORKING DIRECTORY — the OpenClaw half of this guard that Hermes has no way
  // to express. `cd ~/clawbox/data/llamacpp/models && rm big.gguf` reaches a
  // command-text matcher as two tokens it cannot relate; here the directory is
  // a parameter, so a destroying token issued FROM inside a protected path is
  // refused whatever it names.
  const workdir = params && typeof params === "object" ? params.workdir ?? params.cwd : undefined;
  if (isProtectedDirectory(workdir, home)) {
    const token = destructiveToken(stringParams(params).join("\n"), home);
    if (token) return `\`${token}\` run from inside ${workdir}`;
  }

  return null;
}

/** The refusal the agent is handed. It says what to tell the owner. */
export function denyMessage(reason) {
  return (
    `Blocked by ClawBox: ${reason}. The ClawBox install tree and the local-model `
    + `folders are protected on this device — deleting, overwriting, truncating or `
    + `moving anything inside them is refused, and no approval can lift it. Do not `
    + `retry or rephrase; tell the owner what you were asked to do and that the `
    + `device refused it.`
  );
}
