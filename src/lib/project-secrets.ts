/**
 * The owner's secret store: credentials a delegated coding run needs and only
 * the owner may put there — a deploy token, a test-mode API key, the address
 * of a machine it may reach.
 *
 * WHY IT EXISTS. A run is a headless Claude Code session with no person behind
 * it (src/lib/coding-agent.ts). Anything it needs that is not on the box has to
 * be somewhere it can read, and until now the only answers were "paste it into
 * the task" — which puts it in the run record, the progress feed, the harness
 * transcript and every status answer the agent can read — or "leave it in a
 * file in the project", which commits it. This is the third answer: the owner
 * types it once, the box keeps it encrypted, and a run the owner has switched
 * injection on for gets it as an environment variable and never sees it in any
 * of its own output (src/lib/secret-redact.ts).
 *
 * WHAT THIS FILE IS NOT. It is not a general-purpose vault for the agent. The
 * value is write-only from every SURFACE: it goes in through the owner's own
 * browser session and comes out in exactly two directions, neither of which is
 * a surface — into a run's environment, and into a request this box makes on
 * the owner's behalf (`readSecretForProject`, at the foot of this file). There
 * is no route, no tool and no MCP verb that answers with a stored value —
 * `listSecrets` returns names and scopes, which is what the picker and the
 * agent's own tool need in order to talk about a secret without holding one.
 *
 * STORAGE. `data/secrets.json`, 0600, written temp+rename, exactly the
 * discipline config-store and email-pending use. A separate file rather than a
 * config key for the same reason the mail queue is: this is a keyed collection
 * with a lifecycle, and it must not be in the blob every settings read parses
 * and every config dump prints.
 *
 * ENCRYPTION AT REST. AES-256-GCM, one random 96-bit IV per entry, the tag
 * kept beside it, and the entry's own `name` and `scope` as additional
 * authenticated data — so a stored row cannot be relabelled into another
 * project's scope or under another variable's name without the open failing.
 *
 * THE KEY, and why HKDF and not scrypt. It is derived from the box's existing
 * session secret (`data/.session-secret`, 32 bytes from `crypto.randomBytes`,
 * 0600, the file middleware signs cookies with) through HKDF-SHA256 with a
 * fixed salt and info string. A password KDF is the right answer for
 * LOW-entropy input — it buys a work factor against guessing. There is nothing
 * to guess here: the input is already full-entropy random, and an attacker who
 * has it is root or the app user, at which point they can read this file, the
 * cookie secret and every other credential on the box anyway. So what
 * encryption at rest buys is narrower and worth stating plainly: a secret does
 * not sit in cleartext in a JSON file that gets copied into a backup, a support
 * bundle, a stray `git add` or a ClawKeep snapshot whose passphrase is the
 * thing protecting it. HKDF is the correct primitive for stretching one strong
 * key into a purpose-separated one, and the `info` string is what keeps this
 * key from being the cookie-signing key.
 *
 * WHAT FOLLOWS FROM THE KEY BEING THAT FILE. Lose `.session-secret` — a factory
 * reset wipes it — and every stored value is unrecoverable. That is the right
 * failure: the alternative is key material this box could not protect any
 * better. Each row records the `keyId` it was written under, so a value that
 * cannot be opened is reported as "written under a key this box no longer has"
 * rather than as a corrupt file, and the owner is told to type it again.
 */

import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { DATA_DIR, get as configGet, set as configSet } from "@/lib/config-store";
import { getOrCreateSecret } from "@/lib/auth";
import {
  BOX_SCOPE,
  isReservedSecretName,
  isValidSecretScope,
  MAX_SECRET_VALUE_CHARS,
  MAX_SECRETS,
  MIN_SECRET_VALUE_CHARS,
  SECRET_INJECT_CONFIG_KEY,
  SECRET_NAME_RE,
  SECRETS_FILE_NAME,
  SecretStoreError,
  type SecretView,
} from "@/lib/project-secrets-shape";

