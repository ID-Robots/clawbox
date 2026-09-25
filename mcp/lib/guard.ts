// Path and process safety for every file-touching tool.
//
// IMPORT RULE for mcp/lib/**: a src/lib module may be imported here only if its
// ENTIRE transitive import graph is relative paths + node builtins. Verified
// safe today: edition-source, file-guard (→ config-store), hermes-skills,
// hermes-reasoning. Anything using the "@/" alias is forbidden — bun resolves
// it inconsistently for files outside the root tsconfig include, and it drags
// server-only Next.js code into this stdio process.
//
// The secret denylist is src/lib/file-guard.ts PLUS the two MCP-local rules
// below — ONE list, not two. The MCP previously kept a parallel copy of the
// rules, which is a shape that drifts: two lists of the same thing eventually
// disagree, and the weaker one wins wherever it is consulted. What stays here is
// only what file-guard cannot express, because file-guard is shared with the
// Files API, where the user drives the file manager themselves and the trust
// decision is a different one.

import { spawn } from "child_process";
import { statSync } from "fs";
import { basename, resolve, isAbsolute, normalize, join } from "path";
import {
  canonicalPath,
  isDeniedOpenclawPath,
  isOpenclawStatePath,
  isOpenclawWorkspacePath,
  isProtectedResolvedPath,
} from "../../src/lib/file-guard";
// TASK-605's protected-path rule, from the module the OpenClaw hook plugin
// carries into ~/.openclaw/extensions. It lives there because a plugin copied
// out of the checkout has to take its rule with it; it is imported HERE
// because ClawBox's own `bash`, `write_file`, `edit_file` and `notebook_edit`
// reach the same files the harness's tools do wherever an owner has switched
// them on (CLAWBOX_MCP_CODING_TOOLS=1), and a deny the agent can walk around
// through this server is not a deny. Its whole import graph is node
// builtins, so it satisfies the rule at the top of this file.
import {
  commandDenyReason,
  destructiveToken,
  isProtectedDirectory,
  pathDenyReason,
} from "../../scripts/openclaw-plugins/clawbox-path-guard/path-guard.mjs";
import { ToolError } from "./errors";

export const HOME = process.env.HOME || "/home/clawbox";
export const DEFAULT_CWD = process.env.CLAWBOX_ROOT || "/home/clawbox/clawbox";

// Device nodes and process memory. This is a DIFFERENT concern from the secret
// denylist (these are not credentials, they are files that hang or OOM a
// reader), so it lives here rather than being pushed into file-guard.
const BLOCKED_EXACT = new Set([
  "/dev/zero", "/dev/null", "/dev/random", "/dev/urandom",
  "/dev/stdin", "/dev/stdout", "/dev/stderr", "/dev/tty", "/dev/console",
]);

function isDevicePath(abs: string): boolean {
  if (BLOCKED_EXACT.has(abs)) return true;
  if (abs === "/dev" || abs.startsWith("/dev/")) return true;
  // /proc/<pid>/environ carries every secret the process was started with.
  if (abs === "/proc" || abs.startsWith("/proc/")) return true;
  if (abs.startsWith("/sys/")) return true;
  return false;
}

// Dotenv files, anywhere — read AND write.
//
// <CLAWBOX_ROOT>/.env is a credential store (see .env.example for what the
// install keeps there), and it is also configuration: clawbox-setup.service
// loads it as an EnvironmentFile, so its contents shape how the web server comes
// up on the next restart (src/lib/edition-source.ts explains why the edition
// lock deliberately sits in a root-owned file instead). Neither role belongs to
// an agent-facing tool, so the whole family is out of reach here.
//
// This rule is MCP-local rather than in file-guard because file-guard also backs
// the Files app, where a user browsing their own project folder is a different
// trust decision from a tool acting on content the device did not author.
// The backslash alternative is only for the dev machines this file is unit-run
// on; the device is POSIX.
const DOTENV_RE = /(^|[/\\])(\.env(\.[^/\\]*)?|\.envrc)$/;

function isDotenvPath(abs: string): boolean {
  return DOTENV_RE.test(abs);
}

/**
 * Expand `~`, resolve relative paths against the project root, and reject
 * anything that cannot be a real path. Returns an absolute, normalised path.
 */
export function resolveUserPath(input: string): string {
  if (input.includes("\0")) {
    throw new ToolError(
      "BAD_ARGUMENT",
      "That path contains an illegal character.",
      "Pass a plain filesystem path with no control characters.",
    );
  }
  let p = input.trim();
  if (!p) {
    throw new ToolError("BAD_ARGUMENT", "The path was empty.", "Pass a file or directory path.");
  }
  if (p === "~") p = HOME;
  else if (p.startsWith("~/")) p = join(HOME, p.slice(2));
  return normalize(isAbsolute(p) ? p : resolve(DEFAULT_CWD, p));
}

