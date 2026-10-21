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
import path, { untraced } from "@/lib/runtime-path";
import { DATA_DIR, get as configGet, set as configSet } from "@/lib/config-store";
import { getOrCreateSecret } from "@/lib/auth";
import { appendSecretAudit, type SecretImportSource } from "@/lib/secrets-audit";
import {
  BOX_SCOPE,
  isDeviceSecretScope,
  isReservedSecretName,
  isSecretExpired,
  isValidSecretScope,
  MAX_DEVICE_SECRETS,
  MAX_SECRET_VALUE_CHARS,
  MAX_SECRETS,
  MIN_SECRET_VALUE_CHARS,
  readSecretExpiry,
  SECRET_EXPIRY_RUN,
  SECRET_INJECT_CONFIG_KEY,
  SECRET_NAME_RE,
  SECRETS_FILE_NAME,
  SecretStoreError,
  type DeviceSecretScope,
  type SecretExpiry,
  type SecretView,
} from "@/lib/project-secrets-shape";

// Re-exported so a server caller has one import for the store and its shape.
// The shape half is a separate module because it has to run in the BROWSER too
// — the secrets card validates a typed name before it posts it, the way
// coding-permission-rules is shared for the same reason — and this file reaches
// for `fs`, `crypto` and the session secret.
export {
  BOX_SCOPE,
  DEVICE_SECRET_SCOPES,
  isDeviceSecretScope,
  isReservedSecretName,
  isValidSecretScope,
  MAX_SECRET_VALUE_CHARS,
  MAX_SECRETS,
  MIN_SECRET_VALUE_CHARS,
  SECRET_EXPIRY_RUN,
  SECRET_INJECT_CONFIG_KEY,
  SECRET_NAME_RE,
  SECRET_SCOPE_RE,
  SECRETS_FILE_NAME,
  SecretStoreError,
  type DeviceSecretScope,
  type SecretExpiry,
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
  /**
   * OPTIONAL, and only on a copy the owner limited (`importSecret`): "run" or an
   * ISO instant — see SecretExpiry. Unauthenticated like the rest of the label,
   * and that is safe in one direction only, which is the one that matters: a
   * hand edit can shorten or break an expiry (an unreadable one reads as over),
   * but anyone able to remove it could equally read `.session-secret`.
   */
  expiresAt?: SecretExpiry;
  /** The run a "run" entry was handed to. Set once, by `resolveSecretsForRun`. */
  usedBy?: string;
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
      "A secret's name is an environment variable name: capital letters, digits and underscores, starting with a letter — like DEPLOY_TOKEN.",
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

/**
 * True when `requireSecretValue` would accept it. For a list that must only
 * offer what a save can keep — the assistant's keys (src/lib/assistant-secrets.ts),
 * where a button that always ends in a refusal is no offer at all.
 */
export function isStorableSecretValue(value: unknown): boolean {
  try {
    requireSecretValue(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * A copy's expiry as the owner asked for it: none (absent, null or ""), "run",
 * or an ISO-8601 instant still to come — normalised to `toISOString`'s form.
 * A date already over is refused rather than stored: a copy that could never
 * reach a run is not what the owner meant.
 */
export function requireSecretExpiry(value: unknown): SecretExpiry | null {
  if (value === undefined || value === null || value === "") return null;
  const expiry = readSecretExpiry(value);
  if (expiry === SECRET_EXPIRY_RUN) return SECRET_EXPIRY_RUN;
  if (typeof expiry !== "number" || !Number.isFinite(expiry) || expiry <= Date.now()) {
    throw new SecretStoreError("invalid_expiry", 'A copy expires after one run ("run") or at a date still to come.');
  }
  return new Date(expiry).toISOString();
}

// ── the file ────────────────────────────────────────────────────────────────

// A copy from the assistant (`importSecret`) is a row of this shape, plus an
// optional `expiresAt` (and, once a one-run copy is handed out, `usedBy`).
// Neither is checked here: an older build reads such a row unchanged, and this
// one reads an unreadable expiry as over (`isSecretExpired`).
function isStoredSecret(value: unknown): value is StoredSecret {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.name === "string" && SECRET_NAME_RE.test(v.name)
    // A device scope is one of ours too — dropping its rows here would have the
    // next owner save write the Anthropic accounts out of the file.
    && typeof v.scope === "string" && (isValidSecretScope(v.scope) || isDeviceSecretScope(v.scope))
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
  const tmp = untraced(`${SECRETS_PATH}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
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
    ...(entry.expiresAt !== undefined && entry.expiresAt !== null
      ? { expiresAt: String(entry.expiresAt), expired: isSecretExpired(entry.expiresAt, entry.usedBy) }
      : {}),
  };
}

function sortViews(views: SecretView[]): SecretView[] {
  return views.sort((a, b) => (a.scope === b.scope ? a.name.localeCompare(b.name) : a.scope.localeCompare(b.scope)));
}

/** The owner's rows: everything but the device's own scopes (see DEVICE_SECRET_SCOPES). */
function ownerEntries(entries: StoredSecret[]): StoredSecret[] {
  return entries.filter((entry) => !isDeviceSecretScope(entry.scope));
}

/** Every entry, names and scopes only. Never a value — see the header. */
export async function listSecrets(): Promise<SecretView[]> {
  const [entries, k] = await Promise.all([readStore(), storeKey()]);
  return sortViews(ownerEntries(entries).map((entry) => viewOf(entry, k)));
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
  return putSecret({ name, scope, value, inject, createOnly: false, audit: { action: "save" } });
}

/**
 * Save a value COPIED from where the box already holds it — the "Import from
 * assistant" button (src/lib/assistant-secrets.ts is the only caller, and it
 * reads the value server-side; no surface ever sends or receives one).
 *
 * Two differences from `setSecret`, and both are the safe reading of a copy:
 *
 *  - A NEW ENTRY ONLY. A name already stored in that scope is refused
 *    (`exists`), never replaced: the owner's own value under that name, and
 *    their tick on it, are a decision this button must not overwrite.
 *  - NEVER TICKED. `inject` is false whatever is asked, so a copied key reaches
 *    no run until the owner ticks it — the same three gates as a typed one.
 *
 * And one thing a typed entry does not have: an optional EXPIRY (SecretExpiry)
 * — one run, or a date — because a key borrowed from the assistant for one job
 * is exactly the grant that should not outlive the job. It is the row's only
 * extra field, and an optional one, so an older build after a rollback still
 * reads and keeps the row (without honouring the expiry). Where the copy came
 * from is on the audit line instead (src/lib/secrets-audit.ts).
 */
export async function importSecret(input: {
  name: unknown;
  value: unknown;
  scope?: unknown;
  source: SecretImportSource;
  expiresAt?: unknown;
}): Promise<SecretView> {
  const name = requireSecretName(input.name);
  const scope = requireSecretScope(input.scope);
  const value = requireSecretValue(input.value);
  const expiresAt = requireSecretExpiry(input.expiresAt);
  return putSecret({
    name,
    scope,
    value,
    inject: false,
    createOnly: true,
    expiresAt,
    audit: { action: "import", source: input.source, ...(expiresAt ? { expiresAt } : {}) },
  });
}

/** The one write path for an owner entry: `setSecret` and `importSecret`. */
function putSecret(input: {
  name: string;
  scope: string;
  value: string;
  inject: boolean | null;
  createOnly: boolean;
  /** A new entry's expiry. A REPLACED entry keeps its own: a re-typed value is not a wider grant. */
  expiresAt?: SecretExpiry | null;
  audit: { action: "save" | "import"; source?: SecretImportSource; expiresAt?: SecretExpiry };
}): Promise<SecretView> {
  const { name, scope, value, inject } = input;
  return serialised(async () => {
    const k = await storeKey();
    const entries = await readStore();
    const at = indexOf(entries, name, scope);
    const now = Date.now();
    if (at >= 0 && input.createOnly) {
      // Checked inside the chain, against the list as it stands now — a check
      // made before it could be beaten by a save landing in between.
      throw new SecretStoreError("exists", `There is already a secret called ${name} in that scope on this ClawBox. Remove it first to copy the assistant's.`);
    }
    if (at < 0 && ownerEntries(entries).length >= MAX_SECRETS) {
      // Refused, never evicted: the list is what the owner believes a run can
      // reach, and a save that quietly dropped the oldest entry would take a
      // working deploy token away from a project nobody was looking at.
      throw new SecretStoreError("full", `This ClawBox keeps at most ${MAX_SECRETS} secrets. Remove one first.`);
    }
    const sealed = seal(value, name, scope, k);
    const entry: StoredSecret = at < 0
      ? { name, scope, createdAt: now, updatedAt: now, inject: inject ?? false, ...sealed, ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}) }
      : { ...entries[at], updatedAt: now, inject: inject ?? entries[at].inject, ...sealed };
    if (at < 0) entries.push(entry);
    else entries[at] = entry;
    await writeStore(entries);
    await appendSecretAudit({ ...input.audit, name, scope });
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
    await appendSecretAudit({ action: inject ? "tick" : "untick", name, scope });
    return viewOf(entries[at], k);
  });
}

