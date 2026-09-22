import path from "path";
import fs from "fs";
import { DATA_DIR } from "./config-store";

// ── Files API secret guard ──────────────────────────────────────────────────
//
// The Files API browses the home directory, so its every secret store lives
// *inside* the sandbox root — `..` containment alone doesn't protect them. This
// module keeps credential/key material off the read, write, list, rename and
// download paths. Matched against the realpath'd path so an in-base symlink
// can't dodge the check (CWE-59). (realpath resolves symlinks, not hard links —
// a hard link to a secret already needs read access to create, a separate
// fuller-privilege surface.)
//
// Three shapes of rule: named credential stores elsewhere in the home directory
// are listed below, the ClawBox data directory is covered by containment, and
// `~/.openclaw` — the agent's own state directory, which holds the device's
// secrets and the agent's own working notes in the same folder — is containment
// with an allow-list inside it (`isProtectedOpenclawPath`).

/**
 * Credential stores in the home directory, as folder names relative to it.
 * Exported so the coding agent (src/lib/coding-agent.ts) denies exactly these
 * folders to Claude Code's own file tools — one list, so a store added here
 * can never be silently left open there.
 */
export const PROTECTED_HOME_DIRS: readonly string[] = [
  ".ssh",
  // The one entry with a carve-out inside it: `isProtectedOpenclawPath` opens
  // the agent's own workspaces and refuses the rest. THIS LIST IS UNAFFECTED —
  // it is also what src/lib/coding-agent.ts denies to a delegated coding run,
  // whose deny is for the whole folder (a run is handed the assets it needs
  // under data/coding-agent-inputs instead) and whose rule is the array, not
  // the predicate.
  ".openclaw",
  // Hermes edition: ~/.hermes holds config.yaml (the ClawBox AI billing token,
  // the dashboard signing secret and its scrypt password hash), .env (provider
  // keys) and auth.json (OAuth tokens) — the Hermes equivalent of ~/.openclaw.
  ".hermes",
  ".codex",
  // ClawKeep keeps its portal token and the device's backup-encryption
  // passphrase in ~/.clawkeep. Its API route is already classed as sensitive
  // in middleware.ts; this is the same rule applied to the store behind it.
  ".clawkeep",
  ".gnupg",
  ".aws",
  ".kube",
  ".docker",
  ".config/gcloud",
  ".config/gh",
  ".config/rclone",
];

/**
 * The OpenClaw agent's own state directory: the one entry above whose folder is
 * not all credentials, and the only one with a carve-out inside it. Judged by
 * `isProtectedOpenclawPath` rather than by the whole-folder rule below.
 */
const OPENCLAW_DIR = ".openclaw";

/**
 * The top segments inside `~/.openclaw` that hold the agent's own working
 * notes rather than the device's secrets: its workspace, and a second agent's
 * workspace beside it (`workspace-<name>`).
 *
 * Exported because mcp/lib/guard.ts matches the same names in a shell string,
 * where there is no path to split — one definition, so the tool that opens a
 * file and the pre-flight that vets a command line cannot disagree about which
 * folder is the agent's.
 */
export const OPENCLAW_AGENT_SUBTREE_RE = /^workspace(-[^/]+)?$/;

// Each folder matched as a whole path segment (or segments), anywhere in the
// path — the same shape the hand-written patterns had. `.openclaw` is left out
// and judged separately: a single verdict for that whole folder has to be wrong
// about one half of it (see `isProtectedOpenclawPath`).
const PROTECTED_DIR_RES: RegExp[] = PROTECTED_HOME_DIRS.filter((dir) => dir !== OPENCLAW_DIR).map(
  (dir) => new RegExp(`(^|\\/)${dir.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}(\\/|$)`),
);

// Credential files matched by basename anywhere under the browse root — common
// on a dev box (git/npm/pip/postgres tokens). Blocking the whole file is fine:
// a file manager has no legitimate reason to surface a credential store.
const PROTECTED_FILE_RES: RegExp[] = [
  /(^|\/)\.netrc$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.pypirc$/,
  /(^|\/)\.pgpass$/,
  /(^|\/)\.git-credentials$/,
  /(^|\/)\.config\/git\/credentials$/,
];

