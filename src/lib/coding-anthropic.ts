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
 *  - an API KEY, saved here. It lives beside `clawai_token` in the same 0600
 *    data/config.json — the box's existing pattern for a credential held on
 *    the owner's behalf — and leaves that file in exactly one direction: the
 *    `claude-ds` wrapper reads it itself, as root-less clawbox, immediately
 *    before exec. It is never in a response body, never in a log line, never
 *    in argv and never in the environment the web server hands the child.
 *
 * A run is DENIED the key it must not have: the deny rules a run is spawned
 * with already put data/ off limits (src/lib/coding-agent.ts), so neither
 * provider's run can read the other's credential out of the config.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { get as configGet, set as configSet } from "@/lib/config-store";
import { ANTHROPIC_API_KEY_CONFIG_KEY } from "@/lib/coding-provider";

/**
 * Claude Code's own state, at its defaults. An `anthropic` run deliberately
 * does NOT set CLAUDE_CONFIG_DIR (the ClawBox AI runs keep their own
 * ~/.claude-ds), so the native login the owner made in a terminal is the one
 * the run uses — which means these are the files to ask.
 */
function claudeHome(): string {
  return path.join(os.homedir(), ".claude");
}

/** Where `claude` writes an OAuth credential on Linux. */
function credentialsPath(): string {
  return path.join(claudeHome(), ".credentials.json");
}

/** Claude Code's top-level config, which records the signed-in account. */
function claudeConfigPath(): string {
  return path.join(os.homedir(), ".claude.json");
}

/** An API key's shape, before it is ever stored. */
const KEY_PREFIX = "sk-ant-";
const MIN_KEY_CHARS = 24;
export const MAX_ANTHROPIC_KEY_CHARS = 500;

/** How long the optional live check may take before the box stops waiting. */
const VERIFY_TIMEOUT_MS = 10_000;

/** Anthropic's cheapest authenticated call: it lists models and bills nothing. */
const VERIFY_URL = "https://api.anthropic.com/v1/models?limit=1";
const ANTHROPIC_VERSION = "2023-06-01";

export type AnthropicSource = "key" | "login";

export interface AnthropicConnection {
  /** Would an `anthropic` run have something to authenticate with? */
  connected: boolean;
  /** The key the owner saved here. */
  hasKey: boolean;
  /** A `claude` login the owner made themselves, which this app does not own. */
  hasLogin: boolean;
  /**
   * Which one a run would use. The key wins, because it is the one the owner
   * chose HERE and the wrapper exports ANTHROPIC_API_KEY when it is present.
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

/** The stored key, or null. The ONE reader; nothing else may call configGet for it. */
export async function getAnthropicKey(): Promise<string | null> {
  const raw = await configGet(ANTHROPIC_API_KEY_CONFIG_KEY);
  const key = typeof raw === "string" ? raw.trim() : "";
  return key === "" ? null : key;
}

/** Whether one is stored, without reading it into the caller's scope. */
export async function hasAnthropicKey(): Promise<boolean> {
  return (await getAnthropicKey()) !== null;
}

/**
 * Save the owner's key. Shape-checked here rather than at the route, so every
 * caller gets the same refusal.
 *
 * @throws Error with an owner-facing sentence when the value is not a key
 */
export async function setAnthropicKey(value: string): Promise<void> {
  const key = value.trim();
  if (!looksLikeAnthropicKey(key)) {
    throw new Error(`That does not look like an Anthropic API key — they start with "${KEY_PREFIX}".`);
  }
  await configSet(ANTHROPIC_API_KEY_CONFIG_KEY, key);
}

/** Forget the stored key. The owner's own `claude` login is left alone. */
export async function clearAnthropicKey(): Promise<void> {
  await configSet(ANTHROPIC_API_KEY_CONFIG_KEY, undefined);
}

function readableNonEmptyFile(file: string): boolean {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

/**
 * Has the owner signed `claude` in on this box?
 *
 * Asked of the files rather than by running `claude`: the CLI has no
 * non-interactive "who am I" that answers in under a second, and this is read
 * on every status poll. Two places count, because which one holds the answer
 * depends on the CLI's version — the credential file it writes on Linux, and
 * the account block in its top-level config.
 */
export function hasAnthropicLogin(): boolean {
  if (readableNonEmptyFile(credentialsPath())) return true;
  try {
    const raw = fs.readFileSync(claudeConfigPath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return false;
    const account = (parsed as { oauthAccount?: unknown }).oauthAccount;
    return typeof account === "object" && account !== null;
  } catch {
    return false;
  }
}

/** The whole connection state, for the status payload and for readiness. */
export async function getAnthropicConnection(): Promise<AnthropicConnection> {
  const [hasKey, hasLogin] = [await hasAnthropicKey(), hasAnthropicLogin()];
  return {
    connected: hasKey || hasLogin,
    hasKey,
    hasLogin,
    source: hasKey ? "key" : hasLogin ? "login" : null,
  };
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