/**
 * Take back every entry filed under ONE project's scope. Answers the names
 * removed, in the order they were stored.
 *
 * For the one caller that has to: deleting a project folder
 * (src/lib/coding-project-delete.ts). A project's secrets are keyed by the same
 * identity the projects listing names a row with, so once the folder is gone
 * the rows are credentials for a project that no longer exists — kept, they sit
 * in the owner's list looking like a live grant, and a NEW folder of the same
 * name would silently inherit them. `BOX_SCOPE` is refused rather than accepted
 * and ignored: a caller that asked to clear "the box" means something this
 * function must never do.
 *
 * Answers the NAMES and never a value, like everything else here — that is what
 * lets the delete route tell the owner what went with the folder.
 */
export async function deleteSecretsForScope(scope: unknown): Promise<string[]> {
  const key = requireSecretScope(scope);
  if (key === BOX_SCOPE) {
    throw new SecretStoreError("invalid_scope", "Box-wide secrets belong to no one project and are never cleared with one.");
  }
  return serialised(async () => {
    const entries = await readStore();
    const removed = entries.filter((entry) => entry.scope === key).map((entry) => entry.name);
    if (!removed.length) return [];
    await writeStore(entries.filter((entry) => entry.scope !== key));
    await appendSecretAudit({ action: "delete", names: removed, scope: key, reason: "project_deleted" });
    return removed;
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
    await appendSecretAudit({ action: "delete", name, scope });
    return sortViews(ownerEntries(entries).map((e) => viewOf(e, k)));
  });
}