// Re-exported so a server caller has one import for the store and its shape.
// The shape half is a separate module because it has to run in the BROWSER too
// — the secrets card validates a typed name before it posts it, the way
// coding-permission-rules is shared for the same reason — and this file reaches
// for `fs`, `crypto` and the session secret.
export {
  BOX_SCOPE,
  isReservedSecretName,
  isValidSecretScope,
  MAX_SECRET_VALUE_CHARS,
  MAX_SECRETS,
  MIN_SECRET_VALUE_CHARS,
  SECRET_INJECT_CONFIG_KEY,
  SECRET_NAME_RE,
  SECRET_SCOPE_RE,
  SECRETS_FILE_NAME,
  SecretStoreError,
  type SecretRefusal,
  type SecretView,
} from "@/lib/project-secrets-shape";

/** Where the store lives. */
const SECRETS_PATH = path.join(DATA_DIR, SECRETS_FILE_NAME);

export function secretsStorePath(): string {
  return SECRETS_PATH;
}

interface StoredSecret {
  name: string;
  scope: string;
  createdAt: number;
  updatedAt: number;
  inject: boolean;
  /** base64: the 12-byte IV, the 16-byte GCM tag, the ciphertext. */
  iv: string;
  tag: string;
  value: string;
  /** Which derived key sealed it — see the header. */
  keyId: string;
}

// ── the key ─────────────────────────────────────────────────────────────────

const HKDF_SALT = "clawbox/secret-store/v1";
const HKDF_INFO = "clawbox-project-secrets-aes-256-gcm";

interface StoreKey {
  key: Buffer;
  id: string;
}

/**
 * Derived once per process and cached: the session secret does not change while
 * the web server runs (rotating it needs a restart — see auth.ts), and the read
 * path runs on every poll of an open Settings window.
 */
let cachedKey: StoreKey | null = null;

