import path from "path";
import fs from "fs";
import { DATA_DIR } from "./config-store";

// ── Files API secret guard ──────────────────────────────────────────────────
//
// The Files API browses the home directory, so its every secret store lives
// *inside* the sandbox root — `..` containment alone doesn't protect them. This
// denylist keeps credential/key material off the read, write, list, rename and
// download paths. Matched against the realpath'd path so an in-base symlink
// can't dodge the check (CWE-59). (realpath resolves symlinks, not hard links —
// a hard link to a secret already needs read access to create, a separate
// fuller-privilege surface.)

const PROTECTED_DIR_RES: RegExp[] = [
  /(^|\/)\.ssh(\/|$)/,
  /(^|\/)\.openclaw(\/|$)/,
  // Hermes edition: ~/.hermes holds config.yaml (the ClawBox AI billing token,
  // the dashboard signing secret and its scrypt password hash), .env (provider
  // keys) and auth.json (OAuth tokens) — the Hermes equivalent of ~/.openclaw.
  /(^|\/)\.hermes(\/|$)/,
  /(^|\/)\.codex(\/|$)/,
  /(^|\/)\.gnupg(\/|$)/,
  /(^|\/)\.aws(\/|$)/,
  /(^|\/)\.kube(\/|$)/,
  /(^|\/)\.docker(\/|$)/,
  /(^|\/)\.config\/(gcloud|gh|rclone)(\/|$)/,
];

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

// Exact secret files in the ClawBox data dir: the session-secret (forge cookies),
// the service bearer tokens, and the config/kv stores that carry provider keys.
// `.hermes-dashboard-pw` is the server-side password the dashboard proxy logs in
// with — reading it is a full sign-in to the Hermes dashboard.
const PROTECTED_FILES = new Set(
  [".session-secret", ".mcp-token", ".local-ai-token", ".hermes-dashboard-pw", "config.json", "kv.json"]
    .map((n) => path.join(DATA_DIR, n)),
);

function isProtected(abs: string): boolean {
  if (PROTECTED_FILES.has(abs)) return true;
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