/**
 * A credential-shaped BASENAME inside the `~/.openclaw` workspace carve-out.
 *
 * Scoped to the carve-out on purpose. That carve-out is a new hole in a
 * credential store (src/lib/file-guard.ts, TASK-1072), and the folder behind it
 * is written by an agent rather than by a person — so a file the agent named
 * `.mcp-token` in its own workspace is refused here exactly as the real one is
 * two directories up, and the `bash` pre-flight, which sees only a string and
 * matches the same names, cannot end up stricter than the file tools.
 *
 * `SECRET_NAME_RE` wants a boundary in front of the name, which a bare basename
 * does not have; the leading `/` is that boundary and is not a path.
 */
function isOpenclawSecretName(abs: string): boolean {
  return isOpenclawWorkspacePath(abs) && SECRET_NAME_RE.test(`/${basename(abs)}`);
}

/** The whole read-side denylist, applied to ONE spelling of a path. */
function deniedAsSpelled(abs: string): boolean {
  return (
    isDevicePath(abs)
    || isDotenvPath(abs)
    || isOpenclawSecretName(abs)
    || isProtectedResolvedPath(abs)
  );
}

/**
 * True when this path may be read, listed, searched or written by a tool.
 *
 * Judged on the path AS TYPED and on its CANONICAL form, and every rule on
 * both. It used to be that only file-guard's inventory saw the resolved
 * target — the device-node and dotenv rules here looked at the typed name
 * alone — so `notes.txt -> <root>/.env` and `readme.md -> /proc/self/environ`
 * passed: a benign name, a target in neither list file-guard keeps. Both must
 * pass because they answer different questions: a typed `.env` that links
 * somewhere harmless is still a dotenv file to the agent that wrote it, and
 * `/dev/stdin` resolves to `/dev/pts/N`, which only the resolved side sees.
 *
 * ONE realpath per call, shared by all three rules — this runs once per entry
 * of a listing, a glob or a grep, up to 20k of them. A caller that has already
 * resolved the path passes `real` in, so the path it judges is the path it
 * goes on to open: `resolveGuardedPath` resolves once and hands THAT to the
 * assertions and to the sink, because two resolves of one spelling are two
 * walks of the tree, and a link swapped between them would have the sink open
 * a target nobody vetted.
 */
export function isAllowedPath(abs: string, real: string | null = canonicalPath(abs)): boolean {
  if (deniedAsSpelled(abs)) return false;
  // A resolve that fails is not evidence of anything; the typed verdict stands.
  return real === null || real === abs || !deniedAsSpelled(real);
}

/**
 * Basenames that mean "a credential store" wherever they appear in a string.
 * Used by the `bash` pre-flight, which sees a shell string rather than a path.
 *
 * `.openclaw` IS NOT HERE, and it is the only name in the home directory that
 * is deliberately absent: part of that folder is the agent's own workspace and
 * part of it is the device's keys, so one substring cannot answer for it.
 * `openclawDeniedInCommand` below judges each mention of it by what follows —
 * and `.mcp-token`, `.session-secret` and the rest of this list still fire on
 * the files inside it, whichever folder they turn up in.
 */
export const SECRET_NAME_RE =
  /(^|[^\w.-])\.(ssh|hermes|clawkeep|codex|gnupg|aws|kube|env|envrc|netrc|npmrc|pypirc|pgpass|git-credentials|session-secret|mcp-token|local-ai-token|hermes-dashboard-pw)(?![\w-])|(^|[^\w-])id_(rsa|ecdsa|ed25519)(?![\w-])/i;

/**
 * Every `.openclaw` mention in a shell string, with whatever path follows it.
 *
 * The tail stops at the characters that end a word in a command line, so
 * `cat "~/.openclaw/workspace/MEMORY.md" && …` yields `/workspace/MEMORY.md`
 * and nothing after the quote.
 */
