// Discord on a Hermes device.
//
// Hermes ships Discord as a first-class gateway platform
// (plugins/platforms/discord/plugin.yaml: `requires_env: DISCORD_BOT_TOKEN`),
// wired exactly the way Telegram is — which is why this file is thin:
//
//   * `hermes config set DISCORD_BOT_TOKEN <token>` routes to ~/.hermes/.env.
//     DISCORD_BOT_TOKEN is in the CLI's own env-key allowlist (hermes_cli/
//     config.py `_is_env_config_key`), so it lands in .env like the Telegram
//     token and NOT as a plaintext scalar in config.yaml. A token present there
//     is what enables the platform.
//   * The messaging gateway is shared — one process serves every platform — so
//     Discord reuses `ensureHermesGateway` rather than installing anything of
//     its own.
//
// The other DISCORD_* variables (allowed users, home channel) are deliberately
// not exposed: they are NOT in the CLI's env-key allowlist, so `hermes config
// set` would write them into config.yaml instead, and Hermes' own dashboard
// catalog exposes only the token as the required field.

import fs from "fs/promises";
import path from "path";
import { runHermesCli } from "@/lib/hermes-cli";
import { hermesHome, readHermesEnv, setHermesEnvValues } from "@/lib/hermes-env";
import { ensureHermesGateway, hermesGatewayStatus } from "@/lib/hermes-telegram";

const PLATFORM = "discord";
export const DISCORD_TOKEN_ENV_VAR = "DISCORD_BOT_TOKEN";

// Same ceilings as the Telegram path — these bound a wedged CLI on a loaded
// Jetson, they are not expectations (`config set` is ~1 s, `send --list` ~2 s).
const CONFIG_TIMEOUT_MS = 90_000;
const SEND_TIMEOUT_MS = 90_000;

// One gateway serves every Hermes platform, so Discord installs/restarts the
// same service Telegram does. Re-exported so a route only has to know about the
// platform module it is actually configuring.
export { ensureHermesGateway, hermesGatewayStatus };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Store the bot token where Hermes reads it (~/.hermes/.env) via
 * `hermes config set`, which also clears a stale config.yaml mirror that would
 * otherwise outrank it.
 *
 * The token is passed as a single argv element (runHermesCli never uses a
 * shell) and the caller has already rejected anything outside the safe charset,
 * so it cannot be read as a flag.
 */
export async function setHermesDiscordToken(
  botToken: string,
  signal?: AbortSignal,
): Promise<void> {
  const res = await runHermesCli(["config", "set", DISCORD_TOKEN_ENV_VAR, botToken], {
    timeoutMs: CONFIG_TIMEOUT_MS,
    signal,
  });
  if (res.code !== 0) {
    // Never echo the CLI's stderr — it can quote the value it was handed.
    throw new Error("Hermes rejected the bot token");
  }
}

/**
 * Whether Hermes itself considers Discord a configured platform.
 *
 * Tri-state, for the same reason as the Telegram probe: `false` means Hermes
 * answered and reported no Discord, `null` means we could not ask it (CLI
 * missing, timed out, unparseable output). Collapsing the two would flash "not
 * configured" at someone whose bot is working fine.
 */
export async function hermesDiscordRegistered(signal?: AbortSignal): Promise<boolean | null> {
  let res;
  try {
    res = await runHermesCli(["send", "--list", PLATFORM, "--json"], {
      timeoutMs: SEND_TIMEOUT_MS,
      signal,
    });
  } catch {
    return null;
  }
  // Exit 1 with the "no targets found for platform" notice is a real "no".
  if (res.code !== 0) return false;
  try {
    const parsed: unknown = JSON.parse(res.stdout);
    if (!isRecord(parsed) || !isRecord(parsed.platforms)) return null;
    return PLATFORM in parsed.platforms;
  } catch {
    return null;
  }
}