// ── The ClawBox data directory ──────────────────────────────────────────────
//
// DATA_DIR is server state rather than user content: the config and kv stores,
// the service bearer tokens, the session secret, the OAuth flow files, tunnel
// and network state, the local-model runtime. The rule for it is containment —
// everything under it is protected except the subtrees below, which hold
// material the desktop is meant to show.
//
// Containment rather than a list of filenames, because a list cannot describe
// this directory even in principle: an atomic write stages `<name>.tmp.<hex>`
// beside its target, so some of what lands here is named at runtime. A
// hand-maintained list also only describes the code as it was when the list was
// last edited — the one this replaced had fallen behind the OAuth flow files,
// the login and credentials-change state, the tunnel state and cloudflared/.
//
// The name-shaped rules above cannot stand in for it either. Each matches the
// names it was written for, and this directory is full of names just outside
// them: it holds `network.env`, `hotspot.env`, `ap-runtime.env` and
// `hostname.env`, which END in `.env`, while the dotenv rule in mcp/lib/guard.ts
// matches names that BEGIN with it. Neither rule is wrong; they describe
// different things. Only the directory describes the directory.
//
// DATA_DIR *itself* is deliberately not protected. The Files API filters a
// directory listing entry by entry, so keeping the directory openable is what
// lets the public subtrees below appear at all.
//
// The names are spelled out here rather than imported from the modules that
// own them (code-projects, llamacpp-server, the app-store routes) because those
// import graphs use the "@/" alias, and mcp/lib/guard.ts — which consumes this
// file — may only import modules whose whole graph is relative paths and node
// builtins. Read the import rule at the top of mcp/lib/guard.ts before changing
// this: an import here breaks the MCP server at startup, not at build time.

/**
 * The per-run evidence folders coding-agent runs write into. Owned HERE (the
 * alias-free end of the import graph) and imported by coding-agent-artifacts,
 * the module that builds paths from it — one owner, no mirrored literal.
 */
export const CODING_AGENT_ARTIFACTS_SUBTREE = "coding-agent-artifacts";

/**
 * Where a coding-agent run finds the files it was GIVEN to work from — the
 * pictures the assistant generated for the task, an attachment that arrived in
 * chat, anything the owner dropped in by hand.
 *
 * Owned here for the reason the artifacts subtree above is: this is the
 * alias-free end of the import graph, and the list just below is the one thing
 * that decides what under data/ a run may open at all.
 *
 * It exists because the assistant writes its generated media into its OWN
 * state directory (`~/.openclaw/media`), which sits inside a credential store
 * this box denies to every run, wholesale and on purpose — the same folder
 * holds openclaw.json, the provider keys and every session transcript. So an
 * asset made FOR a coding task could not be read BY it, and a run either drew
 * it again or gave up. The box copies the named assets out into this tree
 * instead (src/lib/coding-run-inputs.ts), which is safe by construction:
 * nothing is opened that was not deliberately put here.
 */
export const CODING_AGENT_INPUTS_SUBTREE = "coding-agent-inputs";

export const DATA_DIR_PUBLIC_SUBTREES = new Set([
  "webapps",       // built desktop webapps, also served by the webapps route
  "icons",         // installed-app icons, also served by the icon route
  "catalog-cache", // cached copies of the providers' public model catalogues
  "code-projects", // the code assistant's project sources
  "llamacpp",      // local-model runtime: downloaded weights, pid file, log
  "embed",         // memory-search embedder runtime: its GGUF and log (embed-server.ts)
  CODING_AGENT_ARTIFACTS_SUBTREE,
  CODING_AGENT_INPUTS_SUBTREE,
]);

// DATA_DIR is already absolute and normalised (config-store builds it with
// path.join off an absolute root), so a prefix test is all this needs.
const DATA_DIR_PREFIX = DATA_DIR + path.sep;

/**
 * Takes an already-normalised absolute path — every caller resolves before
 * calling, and isProtectedFilePath's realpath pass re-checks anything that
 * exists on disk, so a `..` segment cannot survive into a real lookup.
 *
 * Deliberately a prefix test rather than path.relative: this runs once per
 * entry in a directory listing (up to 20k on a search), where path.relative's
 * two normalisation passes and its segment array cost about six times the rest
 * of the guard put together.
 */
function isProtectedDataDirPath(abs: string): boolean {
  // Both the data dir itself and a sibling such as `data-backup` fail this
  // test — the first for want of a trailing separator, the second on the name.
  if (!abs.startsWith(DATA_DIR_PREFIX)) return false;
  const rest = abs.slice(DATA_DIR_PREFIX.length);
  // Only the first segment matters, so find one separator instead of splitting
  // the whole path. Splitting on a character class of both separators would
  // also be wrong on POSIX, where a backslash is a legal filename character.
  const cut = rest.indexOf(path.sep);
  const top = cut === -1 ? rest : rest.slice(0, cut);
  if (top === "" || top === "..") return false;
  return !DATA_DIR_PUBLIC_SUBTREES.has(top);
}

