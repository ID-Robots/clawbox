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
 * The table, from whichever of the two layouts this module is sitting in:
 * beside the plugin once gateway-pre-start.sh has copied it into
 * ~/.openclaw/extensions/clawbox-path-guard/, or at config/ in a checkout.
 *
 * A throw here is the right answer to a missing table: the plugin fails to
 * load, the gateway logs it by name, and nothing silently enforces an empty
 * rule set. The install step refuses to deploy the plugin without this file, so
 * on a box the throw would mean someone deleted half of an extension directory.
 */
function loadTable() {
  const candidates = [
    new URL("./protected-paths.json", import.meta.url),
    new URL("../../../config/protected-paths.json", import.meta.url),
  ];
  let lastErr;
  for (const url of candidates) {
    try {
      return JSON.parse(readFileSync(url, "utf-8"));
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`clawbox-path-guard: protected-paths.json is not readable (${lastErr})`);
}

const TABLE = loadTable();

/** Exported so the parity test renders the Hermes globs from the same table. */
export const PATH_ROOTS = TABLE.pathRoots;
export const PATH_TERMINATORS = TABLE.pathTerminators;
export const VERB_FIRST_TOKENS = TABLE.verbFirstTokens;
export const PATH_FIRST_TOKENS = TABLE.pathFirstTokens;
export const REDIRECTION_PREFIXES = TABLE.redirectionPrefixes;

const TERMINATORS = new Set([...PATH_TERMINATORS]);

/**
 * The tool ids whose parameters name a file they are about to write.
 *
 * `read` is deliberately absent: the ruling forbids destroying these paths, not
 * looking at them. `exec` is handled by the command rules below instead, and
 * `apply_patch` is here because the host derives its target paths for us
 * (`event.derivedPaths`) while its command-shaped envelope carries none.
 */
export const FILE_MUTATING_TOOLS = new Set(["write", "edit", "apply_patch"]);

/**
 * The tool ids whose parameters carry a command line or a script. `bash` is
 * the core's documented alias for `exec`; `code_execution` runs an inline
 * script, where only the shell-shaped spellings inside it are reachable by a
 * text rule (see the residual note in the PR body).
 */
export const COMMAND_TOOLS = new Set(["exec", "bash", "code_execution"]);

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

/**
 * The index just past a protected root in `text`, at or after `from`, or -1.
 *
 * The root must END a path segment: `~/clawbox` and `~/clawbox/data` are the
 * tree, `~/clawbox-notes.txt` is a file that merely starts the same way.
 */
function findRoot(text, from = 0) {
  for (const root of PATH_ROOTS) {
    let at = text.indexOf(root, from);
    while (at >= 0) {
      const next = text[at + root.length];
      if (next === undefined || TERMINATORS.has(next)) return { root, end: at + root.length };
      at = text.indexOf(root, at + 1);
    }
  }
  return null;
}

/**
 * Why this command line is refused, or null.
 *
 * The three rules are the ones the Hermes deny globs express, in the same
 * order, so that one case table can hold both sides to the same answer:
 *
 *   A  a destroying token, then a protected root   `*rm *· /clawbox ·[/ ...]*`
 *   B  a protected root, then a destroying token   `*· /clawbox ·[/ ...]*rm *`
 *   C  a redirection straight into a protected root
 *
 * Matching is case-insensitive on both sides. Rules A and B are substring rules
 * over the WHOLE command line, so a compound command that destroys something
 * elsewhere and merely mentions a protected path in its other half —
 * `rm /tmp/x && du -sh ~/clawbox/data` — is refused too. That is the cost of a
 * rule that cannot parse a shell, and it is paid deliberately: the refusal text
 * names the rule, so the agent can re-issue the two halves separately.
 */
export function commandDenyReason(command, home = os.homedir()) {
  if (typeof command !== "string" || !command) return null;
  const text = foldHome(command, home).toLowerCase();

  for (const token of VERB_FIRST_TOKENS) {
    const at = text.indexOf(token.toLowerCase());
    if (at < 0) continue;
    const hit = findRoot(text, at + token.length);
    if (hit) return `\`${token.trim()}\` targeting ${hit.root}`;
  }

  const rootHit = findRoot(text);
  if (rootHit) {
    for (const token of PATH_FIRST_TOKENS) {
      if (text.indexOf(token.toLowerCase(), rootHit.end) >= 0) {
        return `\`${token.trim()}\` after ${rootHit.root}`;
      }
    }
  }

  for (const prefix of REDIRECTION_PREFIXES) {
    for (const root of PATH_ROOTS) {
      const at = text.indexOf(prefix + root);
      if (at < 0) continue;
      const next = text[at + prefix.length + root.length];
      if (next === undefined || TERMINATORS.has(next)) return `a redirection into ${root}`;
    }
  }

  return null;
}

/** True when this directory is, or is inside, a protected path. */
export function isProtectedDirectory(dir, home = os.homedir()) {
  if (typeof dir !== "string" || !dir) return false;
  return findRoot(foldHome(dir, home).toLowerCase().replace(/\/+$/, "")) !== null;
}

/**
 * The string parameter values that can be naming a file.
 *
 * By SHAPE, not by key name: the core's own parameter names for `write` and
 * `edit` are not in the published tool reference, and a guard pinned to a name
 * that is later spelled differently is a guard that silently stops guarding.
 * A path never contains a newline, so dropping multi-line values keeps a patch
 * body or a file's contents from being read as a target while still catching
 * every single-line one.
 */
function* pathLikeValues(params) {
  if (!params || typeof params !== "object") return;
  for (const value of Object.values(params)) {
    if (typeof value !== "string" || !value || value.includes("\n")) continue;
    yield value;
  }
}

function stringParams(params) {
  if (!params || typeof params !== "object") return [];
  return Object.values(params).filter((value) => typeof value === "string");
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
    const derived = Array.isArray(event?.derivedPaths) ? event.derivedPaths : [];
    for (const candidate of [...derived, ...pathLikeValues(params)]) {
      if (typeof candidate !== "string") continue;
      const hit = findRoot(foldHome(candidate, home).toLowerCase().replace(/\/+$/, ""));
      if (hit) return `\`${toolName}\` writing inside ${hit.root}`;
    }
    return null;
  }

  if (!COMMAND_TOOLS.has(toolName)) return null;

  // Every string parameter, for the same reason pathLikeValues takes them all:
  // `exec` documents `command`, but `code_execution` does not publish the key
  // its script arrives under, and a guard that only read `command` would let
  // the sibling tool through.
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
    const text = stringParams(params).join("\n").toLowerCase();
    for (const token of [...VERB_FIRST_TOKENS, ...PATH_FIRST_TOKENS]) {
      if (text.includes(token.toLowerCase())) {
        return `\`${token.trim()}\` run from inside ${workdir}`;
      }
    }
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