// ── the switch ──────────────────────────────────────────────────────────────

/** The owner's consent for injection. OFF when absent — see the key. */
export async function getInjectSecrets(): Promise<boolean> {
  return (await configGet(SECRET_INJECT_CONFIG_KEY)) === true;
}

/**
 * Flip the owner's switch. The audit line is written after the config store
 * has saved it, and only when it actually changed: the trail records a consent
 * given or withdrawn, not every click on a switch already where it was. On the
 * store's chain, so two windows flipping it at once cannot both read "off".
 */
export async function setInjectSecrets(on: unknown): Promise<boolean> {
  if (typeof on !== "boolean") {
    throw new SecretStoreError("invalid_value", "The secret-injection switch must be true or false.");
  }
  return serialised(async () => {
    const was = await getInjectSecrets();
    await configSet(SECRET_INJECT_CONFIG_KEY, on);
    if (was !== on) await appendSecretAudit({ action: on ? "switch_on" : "switch_off" });
    return on;
  });
}

// ── what a run gets ─────────────────────────────────────────────────────────

export interface ResolvedRunSecrets {
  /** Name → value, ready to merge into the run's environment. */
  env: Record<string, string>;
  /** The names injected, in order. Safe to log and to put on the record. */
  names: string[];
  /** Ticked entries this box could not open — named so the owner can re-enter them. */
  unreadable: string[];
  /** Name → the scope its value came FROM, for the audit line (`recordRunSecretsHanded`). Names only. */
  scopes: Record<string, string>;
}