/**
 * The separator the patterns above are written in.
 *
 * Every rule in this file spells its separator `/`, so on Windows — where a
 * resolved path arrives with backslashes — the name-shaped half of this guard
 * matched nothing at all and `~/.ssh` was not protected. The appliance is Linux
 * and never took that branch, but the tests run on developer machines, and a
 * security rule that quietly no-ops on the platform it is TESTED on is a rule
 * nobody is really testing.
 *
 * Rewritten only where the separator actually differs: on POSIX a backslash is
 * a legal character in a filename, and normalising there would invent matches
 * rather than find them. (`isProtectedDataDirPath` needs none of this — it
 * compares with `path.sep` throughout.)
 */
const toPatternPath: (abs: string) => string =
  path.sep === "/" ? (abs) => abs : (abs) => abs.replace(/\\/g, "/");

/**
 * The `~/.openclaw` rule: containment with an allow-list, exactly the shape
 * `DATA_DIR_PUBLIC_SUBTREES` has above, and for the same reason.
 *
 * That folder holds two unlike things side by side. `openclaw.json` carries the
 * provider keys and the MCP bearer, `credentials/` and `auth-profile*` carry
 * the rest, the per-agent `sessions/` folders are every word the owner has
 * ever said to the box,
 * and `extensions/` is the hook plugin that enforces TASK-605 — an agent that
 * can rewrite its own guard has none. Beside them sits `workspace/`: the
 * AGENTS.md, MEMORY.md, memory/ and skills/ the on-device agent is SUPPOSED to
 * edit. One verdict for the whole tree has to be wrong about one of them, and
 * the whole-folder deny was wrong about the half the agent owns — on the
 * OpenClaw edition "add a line to your MEMORY.md" was refused by every file
 * tool on the box (TASK-1072).
 *
 * EVERY `.openclaw` segment is judged, not the first: `…/workspace/.openclaw/
 * credentials/x` names the carve-out and then leaves it again. A `..` after one
 * is refused on the spelling alone, before anything resolves, for the same
 * reason the directory rules match anywhere in the string — `workspace/../
 * credentials` is not in the workspace, and a caller that has not normalised
 * must not be told that it is.
 *
 * `~/.openclaw` ITSELF answers false, deliberately and for the reason DATA_DIR
 * does: a listing is filtered entry by entry, so keeping the folder openable is
 * what lets the workspace inside it be found at all, and nothing else in it
 * survives the same filter. `isProtectedContainer` still says the folder may
 * not be renamed or removed.
 *
 * `p` is a pattern path (see `toPatternPath`), already absolute and normalised
 * by the caller.
 */
function isProtectedOpenclawPath(p: string): boolean {
  // An indexOf before the split, for the same reason `isProtectedDataDirPath`
  // is a prefix test: this runs once per entry of a listing, a glob or a grep,
  // up to 20k of them, and all but a handful of those paths are nowhere near
  // this folder. The substring test can only be loose (`.openclaw-notes.txt`),
  // and the segment walk below is what decides.
  if (!p.includes(OPENCLAW_DIR)) return false;
  const segs = p.split("/");
  for (let i = 0; i < segs.length; i += 1) {
    if (segs[i] !== OPENCLAW_DIR) continue;
    const rest = segs.slice(i + 1);
    // The folder itself, with or without a trailing separator.
    if (rest.length === 0 || (rest.length === 1 && rest[0] === "")) continue;
    if (!OPENCLAW_AGENT_SUBTREE_RE.test(rest[0])) return true;
    if (rest.includes("..")) return true;
  }
  return false;
}

function isProtected(abs: string): boolean {
  if (isProtectedDataDirPath(abs)) return true;
  const p = toPatternPath(abs);
  // BEFORE the carve-out, so a credential basename inside the agent's own
  // workspace is still a credential store. mcp/lib/guard.ts adds the dotenv and
  // secret-name rules on top for the tool surface; this file is also the Files
  // API's guard, where the owner browsing their own device is a different trust
  // decision and always has been.
  if (PROTECTED_FILE_RES.some((re) => re.test(p))) return true;
  if (isProtectedOpenclawPath(p)) return true;
  return PROTECTED_DIR_RES.some((re) => re.test(p));
}

