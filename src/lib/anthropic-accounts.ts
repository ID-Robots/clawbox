/**
 * THE ANTHROPIC ACCOUNT POOL — more than one Anthropic account on one box, in
 * the owner's order, and the one that answers next.
 *
 * WHY. One Claude subscription has a five-hour session window and a weekly
 * cap. On 2026-09-18 the overnight coding queue spent account #1's window at
 * 22:27 and every run and review round failed until 22:50. With a second
 * account in the pool the run that hit the limit is moved to it and resumed in
 * place (src/lib/coding-agent.ts), and account #1 is simply the first usable
 * account again once its limit is over — preference order, never round-robin.
 * The arithmetic of that is src/lib/anthropic-limit.ts; this module is the
 * state and the credentials.
 *
 * THREE KINDS OF ACCOUNT.
 *  - `oauth`: a Claude Pro/Max account connected through the box's EXISTING
 *    Anthropic OAuth flow (`/setup-api/ai-models/oauth/start` → the owner pastes
 *    the code → `…/exchange`, which leaves the tokens in the 0600 handoff file).
 *    The pool takes the tokens from there, and from then on this box is the one
 *    holder that refreshes them: two holders refreshing one refresh token race,
 *    and the loser is signed out.
 *  - `api_key`: an Anthropic API key, pasted here or in the Coding Agent app.
 *  - `login`: the `claude` sign-in the owner made in the Terminal app. Listed so
 *    it can be ordered with the others; its credential stays Claude Code's own —
 *    never read, never copied (src/lib/claude-login.ts).
 *
 * WHERE THINGS ARE. The credentials — an OAuth token set, an API key — are in
 * the owner secret store (src/lib/project-secrets.ts), encrypted, under the
 * device scope `@anthropic-accounts` that no owner surface lists, no run is
 * injected from and no route can reach. NEVER in data/config.json, a log line,
 * a run record or a pull request. What IS in config.json, under
 * `anthropic_accounts`, is the pool's state: labels, emails, the order, which
 * account is limited until when. Nothing in that key is a secret.
 *
 * MIGRATION. A box that predates the pool had at most one Anthropic credential
 * of its own — `anthropic_api_key` in config.json, which the wrapper read — and
 * possibly the owner's `claude` sign-in. The first read of the pool moves the
 * key into the secret store as account #1 and deletes it from the config, adds
 * the sign-in after it, and records that it did so. No owner action, and a
 * migration that could not complete (no session secret yet, a store that would
 * not write) leaves the key where it was and is tried again at the next read.
 */

import crypto from "crypto";
import fs from "fs";
import path from "@/lib/runtime-path";
import { DATA_DIR, get as configGet, set as configSet } from "@/lib/config-store";
import { anthropicLoginEmail, hasAnthropicLogin } from "@/lib/claude-login";
import { ANTHROPIC_API_KEY_CONFIG_KEY } from "@/lib/coding-provider";
import { OAUTH_PROVIDERS } from "@/lib/oauth-config";
import { createSerialLock, type SerialLock } from "@/lib/serial-lock";
import {
  deleteDeviceSecret,
  listDeviceSecretNames,
  readDeviceSecret,
  setDeviceSecret,
} from "@/lib/project-secrets";
import {
  ANTHROPIC_ACCOUNT_STATUSES,
  effectiveStatus,
  isUsable,
  pickAccount,
  poolHealth,
  type AnthropicAccountStatus,
  type AnthropicLimitKind,
  type PoolHealth,
} from "@/lib/anthropic-limit";

// ── the record ──────────────────────────────────────────────────────────────

export const ANTHROPIC_ACCOUNT_KINDS = ["oauth", "api_key", "login"] as const;
export type AnthropicAccountKind = (typeof ANTHROPIC_ACCOUNT_KINDS)[number];

const LIMIT_KINDS: readonly AnthropicLimitKind[] = ["session", "weekly", "rate", "credit"];

export interface AnthropicAccount {
  /** Eight lowercase hex characters. Stable for the account's life; the secret's name derives from it. */
  id: string;
  /** What the owner calls it. */
  label: string;
  /** The account's handle, when the box knows it. A label, never a key. */
  email: string | null;
  kind: AnthropicAccountKind;
  /** As last recorded — read it through `effectiveStatus`, which ends a limit whose time has come. */
  status: AnthropicAccountStatus;
  /** When a `limited` account is expected back (ms since the epoch). */
  limitedUntil: number | null;
  /** Which cap it hit, for the owner's list. */
  limitKind: AnthropicLimitKind | null;
  addedAt: number;
  lastUsedAt: number | null;
  lastLimitedAt: number | null;
  /** An `oauth` account's access-token expiry — not a secret, and what the refresh is timed on. */
  expiresAt: number | null;
}

interface PoolFile {
  version: 1;
  /** The single legacy credential has been moved in (see the header). */
  migrated: boolean;
  /** The owner took the `claude` sign-in OUT of the pool; do not put it back by itself. */
  loginDismissed: boolean;
  /** In priority order: the first usable one answers. */
  accounts: AnthropicAccount[];
}