// ── Who may talk to the assistant ───────────────────────────────────────────
//
// The friction this exists for: a verified token and a connected bot still
// answer nobody. Hermes' Discord adapter denies every inbound message until an
// allowlist exists, and says so only in the gateway log:
//
//   [Discord] Discord messages are being denied because no allowlist is
//   configured. Set DISCORD_ALLOWED_USERS, DISCORD_ALLOWED_ROLES, or
//   DISCORD_ALLOWED_CHANNELS, or set DISCORD_ALLOW_ALL_USERS=true ...
//
// ClawBox wrote none of those, so the panel could report a healthy bot while
// every message was dropped. The fix that worked by hand — look the guild
// members up through the bot's own API and put the owner's numeric id in
// DISCORD_ALLOWED_USERS — is what the configure route now does for itself.
//
// WHY NOT `hermes config set`. DISCORD_BOT_TOKEN is in the CLI's env-key
// allowlist, so `config set` routes it to ~/.hermes/.env. DISCORD_ALLOWED_USERS
// is not, and does not end in _API_KEY/_TOKEN/_SECRET either, so the same
// command would write it into config.yaml — a different file that Hermes' env
// loader never reads for this key. Verified against `_is_env_config_key` in
// hermes_cli/config.py on a live v0.20.5 device. So the allowlist is written
// through hermes-env.ts, the same writer the WhatsApp integration uses.
//
// There is deliberately no allow-everyone switch here. DISCORD_ALLOW_ALL_USERS
// exists upstream and is read below so the panel can *report* one that was set
// by hand, but ClawBox never sets it: a box that answers any stranger who finds
// the server is not a default anyone should reach by clicking a toggle.


export const DISCORD_ENV_ALLOWED_USERS = "DISCORD_ALLOWED_USERS";
export const DISCORD_ENV_ALLOWED_ROLES = "DISCORD_ALLOWED_ROLES";
export const DISCORD_ENV_ALLOWED_CHANNELS = "DISCORD_ALLOWED_CHANNELS";
export const DISCORD_ENV_ALLOW_ALL_USERS = "DISCORD_ALLOW_ALL_USERS";

// Discord snowflakes are 17-19 digits today and grow by one roughly every few
// years. Deliberately generous at both ends: this is a "could not possibly be
// anything else" guard that also keeps the value safe as a single env line, not
// a format check that a future id length would fail.
const SNOWFLAKE_RE = /^\d{15,25}$/;

/** A user id, or null when the value could not be one. */
export function normalizeDiscordUserId(raw: string | null | undefined): string | null {
  const trimmed = String(raw ?? "").trim();
  return SNOWFLAKE_RE.test(trimmed) ? trimmed : null;
}

/**
 * Parse a stored DISCORD_ALLOWED_USERS value into numeric ids.
 *
 * Hermes also accepts usernames here and rewrites them to ids once it has
 * resolved them, so a hand-edited .env can hold entries this does not return.
 * Those are reported separately by readHermesDiscordAccess rather than silently
 * dropped — the panel has to be able to show everything that grants access.
 */
export function parseDiscordAllowedUsers(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const part of String(raw).split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    // Upstream's allow-everyone marker. It is not a user, and ClawBox never
    // writes it, but an env edited by hand can contain it.
    if (trimmed === "*") continue;
    const id = normalizeDiscordUserId(trimmed);
    if (id) seen.add(id);
  }
  return [...seen];
}

/** Entries that grant access but are not numeric ids (usernames, "*"). */
export function parseDiscordAllowlistExtras(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of String(raw).split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (normalizeDiscordUserId(trimmed)) continue;
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

/**
 * Serialise for DISCORD_ALLOWED_USERS: comma-joined, no spaces.
 *
 * Whitespace-free is not cosmetic. Upstream splits the value on commas and
 * matches the parts against a strict identifier pattern; a stray space inside
 * an entry fails that pattern and the user is silently denied — the exact
 * class of bug this whole change is about.
 */
export function formatDiscordAllowedUsers(ids: string[]): string {
  return ids.join(",");
}

/** Same set of ids, order-insensitively? Used to keep a save idempotent. */
function sameIdSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
}

/** A configured bot may not be left with nothing that can reach it. */
export class DiscordEmptyAllowlistError extends Error {
  constructor() {
    super("Discord allowlist would be empty");
    this.name = "DiscordEmptyAllowlistError";
  }
}