/**
 * Is this path inside the OpenClaw agent's own state directory at all?
 *
 * For a CALLER THAT HAS ALREADY BEEN REFUSED and is choosing what to say about
 * it: a deny under `~/.openclaw` is worth a different next step from a deny
 * under `~/.ssh`, because the harness's own file tools are not bound by this
 * guard and the agent can still get there (mcp/lib/guard.ts `assertPathAllowed`).
 */
export function isOpenclawStatePath(abs: string): boolean {
  return abs.includes(OPENCLAW_DIR) && toPatternPath(abs).split("/").includes(OPENCLAW_DIR);
}

/**
 * Is this path inside one of the agent workspaces the carve-out opens?
 *
 * True for a path the carve-out COVERS, whatever some other rule then says
 * about it — a `.env` in the workspace is a workspace file that is refused, not
 * a credential store the agent should stay quiet about. Judged on the first
 * `.openclaw` segment; `isProtectedFilePath` is what answers whether the path
 * is actually allowed.
 */
export function isOpenclawWorkspacePath(abs: string): boolean {
  if (!abs.includes(OPENCLAW_DIR)) return false;
  const segs = toPatternPath(abs).split("/");
  const at = segs.indexOf(OPENCLAW_DIR);
  return at >= 0 && OPENCLAW_AGENT_SUBTREE_RE.test(segs[at + 1] ?? "");
}

/**
 * The tree the box lets an authenticated session browse: the customer's home
 * directory, and also the agent's own working directory — on the appliance they
 * are the same place.
 *
 * Lives beside the guard rather than in the routes because the root and the
 * rule that carves secrets out of it are one decision, and it was written out
 * three times before this: both Files API routes and, now, the adoption of a
 * picture the agent wrote outside its image cache. A root defined in one file
 * and guarded in another is how a fourth caller ends up browsing a tree nobody
 * remembered to protect.
 */
export function filesBrowseRoot(): string {
  return process.env.FILES_ROOT ?? (process.env.HOME || "/home/clawbox");
}

/**
 * How many links `canonicalPath` will step through before calling the path a
 * loop. Linux itself gives up at 40 (its own ELOOP threshold), so a path the
 * kernel would open never hits this; only a cycle does.
 */
const MAX_LINK_HOPS = 40;

/**
 * The path with every symlink resolved, for a path that need not exist yet.
 *
 * `realpathSync` refuses a path whose leaf is missing, so the earlier guard
 * fell back to resolving the PARENT and re-joining the basename — and stopped
 * there. A path two or more segments past the last existing directory
 * (`~/link/newdir/x`, with `~/link -> ~/.ssh`) failed both resolves and was
 * judged by its typed spelling, which names no store at all. This walks up
 * `dirname` until something resolves and re-joins what it walked past, so the
 * verdict is about where the write would actually LAND.
 *
 * A DANGLING link is followed too, not re-joined as a name. `realpathSync`
 * refuses `~/proj/keys.txt -> ~/.ssh/authorized_keys` while the target is
 * absent exactly as it refuses a missing file, and answering the link's own
 * spelling there judged the write as landing in `~/proj` — where nothing
 * lands: `open(2)` follows the link and CREATES `~/.ssh/authorized_keys`. So a
 * component that fails to resolve is `lstat`ed, and a link among them is
 * read and the walk carried on from its target, relative targets resolved
 * against the link's own directory the way the kernel does. Null only when
 * nothing on the way up resolves or the links form a cycle, which a resolver
 * cannot say anything about.
 */
export function canonicalPath(abs: string): string | null {
  let dir = abs;
  const rest: string[] = [];
  let hops = 0;
  for (;;) {
    try {
      const real = fs.realpathSync(dir);
      return rest.length ? path.join(real, ...rest) : real;
    } catch {
      const target = danglingLinkTarget(dir);
      if (target !== null) {
        if (++hops > MAX_LINK_HOPS) return null;
        dir = target;
        continue;
      }
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      rest.unshift(path.basename(dir));
      dir = parent;
    }
  }
}

/**
 * Where a link points, resolved against its own directory, when `p` IS a link
 * (the only way a path that exists can fail `realpathSync`, short of EACCES).
 * Null for anything else — a missing name, an ordinary file, a directory this
 * user cannot look at — so the caller walks up the way it always did.
 */