/** The config-store key the pool's STATE lives under. Never a credential. */
export const ANTHROPIC_ACCOUNTS_CONFIG_KEY = "anthropic_accounts";

/** The secret-store scope every account credential is filed under. */
export const ANTHROPIC_ACCOUNTS_SCOPE = "@anthropic-accounts" as const;

/** How many accounts one box holds. Enough for a household; a bound on a list the owner scrolls. */
export const MAX_ANTHROPIC_ACCOUNTS = 8;

export const MAX_ACCOUNT_LABEL_CHARS = 60;

const ID_RE = /^[0-9a-f]{8}$/;

function secretName(id: string): string {
  return `ACCOUNT_${id.toUpperCase()}`;
}

function newId(taken: readonly AnthropicAccount[]): string {
  for (;;) {
    const id = crypto.randomBytes(4).toString("hex");
    if (!taken.some((a) => a.id === id)) return id;
  }
}

function cleanLabel(raw: unknown, fallback: string): string {
  // Control characters out (a label is drawn in the owner's list and said in a
  // chat notice), runs of whitespace folded, then bounded.
  const text = typeof raw === "string" ? raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : "";
  return (text || fallback).slice(0, MAX_ACCOUNT_LABEL_CHARS);
}

function cleanEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim();
  return email.length > 3 && email.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(email) ? email : null;
}

/** One Claude account, however the sign-in happened to case its email. */
function sameEmail(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && a.toLowerCase() === b.toLowerCase();
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** One account off disk, or null — a hand-edited row the pool cannot trust is dropped, not guessed at. */
function normalizeAccount(raw: unknown): AnthropicAccount | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.id !== "string" || !ID_RE.test(v.id)) return null;
  if (!(ANTHROPIC_ACCOUNT_KINDS as readonly unknown[]).includes(v.kind)) return null;
  const status = (ANTHROPIC_ACCOUNT_STATUSES as readonly unknown[]).includes(v.status) ? (v.status as AnthropicAccountStatus) : "ok";
  const limitedUntil = num(v.limitedUntil);
  return {
    id: v.id,
    label: cleanLabel(v.label, "Anthropic account"),
    email: cleanEmail(v.email),
    kind: v.kind as AnthropicAccountKind,
    // A limit with no time on it could never end by itself; read it as over.
    status: status === "limited" && limitedUntil === null ? "ok" : status,
    limitedUntil: status === "limited" ? limitedUntil : null,
    limitKind: (LIMIT_KINDS as readonly unknown[]).includes(v.limitKind) ? (v.limitKind as AnthropicLimitKind) : null,
    addedAt: num(v.addedAt) ?? 0,
    lastUsedAt: num(v.lastUsedAt),
    lastLimitedAt: num(v.lastLimitedAt),
    expiresAt: num(v.expiresAt),
  };
}

function normalizePool(raw: unknown): PoolFile {
  const v = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const seen = new Set<string>();
  const accounts: AnthropicAccount[] = [];
  for (const entry of Array.isArray(v.accounts) ? v.accounts : []) {
    const account = normalizeAccount(entry);
    if (!account || seen.has(account.id)) continue;
    seen.add(account.id);
    accounts.push(account);
    if (accounts.length >= MAX_ANTHROPIC_ACCOUNTS) break;
  }
  return {
    version: 1,
    migrated: v.migrated === true,
    loginDismissed: v.loginDismissed === true,
    accounts,
  };
}

// ── errors ──────────────────────────────────────────────────────────────────

export type AnthropicAccountRefusal =
  | "not_found"
  | "invalid"
  | "full"
  | "duplicate"
  | "wrong_account"
  | "store_unavailable";

export class AnthropicAccountError extends Error {
  /**
   * `details`: the facts a refusal's message is built from (emails, a label),
   * so the owner's card can say it in the owner's language rather than show
   * the English `message`. Labels and emails only — never a credential.
   */
  constructor(readonly code: AnthropicAccountRefusal, message: string, readonly details?: Readonly<Record<string, string>>) {
    super(message);
    this.name = "AnthropicAccountError";
  }
}

// ── the state, serialised ───────────────────────────────────────────────────

/**
 * The last pool this process read or wrote. The runner's settle path is
 * synchronous and has to know, in the same tick, whether ANOTHER account can
 * take a run over — this is that answer. Every read and every write refreshes
 * it; nothing but this module assigns it.
 */
let snapshot: PoolFile | null = null;

/** Every change runs after the previous one: a read-modify-write of one config key, reachable from two tabs and the runner. */
let chain: Promise<unknown> = Promise.resolve();

function serialised<T>(work: () => Promise<T>): Promise<T> {
  const next = chain.then(work, work);
  chain = next.then(() => undefined, () => undefined);
  return next;
}

async function writePool(file: PoolFile): Promise<void> {
  await configSet(ANTHROPIC_ACCOUNTS_CONFIG_KEY, file);
  snapshot = file;
  armWake(file);
}

/**
 * Keep the `claude` sign-in's row in step with the files: added when it
 * appears (unless the owner took it out), `expired` when it is gone, back to
 * `ok` when it returns. Answers whether anything changed.
 */
