/**
 * The owner's OWN Anthropic access for a coding run — the second provider
 * beside the box's ClawBox AI plan (see src/lib/coding-provider.ts).
 *
 * TWO WAYS IN, AND THE BOX HOLDS ONLY ONE OF THEM
 *
 *  - the NATIVE login. `claude` signs in from the Terminal app (`claude
 *    /login`) and stores its own credential under the clawbox user's home,
 *    the way it does on any machine. ClawBox neither writes nor reads that
 *    credential; it only asks whether one is there, so it can tell the owner
 *    whether a run would work. Disconnecting here never touches it — that
 *    login is the owner's, made outside this app, and deleting somebody's
 *    session because they pressed a button labelled "disconnect the key"
 *    would be the wrong reading of the button.
 *  - an API KEY, saved here — and, since TASK-902, any number of Claude
 *    accounts beside it. They are accounts in the ANTHROPIC ACCOUNT POOL
 *    (src/lib/anthropic-accounts.ts), with each credential in the owner secret
 *    store, never in data/config.json. A run is handed its account's credential
 *    through a one-shot 0600 file that `claude-ds` reads and deletes right
 *    before exec; it is never in a response body, never in a log line, never in
 *    argv and never in the environment the web server hands the child.
 *
 * A run is DENIED the key it must not have: the deny rules a run is spawned
 * with already put data/ off limits (src/lib/coding-agent.ts), so neither
 * provider's run can read the other's credential out of the config.
 */

import {
  addApiKeyAccount,
  poolHasCredential,
  readAccounts,
  removeAccount,
  replaceCredential,
} from "@/lib/anthropic-accounts";
import { hasAnthropicLogin } from "@/lib/claude-login";

// The `claude` sign-in checks moved to their own module (the account pool needs
// them too, and importing this file from there would be a cycle); re-exported so
// every caller keeps its import.
export { _resetAnthropicLoginCache, hasAnthropicLogin } from "@/lib/claude-login";

/** An API key's shape, before it is ever stored. */
const KEY_PREFIX = "sk-ant-";
const MIN_KEY_CHARS = 24;
export const MAX_ANTHROPIC_KEY_CHARS = 500;

/** How long the optional live check may take before the box stops waiting. */
const VERIFY_TIMEOUT_MS = 10_000;

/** Anthropic's cheapest authenticated call: it lists models and bills nothing. */
const VERIFY_URL = "https://api.anthropic.com/v1/models?limit=1";
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Which kind of access a run would use. `oauth` joined `key` and `login` with
 * the account pool: a Claude account connected through the box's own sign-in.
 */
export type AnthropicSource = "key" | "login" | "oauth";

export interface AnthropicConnection {
  /** Would an `anthropic` run have something to authenticate with? */
  connected: boolean;
  /** An API key is among the box's accounts. */
  hasKey: boolean;
  /** A `claude` login the owner made themselves, which this app does not own. */
  hasLogin: boolean;
  /**
   * What the account a run would use NOW is — the first usable one in the
   * owner's order (src/lib/anthropic-accounts.ts).
   */
  source: AnthropicSource | null;
}

/** Is this a plausible Anthropic key? Shape only — the live check is separate. */
export function looksLikeAnthropicKey(value: string): boolean {
  return (
    value.startsWith(KEY_PREFIX)
    && value.length >= MIN_KEY_CHARS
    && value.length <= MAX_ANTHROPIC_KEY_CHARS
    && !/\s/.test(value)
  );
}

/** The first API-key account, or null. */
async function firstKeyAccount(): Promise<{ id: string } | null> {
  return (await readAccounts()).find((a) => a.kind === "api_key") ?? null;
}

/** Whether an API key is among the box's accounts, without reading it into the caller's scope. */
export async function hasAnthropicKey(): Promise<boolean> {
  return (await firstKeyAccount()) !== null;
}

/**
 * Save the owner's key — the Coding Agent app's one-field form. Shape-checked
 * here rather than at the route, so every caller gets the same refusal.
 *
 * Into the ACCOUNT POOL, and so into the owner secret store — never
 * data/config.json, where it used to sit beside the portal token. A box that
 * already has a key account gets its key replaced (a rotated key is the same
 * account); one without gets a new account FIRST in the order, which is the
 * precedence this form always had: the key it saved was the one runs used.
 *
 * @throws Error with an owner-facing sentence when the value is not a key
 */
export async function setAnthropicKey(value: string): Promise<void> {
  const key = value.trim();
  if (!looksLikeAnthropicKey(key)) {
    throw new Error(`That does not look like an Anthropic API key — they start with "${KEY_PREFIX}".`);
  }
  const existing = await firstKeyAccount();
  if (existing) await replaceCredential(existing.id, { kind: "api_key", key });
  else await addApiKeyAccount({ key, first: true });
}

/** Forget the stored key — the first API-key account. The owner's own `claude` login is left alone. */
export async function clearAnthropicKey(): Promise<void> {
  const existing = await firstKeyAccount();
  if (existing) await removeAccount(existing.id);
}

/** The whole connection state, for the status payload and for readiness. */
export async function getAnthropicConnection(): Promise<AnthropicConnection> {
  try {
    const pool = await poolHasCredential();
    return {
      connected: pool.any,
      hasKey: pool.hasKey,
      hasLogin: hasAnthropicLogin(),
      source: pool.first === "api_key" ? "key" : pool.first,
    };
  } catch {
    // A pool that cannot be read at all must not read as "not connected" to a
    // box whose sign-in is plainly there — the run's own spawn re-reads.
    const hasLogin = hasAnthropicLogin();
    return { connected: hasLogin, hasKey: false, hasLogin, source: hasLogin ? "login" : null };
  }
}

export type KeyVerdict = "ok" | "rejected" | "unreachable";

/**
 * Ask Anthropic whether this key works, before it is saved.
 *
 * "unreachable" is NOT a refusal: this appliance is often offline, and a key
 * the owner pasted correctly must still be storable on a box behind a captive
 * portal. Only a definite 401/403 — Anthropic saying the credential is no
 * good — stops the save, because storing one of those buys a run that fails
 * minutes later with a message the owner cannot act on.
 */
export async function verifyAnthropicKey(key: string): Promise<KeyVerdict> {
  try {
    const res = await fetch(VERIFY_URL, {
      method: "GET",
      headers: {
        "x-api-key": key,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) return "rejected";
    if (!res.ok) return "unreachable";
    return "ok";
  } catch {
    return "unreachable";
  }
}
