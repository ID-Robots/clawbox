/**
 * The secret store's SHAPE: what a name, a scope and a value may be, what the
 * box keeps for itself, and what a refusal is called.
 *
 * Its own module, and pure — no `fs`, no `crypto`, no config read — for the
 * reason `coding-permission-rules.ts` is: the secrets card in the browser has
 * to reach the same verdict about a typed name as the route does, and a card
 * that imported the store itself would pull the session secret and the
 * filesystem into the desktop bundle. src/lib/project-secrets.ts re-exports
 * every name here, so a server caller has one import.
 */

export const SECRETS_FILE_NAME = "secrets.json";

/**
 * How many entries the owner may keep.
 *
 * A cap, not a limit anybody reaches by working: it exists because this file is
 * read and rewritten whole on every change and merged into a run's environment,
 * and an unbounded list is an unbounded environment block.
 */
export const MAX_SECRETS = 64;

/**
 * How long one value may be. A PEM-encoded key is a few thousand characters and
 * this has to be able to hold one; a multi-megabyte paste is not a secret, it
 * is a file.
 */
export const MAX_SECRET_VALUE_CHARS = 8_192;

/**
 * The SHORTEST value this store will keep, and why it is a number rather than
 * "anything non-empty".
 *
 * It is the redaction floor (`MIN_REDACT_CHARS` in src/lib/secret-redact.ts is
 * this constant). Redaction cannot match a three-character value without
 * turning every `abc` in a run's timeline into a marker — which is both
 * unreadable and a way to read the value off by watching which substrings
 * vanish. So the two have to agree on one number, and the honest place to
 * enforce it is the SAVE: a value the box would inject but could not scrub is a
 * credential it would print, which is exactly what this feature exists to
 * prevent (found in review). Eight characters is below any real credential and
 * above the length at which substring collisions are routine.
 */
export const MIN_SECRET_VALUE_CHARS = 8;

/**
 * ENV_STYLE, and nothing else: the name becomes an environment variable in a
 * run's process, so the alphabet is the one a shell can name. A leading digit
 * is refused (`2FA_TOKEN` is not a variable a shell can read back), and lower
 * case is refused so the list cannot hold two entries a careless reader sees as
 * one.
 */
export const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * The scope that means "every run on this box".
 *
 * `@box`, not `box`, and the `@` is the whole point: a project scope is a
 * project id or folder name, and a folder can perfectly well be CALLED `box`.
 * With the plain word as the sentinel, a secret the owner saved for that one
 * project was stored as box-wide and handed to every run on the device — an
 * authorisation hole with no error anywhere, found in review. `@` is outside
 * `SECRET_SCOPE_RE`, so no project scope can ever collide with this one.
 */
export const BOX_SCOPE = "@box";

/**
 * A project scope is a project id or a project folder's name — one path segment
 * out of the alphabet those already use. Never a path: the scope is a label
 * this module compares, and a scope that could hold `/` or `..` would be a path
 * waiting for somebody to join it to something. And never `@`-anything, which
 * is what keeps `BOX_SCOPE` in a namespace of its own.
 */
export const SECRET_SCOPE_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Names the box keeps for itself, refused at save time so the owner learns at
 * once rather than wondering why a run ignored the entry.
 *
 * Two kinds, and both matter:
 *
 *  - THE DEVICE'S OWN WIRING. `buildRunEnv` writes HOME, PATH, the artifacts
 *    folder and the `CLAUDE_DS_*` variables that decide which account pays for
 *    a run and which model answers. An entry named one of those would either be
 *    silently dropped (the injection never overwrites) or, in a future where it
 *    was not, move a run onto another account. The whole `CLAWBOX_`, `CLAUDE_`
 *    and `ANTHROPIC_` prefixes are reserved for that reason, not only the names
 *    in use today.
 *
 *  - LOADER AND INTERPRETER HOOKS. `LD_PRELOAD`, `BASH_FUNC_*`, `NODE_OPTIONS`,
 *    `PYTHONSTARTUP` and their family are not configuration; they are ways to
 *    run code in every process a run spawns, including ones the device's own
 *    deny rules are there to contain. This store is for credentials, and an
 *    owner who wants to change how a run's shell starts has the permission
 *    rules for it.
 */
const RESERVED_NAMES: ReadonlySet<string> = new Set([
  "HOME", "USER", "LOGNAME", "PATH", "LANG", "TERM", "NO_COLOR", "SHELL", "SHELLOPTS",
  "BASHOPTS", "IFS", "ENV", "PS4", "CDPATH", "PWD", "OLDPWD",
  "NODE_OPTIONS", "NODE_PATH", "PYTHONSTARTUP", "PYTHONPATH", "PERL5OPT", "PERL5LIB",
  "RUBYOPT", "GIT_SSH_COMMAND", "GIT_ASKPASS", "GIT_EXTERNAL_DIFF", "GIT_CONFIG",
  "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "SSH_ASKPASS",
]);

/** Prefixes reserved for the same reason — see RESERVED_NAMES. */
// `BASH_` whole rather than `BASH_FUNC_` alone: `BASH_ENV` is read and SOURCED
// by a non-interactive bash before it runs a line of its own body, which is a
// way to run code inside `scripts/claude-ds` itself (found in review). The
// prefix covers it, `BASH_FUNC_x` and whatever bash adds next.
const RESERVED_PREFIXES: readonly string[] = ["CLAWBOX_", "CLAUDE_", "ANTHROPIC_", "BASH_", "LD_", "DYLD_"];

/** True when this name is the device's to write, not the owner's. */
export function isReservedSecretName(name: string): boolean {
  if (RESERVED_NAMES.has(name)) return true;
  return RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * The owner's switch for injection.
 *
 * OFF when absent, unlike the coding agent's media and browser preferences:
 * this is a CONSENT, not a preference. Storing a token is one decision, and
 * handing it to an unattended shell that reaches the internet is another — a
 * box that has never been asked must not have said yes.
 */
export const SECRET_INJECT_CONFIG_KEY = "coding_agent_inject_secrets";

export type SecretRefusal =
  | "invalid_name"
  | "reserved_name"
  | "invalid_scope"
  | "invalid_value"
  | "value_too_long"
  | "value_too_short"
  | "full"
  | "not_found"
  | "store_unreadable"
  | "store_unwritable"
  | "key_unavailable";

export class SecretStoreError extends Error {
  constructor(readonly code: SecretRefusal, message: string) {
    super(message);
    this.name = "SecretStoreError";
  }
}

/** What every surface may see: the label, never the value. */
export interface SecretView {
  name: string;
  /** BOX_SCOPE, or the id of the project it belongs to. */
  scope: string;
  createdAt: number;
  updatedAt: number;
  /** Did the owner tick this one for a run's environment? */
  inject: boolean;
  /**
   * False when the row cannot be opened with this box's current key — the
   * session secret was replaced (a factory reset), or the file was carried over
   * from another device. The name is still shown, because the owner's next move
   * is to type the value again under it.
   */
  readable: boolean;
}

/** True when `scope` is one this store recognises. */
export function isValidSecretScope(scope: string): boolean {
  return scope === BOX_SCOPE || SECRET_SCOPE_RE.test(scope);
}
