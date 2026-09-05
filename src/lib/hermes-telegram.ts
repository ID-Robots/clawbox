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
//     config.yaml copy that held the PREVIOUS value. A token present there is
//     enough to enable the platform: the gateway's env pass turns Telegram on when
//     the token is set and no explicit `enabled: false` overrides it.
//   * `hermes gateway install/start/status` — the process that actually RECEIVES
//     messages. `hermes gateway setup` is the documented configure command but it
//     is a TTY wizard that takes no arguments, so it can never be called from a
//     route handler; the two writes it would make are the ones above.
//   * `hermes pairing list|approve|revoke|clear-pending` — the approval flow behind
//     ClawBox's request popup.
//
// Everything here goes through runHermesCli (argv only, never a shell).

import { execFile } from "child_process";
import fs from "fs/promises";
import path from "path";
import { promisify } from "util";
import { runHermesCli } from "@/lib/hermes-cli";
import { readHermesConfigTopLevelScalar } from "@/lib/hermes-config-yaml";
import { getHermesEnvValue } from "@/lib/hermes-env";
import { PAIRING_TOKEN_RE, normalizePairingToken } from "@/lib/telegram-pairing-token";

const execFileAsync = promisify(execFile);

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
 *
 * The store key IS the request id `hermes pairing approve` accepts. The code the
 * bot DM'd is only ever persisted as a salted hash, so it cannot be recovered
 * here — the request id is what the UI's Approve button has to carry.
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
 * any store file left behind. Best-effort throughout: each step is a separate
 * `hermes` process that may be missing or refuse, and the store-file removal
 * at the end is the backstop.
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

/** The env key Hermes' own `config set` routes to ~/.hermes/.env. */
const HERMES_TELEGRAM_TOKEN_KEY = "TELEGRAM_BOT_TOKEN";

/** What Hermes holds as its Telegram credential — and whether we could look. */
export interface HermesTelegramToken {
  /** Hermes' bot token, or null when it has none / could not be read. */
  token: string | null;
  /** False when ~/.hermes/.env could not be read, so `token` proves nothing. */
  known: boolean;
}

/**
 * ~/.hermes/.env's answer, tri-state like the whole of this reader.
 *
 * `value` is null ONLY when the key is absent from the file — an empty
 * `TELEGRAM_BOT_TOKEN=` comes back as `""`, because that is a key the bridge
 * puts in os.environ and the config.yaml pass then skips. Collapsing the two
 * would send the reader on to a config.yaml copy the gateway is not using and
 * report that bot as this box's.
 */
async function envToken(): Promise<{ value: string | null; known: boolean }> {
  try {
    return { value: await getHermesEnvValue(HERMES_TELEGRAM_TOKEN_KEY), known: true };
  } catch (err) {
    // An unreadable .env — EACCES after a root-owned write, EIO on a failing
    // eMMC, a directory where the file should be. Reporting "no bot" here is
    // what let the approvals guard wave through the harness's own bot, so the
    // caller gets `known: false` instead. Logged rather than swallowed: this is
    // a real fault, the routes above it answer a permanent 503, and without
    // this line the service log holds nothing to explain either. The MESSAGE
    // only: an fs error carries the path, and a rethrown reader error can carry
    // a window of the file it failed on.
    console.error(
      "[telegram] ~/.hermes/.env could not be read; Hermes' bot is unknown:",
      err instanceof Error ? err.message : err,
    );
    return { value: null, known: false };
  }
}

