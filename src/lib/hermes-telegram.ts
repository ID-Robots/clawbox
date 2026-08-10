// Telegram on a Hermes device.
//
// The OpenClaw path (src/lib/openclaw-config.ts) writes ~/.openclaw/openclaw.json
// and restarts clawbox-gateway.service. A Hermes ClawBox has neither: the unit is
// masked and the gateway port is closed, so a token stored that way is never read
// by anything and the bot silently never answers.
//
// Hermes owns the same three jobs under its own commands:
//   * `hermes config set TELEGRAM_BOT_TOKEN <token>` — routes to ~/.hermes/.env
//     (the CLI's own env-key allowlist covers TELEGRAM_BOT_TOKEN) and rotates any
//     stale config.yaml mirror of the value. A token present there is enough to
//     enable the platform: the gateway's env pass turns Telegram on when the token
//     is set and no explicit `enabled: false` overrides it.
//   * `hermes gateway install/start/status` — the process that actually RECEIVES
//     messages. `hermes gateway setup` is the documented configure command but it
//     is a TTY wizard that takes no arguments, so it can never be called from a
//     route handler; the two writes it would make are the ones above.
//   * `hermes pairing list|approve|revoke|clear-pending` — the approval flow behind
//     ClawBox's request popup.
//
// Everything here goes through runHermesCli (argv only, never a shell).

import fs from "fs/promises";
import path from "path";
import { runHermesCli } from "@/lib/hermes-cli";
import { PAIRING_TOKEN_RE, normalizePairingToken } from "@/lib/telegram-pairing-token";

const PLATFORM = "telegram";

/** Hermes' data root. Matches HERMES_HOME resolution in the CLI. */
function hermesHome(): string {
  return process.env.HERMES_HOME || path.join(process.env.HOME || "/home/clawbox", ".hermes");
}

// Hermes keeps the pairing store at platforms/pairing/, but an install that
// predates that layout keeps using a non-empty legacy pairing/. Read both and
// let the newer location win per entry, which is what Hermes' own merge does.
function pairingDirs(): string[] {
  const home = hermesHome();
  return [path.join(home, "platforms", "pairing"), path.join(home, "pairing")];
}

// Measured on a Jetson ClawBox: `pairing list` ~0.8 s, `send --list` ~1.7 s,
// `gateway status` ~2 s. The timeouts are far above that on purpose — these are
// ceilings for a wedged CLI on a loaded box, not expectations, and `gateway
// install --start-now` waits for the service to come up.
const PAIRING_TIMEOUT_MS = 90_000;
const CONFIG_TIMEOUT_MS = 90_000;
const GATEWAY_TIMEOUT_MS = 180_000;
const SEND_TIMEOUT_MS = 90_000;

// Codes and their pending entries expire after an hour (gateway/pairing.py
// CODE_TTL_SECONDS). The CLI prunes on read; a direct file read has to filter
// itself or the popup would offer requests that can no longer be approved.
const PAIRING_TTL_MS = 60 * 60 * 1000;

export interface HermesPairingRequest {
  /** Token to pass back to POST /telegram/pairing — a Hermes request id here,
   *  named `code` because that is the field the popup and Settings list read. */
  code?: string;
  /** Telegram user id. Doubles as the DM chat id for the approval notice. */
  id?: string;
  name?: string;
  createdAt?: string;
}

export interface HermesApprovedUser {
  id: string;
  name?: string;
}

// ── Pairing store reads (no CLI — cheap enough for the 20 s desktop poll) ────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readPairingFile(basename: string): Promise<Record<string, unknown>> {
  const merged: Record<string, unknown> = {};
  // Reverse order: legacy first, so the current location overwrites it.
  for (const dir of [...pairingDirs()].reverse()) {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(path.join(dir, basename), "utf-8"));
      if (isRecord(parsed)) Object.assign(merged, parsed);
    } catch {
      // Missing/unreadable/corrupt store — treated as empty, same as Hermes does.
    }
  }
  return merged;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Pending Telegram access requests, read straight from Hermes' pairing store —
 * no CLI, so the desktop popup can poll it on a timer without spawning a
 * process every 20 s.
 * The store key IS the request id `hermes pairing approve` accepts; the code the
 * bot DM'd is stored only as a salted hash and can never be recovered here.
 */
export async function readHermesPairingRequests(now = Date.now()): Promise<HermesPairingRequest[]> {
  const pending = await readPairingFile(`${PLATFORM}-pending.json`);
  const out: HermesPairingRequest[] = [];
  for (const [requestId, raw] of Object.entries(pending)) {
    if (!isRecord(raw)) continue;
    const createdAt = typeof raw.created_at === "number" ? raw.created_at * 1000 : undefined;
    if (createdAt !== undefined && now - createdAt > PAIRING_TTL_MS) continue;
    // Pre-hash legacy entries have no approvable id; they only age out.
    if (typeof raw.hash !== "string" || typeof raw.salt !== "string") continue;
    out.push({
      code: requestId,
      id: optionalString(raw.user_id),
      name: optionalString(raw.user_name),
      createdAt: createdAt === undefined ? undefined : new Date(createdAt).toISOString(),
    });
  }
  return out;
}

