// WhatsApp on a Hermes device.
//
// WHAT HERMES ACTUALLY SUPPORTS, AND WHAT THAT MEANS FOR CLAWBOX
//
// Hermes ships a first-class WhatsApp platform adapter
// (plugins/platforms/whatsapp/) that talks to WhatsApp Web through a bundled
// Node bridge (Baileys). It is NOT the official Business API: there is no
// token to paste. Authentication is a QR code scanned from the owner's phone,
// and the resulting session lands on disk as creds.json.
//
// The only supported way to produce that session is `hermes whatsapp`, whose
// full --help is:
//
//     usage: hermes whatsapp [-h]
//     Configure WhatsApp and pair via QR code
//
// Zero flags, no --json, no --non-interactive. It is a TTY wizard that renders
// a live QR and waits for a scan — exactly the same shape as `hermes gateway
// setup`, which src/lib/hermes-telegram.ts already documents as impossible to
// drive from a route handler. `hermes whatsapp-cloud` (the official Meta Cloud
// API adapter) is the same: a zero-flag TTY wizard, and it additionally needs a
// Meta Business account and a PUBLIC webhook URL, which a box behind a home
// router or serving its own AP cannot receive.
//
// So ClawBox does NOT try to reimplement pairing. What it does own is
// everything around it, which is the part that actually needs a UI:
//
//   * report the real state (Hermes' own three-way verdict, gateway.py:6280 —
//     "not configured" / "enabled, not paired" / "configured + paired")
//   * write the access allowlist, which is the security-critical bit and is
//     otherwise only reachable by re-running the whole wizard
//   * turn the channel off (and back on once paired) without a terminal
//
// WHY NOT `hermes config set`
//
// No WHATSAPP_* key passes hermes_cli/config.py `_is_env_config_key`, so
// `hermes config set WHATSAPP_ENABLED true` writes into config.yaml instead of
// .env. See src/lib/hermes-env.ts for the full explanation; that module is the
// writer used here, matching the adapter's own `save_env_value` calls.

import fs from "fs/promises";
import path from "path";
import { getHermesEnvValue, hermesHome, readHermesEnv, setHermesEnvValues } from "@/lib/hermes-env";

export const WHATSAPP_ENV_ENABLED = "WHATSAPP_ENABLED";
export const WHATSAPP_ENV_MODE = "WHATSAPP_MODE";
export const WHATSAPP_ENV_ALLOWED_USERS = "WHATSAPP_ALLOWED_USERS";
export const WHATSAPP_ENV_ALLOW_ALL_USERS = "WHATSAPP_ALLOW_ALL_USERS";

export type WhatsappMode = "bot" | "self-chat";

export function isWhatsappMode(value: unknown): value is WhatsappMode {
  return value === "bot" || value === "self-chat";
}

/**
 * Where the bridge keeps its session.
 *
 * Two locations, and they genuinely disagree upstream: the adapter resolves
 * `get_hermes_dir("platforms/whatsapp/session", "whatsapp/session")` (new path,
 * legacy fallback) while the CLI's status helper only ever stats the legacy
 * `~/.hermes/whatsapp/session/creds.json`. Checking both is the only way to be
 * right on an install of either vintage.
 */
export function whatsappSessionDirs(): string[] {
  const home = hermesHome();
  return [path.join(home, "platforms", "whatsapp", "session"), path.join(home, "whatsapp", "session")];
}

/** The Baileys bridge that ships inside the Hermes checkout. */
export function whatsappBridgeDir(): string {
  const agent =
    process.env.HERMES_AGENT_DIR || path.join(hermesHome(), "hermes-agent");
  return path.join(agent, "scripts", "whatsapp-bridge");
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

/** True once a QR scan has produced a linked session. */
export async function whatsappPaired(): Promise<boolean> {
  for (const dir of whatsappSessionDirs()) {
    if (await exists(path.join(dir, "creds.json"))) return true;
  }
  return false;
}

/**
 * Whether the bundled Node bridge has its dependencies installed.
 *
 * Tri-state: `null` means we could not find the bridge directory at all (a
 * non-Hermes box, or a checkout laid out differently), which must not be shown
 * as "your bridge is broken".
 */
export async function whatsappBridgeReady(): Promise<boolean | null> {
  const dir = whatsappBridgeDir();
  if (!(await exists(dir))) return null;
  return exists(path.join(dir, "node_modules"));
}

// ── Phone numbers ───────────────────────────────────────────────────────────

/**
 * Normalise a phone number to the form Hermes expects: country code first,
 * digits only, NO leading "+".
 *
 * OpenClaw's WhatsApp channel wants the opposite (`+15551234567`), which is a
 * quiet way to get an allowlist that silently denies everyone. Keeping the
 * normalisation in one named function means the difference is testable rather
 * than implied by whatever the user happened to paste.
 *
 * Returns null for anything that cannot be a phone number. E.164 allows at most
 * 15 digits; a country code plus a subscriber number is never shorter than 7.
 */
export function normalizeWhatsappNumber(raw: string): string | null {
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  return digits;
}

/** Parse a stored WHATSAPP_ALLOWED_USERS value into normalised numbers. */
export function parseAllowedUsers(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    // "*" is upstream's allow-everyone marker; it is not a user and ClawBox
    // never writes it, but an env edited by hand can contain it.
    if (trimmed === "*") continue;
    const normalized = normalizeWhatsappNumber(trimmed);
    if (normalized) seen.add(normalized);
  }
  return [...seen];
}