async function storeKey(): Promise<StoreKey> {
  if (cachedKey) return cachedKey;
  let secret: string;
  try {
    // The FILE, deliberately, and not `getSessionSigningSecret`: that one
    // prefers `process.env.SESSION_SECRET`, which is an operator override that
    // can be set, unset or changed between restarts. A key that followed it
    // would make every stored value unreadable the first time somebody started
    // the server without the variable.
    secret = (await getOrCreateSecret()).trim();
  } catch (err) {
    throw new SecretStoreError(
      "key_unavailable",
      `This ClawBox could not read the key its secrets are encrypted with: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (secret.length < 32) {
    throw new SecretStoreError("key_unavailable", "This ClawBox has no session secret yet, so there is no key to encrypt a secret with.");
  }
  const key = Buffer.from(crypto.hkdfSync(
    "sha256",
    Buffer.from(secret, "utf8"),
    Buffer.from(HKDF_SALT, "utf8"),
    Buffer.from(HKDF_INFO, "utf8"),
    32,
  ));
  // A NAME for the key, not a piece of it: the hash is taken of the derived
  // key, so it says which key sealed a row without being usable to open one.
  const id = crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
  cachedKey = { key, id };
  return cachedKey;
}

/** Test seam: drop the cached key so a test can point HOME somewhere else. */
export function _resetSecretKeyCacheForTests(): void {
  cachedKey = null;
}

/** The AAD that binds a row to its label. See the header. */
function aad(name: string, scope: string): Buffer {
  return Buffer.from(`${name}\u0000${scope}`, "utf8");
}

function seal(value: string, name: string, scope: string, k: StoreKey): Pick<StoredSecret, "iv" | "tag" | "value" | "keyId"> {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", k.key, iv);
  // The label is authenticated, not encrypted: it is in the file in the clear
  // (the picker needs it), and binding it here is what stops a row being moved
  // to another scope or renamed by editing the JSON.
  cipher.setAAD(aad(name, scope));
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    value: body.toString("base64"),
    keyId: k.id,
  };
}

/**
 * The stored value, or null when this box cannot open it.
 *
 * Never throws: an entry sealed under a key that is gone, or a row somebody
 * edited by hand, must not take the whole store down — the other entries are
 * still the owner's and still work.
 */
function open(entry: StoredSecret, k: StoreKey): string | null {
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", k.key, Buffer.from(entry.iv, "base64"));
    decipher.setAAD(aad(entry.name, entry.scope));
    decipher.setAuthTag(Buffer.from(entry.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(entry.value, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

// ── validation ──────────────────────────────────────────────────────────────

/** The name, checked. Throws the refusal the owner is shown. */
export function requireSecretName(name: unknown): string {
  if (typeof name !== "string" || !SECRET_NAME_RE.test(name)) {
    throw new SecretStoreError(
      "invalid_name",
      "A secret's name is an environment variable name: capital letters, digits and underscores, starting with a letter — like VERCEL_TOKEN.",
    );
  }
  if (isReservedSecretName(name)) {
    throw new SecretStoreError(
      "reserved_name",
      `${name} is a name this ClawBox uses itself, so a run would never see your value under it. Choose another name.`,
    );
  }
  return name;
}

/** The scope, checked. `undefined` and `null` both mean the whole box. */
export function requireSecretScope(scope: unknown): string {
  if (scope === undefined || scope === null || scope === BOX_SCOPE) return BOX_SCOPE;
  if (typeof scope !== "string" || !isValidSecretScope(scope)) {
    throw new SecretStoreError("invalid_scope", 'A secret belongs either to the whole box ("box") or to one project, named by its id.');
  }
  return scope;
}

/**
 * The value, checked.
 *
 * No C0 controls and no DEL, for the reason email-pending refuses them in a
 * subject: this string becomes an environment variable, and a NUL would
 * truncate it where the kernel copies it, while an ANSI escape would rewrite
 * whatever terminal ever prints a line near it. Newlines and tabs are KEPT — a
 * PEM key is multi-line and is exactly what this store has to hold. Surrounding
 * whitespace is trimmed rather than refused, because a value pasted out of a
 * file carries a trailing newline the owner cannot see and a token with one is
 * a token that does not work.
 */
/** C0 controls and DEL, less tab, newline and carriage return. */
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function requireSecretValue(value: unknown): string {
  if (typeof value !== "string") {
    throw new SecretStoreError("invalid_value", "A secret's value must be text.");
  }
  const trimmed = value.trim();
  if (!trimmed) throw new SecretStoreError("invalid_value", "A secret needs a value.");
  // Refused rather than stored-and-unscrubbable: see MIN_SECRET_VALUE_CHARS.
  if (trimmed.length < MIN_SECRET_VALUE_CHARS) {
    throw new SecretStoreError(
      "value_too_short",
      `A secret's value must be at least ${MIN_SECRET_VALUE_CHARS} characters, so this ClawBox can keep it out of a run's own output.`,
    );
  }
  if (trimmed.length > MAX_SECRET_VALUE_CHARS) {
    throw new SecretStoreError("value_too_long", `A secret's value may be at most ${MAX_SECRET_VALUE_CHARS} characters.`);
  }
  if (CONTROL_CHARS_RE.test(trimmed)) {
    throw new SecretStoreError(
      "invalid_value",
      "A secret's value has control characters in it that this ClawBox will not put in a run's environment.",
    );
  }
  return trimmed;
}

// ── the file ────────────────────────────────────────────────────────────────

function isStoredSecret(value: unknown): value is StoredSecret {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.name === "string" && SECRET_NAME_RE.test(v.name)
    && typeof v.scope === "string" && isValidSecretScope(v.scope)
    && typeof v.createdAt === "number" && typeof v.updatedAt === "number"
    && typeof v.inject === "boolean"
    && typeof v.iv === "string" && typeof v.tag === "string"
    && typeof v.value === "string" && typeof v.keyId === "string";
}

/**
 * Read the store.
 *
 * A missing file is an empty store — that is a box nobody has saved a secret
 * on. Anything else is REPORTED, not swallowed: unlike the mail queue, where an
 * unreadable file means "nothing is waiting", a secret store read as empty
 * would be written back empty by the next save and take the owner's whole list
 * with it. The same reasoning as `mutateExtraPaths`'s strict read.
 */
async function readStore(): Promise<StoredSecret[]> {
  let raw: string;
  try {
    raw = await fs.readFile(SECRETS_PATH, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw new SecretStoreError(
      "store_unreadable",
      `This ClawBox could not read its secret store: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new SecretStoreError(
      "store_unreadable",
      `This ClawBox's secret store is not readable JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new SecretStoreError("store_unreadable", "This ClawBox's secret store is not the list it should be.");
  }
  // A row that is not one of ours is dropped rather than refused: the shape
  // check is what keeps a hand-edited file from reaching the cipher, and one
  // bad row must not hide the rest of the owner's list.
  return parsed.filter(isStoredSecret);
}

async function writeStore(entries: StoredSecret[]): Promise<void> {
  // A unique temp name, like the timezone route's: two saves that overlapped on
  // one fixed `.tmp` would each write half a file for the other to rename.
  const tmp = `${SECRETS_PATH}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(entries, null, 2), { mode: 0o600 });
    // Explicit, because `mode` is masked by the process umask and because a
    // stale temp could have survived a crash at a wider mode.
    await fs.chmod(tmp, 0o600);
    await fs.rename(tmp, SECRETS_PATH);
    // The renamed file carries the temp's mode; this is for a store written by
    // an older build, or restored from an archive that lost the bits.
    await fs.chmod(SECRETS_PATH, 0o600);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw new SecretStoreError(
      "store_unwritable",
      `This ClawBox could not save to its secret store: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Every change runs after the previous one has settled.
 *
 * The same mechanism and the same reason as `mutateExtraPaths`: a read-modify-
 * write over one file, reachable from two clicks in two windows. Overlapped,
 * the second save writes the list it read before the first one landed, and one
 * entry disappears with both requests answering success. A failed mutation is
 * its caller's to report and is never inherited by the next one.
 */
let chain: Promise<unknown> = Promise.resolve();

function serialised<T>(work: () => Promise<T>): Promise<T> {
  const next = chain.then(work, work);
  chain = next.then(() => undefined, () => undefined);
  return next;
}

// ── the public store ────────────────────────────────────────────────────────

function viewOf(entry: StoredSecret, k: StoreKey): SecretView {
  return {
    name: entry.name,
    scope: entry.scope,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    inject: entry.inject,
    readable: entry.keyId === k.id && open(entry, k) !== null,
  };
}

function sortViews(views: SecretView[]): SecretView[] {
  return views.sort((a, b) => (a.scope === b.scope ? a.name.localeCompare(b.name) : a.scope.localeCompare(b.scope)));
}

/** Every entry, names and scopes only. Never a value — see the header. */
export async function listSecrets(): Promise<SecretView[]> {
  const [entries, k] = await Promise.all([readStore(), storeKey()]);
  return sortViews(entries.map((entry) => viewOf(entry, k)));
}

/** Where an entry sits in the list: one name in one scope, and nowhere twice. */
function indexOf(entries: StoredSecret[], name: string, scope: string): number {
  return entries.findIndex((entry) => entry.name === name && entry.scope === scope);
}

/**
 * Save a value under a name and a scope — a new entry, or a new value for one
 * that is already there.
 *
 * Replacing keeps `createdAt` and the owner's `inject` tick unless this call
 * names one: re-pasting a rotated token is not a reason to re-ask whether runs
 * may have it.
 */
export async function setSecret(input: { name: unknown; value: unknown; scope?: unknown; inject?: unknown }): Promise<SecretView> {
  const name = requireSecretName(input.name);
  const scope = requireSecretScope(input.scope);
  const value = requireSecretValue(input.value);
  const inject = typeof input.inject === "boolean" ? input.inject : null;
  return serialised(async () => {
    const k = await storeKey();
    const entries = await readStore();
    const at = indexOf(entries, name, scope);
    const now = Date.now();
    if (at < 0 && entries.length >= MAX_SECRETS) {
      // Refused, never evicted: the list is what the owner believes a run can
      // reach, and a save that quietly dropped the oldest entry would take a
      // working deploy token away from a project nobody was looking at.
      throw new SecretStoreError("full", `This ClawBox keeps at most ${MAX_SECRETS} secrets. Remove one first.`);
    }
    const sealed = seal(value, name, scope, k);
    const entry: StoredSecret = at < 0
      ? { name, scope, createdAt: now, updatedAt: now, inject: inject ?? false, ...sealed }
      : { ...entries[at], updatedAt: now, inject: inject ?? entries[at].inject, ...sealed };
    if (at < 0) entries.push(entry);
    else entries[at] = entry;
    await writeStore(entries);
    return viewOf(entry, k);
  });
}

/** Tick or un-tick one entry for a run's environment. */
export async function setSecretInject(input: { name: unknown; scope?: unknown; inject: unknown }): Promise<SecretView> {
  const name = requireSecretName(input.name);
  const scope = requireSecretScope(input.scope);
  if (typeof input.inject !== "boolean") {
    throw new SecretStoreError("invalid_value", "The injection tick must be true or false.");
  }
  const inject = input.inject;
  return serialised(async () => {
    const k = await storeKey();
    const entries = await readStore();
    const at = indexOf(entries, name, scope);
    if (at < 0) throw new SecretStoreError("not_found", `There is no secret called ${name} in that scope on this ClawBox.`);
    entries[at] = { ...entries[at], inject, updatedAt: Date.now() };
    await writeStore(entries);
    return viewOf(entries[at], k);
  });
}

/** Take one back. Answers the list as it now stands. */
export async function deleteSecret(input: { name: unknown; scope?: unknown }): Promise<SecretView[]> {
  const name = requireSecretName(input.name);
  const scope = requireSecretScope(input.scope);
  return serialised(async () => {
    const k = await storeKey();
    const entries = await readStore();
    const at = indexOf(entries, name, scope);
    if (at < 0) throw new SecretStoreError("not_found", `There is no secret called ${name} in that scope on this ClawBox.`);
    entries.splice(at, 1);
    await writeStore(entries);
    return sortViews(entries.map((e) => viewOf(e, k)));
  });
}

// ── the switch ──────────────────────────────────────────────────────────────

/** The owner's consent for injection. OFF when absent — see the key. */
export async function getInjectSecrets(): Promise<boolean> {
  return (await configGet(SECRET_INJECT_CONFIG_KEY)) === true;
}

export async function setInjectSecrets(on: unknown): Promise<boolean> {
  if (typeof on !== "boolean") {
    throw new SecretStoreError("invalid_value", "The secret-injection switch must be true or false.");
  }
  await configSet(SECRET_INJECT_CONFIG_KEY, on);
  return on;
}

// ── what a run gets ─────────────────────────────────────────────────────────

export interface ResolvedRunSecrets {
  /** Name → value, ready to merge into the run's environment. */
  env: Record<string, string>;
  /** The names injected, in order. Safe to log and to put on the record. */
  names: string[];
  /** Ticked entries this box could not open — named so the owner can re-enter them. */
  unreadable: string[];
}

const NOTHING: ResolvedRunSecrets = { env: {}, names: [], unreadable: [] };

/**
 * The secrets ONE run may have: the box-scoped ticked entries plus the ticked
 * entries of its own project, and nothing else.
 *
 * THREE gates, and every one of them has to be open:
 *   1. the owner's switch (`SECRET_INJECT_CONFIG_KEY`), off by default;
 *   2. the entry's own `inject` tick, off by default;
 *   3. the scope — a project's secret reaches that project's runs only.
 * A run with no project (a bare folder the owner pointed the agent at) gets the
 * box-scoped entries alone: it is not a project, so no project's secrets are
 * its own.
 *
 * A project-scoped entry WINS over a box-scoped one of the same name, because
 * the more specific statement is the one the owner made about this project — a
 * `STRIPE_KEY` saved on the project is the project's key.
 *
 * `run.project` is the project's IDENTITY as the projects listing names it
 * (`CodingProject.folder`): a code project's id, or the first folder under the
 * owner's project folder for a run working anywhere inside one. Not
 * `run.projectId`, which is null for every folder project — scoping on that
 * would have made a project secret reach code projects only, which is the
 * minority of runs. `projectScopeFor` in coding-agent.ts is the resolver.
 *
 * Never throws. A store this box cannot read is reported as nothing injected:
 * failing the run over it would be the worse outcome, and the resolved names go
 * on the record so a run that got nothing can be told why.
 */
export async function resolveSecretsForRun(run: { project?: string | null }): Promise<ResolvedRunSecrets> {
  try {
    if (!(await getInjectSecrets())) return NOTHING;
    const [entries, k] = await Promise.all([readStore(), storeKey()]);
    const project = typeof run.project === "string" && isValidSecretScope(run.project) ? run.project : null;
    const env: Record<string, string> = {};
    const unreadable: string[] = [];
    // Box scope first, the project's over the top: see the precedence note. A
    // project scope can never BE the box scope — `BOX_SCOPE` is outside the
    // project alphabet — so the two passes are always distinct.
    for (const scope of project ? [BOX_SCOPE, project] : [BOX_SCOPE]) {
      for (const entry of entries) {
        if (entry.scope !== scope || !entry.inject) continue;
        // Checked again here rather than trusted from the save: the floor only
        // ever grows, and a name that was allowed under an older build must not
        // reach a run's environment unchecked.
        if (!SECRET_NAME_RE.test(entry.name) || isReservedSecretName(entry.name)) continue;
        const value = open(entry, k);
        if (value === null) {
          // The OVERRIDE could not be opened, so the box-wide value under the
          // same name must go with it. Keeping it would hand the run a
          // different credential from the one the owner chose for this project
          // — silently, which is the worst of the three outcomes (found in
          // review). Nothing, and a named reason, is the honest answer.
          delete env[entry.name];
          if (!unreadable.includes(entry.name)) unreadable.push(entry.name);
          continue;
        }
        env[entry.name] = value;
        // The other direction: a box-wide entry this box cannot open, overridden
        // by a project entry it can, is not a problem to report.
        const stale = unreadable.indexOf(entry.name);
        if (stale >= 0) unreadable.splice(stale, 1);
      }
    }
    return { env, names: Object.keys(env), unreadable };
  } catch (err) {
    console.error("[secrets] could not resolve the secrets for a run:", err instanceof Error ? err.message : err);
    return NOTHING;
  }
}

// ── what the BOX itself may read ────────────────────────────────────────────

/**
 * ONE stored value, resolved for a project, for a call this box makes ITSELF.
 *
 * THE SECOND LEGITIMATE CONSUMER, and the header's "write-only from every
 * surface" is unchanged by it: a value still leaves this module in exactly two
 * directions — into a run's environment, and into an outgoing request the
 * device makes on the owner's behalf (src/lib/vercel-link.ts asks a Vercel
 * project how its build went). Neither is a surface. No route, no tool and no
 * MCP verb answers with what this returns, and the one sentence that could
 * carry it — an upstream error quoted back — is scrubbed before it is stored
 * (`redactToken` in src/lib/vercel.ts).
 *
 * DELIBERATELY NOT GATED ON THE INJECTION SWITCH OR THE ENTRY'S TICK. Both of
 * those answer "may an unattended shell hold this credential", which is a
 * different question from "may this ClawBox use the token its owner attached to
 * a deploy". An owner who has switched injection OFF has said runs may not have
 * their token; they have not said the box may not tell them whether their
 * project built. Gating on the tick would also make a feature the owner
 * configured fail silently the day they un-ticked an unrelated box.
 *
 * The SCOPE precedence is `resolveSecretsForRun`'s, because it is the store's
 * rule rather than that function's: the project's own entry wins over a
 * box-wide one of the same name.
 *
 * Never throws, and never says WHY beyond null: the callers turn that into
 * their own refusal, and a store that cannot be read is not this function's to
 * explain.
 */
export async function readSecretForProject(input: { name: string; project?: string | null }): Promise<string | null> {
  try {
    const name = requireSecretName(input.name);
    const project = typeof input.project === "string" && isValidSecretScope(input.project) && input.project !== BOX_SCOPE
      ? input.project
      : null;
    const [entries, k] = await Promise.all([readStore(), storeKey()]);
    for (const scope of project ? [project, BOX_SCOPE] : [BOX_SCOPE]) {
      const at = indexOf(entries, name, scope);
      if (at < 0) continue;
      const value = open(entries[at], k);
      // An override this box cannot OPEN takes the box-wide value with it, the
      // way it does for a run: handing back a different credential from the one
      // the owner chose for this project, silently, is the worst of the three
      // outcomes.
      return value;
    }
    return null;
  } catch {
    return null;
  }
}