function danglingLinkTarget(p: string): string | null {
  // Resolved and prefix-checked before the two reads, the shape CodeQL's
  // path-injection query recognises as a sanitiser (js/path-injection,
  // alerts 520/521). The root is `/` on purpose: this resolver's job is to
  // find where ANY path the caller names really leads — the containment
  // verdict is the caller's, on the canonical answer — and lstat/readlink read
  // a name's metadata, never a file's bytes.
  const abs = path.resolve(p);
  if (!abs.startsWith(path.sep)) return null;
  try {
    if (!fs.lstatSync(abs).isSymbolicLink()) return null;
    return path.resolve(path.dirname(abs), fs.readlinkSync(abs));
  } catch {
    return null;
  }
}

/**
 * The inventory alone, applied to a path the CALLER has already resolved —
 * no realpath here. For a caller that already paid one resolve for its own
 * rules (mcp/lib/guard.ts judges device nodes and dotenv files on the same
 * canonical path) and runs once per entry of a 20k-entry listing, a second
 * lstat walk per entry is the whole cost of the guard again.
 */
export function isProtectedResolvedPath(abs: string): boolean {
  return isProtected(abs);
}

/**
 * True if `abs` — or, after resolving symlinks, its real target — is a protected
 * secret store. Callers should treat a `true` result as "not found / forbidden".
 *
 * This answers "may this be READ, LISTED or WRITTEN", and DATA_DIR itself
 * answers false to it on purpose (see the note above `DATA_DIR_PUBLIC_SUBTREES`).
 * Whether a directory may be MOVED or REMOVED is `isProtectedContainer`'s
 * question, and the two do not agree about the data directory.
 */
export function isProtectedFilePath(abs: string): boolean {
  if (isProtected(abs)) return true;
  // The path (or its leaf) may not exist yet, e.g. an upload target — the
  // resolve then lands on the nearest existing ancestor, so a symlinked
  // ancestor cannot smuggle a write into a secret dir however deep the new
  // path goes below it.
  const real = canonicalPath(abs);
  return real !== null && real !== abs && isProtected(real);
}

/**
 * Whether `abs`, as typed or once its links are resolved, is a directory that
 * HOLDS a protected store: the ClawBox data directory or any ancestor of it
 * (the checkout, the home), any ancestor of a credential store named in
 * `PROTECTED_HOME_DIRS` (so `~/.config` for `.config/gh`), or the browse root
 * itself.
 *
 * A different question from `isProtectedFilePath`. That one keeps DATA_DIR
 * openable so the Files app can list it and show the public subtrees; this one
 * says the same directory may not be renamed or recursively deleted — a rename
 * takes every store inside it out from under the containment rule (`data` →
 * `data-copy`, then `data-copy/config.json` is nobody's business), and a delete
 * removes the box's whole state in one request. Only mutation callers ask it;
 * `safePath`, the listing and the download must not, or `data/` would vanish
 * from the desktop — the regression the note above warns about.
 *
 * Judged on the path as typed AND on `canonicalPath(abs)`, because `~/link ->
 * ~/clawbox` then `link/data` names the real directory without spelling it.
 */
export function isProtectedContainer(abs: string): boolean {
  if (holdsProtectedStore(abs)) return true;
  const real = canonicalPath(abs);
  return real !== null && real !== abs && holdsProtectedStore(real);
}

function holdsProtectedStore(abs: string): boolean {
  const root = path.resolve(filesBrowseRoot());
  if (abs === root) return true;
  // isInside(child, parent): is DATA_DIR at or under `abs` — i.e. `abs` IS the
  // data directory or an ancestor of it.
  if (isInside(DATA_DIR, abs)) return true;
  // Only the stores rooted at the browse root: a single-segment store carries
  // its name wherever it is moved and stays protected by name, so the ancestor
  // rule matters for the two-segment `.config/*` entries, whose classification
  // is lost when `.config` is renamed. A `.config/gh` nested somewhere else
  // (`~/projects/x/.config/gh`) is not covered — gh reads only `~/.config` or
  // `$XDG_CONFIG_HOME`, and the residual is data loss, not disclosure.
  return PROTECTED_HOME_DIRS.some((dir) => isInside(path.join(root, dir), abs));
}

/**
 * Path containment: is `child` at or under `parent`? (`parent` itself counts.)
 * The one fence every run-scoped file check uses — the runner's working-folder
 * rule, the browser route's file:// scope, the vision route's evidence scope —
 * so they cannot disagree on an edge case.
 */
export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