/** Serialise for WHATSAPP_ALLOWED_USERS (the adapter strips spaces itself). */
export function formatAllowedUsers(numbers: string[]): string {
  return numbers.join(",");
}

// ── Status ──────────────────────────────────────────────────────────────────

/**
 * Hermes' own three-way verdict, kept verbatim so ClawBox and `hermes gateway
 * status` can never disagree about the same box.
 */
export type WhatsappState = "not_configured" | "enabled_not_paired" | "paired";

export interface HermesWhatsappStatus {
  state: WhatsappState;
  enabled: boolean;
  paired: boolean;
  mode: WhatsappMode | null;
  allowedUsers: string[];
  /** WHATSAPP_ALLOW_ALL_USERS — upstream calls this dev-only; ClawBox surfaces
   *  it as a warning and never sets it. */
  allowAllUsers: boolean;
  /** null = bridge directory not found, not "bridge broken". */
  bridgeReady: boolean | null;
}

function envIsTrue(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === "true";
}

export async function readHermesWhatsappStatus(): Promise<HermesWhatsappStatus> {
  const [env, paired, bridgeReady] = await Promise.all([
    readHermesEnv(),
    whatsappPaired(),
    whatsappBridgeReady(),
  ]);

  const enabled = envIsTrue(env[WHATSAPP_ENV_ENABLED]);
  const rawMode = (env[WHATSAPP_ENV_MODE] || "").trim();
  const allowedUsers = parseAllowedUsers(env[WHATSAPP_ENV_ALLOWED_USERS]);
  const allowAllUsers =
    envIsTrue(env[WHATSAPP_ENV_ALLOW_ALL_USERS]) ||
    (env[WHATSAPP_ENV_ALLOWED_USERS] || "").trim() === "*";

  const state: WhatsappState = !enabled ? "not_configured" : paired ? "paired" : "enabled_not_paired";

  return {
    state,
    enabled,
    paired,
    mode: isWhatsappMode(rawMode) ? rawMode : null,
    allowedUsers,
    allowAllUsers,
    bridgeReady,
  };
}

// ── Writes ──────────────────────────────────────────────────────────────────

export interface WhatsappConfigUpdate {
  /** Replaces the allowlist wholesale. An empty array clears the key. */
  allowedUsers?: string[];
  mode?: WhatsappMode;
  enabled?: boolean;
}

export class WhatsappNotPairedError extends Error {
  constructor() {
    super("WhatsApp is not paired yet");
    this.name = "WhatsappNotPairedError";
  }
}

/**
 * Apply an access-control / enablement change to ~/.hermes/.env.
 *
 * ENABLING IS GATED ON PAIRING, on purpose. Upstream's wizard deliberately
 * writes WHATSAPP_ENABLED=true only after a successful scan (hermes_cli
 * main.py: "an aborted setup leaves WHATSAPP_ENABLED unset → gateway skips
 * it"), because an enabled-but-unpaired adapter starts the bridge, fails to
 * find creds.json, and logs an error on every gateway boot. ClawBox must not
 * be the thing that puts a box into that state, so `enabled: true` without a
 * session is refused rather than written.
 *
 * Disabling is always allowed — turning a channel off must never depend on the
 * channel being healthy.
 *
 * Returns the key names written, for the caller's audit line. Never returns or
 * logs values.
 */
export async function setHermesWhatsappConfig(update: WhatsappConfigUpdate): Promise<string[]> {
  const entries: Record<string, string | null> = {};

  if (update.enabled === true) {
    if (!(await whatsappPaired())) throw new WhatsappNotPairedError();
    entries[WHATSAPP_ENV_ENABLED] = "true";
  } else if (update.enabled === false) {
    entries[WHATSAPP_ENV_ENABLED] = "false";
  }

  if (update.mode !== undefined) {
    entries[WHATSAPP_ENV_MODE] = update.mode;
  }

  if (update.allowedUsers !== undefined) {
    const numbers = update.allowedUsers
      .map((n) => normalizeWhatsappNumber(n))
      .filter((n): n is string => n !== null);
    const unique = [...new Set(numbers)];
    entries[WHATSAPP_ENV_ALLOWED_USERS] = unique.length > 0 ? formatAllowedUsers(unique) : null;
    // Writing an explicit allowlist and leaving a stale ALLOW_ALL_USERS=true in
    // place would keep the channel wide open while the UI showed a short list.
    // Clear it whenever we take ownership of access control.
    if (envIsTrue(await getHermesEnvValue(WHATSAPP_ENV_ALLOW_ALL_USERS))) {
      entries[WHATSAPP_ENV_ALLOW_ALL_USERS] = "false";
    }
  }

  const keys = Object.keys(entries);
  if (keys.length === 0) return [];
  await setHermesEnvValues(entries);
  return keys;
}