const NOTHING: ResolvedRunSecrets = { env: {}, names: [], unreadable: [], scopes: {} };

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
 * A COPY WITH AN EXPIRY (SecretExpiry) is a fourth gate, on that entry alone:
 * past its date it reaches no run at all, and a one-run copy reaches the first
 * run that resolves it and no other — that run's id is written onto the row
 * here, before the run is handed anything, so two runs starting together cannot
 * both have it. The entry itself is removed when that run ends
 * (`releaseRunSecrets`). A resolve that names no run cannot claim one.
 *
 * Writes NO audit line: resolving is not handing, and the child it is for may
 * never start. The caller records the hand-off once it knows
 * (`recordRunSecretsHanded`).
 *
 * Never throws. A store this box cannot read is reported as nothing injected:
 * failing the run over it would be the worse outcome, and the resolved names go
 * on the record so a run that got nothing can be told why.
 */
export async function resolveSecretsForRun(run: { project?: string | null; runId?: string }): Promise<ResolvedRunSecrets> {
  try {
    if (!(await getInjectSecrets())) return NOTHING;
    // On the store's chain: a one-run copy is claimed by a write, and two runs
    // resolving at once must see each other's claim.
    return await serialised(() => resolveRunSecrets(run));
  } catch (err) {
    console.error("[secrets] could not resolve the secrets for a run:", err instanceof Error ? err.message : err);
    return NOTHING;
  }
}

/** A run id as the coding agent mints them; anything else claims nothing. */
const CLAIM_RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

async function resolveRunSecrets(run: { project?: string | null; runId?: string }): Promise<ResolvedRunSecrets> {
  const [entries, k] = await Promise.all([readStore(), storeKey()]);
  const project = typeof run.project === "string" && isValidSecretScope(run.project) ? run.project : null;
  const runId = typeof run.runId === "string" && CLAIM_RUN_ID_RE.test(run.runId) ? run.runId : null;
  const now = Date.now();
  const env: Record<string, string> = {};
  const scopes: Record<string, string> = {};
  const unreadable: string[] = [];
  /** The one-run copies this resolve hands out, by name — to be claimed for this run below. */
  const claims = new Map<string, StoredSecret>();
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
      // The expiry. Skipped like an un-ticked entry — no override is dropped
      // for it: a project copy that has expired is simply not there, and the
      // box-wide entry of the same name is what the owner left in place.
      const expiry = readSecretExpiry(entry.expiresAt);
      if (expiry === SECRET_EXPIRY_RUN) {
        if (!runId || (entry.usedBy !== undefined && entry.usedBy !== runId)) continue;
      } else if (expiry !== undefined && expiry <= now) {
        continue;
      }
      const value = open(entry, k);
      if (value === null) {
        // The OVERRIDE could not be opened, so the box-wide value under the
        // same name must go with it. Keeping it would hand the run a
        // different credential from the one the owner chose for this project
        // — silently, which is the worst of the three outcomes (found in
        // review). Nothing, and a named reason, is the honest answer.
        delete env[entry.name];
        delete scopes[entry.name];
        claims.delete(entry.name);
        if (!unreadable.includes(entry.name)) unreadable.push(entry.name);
        continue;
      }
      env[entry.name] = value;
      scopes[entry.name] = scope;
      // Only the entry whose value the run actually gets is claimed: a
      // one-run box-wide copy overridden by the project's own entry stays
      // free for the next run.
      if (expiry === SECRET_EXPIRY_RUN) claims.set(entry.name, entry);
      else claims.delete(entry.name);
      // The other direction: a box-wide entry this box cannot open, overridden
      // by a project entry it can, is not a problem to report.
      const stale = unreadable.indexOf(entry.name);
      if (stale >= 0) unreadable.splice(stale, 1);
    }
  }
  const unclaimed = [...claims.values()].filter((entry) => entry.usedBy === undefined);
  if (unclaimed.length > 0) {
    for (const entry of unclaimed) entry.usedBy = runId!;
    try {
      await writeStore(entries);
    } catch (err) {
      // Not written means not claimed, and an unclaimed one-run copy could go
      // to a second run as well. So this run does not get it either.
      console.error("[secrets] could not claim a one-run secret for a run:", err instanceof Error ? err.message : err);
      for (const entry of unclaimed) {
        delete env[entry.name];
        delete scopes[entry.name];
      }
    }
  }
  return { env, names: Object.keys(env), unreadable, scopes };
}