const OPENCLAW_MENTION_RE = /(?:^|[^\w.-])\.openclaw(?![\w-])([^\s'"`;&|<>()]*)/gi;

/** Does the command name `.openclaw` anywhere? The rule above without the `g` and its `lastIndex`. */
const OPENCLAW_MENTIONED_RE = new RegExp(OPENCLAW_MENTION_RE.source, "i");

/**
 * The word-shaped pieces of a command line, on the characters a shell ends a
 * word at. Shared so the two passes below cannot disagree about what a token is.
 */
function shellTokens(command: string): string[] {
  return command.split(/[\s;|&<>()'"`]+/).filter(Boolean);
}

/**
 * Does this command name something under `~/.openclaw` that is NOT one of the
 * agent's own workspaces?
 *
 * The path-shaped half of the pre-flight already resolves the tokens it can
 * recognise; this is for the ones it cannot — `$HOME/.openclaw/credentials/x`
 * starts with a `$`, so nothing resolves it and only the text is left. Three
 * refusals, all on the spelling:
 *
 *   - a mention with no path after it (`ls ~/.openclaw`, `.openclaw.json`).
 *     `bash` output is NOT filtered the way `list_directory` is, so a listing
 *     there prints the credential names this guard exists to keep out of one;
 *   - a path the file tools would refuse, judged by THEIR rule on the tail.
 *
 * The tail is handed to `isDeniedOpenclawPath` whole rather than picked apart
 * here, and that is the fix for the hole a first-segment test left: `$HOME/
 * .openclaw/workspace/.openclaw/credentials/x` and `…/workspace/../credentials/
 * x` both start with an allowed segment and end in the credential store, and
 * with a `$HOME` spelling the token pass above cannot resolve the token, so
 * this rule is the only one left to see it. One rule for the shell and the file
 * tools, so a spelling the tools refuse cannot be run by the shell instead.
 */
export function openclawDeniedInCommand(command: string): boolean {
  for (const [, tail] of command.matchAll(OPENCLAW_MENTION_RE)) {
    // `~/.openclaw/`, `~/.openclaw//`, `~/.openclaw/.` are the folder itself
    // too (TASK-1198) — the listable one, which a shell must not stand in or
    // list — and the rule below reads a bare trailing slash as "nothing named".
    if (!tail.startsWith("/") || /^[/.]*$/.test(tail)) return true;
    // The literal is the one the regex above already matched; this rebuilds the
    // path that mention names, with no home in front of it — the rule is about
    // the segments after `.openclaw` and nothing before it.
    if (isDeniedOpenclawPath(`/.openclaw${tail}`)) return true;
  }
  return false;
}

/**
 * The same rule, for the `.openclaw` the WORKING DIRECTORY spells rather than
 * the command.
 *
 * `bash` takes a cwd, and a cwd is half of every relative path in the command.
 * `assertPathAllowed(cwd)` is not enough on its own here, because the carve-out
 * deliberately lets `~/.openclaw` itself be opened so the workspaces inside it
 * can be found — and a `list_directory` there filters its entries one by one,
 * while `cd ~/.openclaw && cat credentials/anthropic.json` does not name a
 * single refused path anywhere in the command string. Two arms:
 *
 *   - the shell is SITTING in protected state (`~/.openclaw`, `…/credentials`):
 *     refused whatever it runs, because every relative path it names is one and
 *     `bash` output is not filtered the way a listing is;
 *   - the shell is in a workspace, which is allowed, and a relative token walks
 *     back OUT of it (`cat ../credentials/x`, `ls ..`). The text rule above
 *     cannot see those: the `.openclaw` segment came from the cwd, so there is
 *     no mention in the command for it to match. Tokens that spell a path
 *     absolutely are left alone — the text rule and the resolving pass in
 *     `commandPathRefusal` already judge those, against the real home.
 *
 * "The working directory" is EVERY one the command can stand in, not only the
 * one the tool was handed (TASK-1198): `cd ~/.openclaw/workspace && cat
 * ../openclaw.json` moves into the workspace on its first word, and both arms
 * apply there exactly as they would to a `cwd` naming it (`workingDirsOf`).
 */
function openclawDeniedCwd(command: string, cwd: string): boolean {
  const { dirs, unresolved } = workingDirsOf(command, cwd);
  // BOTH SPELLINGS, for the reason `isAllowedPath` judges both: `~/notes -> ~/
  // .openclaw` is a working directory with no `.openclaw` anywhere in its text,
  // and a shell handed it is standing in the state directory all the same.
  for (const dir of dirs) {
    if (!isOpenclawStatePath(dir)) continue;
    if (openclawStateOutsideWorkspace(dir)) return true;
    for (const raw of shellTokens(command)) {
      if (raw.startsWith("/") || raw.startsWith("~")) continue;
      // `join` normalises, which is what this arm wants: the question is where
      // the token LANDS, and `..` is how it leaves. A token that is not a path
      // at all (`cat`, `-r`) lands inside the workspace and is allowed.
      if (openclawStateOutsideWorkspace(join(dir, raw))) return true;
    }
  }
  // A directory change this cannot spell out (`cd "$D"`, `cd $(…)`) in a
  // command that names `~/.openclaw` at all: where the shell stands is unknown,
  // and the workspace it names is the likeliest answer. A relative token that
  // CLIMBS is then refused, because out of a workspace one `..` is the state
  // directory. One that does not climb (`cat MEMORY.md`) is still allowed.
  if (!unresolved || !OPENCLAW_MENTIONED_RE.test(command)) return false;
  return shellTokens(command).some(
    (raw) => !raw.startsWith("/") && !raw.startsWith("~") && raw.split("/").includes(".."),
  );
}

/**
 * Words after which the next word is a directory the rest of the line runs in.
 * `cd` and `pushd` for the shell itself; `-C` / `--directory` / `--chdir` for
 * the tools that take one (`git -C`, `tar -C`, `make -C`, `env -C`).
 */
const CHDIR_WORDS = new Set(["cd", "pushd"]);
const CHDIR_FLAGS = new Set(["-C", "--directory", "--chdir"]);
const CHDIR_FLAG_ASSIGN_RE = /^--(?:directory|chdir)=(.*)$/;

/** More than this many candidate directories and the command is no ordinary one. */
const MAX_WORKING_DIRS = 32;

/**
 * `~`, `$HOME` and `${HOME}` in front of a word, spelled out against the same
 * home `resolveUserPath` expands; null for a word naming a directory only the
 * shell could compute (any other `$`, a command substitution, a glob).
 */
function spellDirectory(word: string): string | null {
  for (const home of ["~", "$HOME", "${HOME}"]) {
    if (word === home) return HOME;
    if (word.startsWith(`${home}/`)) return join(HOME, word.slice(home.length + 1));
  }
  if (/[$`*?[\]{}]/.test(word)) return null;
  return word;
}

/**
 * Every directory a relative word in this command could be resolved against
 * (TASK-1198): the working directory it was handed, its canonical form, and
 * each directory the command itself moves into.
 *
 * THE HOLE THIS CLOSES. `cd ~/.openclaw/workspace && cat ../openclaw.json` —
 * the text rule saw one `.openclaw` mention, the workspace, and allowed it;
 * `../openclaw.json` is relative and names no `.openclaw` of its own; and the
 * working-directory arm only ever looked at the directory the TOOL was handed,
 * never at the one the command `cd`'d into on its first word. So the
 * credential file two words later was read with nothing on the line refusing
 * it. `cd ~/.openclaw/ && cat openclaw.json` was the same hole with a trailing
 * slash, which the text rule reads as the listable folder itself.
 *
 * Lexical and deliberately generous: a `cd` anywhere on the line counts,
 * whatever separator or quoting sits around it, and each one is resolved
 * against every directory already collected rather than the one the shell
 * would actually be in — control flow (`||`, a loop, a subshell) is not
 * modelled, so every place the shell COULD stand is judged. A workspace-only
 * command gains nothing from that: every directory it collects is a workspace.
 */
function workingDirsOf(command: string, cwd: string): { dirs: string[]; unresolved: boolean } {
  const dirs = new Set<string>([cwd, canonicalPath(cwd) ?? cwd]);
  let unresolved = false;
  // Split into simple commands first, so a bare `cd` (home) is not read as
  // moving into whatever word the NEXT command starts with. NOT on `(`, `)`
  // or a backtick, and the words keep them: `cd $(…)` and `` cd `…` `` must
  // reach `spellDirectory` as the substitution they are, not as a bare `cd`
  // followed by whatever the substitution runs. A subshell's own `(cd x` just
  // loses its parenthesis.
  for (const segment of command.split(/&&|\|\||[;&|\n]/)) {
    const words = segment
      .split(/[\s'"<>]+/)
      .map((word) => word.replace(/^[({]+/, "").replace(/\)+$/, ""))
      .filter(Boolean);
    for (let i = 0; i < words.length; i += 1) {
      const word = words[i];
      let target: string | undefined;
      const assigned = CHDIR_FLAG_ASSIGN_RE.exec(word);
      if (assigned) {
        target = assigned[1];
      } else if (CHDIR_WORDS.has(word) || CHDIR_FLAGS.has(word)) {
        // `cd -P dir`, `cd -- dir`: the options come first. `cd -` returns to a
        // directory already collected, so it adds nothing.
        let j = i + 1;
        while (CHDIR_WORDS.has(word) && j < words.length && words[j].startsWith("-") && words[j] !== "-") j += 1;
        target = words[j] ?? (CHDIR_WORDS.has(word) ? "~" : undefined);
        if (target === "-") continue;
      }
      if (target === undefined || target === "") continue;
      const spelled = spellDirectory(target);
      if (spelled === null) {
        unresolved = true;
        continue;
      }
      const next = isAbsolute(spelled) ? [normalize(spelled)] : [...dirs].map((dir) => join(dir, spelled));
      for (const dir of next) {
        if (dirs.size >= MAX_WORKING_DIRS) {
          unresolved = true;
          break;
        }
        dirs.add(dir);
        const real = canonicalPath(dir);
        if (real && dirs.size < MAX_WORKING_DIRS) dirs.add(real);
      }
    }
  }
  return { dirs: [...dirs], unresolved };
}

/**
 * Throw a BLOCKED_PATH the agent can act on. The message deliberately names no
 * path and no reason detail: this tool is reachable from untrusted page content,
 * and "blocked because it is ~/.hermes/.env" is itself a map of where the
 * secrets live.
 */
export function assertPathAllowed(abs: string, real: string | null = canonicalPath(abs)): void {
  if (isAllowedPath(abs, real)) return;
  throw new ToolError(
    "BLOCKED_PATH",
    "That path holds device credentials or a device node and is not accessible to tools.",
    blockedPathNext(abs, real),
  );
}

/**
 * What to do about a refusal — and for `~/.openclaw` that is NOT "give up".
 *
 * The default hint says "do not try variations of it", which is right for a
 * path only this server can reach. It was wrong for the agent's own state
 * directory: THE HARNESS'S OWN `read`, `write` and `edit` ARE NOT BOUND BY THIS
 * GUARD — the `clawbox-path-guard` hook only covers the roots in
 * config/protected-paths.json — so a request this server refused could still be
 * finished with the tools the model already has. Told to stop instead, an agent
 * that happened to pick an MCP tool failed the whole request (TASK-1072).
 *
 * What it may SAY is split the same way the carve-out is. A workspace file may
 * be named to the user: it is the user's own memory or skill file and naming it
 * is how they learn which one did not open. Anything else under `~/.openclaw`
 * may not be named at all, because the rest of that folder is a map of where
 * the device's keys are — the same silence the message above keeps.
 */
function blockedPathNext(abs: string, real: string | null): string {
  if (!isOpenclawStatePath(abs) && !(real !== null && isOpenclawStatePath(real))) {
    return "Do not try variations of it. Tell the user the file is protected and continue with the rest of the task.";
  }
  if (isOpenclawWorkspacePath(abs)) {
    return "Do not try another spelling here, but do not give up either: your own file tools are not bound by this guard, so open that path with one of those. Tell the user which workspace file this tool would not open.";
  }
  return "Do not try another spelling here: openclaw.json and the credential stores stay protected on this device, because they carry the provider keys and the MCP bearer. Your own file tools are not bound by this guard and may still reach the path if the user asked for it by name — but never name this path back to them.";
}

/**
 * The same check for a path a tool is about to WRITE, plus TASK-605's deny.
 *
 * Separate from `assertPathAllowed` because the two rules answer different
 * questions and the difference is the ruling's: the ClawBox tree and the
 * local-model folders may be read and listed — `data/llamacpp` and `data/embed`
 * are public subtrees of the data directory precisely so the desktop can show
 * what was downloaded — and may not be deleted, overwritten, truncated or
 * moved. A single allow-list would have had to choose one answer for both.
 *
 * The message names the rule rather than hiding it: unlike the credential
 * denial above, there is nothing secret about where this device keeps its own
 * code, and an agent told WHY it was refused can tell the owner instead of
 * trying the path again by another spelling.
 */
export function assertWritePathAllowed(abs: string, real: string | null = canonicalPath(abs)): void {
  assertPathAllowed(abs, real);
  // A WRITE inside `~/.openclaw` has to land in one of the agent's own
  // workspaces. The read side lets the FOLDER ITSELF be opened so a listing can
  // show them at all (src/lib/file-guard.ts), which is the same split DATA_DIR
  // gets — and for DATA_DIR the TASK-605 rule below happens to close the write
  // side. Nothing covers `~/.openclaw`, so it is said here, on both spellings.
  if (openclawStateOutsideWorkspace(abs) || (real !== null && openclawStateOutsideWorkspace(real))) {
    throw new ToolError(
      "BLOCKED_PATH",
      "That path holds device credentials or a device node and is not accessible to tools.",
      blockedPathNext(abs, real),
    );
  }
  // THE CANONICAL PATH AS WELL AS THE PATH AS TYPED. `resolveUserPath`
  // normalises `..` and `~` but does not follow links, so a symlink the agent
  // planted earlier — `~/notes/models -> ~/clawbox/data/llamacpp/models` — would
  // reach this as a path with no protected root in it. `canonicalPath` resolves
  // the LEAF when it exists, a dangling leaf to where the kernel would create
  // it, and the nearest existing ancestor otherwise: the earlier parent-only
  // resolve let a leaf link into the tree (`pkg.json -> ~/clawbox/package.json`)
  // and a deep new path under a link into it (`~/tree/newdir/x.ts`, `~/tree ->
  // ~/clawbox`) both through. A resolve that fails is not evidence of
  // anything, so the typed path's verdict stands.
  if (real && real !== abs && pathDenyReason(real, HOME)) throw protectedWriteError();
  // The PATH predicate, not the tool-shaped one: `toolCallDenyReason` drops any
  // string containing a newline, because a tool PARAMETER may be a file body —
  // and a filename may legally contain one, so routing a resolved path through
  // it let `…/models/a\nb.gguf` through.
  if (pathDenyReason(abs, HOME)) throw protectedWriteError();
}

/**
 * The path a file tool should OPEN, once the guard has passed: the canonical
 * form of `abs` (the typed path when nothing resolves). The sinks in
 * mcp/tools/coding.ts stat, read and write THIS, never the typed path — a
 * guard that vetted the target of a link and then opened the link is a guard
 * that judged one file and touched another, and the link can be swapped
 * between the two. Resolved ONCE here and handed to the assertions, so what
 * comes back is the very string they judged — a second resolve after the
 * check would be the same window again, opened by this function itself.
 * Opening the canonical path with O_NOFOLLOW closes the remaining window on
 * the leaf; a link swapped on a directory component needs a rename this guard
 * re-vets on the next call.
 */
export function resolveGuardedPath(abs: string, mode: "read" | "write"): string {
  const real = canonicalPath(abs);
  if (mode === "write") assertWritePathAllowed(abs, real);
  else assertPathAllowed(abs, real);
  return real ?? abs;
}

/**
 * Inside the agent's state directory, but not inside a workspace it owns.
 *
 * Stricter than `isDeniedOpenclawPath` in exactly one place, and deliberately:
 * this says NO to `~/.openclaw` ITSELF, which the read rule allows so that a
 * `list_directory` — which filters its entries one by one — can show the
 * workspaces at all. A write there has no entry filter behind it, and neither
 * does `bash` output, so both surfaces want this predicate rather than that one.
 */
function openclawStateOutsideWorkspace(p: string): boolean {
  return isOpenclawStatePath(p) && !isOpenclawWorkspacePath(p);
}

function protectedWriteError(): ToolError {
  return new ToolError(
    "BLOCKED_PATH",
    "The ClawBox install tree and the local-model folders are protected on this device: they can be read, but not written, deleted or moved.",
    "Do not retry it by another path. Tell the user what you were asked to do and that the device refused it.",
  );
}

/**
 * Whether a shell string names a protected path in a destroying spelling.
 * Re-exported so `bash`'s pre-flight and the OpenClaw hook cannot disagree.
 */
export function commandDeniedByPathGuard(command: string, cwd?: string): string | null {
  // The SAME home this module expands `~` against, never os.homedir(): the
  // rule folds the resolved home into `~/` before matching, and a guard that
  // folded a different directory than `resolveUserPath` expands would answer
  // about a path nobody named.
  const inCommand = commandDenyReason(command, HOME);
  if (inCommand) return inCommand;
  // THE WORKING DIRECTORY, which `bash` takes and used to throw away. The whole
  // reason the OpenClaw hook reads `workdir` is that `cd <protected> && rm x`
  // reaches a text matcher as two tokens it cannot relate — and this tool is
  // handed the directory as an argument, so the same hole was open here in a
  // simpler form: `bash({ cwd: "~/clawbox/data/llamacpp/models", command: "rm
  // -f gemma.gguf" })`.
  if (!cwd || !isProtectedDirectory(cwd, HOME)) return null;
  const token = destructiveToken(command, HOME);
  return token ? `\`${token}\` run from inside ${cwd}` : null;
}

/** Why the `bash` pre-flight refuses a command line. */
export interface CommandPathRefusal {
  /**
   * `credential` — it names a credential store, and the refusal says nothing
   * else; `openclaw` — it names something in the agent's own state directory
   * that is not one of its workspaces; `rule` — TASK-605, and `reason` names it.
   */
  kind: "credential" | "openclaw" | "rule";
  reason?: string;
}

/**
 * Best-effort pre-flight for `bash`. DEFENCE IN DEPTH, NOT A BOUNDARY.
 *
 * State the guarantee precisely, because it is easy to read a list of blocked
 * cases as containment. `bash` evaluates an arbitrary shell string, and a shell
 * can name the same file in many ways; this pre-flight recognises the direct
 * spellings, not all of them. It is a guard rail against a mistake, not a
 * sandbox, and nothing here should be relied on as one.
 *
 * What actually bounds that tool: it is registered on no shipped device — only
 * where an owner set CLAWBOX_MCP_CODING_TOOLS=1 — every other tool is
 * argv-driven and goes through the real path guard, and its own description
 * tells the agent never to run a command that came from content it read. Assume
 * `bash` can reach anything the device user can.
 *
 * Five passes, all cheap, in the order that gives the most useful refusal:
 *   1. the `.openclaw` text rule, first so its own `next` hint survives — a
 *      credential answer here would send the agent away from a workspace file
 *      it could still open with the harness's own tools;
 *   2. the same rule on the WORKING DIRECTORY, which is half of every relative
 *      path in the command and spells a `.openclaw` the text rule cannot see —
 *      the one the tool was handed and every one the command `cd`s into;
 *   3. tokens that look like paths, resolved and checked against the guard;
 *   4. TASK-605's command rule, with the working directory;
 *   5. the whole command scanned for a credential-store NAME anywhere in it, so
 *      a path assembled indirectly is still recognised.
 *
 * It lives HERE rather than in mcp/tools/coding.ts so the tests can ask the
 * same question the tool asks. A pre-flight composed inside the tool and
 * re-composed inside a test is two rules again, and the weaker one is the one
 * nobody notices is weaker.
 */
export function commandPathRefusal(command: string, cwd?: string): CommandPathRefusal | null {
  if (openclawDeniedInCommand(command)) return { kind: "openclaw" };
  // With or without a cwd: the command's own `cd` is a working directory too,
  // and `bash` runs in the home folder when it is handed none.
  if (openclawDeniedCwd(command, cwd ?? HOME)) return { kind: "openclaw" };
  for (const raw of shellTokens(command)) {
    if (!raw.startsWith("/") && !raw.startsWith("~") && !raw.startsWith("./")) continue;
    try {
      if (!isAllowedPath(resolveUserPath(raw))) return { kind: "credential" };
    } catch { /* not a resolvable path */ }
  }
  // TASK-605: the same rule the two harnesses enforce on their own shells.
  // Wherever this tool is switched on, the harness's own shell is already
  // covered by the before_tool_call hook — and this is a SECOND shell, reached
  // by a different tool id, so without this the deny would have a door in it.
  //
  // The WORKING DIRECTORY goes with the command. It is the reason the hook
  // reads `workdir` at all: `cd <protected> && rm x` reaches a text matcher as
  // two tokens it cannot relate, and this tool is handed the directory as an
  // argument, so the same hole was open here in a simpler form.
  const guarded = commandDeniedByPathGuard(command, cwd);
  if (guarded) return { kind: "rule", reason: guarded };
  return SECRET_NAME_RE.test(command) ? { kind: "credential" } : null;
}

/** Drop every protected path from a result list (entries, glob hits, matches). */
export function filterAllowedPaths(paths: string[]): string[] {
  return paths.filter((p) => isAllowedPath(p));
}

// ── Process execution ────────────────────────────────────────────────────────

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
}

/** How long to keep collecting output after the child has already exited. */
const DRAIN_MS = 250;

export interface SpawnOptions {
  timeoutMs?: number;
  maxBytes?: number;
  /**
   * Run the child HERE. Omit it and the child runs in the project root, or in
   * `/` when that root cannot be entered — so an argument that is not an
   * absolute path does not name a fixed file. A directory named here is used
   * exactly as given and is never substituted.
   */
  cwd?: string;
  input?: string;
  /** Extra environment for this child only (e.g. DISPLAY for a screen grab). */
  extraEnv?: Record<string, string>;
}

/**
 * Where a child runs when the caller named no directory.
 *
 * `DEFAULT_CWD` is the project root, and it is the right answer for RESOLVING
 * a relative path (see resolveUserPath). It is NOT a precondition of running a
 * program: when that directory cannot be entered, `spawn` fails before the
 * binary is ever reached and `spawnArgv` settles at 127 — which `hasBinary()`
 * reads as "not installed" and `probeJournal()` as "no journal". The whole
 * capability sweep then answers false at once and the MCP server drops
 * disk_usage, disk_cleanup, logs_tail and screen_capture from its tool list
 * with nothing said (TASK-722, the false-failure class). On a box the tree is
 * normally there; this bites exactly when it briefly is not — mid-update, a
 * failed mount, a mis-set CLAWBOX_ROOT — which is when those tools are wanted.
 *
 * `/` is the fallback because it is the one directory that cannot be missing
 * and cannot be a surprise. It is safe only because every argument these tools
 * pass is already an ABSOLUTE path — the rule is restated on `spawnArgv` and on
 * `SpawnOptions.cwd`, where a caller adding an argument will read it.
 *
 * Asked per spawn rather than once at import: the tree comes BACK after an
 * update, and a capability answered once and kept for the process lifetime is
 * the probe-once class this codebase keeps producing.
 */
const FALLBACK_CWD = "/";

/**
 * The directory a `spawnArgv` call with no `cwd` will actually use.
 *
 * Exported because `check-tools.ts` PRINTS it when a probe answers false: a
 * note that named `DEFAULT_CWD` there would attach the old, wrong cause ("your
 * tree is missing") to a probe that failed for a real reason ("scrot is not
 * installed") — the very misdiagnosis this fix removes.
 */
export function defaultSpawnCwd(): string {
  try {
    return statSync(DEFAULT_CWD).isDirectory() ? DEFAULT_CWD : FALLBACK_CWD;
  } catch {
    return FALLBACK_CWD;
  }
}

/** The spawn failed on the DIRECTORY, before the program was reached. */
function isCwdRefusal(code: string | undefined): boolean {
  return code === "ENOENT" || code === "EACCES" || code === "ENOTDIR";
}

interface Attempt {
  result: SpawnResult;
  /** Set when the child never started and the reason could be the directory. */
  refusedCode?: string;
}

/**
 * The ONLY process entry point outside the `bash` tool. Argv array, never a
 * shell string — so no argument, however hostile, can be re-parsed as a
 * command. Output is capped and the child is killed at the cap so a runaway
 * producer cannot OOM the stdio server and take every tool down with it.
 *
 * EVERY PATH IN `args` MUST BE ABSOLUTE. With no `cwd` the child runs in the
 * project root, or in `/` when that root cannot be entered, so a relative
 * argument does not name a fixed file. `resolveUserPath` is what every caller
 * uses to satisfy this, and `rm -rf --` is one of the callers.
 */
export function spawnArgv(
  bin: string,
  args: string[],
  options: SpawnOptions = {},
): Promise<SpawnResult> {
  const { cwd } = options;
  // A cwd the CALLER named is honoured exactly as given, missing or not: that
  // directory is the caller's meaning, and running somewhere else instead
  // would be the false-success mirror of the bug the fallback above fixes.
  if (cwd !== undefined) return spawnAttempt(bin, args, options, cwd).then((a) => a.result);
  const chosen = defaultSpawnCwd();
  return spawnAttempt(bin, args, options, chosen).then((a) => {
    // The stat above answers "does this exist", which is not the same question
    // as "can this process chdir into it" — a root-owned tree part-way through
    // an install answers yes and then refuses EACCES — and the two syscalls are
    // far enough apart for the tree to vanish between them, which is precisely
    // the mid-update window this fix is about. So the refusal itself, not a
    // prediction of it, is what selects the fallback.
    if (chosen === FALLBACK_CWD || !isCwdRefusal(a.refusedCode)) return a.result;
    return spawnAttempt(bin, args, options, FALLBACK_CWD).then((retry) => retry.result);
  });
}

function spawnAttempt(
  bin: string,
  args: string[],
  options: SpawnOptions,
  effectiveCwd: string,
): Promise<Attempt> {
  const { timeoutMs = 15_000, maxBytes = 4 * 1024 * 1024, input, extraEnv } = options;
  return new Promise((resolveA) => {
    const resolveP = (result: SpawnResult, refusedCode?: string) => resolveA({ result, refusedCode });
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { cwd: effectiveCwd, env: { ...process.env, HOME, ...extraEnv }, shell: false });
    } catch (err) {
      resolveP({
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        exitCode: 127,
        timedOut: false,
        truncated: false,
      }, (err as NodeJS.ErrnoException | undefined)?.code);
      return;
    }
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let drainTimer: ReturnType<typeof setTimeout> | null = null;

    let refusedCode: string | undefined;

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (drainTimer) clearTimeout(drainTimer);
      // Release pipes a surviving grandchild may still hold, so this process
      // does not accumulate open handles once per hung call.
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolveP({ stdout, stderr, exitCode, timedOut, truncated }, refusedCode);
    };

    // Kill, then settle on OUR schedule. Killing the direct child does not
    // necessarily close the pipes — a grandchild can hold them open — so waiting
    // for an event after the kill is waiting for something that may never come.
    const hardStop = (exitCode: number) => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      setTimeout(() => finish(exitCode), DRAIN_MS);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      hardStop(124);
    }, timeoutMs);

    const onChunk = (which: "out" | "err") => (d: Buffer) => {
      if (stdout.length + stderr.length >= maxBytes) return;
      const text = d.toString();
      if (which === "out") stdout += text;
      else stderr += text;
      if (stdout.length + stderr.length >= maxBytes) {
        truncated = true;
        hardStop(1);
      }
    };

    child.stdout?.on("data", onChunk("out"));
    child.stderr?.on("data", onChunk("err"));

    child.on("close", (code) => finish(code ?? 1));
    // `close` waits for every stdio pipe to reach EOF. A child that backgrounds
    // a grandchild (`find … -exec … &`, anything daemonising) leaves the pipe
    // open forever, so `close` never fires. That hung the STARTUP PROBES in
    // lib/context.ts, which buildContext awaits before server.connect() — the
    // whole tool surface silently failed to appear. Settle from `exit` plus a
    // short drain window instead.
    child.on("exit", (code) => {
      if (settled || drainTimer) return;
      drainTimer = setTimeout(() => finish(code ?? 1), DRAIN_MS);
    });
    child.on("error", (err: Error) => {
      stderr += err.message;
      // The code travels with the result so the caller above can tell "the
      // directory refused us" from "the program is not there" — the same
      // message text serves both.
      refusedCode = (err as NodeJS.ErrnoException).code;
      finish(127);
    });

    if (input !== undefined && child.stdin) {
      child.stdin.on("error", () => { /* child exited before reading stdin */ });
      child.stdin.end(input);
    }
  });
}

/** Does this binary exist on PATH? Used for startup capability probes. */
export async function hasBinary(bin: string): Promise<boolean> {
  const r = await spawnArgv("/usr/bin/env", ["which", bin], { timeoutMs: 3_000 });
  return r.exitCode === 0 && r.stdout.trim().length > 0;
}

/**
 * Keep as many rows as fit `budget` characters, and say how many did not.
 *
 * "As many as fit", not "the longest prefix that fits": a row too big for the
 * budget left is SKIPPED and the shorter rows behind it are still considered.
 * Returning at the first overflow spent the rest of the tier on one outlier —
 * with a single store skill carrying a 2 000-character card name (the
 * frontmatter ceiling), skill_list listed 61 built-ins and dropped 41 store
 * skills that would have fitted, the exact inversion its tiers exist to
 * prevent. Rows are in priority order, so skipping one costs only itself.
 *
 * The alternative is capText() below, which is the LAST line of defence: it
 * hard-slices the finished string, so a list that outgrows its cap stops
 * mid-row — unparseable JSON for a tool that answers JSON, a half-written id
 * for one that answers lines — and appends "narrow the query", which the two
 * list tools cannot do because neither takes an argument. A list tool that
 * knows its own budget can drop WHOLE rows and say how many, which is a
 * partial answer instead of a broken one.
 *
 * `cost` is what a row spends, INCLUDING whatever the caller's format puts
 * around it: one newline for a list of lines (the default), and for a JSON
 * array the escaped string plus the indent and the comma. Passing the row's
 * bare length there is the mistake this parameter exists to prevent — a `"` or
 * a `\\` in a third party's text costs an extra character each, a control
 * character up to five, and an underestimate hands the slicer a string that is
 * over the cap after all. A caller whose exact size it cannot predict should
 * measure the finished string and shrink, using this only as the seed.
 */
export function fitRows(
  rows: readonly string[],
  budget: number,
  cost: (row: string) => number = (row) => row.length + 1,
): { kept: string[]; keptIndexes: number[]; omitted: number } {
  const kept: string[] = [];
  // The caller usually has an OBJECT behind each row and needs to know which
  // ones survived; with a prefix it could slice, and with a skip it cannot.
  const keptIndexes: number[] = [];
  let used = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const spend = cost(rows[i]);
    if (used + spend > budget) continue;
    used += spend;
    kept.push(rows[i]);
    keptIndexes.push(i);
  }
  return { kept, keptIndexes, omitted: rows.length - kept.length };
}

/** Cap a string at the tool boundary and say what to do about the truncation. */
export function capText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n…[truncated, ${omitted} chars omitted — narrow the query]`;
}
