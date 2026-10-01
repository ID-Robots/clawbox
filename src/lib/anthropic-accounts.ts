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
 *
 * ONE ACTIVE ACCOUNT FOR THE WHOLE BOX (TASK-1260). The pool also records
 * WHICH account is in use — `activeId` — and that is the one source of truth
 * every Claude consumer re-reads: coding runs, review passes and team workers
 * (src/lib/coding-agent.ts), the OpenClaw gateway's Claude subscription and its
 * crons (src/lib/anthropic-gateway.ts). It is settled on every read and every
 * write (`settleActive`), so a limit, a refused credential, a reset, a removal
 * or the owner's new order all move it through the same few lines; each move
 * is handed to the listeners (`onActiveChange`) once the write has landed, and
 * src/lib/anthropic-swap.ts fans it out to the consumers and records what each
 * did as `lastSwap`.
 */

import crypto from "crypto";
import fs from "fs";
import path from "@/lib/runtime-path";
import { DATA_DIR, get as configGet, set as configSet } from "@/lib/config-store";
import { anthropicLoginChangedAt, anthropicLoginEmail, hasAnthropicLogin } from "@/lib/claude-login";
import { ANTHROPIC_API_KEY_CONFIG_KEY } from "@/lib/coding-provider";
import { OAUTH_PROVIDERS } from "@/lib/oauth-config";
import { processStore } from "@/lib/process-store";
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
  pickForSpawn,
  poolHealth,
  resolveActiveAccount,
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
  /**
   * When Anthropic last refused this account's credential (TASK-1260). For the
   * `claude` sign-in it is what tells a refusal from the owner having signed in
   * again since: a credential file written after it lifts the refusal.
   */
  authFailedAt: number | null;
}

/** Why the active account moved — said to the owner, and what decides which consumers act. */
export const SWAP_CAUSES = ["limit", "auth", "reset", "owner", "removed", "added", "renewed"] as const;
export type SwapCause = (typeof SWAP_CAUSES)[number];

/** Where the failure that moved it was seen. */
export const SWAP_SOURCES = ["coding", "chat", "cron", "owner", "box"] as const;
export type SwapSource = (typeof SWAP_SOURCES)[number];

/** The consumers a swap is fanned out to (src/lib/anthropic-swap.ts). */
export const SWAP_CONSUMERS = ["coding", "gateway", "retries"] as const;
export type SwapConsumerName = (typeof SWAP_CONSUMERS)[number];

/**
 * What one consumer did about a swap. `code` is a fixed word the owner's card
 * says in the owner's language (never free text from a process); `count` is
 * how many things it moved, resumed or retried.
 */
export interface SwapConsumerOutcome {
  status: "ok" | "skipped" | "failed" | "pending";
  code: string | null;
  count: number | null;
}

/** The most recent move of the active account, and what each consumer did about it. */
export interface SwapEvent {
  id: string;
  at: number;
  fromId: string | null;
  fromLabel: string | null;
  /** Null: no account could answer — every one limited or needing the owner. */
  toId: string | null;
  toLabel: string | null;
  cause: SwapCause;
  source: SwapSource;
  limitKind: AnthropicLimitKind | null;
  /** When the account it moved AWAY from is expected back (a limit), or null. */
  limitedUntil: number | null;
  /** With no account left: the earliest time one comes back by itself. */
  nextResetAt: number | null;
  consumers: Partial<Record<SwapConsumerName, SwapConsumerOutcome>>;
}

/**
 * Where the gateway's Claude subscription credential stands, as this box last
 * wrote it (src/lib/anthropic-gateway.ts). `fingerprint` is a truncated SHA-256
 * of the access token — enough to notice that something else has since written
 * the profile (the owner signing in again in Settings), useless for anything
 * else. Never the token.
 */
export interface GatewayMirror {
  accountId: string;
  fingerprint: string;
  expiresAt: number | null;
  at: number;
  /**
   * The token is written but the gateway has not been restarted onto it yet
   * (the restart failed, or is under way). The keeper finishes it: a gateway
   * whose restart failed would otherwise go on running on the old account's
   * token in memory while every file says it moved.
   */
  pending: boolean;
}