/**
 * The audit line for a hand-off, written by the caller once it KNOWS: after the
 * child it resolved them for has started (`handed: true` → "inject"), or after
 * it failed to (`false` → "not_handed", reason "spawn_failed").
 *
 * Names only, one line per scope the values came FROM: a box-wide key handed to
 * a project's run is still a box-wide key, and a line that filed it under the
 * project would tell the owner the project holds it. Nothing at all for a run
 * that was handed none. Never throws (appendSecretAudit does not).
 */
export async function recordRunSecretsHanded(input: {
  runId: string;
  names: readonly string[];
  scopes: Readonly<Record<string, string>>;
  handed: boolean;
}): Promise<void> {
  const byScope = new Map<string, string[]>();
  for (const name of input.names) {
    const scope = input.scopes[name] ?? BOX_SCOPE;
    byScope.set(scope, [...(byScope.get(scope) ?? []), name]);
  }
  for (const [scope, names] of byScope) {
    await appendSecretAudit(input.handed
      ? { action: "inject", names, scope, runId: input.runId }
      : { action: "not_handed", names, scope, runId: input.runId, reason: "spawn_failed" });
  }
}

/**
 * Remove every one-run copy whose run is over. Answers the names removed.
 *
 * `isOver` is the caller's: the store knows which run a copy went to
 * (`usedBy`), never whether that run is still going — the coding agent does.
 * It calls this when a run ends (finished, failed, stopped, or never started)
 * and before it hands anything out, which also clears a copy whose run ended
 * while this server was down. A copy nobody has been handed yet is never
 * touched.
 *
 * One audit line per run and scope, after the store has been written.
 */
export async function releaseRunSecrets(isOver: (runId: string) => boolean): Promise<string[]> {
  return serialised(async () => {
    const entries = await readStore();
    const spent = entries.filter((entry) =>
      readSecretExpiry(entry.expiresAt) === SECRET_EXPIRY_RUN
      && typeof entry.usedBy === "string"
      && isOver(entry.usedBy));
    if (!spent.length) return [];
    await writeStore(entries.filter((entry) => !spent.includes(entry)));
    const lines = new Map<string, { runId: string; scope: string; names: string[] }>();
    for (const entry of spent) {
      const key = `${entry.usedBy}\u0000${entry.scope}`;
      const line = lines.get(key) ?? { runId: entry.usedBy!, scope: entry.scope, names: [] };
      line.names.push(entry.name);
      lines.set(key, line);
    }
    for (const line of lines.values()) {
      await appendSecretAudit({ action: "delete", names: line.names, scope: line.scope, runId: line.runId, reason: "run_ended" });
    }
    return spent.map((entry) => entry.name);
  });
}

/**
 * THREE ways to not have a value, and they are kept apart because each one
 * needs a different sentence said to the owner.
 *
 * Folding any two of them together gives advice that is wrong for the other:
 * "save it under that name" is useless about an entry that is already there,
 * and worse than useless about a store this box cannot read at all — the owner
 * would type a credential into a file that is not going to keep it.
 */
export type SecretLookup =
  /** There is an entry, and this box can open it. */
  | { found: true; value: string }
  /** There is an entry and this box CANNOT open it — sealed under a key that is
   *  gone (a factory reset took `.session-secret`), or edited by hand. */
  | { found: false; reason: "unreadable" }
  /** The store was read, and holds no entry of that name in either scope. */
  | { found: false; reason: "missing" }
  /** The store or its key could not be read AT ALL: `data/secrets.json` is
   *  unreadable or is not the list it should be, or there is no session secret
   *  to derive the key from. Nothing is known about any entry. */
  | { found: false; reason: "unavailable" };