function syncLogin(file: PoolFile, now: number): boolean {
  const present = hasAnthropicLogin();
  const email = present ? anthropicLoginEmail() : null;
  const row = file.accounts.find((a) => a.kind === "login");
  if (!row) {
    if (!present || file.loginDismissed || file.accounts.length >= MAX_ANTHROPIC_ACCOUNTS) return false;
    file.accounts.push({
      id: newId(file.accounts),
      label: "Claude Code sign-in",
      email,
      kind: "login",
      status: "ok",
      limitedUntil: null,
      limitKind: null,
      addedAt: now,
      lastUsedAt: null,
      lastLimitedAt: null,
      expiresAt: null,
    });
    return true;
  }
  let changed = false;
  if (!present && row.status === "ok") {
    row.status = "expired";
    changed = true;
  } else if (present && row.status === "expired") {
    row.status = "ok";
    changed = true;
  }
  if (present && email && row.email !== email) {
    row.email = email;
    changed = true;
  }
  return changed;
}

/**
 * The one-time move of the single legacy credential into account #1.
 *
 * The key is written to the secret store FIRST and taken out of config.json
 * LAST, after the pool that names it has landed: a failure anywhere in between
 * leaves the key where the wrapper can still read it, and the next read tries
 * again. Throws (and so leaves `migrated` false) when the store cannot take it.
 */
async function migrateLegacy(file: PoolFile, now: number): Promise<string | null> {
  const raw = await configGet(ANTHROPIC_API_KEY_CONFIG_KEY);
  const key = typeof raw === "string" ? raw.trim() : "";
  if (!key) return null;
  const id = newId(file.accounts);
  await setDeviceSecret({ scope: ANTHROPIC_ACCOUNTS_SCOPE, name: secretName(id), value: key });
  file.accounts.unshift({
    id,
    label: "API key",
    email: null,
    kind: "api_key",
    status: "ok",
    limitedUntil: null,
    limitKind: null,
    addedAt: now,
    lastUsedAt: null,
    lastLimitedAt: null,
    expiresAt: null,
  });
  return id;
}

/** Read the pool, migrating and syncing the sign-in as needed. Inside the chain. */
async function loadLocked(): Promise<PoolFile> {
  const now = Date.now();
  const file = normalizePool(await configGet(ANTHROPIC_ACCOUNTS_CONFIG_KEY));
  let dirty = false;
  let migratedKey = false;
  if (!file.migrated) {
    try {
      migratedKey = (await migrateLegacy(file, now)) !== null;
      file.migrated = true;
      dirty = true;
    } catch (err) {
      console.error("[anthropic-accounts] could not move the stored API key into the secret store yet:", err instanceof Error ? err.message : err);
    }
  }
  if (syncLogin(file, now)) dirty = true;
  if (dirty) await writePool(file);
  else {
    snapshot = file;
    armWake(file);
  }
  // Out of config.json only once the pool that names it is on disk.
  if (migratedKey) {
    await configSet(ANTHROPIC_API_KEY_CONFIG_KEY, undefined);
    console.error("[anthropic-accounts] moved the stored Anthropic API key into the secret store as account #1");
  }
  return file;
}

async function mutate<T>(work: (file: PoolFile, now: number) => Promise<T> | T): Promise<T> {
  return serialised(async () => {
    const file = await loadLocked();
    const result = await work(file, Date.now());
    await writePool(file);
    return result;
  });
}

/** The pool, in priority order. Copies — changing them changes nothing. */
export async function readAccounts(): Promise<AnthropicAccount[]> {
  const file = await serialised(loadLocked);
  return file.accounts.map((a) => ({ ...a }));
}

/** The last pool this process saw, without touching the disk. Null before the first read. */
export function accountsSnapshot(): AnthropicAccount[] | null {
  return snapshot ? snapshot.accounts.map((a) => ({ ...a })) : null;
}

function find(file: PoolFile, id: unknown): AnthropicAccount {
  const account = typeof id === "string" ? file.accounts.find((a) => a.id === id) : undefined;
  if (!account) throw new AnthropicAccountError("not_found", "There is no Anthropic account with that id on this ClawBox.");
  return account;
}

// ── the owner's changes ─────────────────────────────────────────────────────

export interface OAuthTokens {
  access: string;
  refresh: string | null;
  /** ms since the epoch, or null when the exchange did not say. */
  expires: number | null;
}

function oauthSecret(tokens: OAuthTokens): string {
  return JSON.stringify({ access: tokens.access, refresh: tokens.refresh, expires: tokens.expires });
}

function parseOAuthSecret(value: string): OAuthTokens | null {
  try {
    const v = JSON.parse(value) as Record<string, unknown>;
    if (typeof v.access !== "string" || !v.access) return null;
    return {
      access: v.access,
      refresh: typeof v.refresh === "string" && v.refresh ? v.refresh : null,
      expires: num(v.expires),
    };
  } catch {
    return null;
  }
}