interface PoolFile {
  /** 2 since TASK-1260 added the active account; a file still at 1 adopts one silently. */
  version: 2;
  /** The single legacy credential has been moved in (see the header). */
  migrated: boolean;
  /** The owner took the `claude` sign-in OUT of the pool; do not put it back by itself. */
  loginDismissed: boolean;
  /** In priority order: the first usable one answers. */
  accounts: AnthropicAccount[];
  /** The account every consumer uses now; null when none can answer (or there is none). */
  activeId: string | null;
  /** The owner's preference: back to the first account in the order once it can answer again. */
  returnToPrimary: boolean;
  lastSwap: SwapEvent | null;
  gateway: GatewayMirror | null;
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
    authFailedAt: num(v.authFailedAt),
  };
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

function normalizeOutcome(raw: unknown): SwapConsumerOutcome | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw as Record<string, unknown>;
  if (v.status !== "ok" && v.status !== "skipped" && v.status !== "failed" && v.status !== "pending") return null;
  const code = typeof v.code === "string" && /^[a-z_]{1,40}$/.test(v.code) ? v.code : null;
  const count = typeof v.count === "number" && Number.isInteger(v.count) && v.count >= 0 ? v.count : null;
  return { status: v.status, code, count };
}

/** The last swap off disk, or null — a hand-edited one the card cannot trust is dropped. */
function normalizeSwapEvent(raw: unknown): SwapEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw as Record<string, unknown>;
  const at = num(v.at);
  if (at === null || !(SWAP_CAUSES as readonly unknown[]).includes(v.cause)) return null;
  const consumers: SwapEvent["consumers"] = {};
  const rawConsumers = (typeof v.consumers === "object" && v.consumers !== null ? v.consumers : {}) as Record<string, unknown>;
  for (const name of SWAP_CONSUMERS) {
    const outcome = normalizeOutcome(rawConsumers[name]);
    if (outcome) consumers[name] = outcome;
  }
  const id = (x: unknown) => (typeof x === "string" && ID_RE.test(x) ? x : null);
  return {
    id: typeof v.id === "string" && /^[0-9a-f]{12}$/.test(v.id) ? v.id : crypto.randomBytes(6).toString("hex"),
    at,
    fromId: id(v.fromId),
    fromLabel: str(v.fromLabel) ? cleanLabel(v.fromLabel, "Anthropic account") : null,
    toId: id(v.toId),
    toLabel: str(v.toLabel) ? cleanLabel(v.toLabel, "Anthropic account") : null,
    cause: v.cause as SwapCause,
    source: (SWAP_SOURCES as readonly unknown[]).includes(v.source) ? (v.source as SwapSource) : "box",
    limitKind: (LIMIT_KINDS as readonly unknown[]).includes(v.limitKind) ? (v.limitKind as AnthropicLimitKind) : null,
    limitedUntil: num(v.limitedUntil),
    nextResetAt: num(v.nextResetAt),
    consumers,
  };
}

function normalizeMirror(raw: unknown): GatewayMirror | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.accountId !== "string" || !ID_RE.test(v.accountId)) return null;
  if (typeof v.fingerprint !== "string" || !/^[0-9a-f]{16}$/.test(v.fingerprint)) return null;
  return { accountId: v.accountId, fingerprint: v.fingerprint, expiresAt: num(v.expiresAt), at: num(v.at) ?? 0, pending: v.pending === true };
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
  const activeId = typeof v.activeId === "string" && seen.has(v.activeId) ? v.activeId : null;
  const gateway = normalizeMirror(v.gateway);
  return {
    version: 2,
    migrated: v.migrated === true,
    loginDismissed: v.loginDismissed === true,
    accounts,
    activeId,
    returnToPrimary: v.returnToPrimary === true,
    lastSwap: normalizeSwapEvent(v.lastSwap),
    // A mirror of an account that is no longer on the list is no mirror at all.
    gateway: gateway && seen.has(gateway.accountId) ? gateway : null,
  };
}