/**
 * The bot token Hermes itself would use.
 *
 * TWO FILES, IN HERMES' OWN ORDER. Hermes resolves a credential like this one
 * through its env bridge, not through one file: `gateway/run.py` loads
 * ~/.hermes/.env into the environment and then bridges every TOP-LEVEL scalar
 * in ~/.hermes/config.yaml for keys the environment does not already carry —
 * "Top-level simple values (fallback only — don't override .env)" — and
 * `hermes_cli/send_cmd.py`'s `_load_hermes_env` does the same two steps in the
 * same order (verified read-only against the installed 0.20.5 package). So
 * .env WINS, and config.yaml is a real fallback: a box whose bot was written
 * into config.yaml — a documented way to feed env-shaped keys to the harness —
 * polls a bot that a .env-only read reports as absent. That was this reader
 * answering `known: true` over half the question, which is exactly the
 * confident "no bot" the approvals guard fails open on.
 *
 * HARNESS GAP, stated rather than worked around: `hermes config get
 * TELEGRAM_BOT_TOKEN` is NOT that resolved answer. `get_config_value` routes an
 * env-shaped key to `get_env_value`, which reads os.environ and then .env and
 * never looks at config.yaml (hermes_cli/config.py) — so the CLI would answer
 * "not set" for precisely the box this reader exists for. There is no command
 * that resolves the pair, so ClawBox reads the same two files the harness's own
 * bridge reads, through the readers it already has for each.
 *
 * Tri-state, because "Hermes has no bot" and "we could not find out" are
 * different answers and only one of them may be acted on.
 */
export async function readHermesTelegramToken(): Promise<HermesTelegramToken> {
  // Sequential, not concurrent: .env DEFINING the key ends the question — that
  // is what the bridge puts in the environment, and config.yaml cannot override
  // it, empty value included. Reading the fallback anyway would spend a file
  // read on every panel poll for a value that is discarded — and log a
  // complaint about a config.yaml nothing was going to use.
  const env = await envToken();
  // An UNREADABLE .env ends the question too, and ends it as an unknown. It may
  // define the key — that is exactly what could not be established — so a
  // config.yaml value is not the answer either: the bridge would only reach it
  // for a key .env does not carry. Falling through returned that value with
  // `known: false` beside it, and both panel routes compute `configured: token
  // !== null` and `unknown: !known && token === null` — so a root-owned .env
  // holding bot B and an older config.yaml holding bot A reported A as this
  // box's bot, confidently, on /telegram/status, /telegram/pairing and the
  // wizard, while the gateway polled B.
  if (!env.known) return { token: null, known: false };
  if (env.value !== null) return { token: env.value || null, known: true };
  const yaml = await readHermesConfigTopLevelScalar(HERMES_TELEGRAM_TOKEN_KEY);
  return { token: yaml.value, known: yaml.known };
}

/**
 * Store the bot token where Hermes reads it (~/.hermes/.env) via
 * `hermes config set`, which also rotates a config.yaml copy holding the
 * PREVIOUS value, so the fallback the env bridge would reach for cannot name a
 * bot this box has replaced (hermes_cli/credential_lifecycle.py).
 */