async function storeCredential(id: string, value: string): Promise<void> {
  try {
    await setDeviceSecret({ scope: ANTHROPIC_ACCOUNTS_SCOPE, name: secretName(id), value });
  } catch (err) {
    throw new AnthropicAccountError("store_unavailable", `This ClawBox could not save the account in its secret store: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function requireRoom(file: PoolFile): void {
  if (file.accounts.length >= MAX_ANTHROPIC_ACCOUNTS) {
    throw new AnthropicAccountError("full", `This ClawBox keeps at most ${MAX_ANTHROPIC_ACCOUNTS} Anthropic accounts. Remove one first.`);
  }
}

function blankAccount(id: string, kind: AnthropicAccountKind, label: string, email: string | null, now: number): AnthropicAccount {
  return {
    id,
    label,
    email,
    kind,
    status: "ok",
    limitedUntil: null,
    limitKind: null,
    addedAt: now,
    lastUsedAt: null,
    lastLimitedAt: null,
    expiresAt: null,
  };
}

/**
 * Add a Claude account connected through the OAuth flow — at the END of the
 * order, so connecting a spare never moves the owner's preferred account.
 *
 * The same email twice is not a second account: it is the owner signing the
 * first one in again (a revoked grant, say), so its credential is replaced and
 * its place in the order is kept.
 */
export async function addOAuthAccount(input: { label?: unknown; email?: unknown; tokens: OAuthTokens }): Promise<AnthropicAccount> {
  if (typeof input.tokens?.access !== "string" || !input.tokens.access.trim()) {
    throw new AnthropicAccountError("invalid", "The sign-in did not return a token. Start it again.");
  }
  const email = cleanEmail(input.email);
  return mutate(async (file, now) => {
    const same = email ? file.accounts.find((a) => a.kind === "oauth" && sameEmail(a.email, email)) : undefined;
    if (same) {
      await storeCredential(same.id, oauthSecret(input.tokens));
      same.expiresAt = input.tokens.expires;
      if (same.status === "expired" || same.status === "revoked") same.status = "ok";
      if (typeof input.label === "string" && input.label.trim()) same.label = cleanLabel(input.label, same.label);
      return { ...same };
    }
    requireRoom(file);
    const id = newId(file.accounts);
    await storeCredential(id, oauthSecret(input.tokens));
    const account = blankAccount(id, "oauth", cleanLabel(input.label, email ?? `Claude account ${file.accounts.length + 1}`), email, now);
    account.expiresAt = input.tokens.expires;
    file.accounts.push(account);
    return { ...account };
  });
}

/** Add an API-key account at the end of the order. The shape is the caller's to check (`looksLikeAnthropicKey`). */
export async function addApiKeyAccount(input: { label?: unknown; key: string; first?: boolean }): Promise<AnthropicAccount> {
  return mutate(async (file, now) => {
    requireRoom(file);
    const id = newId(file.accounts);
    await storeCredential(id, input.key.trim());
    const account = blankAccount(id, "api_key", cleanLabel(input.label, "API key"), null, now);
    if (input.first) file.accounts.unshift(account);
    else file.accounts.push(account);
    return { ...account };
  });
}

/**
 * New credential, same account: the owner re-authenticated (OAuth) or pasted a
 * rotated key. Its place in the order and its limit stay — a limit belongs to
 * the ACCOUNT, and signing in again does not lift it.
 *
 * "Same account" is checked, not assumed, for a sign-in: the caller only names
 * the ROW, and the sign-in is what says whose tokens these are. One for another
 * Claude account (the browser was signed in as someone else) is refused —
 * `wrong_account` against the row's own email, `duplicate` when it is another
 * row's. Filing it here would turn "Work" into a second copy of "Personal",
 * and a limited run would then "switch" onto the subscription that just ran
 * out. Nothing is stored on a refusal.
 */
export async function replaceCredential(id: unknown, credential: { kind: "oauth"; tokens: OAuthTokens; email?: unknown } | { kind: "api_key"; key: string }): Promise<AnthropicAccount> {
  return mutate(async (file) => {
    const account = find(file, id);
    if (account.kind !== credential.kind) {
      throw new AnthropicAccountError("invalid", account.kind === "login"
        ? "The Claude Code sign-in is renewed in the Terminal app (`claude`), not here."
        : "That account was connected another way; re-authenticate it the same way it was added.");
    }
    if (credential.kind === "oauth") {
      const email = cleanEmail(credential.email);
      if (email && account.email && !sameEmail(email, account.email)) {
        throw new AnthropicAccountError(
          "wrong_account",
          `That sign-in is ${email}, not ${account.email}. Sign in as ${account.email} to renew "${account.label}", or connect ${email} as an account of its own.`,
          { signedIn: email, expected: account.email, label: account.label },
        );
      }
      const twin = email ? file.accounts.find((a) => a.id !== account.id && a.kind === "oauth" && sameEmail(a.email, email)) : undefined;
      if (email && twin) {
        throw new AnthropicAccountError(
          "duplicate",
          `That sign-in is ${email}, which is already on the list as "${twin.label}".`,
          { signedIn: email, label: twin.label },
        );
      }
      await storeCredential(account.id, oauthSecret(credential.tokens));
      account.expiresAt = credential.tokens.expires;
      if (email) account.email = email;
    } else {
      await storeCredential(account.id, credential.key.trim());
    }
    if (account.status === "expired" || account.status === "revoked") account.status = "ok";
    return { ...account };
  });
}

/** Take an account out of the pool, and its credential out of the store. A `claude` sign-in is only UNLISTED: it is not this box's to end. */
export async function removeAccount(id: unknown): Promise<void> {
  await mutate(async (file) => {
    const account = find(file, id);
    file.accounts = file.accounts.filter((a) => a.id !== account.id);
    if (account.kind === "login") file.loginDismissed = true;
    await deleteDeviceSecret({ scope: ANTHROPIC_ACCOUNTS_SCOPE, name: secretName(account.id) }).catch((err: unknown) => {
      // The row is already off the list, and the sweep below takes an orphan
      // at the next removal; said rather than swallowed.
      console.error("[anthropic-accounts] could not delete a removed account's credential:", err instanceof Error ? err.message : err);
    });
  });
  void sweepOrphanCredentials();
}

/** Put the `claude` sign-in back on the list after the owner took it off. */
export async function relistLogin(): Promise<AnthropicAccount> {
  return mutate((file, now) => {
    const existing = file.accounts.find((a) => a.kind === "login");
    if (existing) return { ...existing };
    if (!hasAnthropicLogin()) {
      throw new AnthropicAccountError("invalid", "There is no Claude Code sign-in on this ClawBox. Sign in with `claude` in the Terminal app first.");
    }
    requireRoom(file);
    file.loginDismissed = false;
    syncLogin(file, now);
    const row = file.accounts.find((a) => a.kind === "login");
    if (!row) throw new AnthropicAccountError("invalid", "The Claude Code sign-in could not be added.");
    return { ...row };
  });
}

/** The owner's new order: every id exactly once. */
export async function reorderAccounts(ids: unknown): Promise<AnthropicAccount[]> {
  return mutate((file) => {
    if (!Array.isArray(ids) || ids.length !== file.accounts.length || new Set(ids).size !== ids.length) {
      throw new AnthropicAccountError("invalid", "The new order must name every account exactly once.");
    }
    file.accounts = ids.map((id) => find(file, id));
    return file.accounts.map((a) => ({ ...a }));
  });
}

export async function renameAccount(id: unknown, label: unknown): Promise<AnthropicAccount> {
  return mutate((file) => {
    const account = find(file, id);
    account.label = cleanLabel(label, account.label);
    return { ...account };
  });
}

// ── limits ──────────────────────────────────────────────────────────────────

export interface LimitRecorded {
  account: AnthropicAccount;
  /** False when the account was already known to be limited — nothing new to tell anyone. */
  newlyLimited: boolean;
  /** True when this limit is the one that left no account able to answer. */
  becameAllLimited: boolean;
  health: PoolHealth;
}

/**
 * Record that an account hit its cap and is expected back at `until`.
 *
 * A later `until` than the one on record wins (a weekly cap reported after a
 * session one); an earlier one does not shorten a limit the box already knows
 * about, because the account that refused is the evidence and it refused now.
 */
export async function markLimited(id: unknown, until: number, kind: AnthropicLimitKind): Promise<LimitRecorded> {
  return mutate((file, now) => {
    const before = poolHealth(file.accounts, now);
    const account = find(file, id);
    const wasLimited = effectiveStatus(account, now) === "limited";
    account.status = "limited";
    account.limitedUntil = wasLimited && account.limitedUntil !== null ? Math.max(account.limitedUntil, until) : until;
    account.limitKind = kind;
    account.lastLimitedAt = now;
    const after = poolHealth(file.accounts, now);
    return { account: { ...account }, newlyLimited: !wasLimited, becameAllLimited: !before.allLimited && after.allLimited, health: after };
  });
}

/** Take a recorded limit back (the owner knows better, or a test is over). */
export async function clearLimit(id: unknown): Promise<AnthropicAccount> {
  return mutate((file) => {
    const account = find(file, id);
    if (account.status === "limited") account.status = "ok";
    account.limitedUntil = null;
    account.limitKind = null;
    return { ...account };
  });
}

/** An account's credential needs the owner (`revoked`) or a renewal (`expired`). */
export async function markCredentialProblem(id: unknown, status: "expired" | "revoked"): Promise<void> {
  await mutate((file) => {
    const account = find(file, id);
    // A limit outranks a credential problem only while it runs: the owner
    // should learn about a dead credential without waiting for a reset.
    account.status = status;
    account.limitedUntil = null;
  });
}

async function noteUsed(id: string): Promise<void> {
  await mutate((file, now) => {
    const account = file.accounts.find((a) => a.id === id);
    if (account) account.lastUsedAt = now;
  }).catch(() => {});
}

/** Credentials in the store that no account names any more — what an interrupted removal or migration leaves. */
async function sweepOrphanCredentials(): Promise<void> {
  try {
    const [names, accounts] = await Promise.all([listDeviceSecretNames(ANTHROPIC_ACCOUNTS_SCOPE), readAccounts()]);
    const wanted = new Set(accounts.map((a) => secretName(a.id)));
    for (const name of names) {
      if (!wanted.has(name)) await deleteDeviceSecret({ scope: ANTHROPIC_ACCOUNTS_SCOPE, name });
    }
  } catch {
    // Housekeeping; a store that cannot be read now is read again at the next removal.
  }
}

// ── the credential a run gets ───────────────────────────────────────────────

export type AnthropicCredential =
  | { kind: "api_key"; secret: string }
  | { kind: "oauth"; secret: string }
  | { kind: "login"; secret: null };

export interface PreparedAccount {
  account: AnthropicAccount;
  credential: AnthropicCredential;
}

/**
 * Refresh an OAuth access token this long before it expires. A run is handed a
 * bare access token (Claude Code cannot refresh a token it was given in the
 * environment), so it has to start with enough life in it for a long run.
 */
export const OAUTH_REFRESH_MARGIN_MS = 3 * 60 * 60_000;

const REFRESH_TIMEOUT_MS = 20_000;

type RefreshResult =
  | { ok: true; tokens: OAuthTokens }
  | { ok: false; reason: "rejected" | "unreachable" };

/** The same token endpoint and client the box's sign-in uses — nothing parallel. */
export async function refreshOAuthTokens(refresh: string, now: number = Date.now()): Promise<RefreshResult> {
  const config = OAUTH_PROVIDERS.anthropic;
  try {
    const res = await fetch(config.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refresh, client_id: config.clientId }),
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
    if (res.status === 400 || res.status === 401 || res.status === 403) return { ok: false, reason: "rejected" };
    if (!res.ok) return { ok: false, reason: "unreachable" };
    const body = await res.json() as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== "string" || !body.access_token) return { ok: false, reason: "unreachable" };
    return {
      ok: true,
      tokens: {
        access: body.access_token,
        // A server that rotates answers a new refresh token; one that does not
        // leaves the old one valid.
        refresh: typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : refresh,
        expires: typeof body.expires_in === "number" && body.expires_in > 0 ? now + body.expires_in * 1000 : null,
      },
    };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
}

/**
 * One credential read-and-renew at a time PER ACCOUNT.
 *
 * Anthropic's refresh tokens are single-use: a renewal answers a new pair and
 * retires the refresh token it was given. Two runs starting together (a coding
 * team's workers, a limit moving several runs at once) would each read the same
 * pair from the store and both spend its refresh token. The second is refused,
 * and with a token that has ten minutes left or less, that refusal marked a
 * healthy account `revoked`. Under the lock the second caller reads the store
 * only AFTER the first has written the renewed pair, finds it good, and hands
 * it out with no request of its own.
 *
 * In-process is enough: this server is the only thing that renews. The wrapper
 * and the CLI are handed an access token and never see the refresh token. The
 * lock never waits on the pool's own `mutate` chain while that chain waits on
 * it, because nothing inside `mutate` reads a credential.
 */
const credentialLocks = new Map<string, SerialLock>();

function credentialLock(id: string): SerialLock {
  let lock = credentialLocks.get(id);
  if (!lock) {
    lock = createSerialLock();
    credentialLocks.set(id, lock);
  }
  return lock;
}

/**
 * The credential for ONE account, renewed if it is an OAuth token near its end.
 * Null — with the account marked — when it cannot answer.
 */
function credentialFor(account: AnthropicAccount, now: number): Promise<AnthropicCredential | null> {
  return credentialLock(account.id)(() => readCredential(account, now));
}

/** `credentialFor`'s body, run under that account's lock: every read of the store here is fresh. */
async function readCredential(account: AnthropicAccount, now: number): Promise<AnthropicCredential | null> {
  if (account.kind === "login") {
    if (hasAnthropicLogin()) return { kind: "login", secret: null };
    await markCredentialProblem(account.id, "expired").catch(() => {});
    return null;
  }
  const stored = await readDeviceSecret({ scope: ANTHROPIC_ACCOUNTS_SCOPE, name: secretName(account.id) });
  if (!stored.found) {
    // "unavailable" is the whole store, not this account: nothing is marked,
    // and the caller has no credential to hand out this time.
    if (stored.reason !== "unavailable") await markCredentialProblem(account.id, "revoked").catch(() => {});
    return null;
  }
  if (account.kind === "api_key") return { kind: "api_key", secret: stored.value };
  const tokens = parseOAuthSecret(stored.value);
  if (!tokens) {
    await markCredentialProblem(account.id, "revoked").catch(() => {});
    return null;
  }
  const stillGood = tokens.expires === null || tokens.expires > now + 10 * 60_000;
  const wantsRefresh = tokens.refresh !== null && tokens.expires !== null && tokens.expires - now < OAUTH_REFRESH_MARGIN_MS;
  if (!wantsRefresh) {
    if (stillGood) return { kind: "oauth", secret: tokens.access };
    await markCredentialProblem(account.id, "expired").catch(() => {});
    return null;
  }
  const refreshed = await refreshOAuthTokens(tokens.refresh!, now);
  if (refreshed.ok) {
    await storeCredential(account.id, oauthSecret(refreshed.tokens));
    await mutate((file) => {
      const row = file.accounts.find((a) => a.id === account.id);
      if (row) row.expiresAt = refreshed.tokens.expires;
    }).catch(() => {});
    return { kind: "oauth", secret: refreshed.tokens.access };
  }
  // The token the box already holds is still worth a run when it has life in
  // it — a refresh that failed for want of a network is not the account's fault.
  if (stillGood) return { kind: "oauth", secret: tokens.access };
  await markCredentialProblem(account.id, refreshed.reason === "rejected" ? "revoked" : "expired").catch(() => {});
  return null;
}

/**
 * The account a run should use now, with its credential in hand.
 *
 * The first usable account in the owner's order, skipping any in `exclude` (the
 * one that has just refused) and any whose credential turns out not to work —
 * those are marked on the way past, so the owner's list says why.
 *
 * `fallback` answers the question "and if NONE can answer?": the runner still
 * has to spawn something on a path that has already committed to a spawn, and
 * the honest thing to spawn is the preferred account, which will refuse with
 * its limit — and that refusal is what pauses the run until the reset.
 */
export async function prepareAccount(opts: { exclude?: ReadonlySet<string>; fallback?: boolean } = {}): Promise<{ prepared: PreparedAccount | null; health: PoolHealth }> {
  const tried = new Set(opts.exclude ?? []);
  for (;;) {
    const now = Date.now();
    const accounts = await readAccounts();
    const next = pickAccount(accounts, now, tried);
    if (!next) {
      if (opts.fallback) {
        for (const account of accounts) {
          if (effectiveStatus(account, now) !== "limited") continue;
          const credential = await credentialFor(account, now).catch(() => null);
          if (credential) return { prepared: { account, credential }, health: poolHealth(await readAccounts(), now) };
        }
      }
      return { prepared: null, health: poolHealth(accounts, now) };
    }
    tried.add(next.id);
    const credential = await credentialFor(next, now).catch(() => null);
    if (!credential) continue;
    void noteUsed(next.id);
    return { prepared: { account: next, credential }, health: poolHealth(accounts, now) };
  }
}

/**
 * Could an account OTHER than `excludeId` take a run over, as far as this
 * process knows right now? Synchronous, off the snapshot — for the runner's
 * settle path. `null` means "not known yet" (nothing read since boot): the
 * caller then asks the slow way.
 */
export function anotherAccountLikely(excludeId: string | null, now: number = Date.now()): boolean | null {
  if (!snapshot) return null;
  return pickAccount(snapshot.accounts, now, new Set(excludeId ? [excludeId] : [])) !== null;
}

// ── handing a credential to the wrapper ─────────────────────────────────────

/**
 * Where a spawn's credential waits for `scripts/claude-ds` to pick it up.
 *
 * A FILE, and never the environment the web server hands the child or its
 * argv: the wrapper has always read its credential itself, right before exec,
 * and that stays true. The file is 0600 in a 0700 folder under data/ (which
 * every run is denied), carries one credential for one spawn, and is deleted by
 * the wrapper the moment it has read it — and by the runner when the spawn
 * settles, and by the boot sweep, for a wrapper that never got that far.
 */
const HANDOFF_DIR = path.join(DATA_DIR, ".anthropic-handoff");

/** How old an unread handoff may get before the sweep takes it. */
const HANDOFF_MAX_AGE_MS = 10 * 60_000;

const RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Write one spawn's credential for the wrapper; answers the path to put in `CLAUDE_DS_ANTHROPIC_CREDENTIAL_FILE`. Synchronous — the spawn is. */
export function writeCredentialHandoff(runId: string, credential: AnthropicCredential): string {
  if (!RUN_ID_RE.test(runId)) throw new Error("invalid run id for a credential handoff");
  fs.mkdirSync(HANDOFF_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(HANDOFF_DIR, 0o700);
  const file = path.join(HANDOFF_DIR, `${runId}-${crypto.randomBytes(6).toString("hex")}.cred`);
  // `wx`: never over the top of something already there.
  fs.writeFileSync(file, `${credential.kind}\n${credential.secret ?? ""}\n`, { mode: 0o600, flag: "wx" });
  return file;
}

/** Remove whatever this run's spawns left unread. */
export function removeCredentialHandoffs(runId: string): void {
  if (!RUN_ID_RE.test(runId)) return;
  let names: string[];
  try {
    names = fs.readdirSync(HANDOFF_DIR);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith(`${runId}-`)) fs.rmSync(path.join(HANDOFF_DIR, name), { force: true });
  }
}

/** Remove every handoff older than a spawn could plausibly take to read it. */
export function sweepCredentialHandoffs(now: number = Date.now()): void {
  let names: string[];
  try {
    names = fs.readdirSync(HANDOFF_DIR);
  } catch {
    return;
  }
  for (const name of names) {
    const file = path.join(HANDOFF_DIR, name);
    try {
      if (now - fs.statSync(file).mtimeMs > HANDOFF_MAX_AGE_MS) fs.rmSync(file, { force: true });
    } catch {
      // gone already
    }
  }
}

// ── the reset wake ──────────────────────────────────────────────────────────

/**
 * Something that wants to know the moment a limited account is back — the
 * runner, which resumes the runs that were waiting for it. The timer lives
 * here because the pool is what knows the times; it is rebuilt from the pool on
 * every read, so a restart re-arms it at the first read after boot.
 */
const wakeListeners = new Set<() => void>();
let wakeTimer: ReturnType<typeof setTimeout> | null = null;
let wakeAt: number | null = null;

/** A small margin past the reset, so the account is really back when the wake runs. */
const WAKE_MARGIN_MS = 20_000;

export function onLimitReset(listener: () => void): () => void {
  wakeListeners.add(listener);
  return () => wakeListeners.delete(listener);
}

function armWake(file: PoolFile): void {
  const now = Date.now();
  const next = poolHealth(file.accounts, now).nextResetAt;
  const at = next === null ? null : next + WAKE_MARGIN_MS;
  if (at === wakeAt && wakeTimer) return;
  if (wakeTimer) clearTimeout(wakeTimer);
  wakeTimer = null;
  wakeAt = at;
  if (at === null) return;
  // setTimeout's own ceiling is ~24.8 days; a longer wait re-arms on the way.
  const delay = Math.min(Math.max(at - now, 1_000), 2_147_000_000);
  wakeTimer = setTimeout(() => {
    wakeTimer = null;
    wakeAt = null;
    for (const listener of wakeListeners) {
      try {
        listener();
      } catch (err) {
        console.error("[anthropic-accounts] a limit-reset listener failed:", err instanceof Error ? err.message : err);
      }
    }
    // Re-read: the next limit in line (if any) arms the next wake.
    void readAccounts().catch(() => {});
  }, delay);
  wakeTimer.unref?.();
}

/** At boot: read the pool (which migrates and arms the wake) and clear stale handoffs. */
export async function startAnthropicAccounts(): Promise<void> {
  sweepCredentialHandoffs();
  await readAccounts();
}

// ── what surfaces see ───────────────────────────────────────────────────────

export interface AnthropicAccountView {
  id: string;
  label: string;
  email: string | null;
  kind: AnthropicAccountKind;
  /** As of now: a limit whose time has come reads `ok`. */
  status: AnthropicAccountStatus;
  limitedUntil: number | null;
  limitKind: AnthropicLimitKind | null;
  /** 1-based place in the owner's order. */
  priority: number;
  /** The account a run starting now would use. */
  active: boolean;
  addedAt: number;
  lastUsedAt: number | null;
  lastLimitedAt: number | null;
}

export interface AnthropicPoolView {
  accounts: AnthropicAccountView[];
  health: PoolHealth;
  activeAccountId: string | null;
  /** Can a `claude` sign-in be put (back) on the list? */
  loginAvailable: boolean;
  now: number;
}

/** The pool as a route and the MCP tool may show it: labels and states, never a credential. */
export async function describePool(): Promise<AnthropicPoolView> {
  const now = Date.now();
  const accounts = await readAccounts();
  const active = pickAccount(accounts, now);
  return {
    accounts: accounts.map((a, i) => ({
      id: a.id,
      label: a.label,
      email: a.email,
      kind: a.kind,
      status: effectiveStatus(a, now),
      limitedUntil: effectiveStatus(a, now) === "limited" ? a.limitedUntil : null,
      limitKind: effectiveStatus(a, now) === "limited" ? a.limitKind : null,
      priority: i + 1,
      active: active?.id === a.id,
      addedAt: a.addedAt,
      lastUsedAt: a.lastUsedAt,
      lastLimitedAt: a.lastLimitedAt,
    })),
    health: poolHealth(accounts, now),
    activeAccountId: active?.id ?? null,
    loginAvailable: !accounts.some((a) => a.kind === "login") && hasAnthropicLogin(),
    now,
  };
}

/** Is there any account a run could authenticate with at all (limited or not)? For readiness. */
export async function poolHasCredential(): Promise<{ any: boolean; hasKey: boolean; hasLogin: boolean; hasOAuth: boolean; first: AnthropicAccountKind | null }> {
  const accounts = await readAccounts();
  const now = Date.now();
  const live = accounts.filter((a) => a.status !== "revoked" && !(a.kind === "login" && a.status === "expired"));
  const usable = pickAccount(accounts, now) ?? live[0] ?? null;
  return {
    any: live.length > 0,
    hasKey: live.some((a) => a.kind === "api_key"),
    hasLogin: live.some((a) => a.kind === "login"),
    hasOAuth: live.some((a) => a.kind === "oauth"),
    first: usable?.kind ?? null,
  };
}

/** Test seam: forget the snapshot, the wake and the chain. */
export function _resetAnthropicAccountsForTests(): void {
  snapshot = null;
  chain = Promise.resolve();
  credentialLocks.clear();
  if (wakeTimer) clearTimeout(wakeTimer);
  wakeTimer = null;
  wakeAt = null;
  wakeListeners.clear();
}

export { isUsable };