// ── the device's own rows ───────────────────────────────────────────────────
//
// A credential the BOX holds for itself — today the Anthropic account pool —
// kept in this file, under this key and this discipline, and outside every
// owner surface (see DEVICE_SECRET_SCOPES). The functions below are the only
// way in or out, they take a device scope and nothing else, and none of them is
// reachable from a route: the pool module calls them, and it answers labels and
// states, never a value.

function requireDeviceScope(scope: unknown): DeviceSecretScope {
  if (!isDeviceSecretScope(scope)) {
    throw new SecretStoreError("invalid_scope", "That is not a scope this ClawBox keeps its own credentials under.");
  }
  return scope;
}

/** A device row's name: the variable-name alphabet, reserved prefixes allowed — nothing here reaches an environment. */
function requireDeviceName(name: unknown): string {
  if (typeof name !== "string" || !SECRET_NAME_RE.test(name)) {
    throw new SecretStoreError("invalid_name", "A device credential is named like an environment variable.");
  }
  return name;
}

/** Save (or replace) one device credential. */
export async function setDeviceSecret(input: { scope: unknown; name: unknown; value: unknown }): Promise<void> {
  const scope = requireDeviceScope(input.scope);
  const name = requireDeviceName(input.name);
  const value = requireSecretValue(input.value);
  await serialised(async () => {
    const k = await storeKey();
    const entries = await readStore();
    const at = indexOf(entries, name, scope);
    if (at < 0 && entries.filter((entry) => entry.scope === scope).length >= MAX_DEVICE_SECRETS) {
      throw new SecretStoreError("full", `This ClawBox keeps at most ${MAX_DEVICE_SECRETS} credentials of this kind.`);
    }
    const now = Date.now();
    const sealed = seal(value, name, scope, k);
    // Never injected, whatever an older row claimed: the tick is the owner's
    // consent for a run's environment, and no run gets a device row.
    const entry: StoredSecret = at < 0
      ? { name, scope, createdAt: now, updatedAt: now, inject: false, ...sealed }
      : { ...entries[at], updatedAt: now, inject: false, ...sealed };
    if (at < 0) entries.push(entry);
    else entries[at] = entry;
    await writeStore(entries);
  });
}

/** One device credential, with the same three ways of not having it as `readSecretForProject`. */
export async function readDeviceSecret(input: { scope: unknown; name: unknown }): Promise<SecretLookup> {
  try {
    const scope = requireDeviceScope(input.scope);
    const name = requireDeviceName(input.name);
    const [entries, k] = await Promise.all([readStore(), storeKey()]);
    const at = indexOf(entries, name, scope);
    if (at < 0) return { found: false, reason: "missing" };
    const value = open(entries[at], k);
    return value === null ? { found: false, reason: "unreadable" } : { found: true, value };
  } catch (err) {
    const bad = err instanceof SecretStoreError && (err.code === "invalid_name" || err.code === "invalid_scope");
    return { found: false, reason: bad ? "missing" : "unavailable" };
  }
}

/** Forget one device credential. Answers whether there was one. */
export async function deleteDeviceSecret(input: { scope: unknown; name: unknown }): Promise<boolean> {
  const scope = requireDeviceScope(input.scope);
  const name = requireDeviceName(input.name);
  return serialised(async () => {
    const entries = await readStore();
    const at = indexOf(entries, name, scope);
    if (at < 0) return false;
    entries.splice(at, 1);
    await writeStore(entries);
    return true;
  });
}

/** The names filed under one device scope — for a sweep of rows nothing refers to any more. */
export async function listDeviceSecretNames(scope: unknown): Promise<string[]> {
  const key = requireDeviceScope(scope);
  return (await readStore()).filter((entry) => entry.scope === key).map((entry) => entry.name);
}