export async function setHermesTelegramToken(botToken: string, signal?: AbortSignal): Promise<void> {
  const res = await runHermesCli(["config", "set", HERMES_TELEGRAM_TOKEN_KEY, botToken], {
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
  /**
   * Did Hermes actually ANSWER, or is this the "we could not ask" shape?
   *
   * `readHermesGatewayStatus` swallows a failed probe into
   * `{ installed: false, running: false }` — the right thing for a caller that
   * only wants to know whether it may start the gateway, and a lie for one
   * asking whether it is RUNNING. The flag was already computed here to pick
   * the 3 s failure TTL over the 15 s one and then dropped; it is carried out
   * now so a route can answer "could not say" instead of "not running", which
   * is what the channel rows draw their dot from.
   *
   * OPTIONAL, and read as `answered !== false`: a value built before this
   * field existed — a test fixture, a stored shape — is an answer, and only an
   * explicit `false` is not. Absence must not invent an unknown.
   */
  answered?: boolean;
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
  // Everything this parses is output Hermes actually produced, so it is always
  // an ANSWER. Only `readHermesGatewayStatus`'s catch makes an unanswered one.
  const verdict = stdout.match(SERVICE_VERDICT_RE);
  if (verdict) {
    return {
      installed: true,
      running: verdict[2].toLowerCase() === "running",
      scope: verdict[1].toLowerCase() === "system" ? "system" : "user",
      answered: true,
    };
  }
  // No service unit. A bare process may still be serving (`hermes gateway run`).
  return { installed: false, running: MANUAL_RUNNING_RE.test(stdout), scope: null, answered: true };
}

/**
 * `hermes gateway status`, parsed, and NEVER memoised. Reports "down" rather
 * than throwing — with ONE exception: a probe the caller CANCELLED is rethrown,
 * because "down" is an answer and a cancellation is not (see the catch below).
 *
 * `answered` is the difference between "the gateway says it is down" and "the
 * gateway could not be asked". Every caller that BRANCHES on the result — this
 * module's `ensureHermesGateway`, email's `stopHermesEmailPolling` — has to use
 * this reader and check that flag, because both of the answers the failure path
 * fabricates (`installed:false`, `running:false`) pick a wrong branch: one runs
 * a privileged install on a box that already has a gateway, the other reports
 * receiving as stopped on a box that is still polling. Callers that only
 * DISPLAY the status take the memoised `hermesGatewayStatus()` below.
 */
export async function readHermesGatewayStatus(
  signal?: AbortSignal,
): Promise<{ value: HermesGatewayStatus; answered: boolean }> {
  try {
    const res = await runHermesCli(["gateway", "status"], {
      timeoutMs: GATEWAY_TIMEOUT_MS,
      signal,
    });
    return { value: parseHermesGatewayStatus(res.stdout), answered: true };
  } catch (err) {
    // A CANCELLED probe is not an answer of "no gateway here". Swallowing it
    // hands `ensureHermesGateway` an `installed: false` for a box whose gateway
    // is fine, which sends it down the privileged INSTALL path. The caller
    // asked to stop; stop. (`runHermesCli` refuses a call whose signal is
    // already aborted before it spawns, so this covers both an abort that lands
    // mid-probe and one that landed before it started.)
    if (signal?.aborted) throw err;
    return { value: { installed: false, running: false, scope: null, answered: false }, answered: false };
  }
}

/**
 * ONE memo for `hermes gateway status`, shared by every caller.
 *
 * This is a Hermes CLI cold start (~2 s on a Jetson) and three separate status
 * routes ask for it — Telegram, WhatsApp and Discord — each of which used to
 * memoise the answer privately. Opening Settings → Channels asks all three at
 * once, so the box paid for the SAME command three times concurrently while
 * each route's own cache sat empty. The dedup belongs here, at the one place
 * that runs the command, not in three copies downstream.
 *
 * A failed probe is remembered too, but briefly: caching only successes means
 * the slower a wedged CLI gets, the more often the box re-enters it. Same
 * success/failure split as the channel-row memo in `openclaw-channels.ts`.
 */
const GATEWAY_STATUS_TTL_MS = 15_000;
const GATEWAY_STATUS_FAILURE_TTL_MS = 3_000;
let cachedGatewayStatus: { value: HermesGatewayStatus; at: number; answered: boolean } | null = null;
let inFlightGatewayStatus: { epoch: number; promise: Promise<HermesGatewayStatus> } | null = null;
/**
 * Invalidation count. A read that started before the last invalidation is
 * describing the process that the invalidation was called BECAUSE it changed,
 * so it may neither be joined nor stored — clearing the cache alone would let
 * an in-flight probe repopulate it with the pre-restart answer a moment later.
 * Same guard as the per-channel one in `openclaw-channels.ts`.
 */
let gatewayStatusEpoch = 0;

/**
 * Drop the remembered gateway status, including a read still in flight.
 *
 * Anything that restarts, installs or reconfigures the gateway must call this:
 * a memo that outlives the thing it describes is how a probe-once bug is born,
 * and this one would report the pre-restart process as the live one.
 */
export function invalidateHermesGatewayStatus(): void {
  cachedGatewayStatus = null;
  gatewayStatusEpoch += 1;
}

export async function hermesGatewayStatus(signal?: AbortSignal): Promise<HermesGatewayStatus> {
  // A caller that brought its own deadline gets its own probe: it cannot be
  // served a shared promise it has no way to abort, and the ensure/restart
  // paths need the truth as of now, not as of fifteen seconds ago.
  if (signal) return (await readHermesGatewayStatus(signal)).value;

  const epoch = gatewayStatusEpoch;
  const age = cachedGatewayStatus ? Date.now() - cachedGatewayStatus.at : Infinity;
  if (
    cachedGatewayStatus
    // `age >= 0` because the clock is wall-clock: an RTC corrected BACKWARDS by
    // NTP would otherwise pin the entry until the clock caught up.
    && age >= 0
    && age < (cachedGatewayStatus.answered ? GATEWAY_STATUS_TTL_MS : GATEWAY_STATUS_FAILURE_TTL_MS)
  ) {
    return cachedGatewayStatus.value;
  }
  // Join a read in flight, but only one started since the last invalidation.
  if (inFlightGatewayStatus && inFlightGatewayStatus.epoch === epoch) {
    return inFlightGatewayStatus.promise;
  }

  const promise = (async () => {
    const { value, answered } = await readHermesGatewayStatus();
    // An invalidation that landed while this was in flight means the answer
    // predates the change that caused it.
    if (gatewayStatusEpoch === epoch) {
      cachedGatewayStatus = { value, at: Date.now(), answered };
    }
    return value;
  })().finally(() => {
    // Only ever clear our OWN entry, or an abandoned read evicts the
    // replacement an invalidation started.
    if (inFlightGatewayStatus?.epoch === epoch) inFlightGatewayStatus = null;
  });
  inFlightGatewayStatus = { epoch, promise };
  return promise;
}

/** Unix user the gateway system service should run as. */
const GATEWAY_SERVICE_USER = process.env.CLAWBOX_USER || "clawbox";

/** The system unit `hermes gateway install --system` writes. */
const HERMES_GATEWAY_UNIT = "hermes-gateway.service";
const SYSTEMCTL_BIN = "/usr/bin/systemctl";

/**
 * What `ensureHermesGateway` observed, plus whether the change it tried to make
 * actually took.
 *
 * `running` alone is not an answer. The status probe runs `hermes gateway
 * status` UNPRIVILEGED, so after a restart that was refused it still sees the
 * OLD process — up, serving the PREVIOUS config — and reports `running: true`.
 * Callers that keyed on that answered `{ restarted: true }` for a restart that
 * never happened, and the user's new Telegram token silently did nothing.
 */
export interface HermesGatewayEnsureResult extends HermesGatewayStatus {
  /**
   * The restart (or first-time install) reported success. When false, the
   * process serving right now may still be the one from before the config
   * change, so the caller must degrade to "saved — applies on next restart"
   * rather than claiming the change is live.
   */
  applied: boolean;
}

/**
 * Restart the gateway's SYSTEM unit through systemctl.
 *
 * Not `sudo hermes gateway restart --system`: that execs
 * /home/clawbox/.local/bin/hermes, which the clawbox user owns and can rewrite,
 * so it is a file we must never hand passwordless root — and consequently one
 * that could not be allow-listed, which is why the restart silently failed on a
 * narrowed box. The unit is root-owned and runs `User=clawbox`, so restarting it
 * through systemctl grants nothing the clawbox user did not already have.
 *
 * `-n` so a box without the grant fails in milliseconds instead of waiting on a
 * password prompt no appliance can answer.
 *
 * Trade-off worth naming: the CLI's restart first attempts a SIGUSR1 graceful
 * drain of in-flight turns. systemd sends SIGTERM instead, which the unit
 * already handles (KillSignal=SIGTERM, KillMode=mixed, TimeoutStopSec). The CLI
 * falls back to the same forced `systemctl restart` whenever the drain does not
 * finish in budget, so this is the CLI's own fallback path, taken directly.
 */
async function restartHermesGatewayUnit(signal?: AbortSignal): Promise<boolean> {
  try {
    // argv[0] spelled as a literal, like every other privileged exec in the
    // tree: scripts/check-sudoers-coverage.sh can only resolve a call site whose
    // sudo binary is written out, and a grant it cannot see is a grant nobody
    // notices going stale.
    await execFileAsync("/usr/bin/sudo", ["-n", SYSTEMCTL_BIN, "restart", HERMES_GATEWAY_UNIT], {
      timeout: GATEWAY_TIMEOUT_MS,
      signal,
    });
    return true;
  } catch (err) {
    console.error("[hermes] gateway restart failed:", err);
    return false;
  }
}

/**
 * Restart a USER-scope gateway service. Stays on the CLI (systemctl --user from
 * a system service would be aimed at root's session bus, not clawbox's), and no
 * sudo is involved, so there is nothing to allow-list.
 *
 * The exit code is checked rather than assumed: runHermesCli RESOLVES on a
 * non-zero exit — it only rejects on spawn failure, timeout or abort — so an
 * unchecked `await` here reads as success for every kind of failure the CLI
 * reports properly.
 */
async function restartHermesGatewayUserService(signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await runHermesCli(["gateway", "restart"], {
      timeoutMs: GATEWAY_TIMEOUT_MS,
      signal,
    });
    if (res.code !== 0) {
      console.error(`[hermes] gateway restart exited ${res.code}: ${res.stderr || res.stdout}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[hermes] gateway restart failed:", err);
    return false;
  }
}

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
export async function ensureHermesGateway(signal?: AbortSignal): Promise<HermesGatewayEnsureResult> {
  // Uncached, always. Whether this installs or restarts turns on `before`, and
  // a fifteen-second-old answer picks the wrong branch — every caller reaches
  // this after its own durable write and so passes no signal, which is exactly
  // the branch of `hermesGatewayStatus` that serves the memo: a stale
  // `installed:false` would send it down the install path on a box where the
  // gateway is already installed.
  const { value: before, answered } = await readHermesGatewayStatus(signal);

  // A probe that FAILED is not an answer of "no gateway here" either. A
  // `hermes gateway status` that times out on a loaded Jetson, or a wedged CLI,
  // degrades to `{installed:false, running:false}` — the exact shape that sends
  // this function on to `sudo hermes gateway install --system` on a box that
  // already has a unit. Report "nothing applied" instead and let the caller
  // warn: the owner retries and the next probe usually answers, whereas a
  // spurious install rewrites a working unit.
  if (!answered) return { ...before, applied: false };

  if (before.installed) {
    // A system unit can only be controlled by root; a user unit must NOT be,
    // or systemctl --user would be aimed at root's session bus.
    const applied = before.scope === "system"
      ? await restartHermesGatewayUnit(signal)
      : await restartHermesGatewayUserService(signal);
    invalidateHermesGatewayStatus();
    return { ...(await hermesGatewayStatus(signal)), applied };
  }

  // A gateway running without a service unit is somebody's foreground
  // `hermes gateway run`. It is already receiving, and `gateway restart` would
  // fall through to running the next one in the FOREGROUND — which from a route
  // handler means blocking until the timeout kills it. Leave it alone.
  //
  // Nothing was applied here either: that process is still serving the config it
  // started with, so the caller must not claim the change is live.
  if (before.running) return { ...before, applied: false };

  // First-time provisioning only, and deliberately ungranted in sudoers: this
  // writes a unit into /etc/systemd/system, and the only way to allow-list it
  // would be a NOPASSWD grant on a clawbox-writable binary. `sudo -n` fails in
  // milliseconds on a narrowed box; the `applied` flag carries that outward
  // instead of it disappearing into a status probe.
  let applied = false;
  try {
    const res = await runHermesCli(
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
    applied = res.code === 0;
  } catch (err) {
    console.error("[hermes] gateway install failed:", err);
  }
  invalidateHermesGatewayStatus();
  return { ...(await hermesGatewayStatus(signal)), applied };
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