export interface HermesDiscordAccess {
  allowedUsers: string[];
  /** Non-id entries found in DISCORD_ALLOWED_USERS (usernames, "*"). */
  allowlistExtras: string[];
  allowedRoles: string[];
  allowedChannels: string[];
  /** DISCORD_ALLOW_ALL_USERS. Reported, never written. */
  allowAllUsers: boolean;
  /**
   * Will the adapter admit anyone at all? False is the state that produced a
   * connected, healthy-looking, completely silent bot.
   */
  authorized: boolean;
}

function envIsTrue(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === "true";
}

function splitList(raw: string | null | undefined): string[] {
  return String(raw ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Read every input the adapter's admission check consults. */
export async function readHermesDiscordAccess(): Promise<HermesDiscordAccess> {
  const env = await readHermesEnv();
  const rawUsers = env[DISCORD_ENV_ALLOWED_USERS] ?? null;
  const allowedUsers = parseDiscordAllowedUsers(rawUsers);
  const allowlistExtras = parseDiscordAllowlistExtras(rawUsers);
  const allowedRoles = splitList(env[DISCORD_ENV_ALLOWED_ROLES]);
  const allowedChannels = splitList(env[DISCORD_ENV_ALLOWED_CHANNELS]);
  const allowAllUsers = envIsTrue(env[DISCORD_ENV_ALLOW_ALL_USERS]);

  return {
    allowedUsers,
    allowlistExtras,
    allowedRoles,
    allowedChannels,
    allowAllUsers,
    // Mirrors the adapter's own "no allowlist is configured" test: ANY of the
    // four inputs being non-empty is enough for it to stop denying everyone.
    authorized:
      allowAllUsers ||
      allowedUsers.length > 0 ||
      allowlistExtras.length > 0 ||
      allowedRoles.length > 0 ||
      allowedChannels.length > 0,
  };
}

export interface DiscordAllowlistResult {
  /** Env keys written, for the caller's audit line. Never the values. */
  changedKeys: string[];
  allowedUsers: string[];
  authorized: boolean;
}

/**
 * Replace DISCORD_ALLOWED_USERS with the ids the picker selected.
 *
 * REPLACE, not union: the picker is the panel's promise about who can reach the
 * assistant, so deselecting somebody has to actually remove them. The
 * never-empty invariant is enforced by refusing the write, not by quietly
 * re-adding the owner — a silent re-add would make the picker lie in the other
 * direction. The caller turns that refusal into a visible warning state.
 *
 * @throws {DiscordEmptyAllowlistError} the resulting allowlist would admit
 *   nobody and no role/channel rule covers for it.
 */
export async function setHermesDiscordAllowlist(
  userIds: string[],
): Promise<DiscordAllowlistResult> {
  const access = await readHermesDiscordAccess();

  const next: string[] = [];
  for (const raw of userIds) {
    const id = normalizeDiscordUserId(raw);
    // Reject rather than silently drop: an owner who pastes one wrong digit
    // would otherwise see a saved allowlist that quietly excludes them.
    if (!id) throw new Error("Invalid Discord user id");
    if (!next.includes(id)) next.push(id);
  }

  const coveredByOtherRule =
    access.allowAllUsers ||
    access.allowedRoles.length > 0 ||
    access.allowedChannels.length > 0;
  if (next.length === 0 && !coveredByOtherRule) {
    throw new DiscordEmptyAllowlistError();
  }

  // Compare against the value already on disk put through the same
  // normalisation, so a save that changes nothing but the spacing or the order
  // is not reported as a change — and, on a box whose allowlist was set by
  // hand, re-selecting the same person writes nothing and restarts nothing.
  const entries: Record<string, string | null> = {};
  if (!sameIdSet(next, access.allowedUsers)) {
    const serialized = formatDiscordAllowedUsers(next);
    entries[DISCORD_ENV_ALLOWED_USERS] = serialized === "" ? null : serialized;
  }

  const changedKeys = Object.keys(entries);
  if (changedKeys.length > 0) await setHermesEnvValues(entries);

  return {
    changedKeys,
    allowedUsers: next,
    authorized: next.length > 0 || coveredByOtherRule,
  };
}

// ── What the gateway actually thinks ────────────────────────────────────────
//
// `receiving: true` used to mean "a token is stored and the gateway process is
// up". Both were true on the bench box while Discord was refusing to connect at
// all, so the panel reported a working bot for a dead one.
//
// Hermes writes a structured snapshot to ~/.hermes/gateway_state.json and keeps
// a per-platform entry in it, so nothing has to be scraped out of a log:
//
//   "platforms": { "discord": { "state": "connected", "error_code": null,
//                               "error_message": null, "updated_at": "..." } }
//
// The error codes come from the adapter's own classifier
// (plugins/platforms/discord/adapter.py `_classify_connect_exception`), which
// maps the exception TYPE to a stable string: PrivilegedIntentsRequired ->
// "discord_intents_required" (non-retryable), LoginFailure ->
// "discord_auth_error", anything else -> "discord_connect_error". Read on a
// live v0.20.5 device.

export const DISCORD_INTENTS_ERROR_CODE = "discord_intents_required";
export const DISCORD_AUTH_ERROR_CODE = "discord_auth_error";

export interface HermesPlatformState {
  /** Hermes' own word: "connected", "retrying", "error", "stopped", ... */
  state: string | null;
  errorCode: string | null;
  updatedAt: string | null;
}

export interface HermesGatewaySnapshot {
  /** Top-level gateway_state, e.g. "running". */
  gatewayState: string | null;
  platform: HermesPlatformState | null;
}

export function gatewayStatePath(): string {
  return path.join(hermesHome(), "gateway_state.json");
}

function isRec(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/** The pure half of readHermesGatewaySnapshot, so mapping is testable. */
export function parseHermesGatewaySnapshot(raw: string, platform: string): HermesGatewaySnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { gatewayState: null, platform: null };
  }
  if (!isRec(parsed)) return { gatewayState: null, platform: null };
  const gatewayState = optionalString(parsed.gateway_state);
  const platforms = isRec(parsed.platforms) ? parsed.platforms : null;
  const entry = platforms && isRec(platforms[platform]) ? platforms[platform] : null;
  if (!entry) return { gatewayState, platform: null };
  return {
    gatewayState,
    platform: {
      state: optionalString(entry.state),
      errorCode: optionalString(entry.error_code),
      updatedAt: optionalString(entry.updated_at),
    },
  };
}

/**
 * Read the gateway's own view of one platform.
 *
 * A missing or unreadable file is "we could not ask", not "it is down" — the
 * caller pairs it with `hermes gateway status` before drawing a conclusion.
 */
export async function readHermesGatewaySnapshot(
  platform = PLATFORM,
): Promise<HermesGatewaySnapshot> {
  try {
    const raw = await fs.readFile(gatewayStatePath(), "utf-8");
    return parseHermesGatewaySnapshot(raw, platform);
  } catch {
    return { gatewayState: null, platform: null };
  }
}

/**
 * The four states the panel can render, each with exactly one remedy.
 *
 *   connected            — the bot is up and somebody is allowed to talk to it
 *   intents-missing      — Message Content was never enabled in the portal
 *   denied-no-allowlist  — connected, but every message is being dropped
 *   offline              — nothing is listening
 */
export type DiscordConnectionState =
  | "connected"
  | "intents-missing"
  | "denied-no-allowlist"
  | "offline";

export interface DiscordConnectionInputs {
  /** `hermes gateway status` said the gateway process is up. */
  gatewayRunning: boolean;
  snapshot: HermesGatewaySnapshot;
  /** Does anything at all admit a sender? */
  authorized: boolean;
}

/**
 * Map the gateway's snapshot onto one of the four states.
 *
 * Order is the argument. Nothing can be connected while the gateway is down, so
 * "offline" is checked first and an intents failure recorded before the process
 * died does not outrank it. Once the process IS up, a non-retryable intents
 * error outranks the platform's own state word, because that is the state the
 * owner has to act on and the adapter will never retry out of it.
 */
export function mapDiscordConnectionState(inputs: DiscordConnectionInputs): DiscordConnectionState {
  const { gatewayRunning, snapshot, authorized } = inputs;
  if (!gatewayRunning) return "offline";
  // A snapshot left behind by a gateway that is no longer the running one.
  if (snapshot.gatewayState !== null && snapshot.gatewayState !== "running") return "offline";
  if (snapshot.platform?.errorCode === DISCORD_INTENTS_ERROR_CODE) return "intents-missing";
  if (snapshot.platform?.state !== "connected") return "offline";
  if (!authorized) return "denied-no-allowlist";
  return "connected";
}