/** A pool written before TASK-1260 has no active account on record: it adopts one without calling it a swap. */
function isLegacyPool(raw: unknown): boolean {
  return typeof raw !== "object" || raw === null || (raw as Record<string, unknown>).version !== 2;
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
 * What moved the active account, handed to every `onActiveChange` listener
 * once the write that moved it has landed. Labels are taken at the moment of
 * the move, so a removed account can still be named.
 */
export interface ActiveChange {
  fromId: string | null;
  fromLabel: string | null;
  toId: string | null;
  toLabel: string | null;
  cause: SwapCause;
  source: SwapSource;
  /** The coding run whose failure moved it, when one did. */
  runId: string | null;
  limitKind: AnthropicLimitKind | null;
  /** When the account it moved away from is back (a limit). */
  limitedUntil: number | null;
  health: PoolHealth;
  at: number;
}

/** What a mutation knows about why it might move the active account. */
interface ChangeContext {
  source?: SwapSource;
  runId?: string | null;
  limitKind?: AnthropicLimitKind | null;
  limitedUntil?: number | null;
  /** The label of an account the mutation took off the list. */
  fromLabel?: string | null;
  /** What the mutation turned out to be, when that is only known inside it. */
  cause?: SwapCause;
}

/**
 * Everything this module keeps between calls, ONE per process.
 *
 * Next compiles the boot hook and the routes as two copies of this file inside
 * one web server (src/lib/process-store.ts). As plain module state, each copy
 * had its own write chain over the one config key, its own per-account refresh
 * lock — two copies could spend one single-use refresh token between them —
 * and its own reset timer, with the runner's listener on only one of them. So
 * the state lives in the process store, keyed by the data folder it caches.
 */
interface PoolRuntime {
  /**
   * The last pool this process read or wrote. The runner's settle path is
   * synchronous and has to know, in the same tick, whether ANOTHER account can
   * take a run over — this is that answer. Every read and every write
   * refreshes it; nothing but this module assigns it.
   */
  snapshot: PoolFile | null;
  /** Every change runs after the previous one: a read-modify-write of one config key, reachable from two tabs and the runner. */
  chain: Promise<unknown>;
  credentialLocks: Map<string, SerialLock>;
  wakeListeners: Set<() => void>;
  changeListeners: Set<(change: ActiveChange) => void>;
  wakeTimer: ReturnType<typeof setTimeout> | null;
  wakeAt: number | null;
}

function runtime(): PoolRuntime {
  return processStore<PoolRuntime>(`anthropic-accounts:${DATA_DIR}`, () => ({
    snapshot: null,
    chain: Promise.resolve(),
    credentialLocks: new Map(),
    wakeListeners: new Set(),
    changeListeners: new Set(),
    wakeTimer: null,
    wakeAt: null,
  }));
}

function serialised<T>(work: () => Promise<T>): Promise<T> {
  const state = runtime();
  const next = state.chain.then(work, work);
  state.chain = next.then(() => undefined, () => undefined);
  return next;
}

async function writePool(file: PoolFile): Promise<void> {
  await configSet(ANTHROPIC_ACCOUNTS_CONFIG_KEY, file);
  runtime().snapshot = file;
  armWake(file);
}

/**
 * Move the active account if it has to move, and say how. The ONE place
 * `activeId` changes (besides the silent adoption of a pre-TASK-1260 pool).
 *
 * Sticky unless the owner prefers the first account (`returnToPrimary`) or has
 * just put a different one first (`reselect`) — see `resolveActiveAccount`.
 * An active account that is no longer on the list is a removal, whatever the
 * caller said.
 */
function settleActive(file: PoolFile, now: number, fallbackCause: SwapCause, ctx: ChangeContext = {}, reselect = false): ActiveChange | null {
  const cause = ctx.cause ?? fallbackCause;
  const previous = file.activeId;
  const stillListed = previous !== null && file.accounts.some((a) => a.id === previous);
  const next = resolveActiveAccount(file.accounts, stillListed ? previous : null, now, {
    returnToPrimary: file.returnToPrimary,
    reselect,
  })?.id ?? null;
  if (next === previous) return null;
  file.activeId = next;
  const labelOf = (id: string | null) => (id ? file.accounts.find((a) => a.id === id)?.label ?? null : null);
  return {
    fromId: previous,
    fromLabel: labelOf(previous) ?? ctx.fromLabel ?? null,
    toId: next,
    toLabel: labelOf(next),
    cause: previous !== null && !stillListed ? "removed" : cause,
    source: ctx.source ?? (cause === "owner" || cause === "removed" || cause === "added" || cause === "renewed" ? "owner" : "box"),
    runId: ctx.runId ?? null,
    limitKind: ctx.limitKind ?? null,
    limitedUntil: ctx.limitedUntil ?? null,
    health: poolHealth(file.accounts, now),
    at: now,
  };
}

/** Hand the moves to the listeners — after the write, outside the chain, never awaited. */
function emit(change: ActiveChange | null): void {
  if (!change) return;
  const listeners = [...runtime().changeListeners];
  if (listeners.length === 0) return;
  queueMicrotask(() => {
    for (const listener of listeners) {
      try {
        listener({ ...change, health: { ...change.health } });
      } catch (err) {
        console.error("[anthropic-accounts] an active-account listener failed:", err instanceof Error ? err.message : err);
      }
    }
  });
}

/**
 * Keep the `claude` sign-in's row in step with the files: added when it
 * appears (unless the owner took it out), `expired` when it is gone, back to
 * `ok` when it returns — and a sign-in Anthropic REFUSED (TASK-1260) back to
 * `ok` only once the credential file has been written since, which is the
 * owner signing in again. Answers whether anything changed.
 */
function syncLogin(file: PoolFile, now: number): boolean {
  const present = hasAnthropicLogin();
  const email = present ? anthropicLoginEmail() : null;
  const row = file.accounts.find((a) => a.kind === "login");
  if (!row) {
    if (!present || file.loginDismissed || file.accounts.length >= MAX_ANTHROPIC_ACCOUNTS) return false;
    file.accounts.push(blankAccount(newId(file.accounts), "login", "Claude Code sign-in", email, now));
    return true;
  }
  let changed = false;
  if (!present && row.status === "ok") {
    row.status = "expired";
    changed = true;
  } else if (present && row.status === "expired") {
    row.status = "ok";
    changed = true;
  } else if (present && row.status === "revoked") {
    const writtenAt = anthropicLoginChangedAt();
    if (writtenAt !== null && row.authFailedAt === null) {
      // A refusal with no time on it (a hand-edited pool): the file as it is
      // now is the one that was refused, and only a later write lifts it.
      row.authFailedAt = Math.ceil(writtenAt);
      changed = true;
    } else if (writtenAt !== null && row.authFailedAt !== null && writtenAt > row.authFailedAt) {
      row.status = "ok";
      row.authFailedAt = null;
      changed = true;
    }
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
  file.accounts.unshift(blankAccount(id, "api_key", "API key", null, now));
  return id;
}

/**
 * Read the pool, migrating and syncing the sign-in as needed, and settle the
 * active account against the clock — a limit that has run out is how the box
 * leaves "every account limited" (or, with `returnToPrimary`, goes back to #1).
 * Inside the chain; the move, if any, is emitted once it is on disk.
 */
async function loadLocked(): Promise<PoolFile> {
  const now = Date.now();
  const raw = await configGet(ANTHROPIC_ACCOUNTS_CONFIG_KEY);
  const file = normalizePool(raw);
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
  const hadNone = file.activeId === null && file.accounts.length === 0;
  if (syncLogin(file, now)) dirty = true;
  let change: ActiveChange | null = null;
  if (isLegacyPool(raw)) {
    // A pool from before the active account existed: the account it would have
    // used is simply the one in use. Not a swap — nothing moved.
    file.activeId = resolveActiveAccount(file.accounts, null, now, { returnToPrimary: file.returnToPrimary })?.id ?? null;
    dirty = true;
  } else {
    change = settleActive(file, now, hadNone ? "added" : "reset");
    if (change) dirty = true;
  }
  if (dirty) await writePool(file);
  else {
    runtime().snapshot = file;
    armWake(file);
  }
  // Out of config.json only once the pool that names it is on disk.
  if (migratedKey) {
    await configSet(ANTHROPIC_API_KEY_CONFIG_KEY, undefined);
    console.error("[anthropic-accounts] moved the stored Anthropic API key into the secret store as account #1");
  }
  emit(change);
  return file;
}

interface MutateOptions {
  /** Why this change might move the active account. */
  cause?: SwapCause;
  /** The owner changed the order: the first usable account is the one they mean. */
  reselect?: boolean;
}

/**
 * One change to the pool, after every earlier one. `work` may fill `ctx` with
 * what it learned (the limit's end, the run that hit it) for the move it may
 * cause; the move is settled after `work`, written with it, and emitted once
 * the write has landed.
 */
async function mutate<T>(work: (file: PoolFile, now: number, ctx: ChangeContext) => Promise<T> | T, opts: MutateOptions = {}): Promise<T> {
  const moved: { change: ActiveChange | null } = { change: null };
  const result = await serialised(async () => {
    const file = await loadLocked();
    const ctx: ChangeContext = {};
    const out = await work(file, Date.now(), ctx);
    moved.change = settleActive(file, Date.now(), opts.cause ?? "reset", ctx, opts.reselect === true);
    await writePool(file);
    return out;
  });
  emit(moved.change);
  return result;
}

/** The pool, in priority order. Copies — changing them changes nothing. */
export async function readAccounts(): Promise<AnthropicAccount[]> {
  const file = await serialised(loadLocked);
  return file.accounts.map((a) => ({ ...a }));
}

/** The last pool this process saw, without touching the disk. Null before the first read. */
export function accountsSnapshot(): AnthropicAccount[] | null {
  const { snapshot } = runtime();
  return snapshot ? snapshot.accounts.map((a) => ({ ...a })) : null;
}

/** The whole state the swap and the owner's card need, as copies. Never a credential. */
export interface PoolState {
  accounts: AnthropicAccount[];
  activeId: string | null;
  returnToPrimary: boolean;
  lastSwap: SwapEvent | null;
  gateway: GatewayMirror | null;
  health: PoolHealth;
}

function stateOf(file: PoolFile, now: number): PoolState {
  return {
    accounts: file.accounts.map((a) => ({ ...a })),
    activeId: file.activeId,
    returnToPrimary: file.returnToPrimary,
    lastSwap: file.lastSwap ? { ...file.lastSwap, consumers: { ...file.lastSwap.consumers } } : null,
    gateway: file.gateway ? { ...file.gateway } : null,
    health: poolHealth(file.accounts, now),
  };
}

export async function readPoolState(): Promise<PoolState> {
  const file = await serialised(loadLocked);
  return stateOf(file, Date.now());
}

/** The active account as this process last saw it, synchronously. Null before the first read or when none can answer. */
export function activeAccountSnapshot(): AnthropicAccount | null {
  const { snapshot } = runtime();
  const active = snapshot?.activeId ? snapshot.accounts.find((a) => a.id === snapshot.activeId) : undefined;
  return active ? { ...active } : null;
}

/**
 * Be told every time the active account moves (src/lib/anthropic-swap.ts is
 * the one listener that matters). Called after the write, outside the pool's
 * chain; a listener may read and write the pool again.
 */
export function onActiveChange(listener: (change: ActiveChange) => void): () => void {
  const listeners = runtime().changeListeners;
  listeners.add(listener);
  return () => listeners.delete(listener);
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
    authFailedAt: null,
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
  return mutate(async (file, now, ctx) => {
    const same = email ? file.accounts.find((a) => a.kind === "oauth" && sameEmail(a.email, email)) : undefined;
    ctx.cause = same ? "renewed" : "added";
    if (same) {
      await storeCredential(same.id, oauthSecret(input.tokens));
      same.expiresAt = input.tokens.expires;
      if (same.status === "expired" || same.status === "revoked") same.status = "ok";
      same.authFailedAt = null;
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
  }, { cause: "added" });
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
    account.authFailedAt = null;
    return { ...account };
  }, { cause: "renewed" });
}

/** Take an account out of the pool, and its credential out of the store. A `claude` sign-in is only UNLISTED: it is not this box's to end. */
export async function removeAccount(id: unknown): Promise<void> {
  await mutate(async (file, _now, ctx) => {
    const account = find(file, id);
    ctx.fromLabel = account.label;
    file.accounts = file.accounts.filter((a) => a.id !== account.id);
    if (account.kind === "login") file.loginDismissed = true;
    await deleteDeviceSecret({ scope: ANTHROPIC_ACCOUNTS_SCOPE, name: secretName(account.id) }).catch((err: unknown) => {
      // The row is already off the list, and the sweep below takes an orphan
      // at the next removal; said rather than swallowed.
      console.error("[anthropic-accounts] could not delete a removed account's credential:", err instanceof Error ? err.message : err);
    });
  }, { cause: "removed" });
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
  }, { cause: "added" });
}