/** Approved Telegram senders, read from the pairing store. */
export async function readHermesApprovedUsers(): Promise<HermesApprovedUser[]> {
  const approved = await readPairingFile(`${PLATFORM}-approved.json`);
  return Object.entries(approved).map(([id, raw]) => ({
    id,
    name: isRecord(raw) ? optionalString(raw.user_name) : undefined,
  }));
}

// ── `hermes pairing list` (authoritative; also prunes expired entries) ───────

export interface HermesPairingList {
  pending: HermesPairingRequest[];
  approved: HermesApprovedUser[];
}

// `hermes pairing list` has no --json (verified against the installed CLI), so
// its fixed-width table is the only machine surface. Columns are padded to
// 12/18/20/20, but a value wider than its column shifts the rest of the row and
// display names contain spaces — so neither column offsets nor a plain split
// is safe. Platform / request id / user id never contain whitespace, so the
// rows are read from the ends inward instead: fixed fields off the front, the
// age suffix off the back, and whatever is left is the name.
const PENDING_HEADER_RE = /^\s*Pending Pairing Requests\s*\(/;
const APPROVED_HEADER_RE = /^\s*Approved Users\s*\(/;
const AGE_SUFFIX_RE = /\s+(\d+)m ago$/;
const PLATFORM_TOKEN_RE = /^[a-z][a-z0-9_]*$/;

/** Parse the table printed by `hermes pairing list`. */
export function parseHermesPairingList(stdout: string): HermesPairingList {
  const pending: HermesPairingRequest[] = [];
  const approved: HermesApprovedUser[] = [];
  let section: "pending" | "approved" | null = null;

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trimEnd();
    if (PENDING_HEADER_RE.test(line)) {
      section = "pending";
      continue;
    }
    if (APPROVED_HEADER_RE.test(line)) {
      section = "approved";
      continue;
    }
    if (!section) continue;

    const trimmed = line.trim();
    if (!trimmed) continue;

    if (section === "pending") {
      // A data row always ends in "<n>m ago"; the column header, the dashed
      // rule and the trailing "Approve with: …" hints never do.
      const age = trimmed.match(AGE_SUFFIX_RE);
      if (!age) continue;
      const body = trimmed.slice(0, trimmed.length - age[0].length);
      const [platform, requestId, userId, ...nameParts] = body.split(/\s+/);
      if (!PLATFORM_TOKEN_RE.test(platform ?? "")) continue;
      if (platform !== PLATFORM) continue;
      pending.push({
        code: requestId && requestId !== "-" ? requestId : undefined,
        id: userId || undefined,
        name: nameParts.join(" ") || undefined,
        createdAt: new Date(Date.now() - Number(age[1]) * 60_000).toISOString(),
      });
      continue;
    }

    const [platform, userId, ...nameParts] = trimmed.split(/\s+/);
    // Skips "Platform  User ID  Name", the dashed rule ("--------"), and the
    // "No approved users." line — none start with a lowercase platform token.
    if (!PLATFORM_TOKEN_RE.test(platform ?? "")) continue;
    if (platform !== PLATFORM || !userId) continue;
    approved.push({ id: userId, name: nameParts.join(" ") || undefined });
  }

  return { pending, approved };
}

/** `hermes pairing list`, parsed. Throws only when the CLI cannot be run. */
export async function listHermesPairing(signal?: AbortSignal): Promise<HermesPairingList> {
  const res = await runHermesCli(["pairing", "list"], { timeoutMs: PAIRING_TIMEOUT_MS, signal });
  if (res.code !== 0) {
    throw new Error("hermes pairing list failed");
  }
  return parseHermesPairingList(res.stdout);
}

// ── Approve / revoke / reset ────────────────────────────────────────────────

/** Outcome of `hermes pairing approve`, parsed out of its success line. */
export interface HermesApprovalResult {
  userId?: string;
  userName?: string;
}

// "  Approved! User Ada Lovelace (12345) on telegram can now use the bot~"
const APPROVED_LINE_RE = /Approved!\s+User\s+(.+?)\s+on\s+\S+\s+can now use/;
const APPROVED_DISPLAY_RE = /^(.*?)\s*\((\d+)\)$/;

function parseApprovalResult(stdout: string): HermesApprovalResult | null {
  const match = stdout.match(APPROVED_LINE_RE);
  if (!match) return null;
  const display = match[1].trim();
  const withName = display.match(APPROVED_DISPLAY_RE);
  if (withName) return { userName: withName[1].trim() || undefined, userId: withName[2] };
  return { userId: display || undefined };
}

/**
 * Approve a pending request by its Hermes request id, or by the 8-char code the
 * bot DM'd if the requester relayed it — `hermes pairing approve` dispatches on
 * the shape and takes either.
 *
 * The CLI exits 0 whether or not the token matched, so success is read from the
 * output rather than the exit code.
 */
export async function approveHermesPairing(
  token: string,
  signal?: AbortSignal,
): Promise<HermesApprovalResult> {
  const normalized = normalizePairingToken(token);
  if (!PAIRING_TOKEN_RE.test(normalized)) {
    throw new Error("Invalid pairing code format");
  }
  const res = await runHermesCli(["pairing", "approve", PLATFORM, normalized], {
    timeoutMs: PAIRING_TIMEOUT_MS,
    signal,
  });
  const parsed = parseApprovalResult(res.stdout);
  if (!parsed) {
    if (/locked out/i.test(res.stdout)) {
      throw new Error("Approvals are locked for now after too many failed attempts.");
    }
    throw new Error("Pairing request not found or expired");
  }
  return parsed;
}

// A Telegram user id is a bare integer. Validated before it reaches argv so a
// value that could be read as a flag can never be passed as one.
const TELEGRAM_USER_ID_RE = /^-?\d{1,20}$/;

/** `hermes pairing revoke telegram <user_id>`. Resolves false when unknown. */
export async function revokeHermesPairing(userId: string, signal?: AbortSignal): Promise<boolean> {
  if (!TELEGRAM_USER_ID_RE.test(userId)) {
    throw new Error("Invalid Telegram user id");
  }
  const res = await runHermesCli(["pairing", "revoke", PLATFORM, userId], {
    timeoutMs: PAIRING_TIMEOUT_MS,
    signal,
  });
  return /Revoked access/i.test(res.stdout);
}

/** Cap on the revokes a single reset will run — each is its own CLI start-up. */
const MAX_RESET_REVOKES = 25;

/**
 * Wipe Telegram pairing state, for when the bot token changes: approvals belong
 * to the old bot. Revokes each approved sender (so Hermes also drops it from any
 * TELEGRAM_ALLOWED_USERS mirror it maintains), clears pending codes, then removes
 * any store file left behind. Best-effort throughout — the token is already saved
 * by the time this runs, so a failure must not fail the save.
 *
 * Note `hermes pairing clear-pending` takes no platform argument and clears every
 * platform's pending codes. On ClawBox Telegram is the only one configured.
 */
export async function clearHermesTelegramPairingState(): Promise<void> {
  let approved: HermesApprovedUser[] = [];
  try {
    approved = await readHermesApprovedUsers();
  } catch {
    approved = [];
  }
  // Sequential: each revoke is a read-modify-write of the same store file by a
  // separate process, and the store's lock is in-process only.
  for (const user of approved.slice(0, MAX_RESET_REVOKES)) {
    if (!TELEGRAM_USER_ID_RE.test(user.id)) continue;
    try {
      await revokeHermesPairing(user.id);
    } catch {
      // fall through to the file removal below
    }
  }
  try {
    await runHermesCli(["pairing", "clear-pending"], { timeoutMs: PAIRING_TIMEOUT_MS });
  } catch {
    // fall through to the file removal below
  }
  await Promise.all(
    pairingDirs().flatMap((dir) =>
      [`${PLATFORM}-pending.json`, `${PLATFORM}-approved.json`].map((name) =>
        fs.rm(path.join(dir, name), { force: true }).catch(() => {}),
      ),
    ),
  );
}

// ── Token + gateway service ─────────────────────────────────────────────────

/**
 * Store the bot token where Hermes reads it (~/.hermes/.env) via
 * `hermes config set`, which also clears a stale config.yaml copy that would
 * otherwise outrank it.
 */
export async function setHermesTelegramToken(botToken: string, signal?: AbortSignal): Promise<void> {
  const res = await runHermesCli(["config", "set", "TELEGRAM_BOT_TOKEN", botToken], {
    timeoutMs: CONFIG_TIMEOUT_MS,
    signal,
  });
  if (res.code !== 0) {
    throw new Error("Hermes rejected the bot token");
  }
}

/**
 * Whether Hermes itself considers Telegram a configured platform.
 *
 * `hermes send --list telegram --json` answers from the same
 * `load_gateway_config()` the gateway runs on, so it reports what the gateway
 * would actually do — unlike "ClawBox has a token in its own config store",
 * which is what the status route used to report and which was simply untrue on
 * a Hermes device.
 *
 * Tri-state on purpose. `false` means Hermes ran and reported no Telegram;
 * `null` means we could not ask it (CLI missing, timed out, output unparseable).
 * Collapsing the two would let a slow Jetson flash "not configured" at someone
 * whose bot is working fine.
 */
export async function hermesTelegramRegistered(signal?: AbortSignal): Promise<boolean | null> {
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

export interface HermesGatewayStatus {
  /** A service unit exists (so start/restart are safe to call). */
  installed: boolean;
  running: boolean;
  /** Which systemd scope holds the unit — a system unit needs root to control. */
  scope: "system" | "user" | null;
}

// `hermes gateway status` has no machine format either. Its three shapes:
//   * service installed → a systemctl block, then
//     "✓/✗ System|User gateway service is running|stopped"
//   * no service, but a gateway process → "✓ Gateway is running (PID: …)"
//   * neither → "✗ Gateway is not running" + a "To start:" hint block
// Note the third prints NO "not installed" line, so absence of a service has to
// be inferred from the absence of a service verdict, not from a phrase.
const SERVICE_VERDICT_RE = /(system|user) gateway service is (running|stopped)/i;
const MANUAL_RUNNING_RE = /✓[^\n]*Gateway is running/i;

/** Parse `hermes gateway status`. */
export function parseHermesGatewayStatus(stdout: string): HermesGatewayStatus {
  const verdict = stdout.match(SERVICE_VERDICT_RE);
  if (verdict) {
    return {
      installed: true,
      running: verdict[2].toLowerCase() === "running",
      scope: verdict[1].toLowerCase() === "system" ? "system" : "user",
    };
  }
  // No service unit. A bare process may still be serving (`hermes gateway run`).
  return { installed: false, running: MANUAL_RUNNING_RE.test(stdout), scope: null };
}

/** `hermes gateway status`, parsed. Reports "down" rather than throwing. */
export async function hermesGatewayStatus(signal?: AbortSignal): Promise<HermesGatewayStatus> {
  try {
    const res = await runHermesCli(["gateway", "status"], {
      timeoutMs: GATEWAY_TIMEOUT_MS,
      signal,
    });
    return parseHermesGatewayStatus(res.stdout);
  } catch {
    return { installed: false, running: false, scope: null };
  }
}

/** Unix user the gateway system service should run as. */
const GATEWAY_SERVICE_USER = process.env.CLAWBOX_USER || "clawbox";

/**
 * Make sure Hermes' messaging gateway is installed and running, so Telegram
 * messages are actually received.
 *
 * Installs a SYSTEM service rather than the no-sudo user service: ClawBox is a
 * headless appliance with no login session, where a user unit would need linger
 * and would stop at logout. `--run-as-user` keeps the agent running as the
 * ClawBox user, and Hermes resolves that user's home for HERMES_HOME itself, so
 * the unit is correct even though the install runs through sudo.
 */
export async function ensureHermesGateway(signal?: AbortSignal): Promise<HermesGatewayStatus> {
  const before = await hermesGatewayStatus(signal);

  if (before.installed) {
    // A system unit can only be controlled by root; a user unit must NOT be,
    // or systemctl --user would be aimed at root's session bus.
    const systemScope = before.scope === "system";
    await runHermesCli(["gateway", "restart", ...(systemScope ? ["--system"] : [])], {
      timeoutMs: GATEWAY_TIMEOUT_MS,
      signal,
      sudo: systemScope,
    });
    return hermesGatewayStatus(signal);
  }

  // A gateway running without a service unit is somebody's foreground
  // `hermes gateway run`. It is already receiving, and `gateway restart` would
  // fall through to running the next one in the FOREGROUND — which from a route
  // handler means blocking until the timeout kills it. Leave it alone.
  if (before.running) return before;

  await runHermesCli(
    [
      "gateway",
      "install",
      "--system",
      "--run-as-user",
      GATEWAY_SERVICE_USER,
      "--start-now",
      "--start-on-login",
    ],
    { timeoutMs: GATEWAY_TIMEOUT_MS, signal, sudo: true },
  );
  return hermesGatewayStatus(signal);
}

/**
 * Tell an approved sender they're in. Hermes' `pairing approve` has no
 * `--notify` (OpenClaw's does), but `hermes send` reuses the same bot token
 * without needing the gateway up, so the notice survives the gap.
 * Best-effort: never fails the approval.
 */
export async function notifyHermesTelegramUser(userId: string, message: string): Promise<boolean> {
  if (!TELEGRAM_USER_ID_RE.test(userId)) return false;
  try {
    const res = await runHermesCli(
      ["send", "--to", `${PLATFORM}:${userId}`, "--quiet", "--", message],
      { timeoutMs: SEND_TIMEOUT_MS },
    );
    return res.code === 0;
  } catch {
    return false;
  }
}
