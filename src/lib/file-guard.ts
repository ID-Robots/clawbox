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
// Two shapes of rule: named credential stores elsewhere in the home directory
// are listed below, and the ClawBox data directory is covered by containment.

/**
 * Credential stores in the home directory, as folder names relative to it.
 * Exported so the coding agent (src/lib/coding-agent.ts) denies exactly these
 * folders to Claude Code's own file tools — one list, so a store added here
 * can never be silently left open there.
 */
export const PROTECTED_HOME_DIRS: readonly string[] = [
  ".ssh",
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

// Each folder matched as a whole path segment (or segments), anywhere in the
// path — the same shape the hand-written patterns had.
const PROTECTED_DIR_RES: RegExp[] = PROTECTED_HOME_DIRS.map(
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
export const DATA_DIR_PUBLIC_SUBTREES = new Set([
  "webapps",       // built desktop webapps, also served by the webapps route
  "icons",         // installed-app icons, also served by the icon route
  "catalog-cache", // cached copies of the providers' public model catalogues
  "code-projects", // the code assistant's project sources
  "llamacpp",      // local-model runtime: downloaded weights, pid file, log
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

function isProtected(abs: string): boolean {
  if (isProtectedDataDirPath(abs)) return true;
  if (PROTECTED_FILE_RES.some((re) => re.test(abs))) return true;
  return PROTECTED_DIR_RES.some((re) => re.test(abs));
}

/**
 * True if `abs` — or, after resolving symlinks, its real target — is a protected
 * secret store. Callers should treat a `true` result as "not found / forbidden".
 */
export function isProtectedFilePath(abs: string): boolean {
  if (isProtected(abs)) return true;
  try {
    const real = fs.realpathSync(abs);
    return real !== abs && isProtected(real);
  } catch {
    // Path (or leaf) doesn't exist yet, e.g. an upload target — resolve the
    // parent so a symlinked ancestor can't smuggle a write into a secret dir.
    try {
      const real = path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs));
      return real !== abs && isProtected(real);
    } catch {
      return false;
    }
  }
}