/**
 * The owner's new order: every id exactly once. The order is also the owner's
 * word on WHICH account to use (TASK-1260): the first usable one in the new
 * order becomes the active one — moving an account to the top is how the
 * owner switches to it by hand.
 */
export async function reorderAccounts(ids: unknown): Promise<AnthropicAccount[]> {
  return mutate((file) => {
    if (!Array.isArray(ids) || ids.length !== file.accounts.length || new Set(ids).size !== ids.length) {
      throw new AnthropicAccountError("invalid", "The new order must name every account exactly once.");
    }
    file.accounts = ids.map((id) => find(file, id));
    return file.accounts.map((a) => ({ ...a }));
  }, { cause: "owner", reselect: true });
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
/** Who saw the failure a mark records: the swap's event says where it came from. */
export interface FailureContext {
  source?: SwapSource;
  runId?: string | null;
}

export async function markLimited(id: unknown, until: number, kind: AnthropicLimitKind, context: FailureContext = {}): Promise<LimitRecorded> {
  return mutate((file, now, ctx) => {
    const before = poolHealth(file.accounts, now);
    const account = find(file, id);
    const wasLimited = effectiveStatus(account, now) === "limited";
    account.status = "limited";
    account.limitedUntil = wasLimited && account.limitedUntil !== null ? Math.max(account.limitedUntil, until) : until;
    account.limitKind = kind;
    account.lastLimitedAt = now;
    ctx.source = context.source ?? "box";
    ctx.runId = context.runId ?? null;
    ctx.limitKind = kind;
    ctx.limitedUntil = account.limitedUntil;
    const after = poolHealth(file.accounts, now);
    return { account: { ...account }, newlyLimited: !wasLimited, becameAllLimited: !before.allLimited && after.allLimited, health: after };
  }, { cause: "limit" });
}

/** Take a recorded limit back (the owner knows better, or a test is over). */
export async function clearLimit(id: unknown): Promise<AnthropicAccount> {
  return mutate((file) => {
    const account = find(file, id);
    if (account.status === "limited") account.status = "ok";
    account.limitedUntil = null;
    account.limitKind = null;
    return { ...account };
  }, { cause: "renewed" });
}

/** An account's credential needs the owner (`revoked`) or a renewal (`expired`). */
export async function markCredentialProblem(id: unknown, status: "expired" | "revoked", context: FailureContext = {}): Promise<void> {
  await mutate((file, now, ctx) => {
    const account = find(file, id);
    // A limit outranks a credential problem only while it runs: the owner
    // should learn about a dead credential without waiting for a reset.
    account.status = status;
    account.limitedUntil = null;
    // For the `claude` sign-in, never earlier than its credential file as it
    // is NOW: only a LATER write of that file (the owner signing in again)
    // lifts the refusal, and a file clock and this process's clock must not
    // be compared to the millisecond.
    const writtenAt = account.kind === "login" ? anthropicLoginChangedAt() : null;
    account.authFailedAt = writtenAt !== null ? Math.max(now, Math.ceil(writtenAt)) : now;
    ctx.source = context.source ?? "box";
    ctx.runId = context.runId ?? null;
  }, { cause: "auth" });
}

/**
 * The owner's preference (TASK-1260): back to the first account in the order
 * the moment it can answer again, instead of staying on the account the box
 * moved to. Turning it on applies it at once.
 */
export async function setReturnToPrimary(on: boolean): Promise<void> {
  await mutate((file) => {
    file.returnToPrimary = on === true;
  }, { cause: "owner" });
}

/** File the swap the listeners are fanning out, so the card can show it while it happens. */
export async function recordSwapEvent(event: SwapEvent): Promise<void> {
  await mutate((file) => {
    file.lastSwap = { ...event, consumers: { ...event.consumers } };
  });
}

/** What one consumer did about the swap on record — ignored once a newer swap has taken its place. */
export async function updateSwapConsumer(eventId: string, name: SwapConsumerName, outcome: SwapConsumerOutcome): Promise<void> {
  await mutate((file) => {
    if (file.lastSwap?.id !== eventId) return;
    file.lastSwap.consumers = { ...file.lastSwap.consumers, [name]: { ...outcome } };
  });
}

/** Where the gateway's Claude subscription credential now stands (src/lib/anthropic-gateway.ts); null when it no longer follows the pool. */
export async function setGatewayMirror(mirror: GatewayMirror | null): Promise<void> {
  await mutate((file) => {
    file.gateway = mirror && file.accounts.some((a) => a.id === mirror.accountId) ? { ...mirror } : null;
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
 * and the CLI are handed an access token and never see the refresh token — and
 * so is the gateway's mirror (src/lib/anthropic-gateway.ts). The locks are the
 * PROCESS's (see PoolRuntime), not one module copy's: the boot hook's copy and
 * a route's copy renewing the same account would otherwise race exactly as two
 * runs did. The lock never waits on the pool's own `mutate` chain while that
 * chain waits on it, because nothing inside `mutate` reads a credential.
 */
function credentialLock(id: string): SerialLock {
  const locks = runtime().credentialLocks;
  let lock = locks.get(id);
  if (!lock) {
    lock = createSerialLock();
    locks.set(id, lock);
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
 * What asking Anthropic about one account's credential answered (TASK-1260):
 * `ok` — it works (an OAuth grant renewed, a key accepted); `dead` — refused,
 * and the account is now marked so; `unknown` — Anthropic could not be asked,
 * and nothing was marked.
 */
export type CredentialProbe = "ok" | "dead" | "unknown";

export type KeyCheck = (key: string) => Promise<"ok" | "rejected" | "unreachable">;

/**
 * A consumer saw a 401 on this account: is the account's credential really
 * dead, or was the token that process held merely stale?
 *
 * Asked the one way that costs no run: an OAuth grant is RENEWED (the pool is
 * its only holder, so spending the refresh token here is safe, and a renewal
 * that succeeds is proof the grant is alive — the stale token is replaced with
 * it); an API key is checked the way the key form checks it (`verifyKey`, the
 * caller's, since that check lives above this module). The `claude` sign-in
 * cannot be asked — this box never reads it — and a refusal that reached a
 * run is one Claude Code could not renew its way out of, so it is marked.
 */
export async function probeAccountCredential(id: string, verifyKey: KeyCheck, context: FailureContext = {}): Promise<CredentialProbe> {
  const account = (await readAccounts()).find((a) => a.id === id);
  if (!account) return "unknown";
  return credentialLock(account.id)(async (): Promise<CredentialProbe> => {
    const dead = async (status: "expired" | "revoked"): Promise<CredentialProbe> => {
      await markCredentialProblem(account.id, status, context).catch(() => {});
      return "dead";
    };
    if (account.kind === "login") return dead(hasAnthropicLogin() ? "revoked" : "expired");
    const stored = await readDeviceSecret({ scope: ANTHROPIC_ACCOUNTS_SCOPE, name: secretName(account.id) });
    if (!stored.found) return stored.reason === "unavailable" ? "unknown" : dead("revoked");
    if (account.kind === "api_key") {
      const verdict = await verifyKey(stored.value).catch(() => "unreachable" as const);
      if (verdict === "rejected") return dead("revoked");
      return verdict === "ok" ? "ok" : "unknown";
    }
    const tokens = parseOAuthSecret(stored.value);
    if (!tokens) return dead("revoked");
    const now = Date.now();
    if (!tokens.refresh) {
      // Nothing to renew with: a token past its end is dead, one with life in
      // it cannot be told apart from a stale copy without spending a request.
      return tokens.expires !== null && tokens.expires <= now ? dead("expired") : "unknown";
    }
    const refreshed = await refreshOAuthTokens(tokens.refresh, now);
    if (!refreshed.ok) return refreshed.reason === "rejected" ? dead("revoked") : "unknown";
    await storeCredential(account.id, oauthSecret(refreshed.tokens));
    await mutate((file) => {
      const row = file.accounts.find((a) => a.id === account.id);
      if (row) row.expiresAt = refreshed.tokens.expires;
    }).catch(() => {});
    return "ok";
  });
}

/**
 * A Claude account's ACCESS token and when it ends, renewed first when it is
 * near that end — what the gateway's copy of the active account is written
 * from (src/lib/anthropic-gateway.ts). Never the refresh token: the pool stays
 * the grant's only holder, so nothing else can spend it. Null for any other
 * kind of account, or one that cannot answer.
 */
export async function gatewayCredentialFor(id: string): Promise<{ access: string; expires: number | null } | null> {
  const account = (await readAccounts()).find((a) => a.id === id);
  if (!account || account.kind !== "oauth") return null;
  return credentialLock(account.id)(async () => {
    const credential = await readCredential(account, Date.now());
    if (!credential || credential.kind !== "oauth") return null;
    const stored = await readDeviceSecret({ scope: ANTHROPIC_ACCOUNTS_SCOPE, name: secretName(account.id) });
    const tokens = stored.found ? parseOAuthSecret(stored.value) : null;
    return { access: credential.secret, expires: tokens && tokens.access === credential.secret ? tokens.expires : null };
  });
}

/**
 * The account a run should use now, with its credential in hand.
 *
 * The ACTIVE account (TASK-1260) — else the first usable one in the owner's
 * order — skipping any in `exclude` (the one that has just refused) and any
 * whose credential turns out not to work — those are marked on the way past,
 * so the owner's list says why, and marking one moves the active account.
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
    const file = await serialised(loadLocked);
    const accounts = file.accounts.map((a) => ({ ...a }));
    const next = pickForSpawn(accounts, file.activeId, now, tried);
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
  const { snapshot } = runtime();
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
 * every read, so a restart re-arms it at the first read after boot. ONE timer
 * per process (PoolRuntime): the read it ends with is what settles the active
 * account against the reset, and so what moves every consumer back to work.
 */

/** A small margin past the reset, so the account is really back when the wake runs. */
const WAKE_MARGIN_MS = 20_000;

export function onLimitReset(listener: () => void): () => void {
  const listeners = runtime().wakeListeners;
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function armWake(file: PoolFile): void {
  const state = runtime();
  const now = Date.now();
  const next = poolHealth(file.accounts, now).nextResetAt;
  const at = next === null ? null : next + WAKE_MARGIN_MS;
  if (at === state.wakeAt && state.wakeTimer) return;
  if (state.wakeTimer) clearTimeout(state.wakeTimer);
  state.wakeTimer = null;
  state.wakeAt = at;
  if (at === null) return;
  // setTimeout's own ceiling is ~24.8 days; a longer wait re-arms on the way.
  const delay = Math.min(Math.max(at - now, 1_000), 2_147_000_000);
  state.wakeTimer = setTimeout(() => {
    state.wakeTimer = null;
    state.wakeAt = null;
    for (const listener of state.wakeListeners) {
      try {
        listener();
      } catch (err) {
        console.error("[anthropic-accounts] a limit-reset listener failed:", err instanceof Error ? err.message : err);
      }
    }
    // Re-read: it settles the active account against the reset (and emits the
    // move), and the next limit in line (if any) arms the next wake.
    void readAccounts().catch(() => {});
  }, delay);
  state.wakeTimer.unref?.();
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
  /** The account every Claude consumer on the box uses now (TASK-1260); null when none can answer. */
  activeAccountId: string | null;
  /** Can a `claude` sign-in be put (back) on the list? */
  loginAvailable: boolean;
  /** The owner's preference: back to the first account once its limit is over. */
  returnToPrimary: boolean;
  /** The most recent move of the active account and what each consumer did about it — labels and times only. */
  lastSwap: SwapEvent | null;
  /** Whether the gateway's Claude subscription follows the active account, and which one it holds. */
  gateway: { following: boolean; accountId: string | null; label: string | null; since: number | null };
  now: number;
}

/** The pool as a route and the MCP tool may show it: labels and states, never a credential. */
export async function describePool(): Promise<AnthropicPoolView> {
  const now = Date.now();
  const file = await serialised(loadLocked);
  const accounts = file.accounts;
  const active = file.activeId ? accounts.find((a) => a.id === file.activeId) ?? null : null;
  const mirrored = file.gateway ? accounts.find((a) => a.id === file.gateway?.accountId) ?? null : null;
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
    returnToPrimary: file.returnToPrimary,
    lastSwap: file.lastSwap ? { ...file.lastSwap, consumers: { ...file.lastSwap.consumers } } : null,
    gateway: {
      following: mirrored !== null,
      accountId: mirrored?.id ?? null,
      label: mirrored?.label ?? null,
      since: mirrored ? file.gateway?.at ?? null : null,
    },
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

/** Test seam: forget the snapshot, the wake, the chain and every listener. */
export function _resetAnthropicAccountsForTests(): void {
  const state = runtime();
  state.snapshot = null;
  state.chain = Promise.resolve();
  state.credentialLocks.clear();
  if (state.wakeTimer) clearTimeout(state.wakeTimer);
  state.wakeTimer = null;
  state.wakeAt = null;
  state.wakeListeners.clear();
  state.changeListeners.clear();
}

export { isUsable };
