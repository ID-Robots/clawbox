// The guided channels (Slack, …) on a Hermes device.
//
// Hermes owns each job under its own commands, so ClawBox only calls them:
//   * `hermes config set <KEY> <value>` — a channel credential. Hermes routes
//     SLACK_* (its env-key allowlist) and every *_TOKEN / *_SECRET key to
//     ~/.hermes/.env itself, and rotates a config.yaml copy of the previous
//     value. Keys that fail that routing test go through hermes-env.ts instead
//     (see the note there).
//   * `hermes send --list <platform> --json` — does Hermes consider the
//     platform configured at all.
//   * `hermes pairing approve <platform> <code>` — admit one sender. Hermes'
//     default `unauthorized_dm_behavior: pair` answers an unknown DM with a
//     one-time code, so approving it is the whole access step; ClawBox never
//     sets an *_ALLOW_ALL_USERS switch.
//   * `hermes gateway …` — restarting the process that receives messages, via
//     the Telegram module's ensureHermesGateway (re-exported below).
//
// Everything goes through runHermesCli (argv only, never a shell).

import { runHermesCli } from "@/lib/hermes-cli";
import { PAIRING_TOKEN_RE, normalizePairingToken } from "@/lib/telegram-pairing-token";

export { ensureHermesGateway, hermesGatewayStatus } from "@/lib/hermes-telegram";
export { readHermesGatewaySnapshot, type HermesGatewaySnapshot } from "@/lib/hermes-discord";

// Same ceilings as the Telegram and Discord modules: measured CLI calls take a
// second or two on a Jetson; these are for a wedged CLI on a loaded box.
const CONFIG_TIMEOUT_MS = 90_000;
const SEND_TIMEOUT_MS = 90_000;
const PAIRING_TIMEOUT_MS = 90_000;

/** Hermes' platform ids for the guided channels (its gateway's own names). */
export type HermesGuidedPlatform = "slack" | "signal" | "teams";
const GUIDED_PLATFORMS: ReadonlySet<string> = new Set<HermesGuidedPlatform>(["slack", "signal", "teams"]);

function assertGuidedPlatform(platform: string): asserts platform is HermesGuidedPlatform {
  // The platform becomes an argv element; only the fixed set may.
  if (!GUIDED_PLATFORMS.has(platform)) throw new Error("Unsupported Hermes platform");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Store channel credentials with `hermes config set`, one key at a time.
 *
 * Only keys Hermes itself routes to .env belong here (see the header); the
 * caller passes module constants as keys and values it has already checked
 * against a safe charset, so no value can be read as a flag. The error never
 * carries the value — the CLI's stderr can quote what it was handed.
 */
export async function setHermesChannelSecrets(values: Record<string, string>): Promise<void> {
  for (const [key, value] of Object.entries(values)) {
    const res = await runHermesCli(["config", "set", key, value], { timeoutMs: CONFIG_TIMEOUT_MS });
    if (res.code !== 0) throw new Error(`Hermes rejected ${key}`);
  }
}

/**
 * Whether Hermes itself considers `platform` configured.
 *
 * Tri-state, like hermesDiscordRegistered: `false` means Hermes answered and
 * reported no such platform, `null` means it could not be asked (CLI missing,
 * timed out, unparseable output) — collapsing the two would flash "not
 * configured" at someone whose bot works.
 */
export async function hermesPlatformRegistered(platform: string): Promise<boolean | null> {
  assertGuidedPlatform(platform);
  let res;
  try {
    res = await runHermesCli(["send", "--list", platform, "--json"], { timeoutMs: SEND_TIMEOUT_MS });
  } catch {
    return null;
  }
  // Exit 1 with the "no targets found for platform" notice is a real "no".
  if (res.code !== 0) return false;
  try {
    const parsed: unknown = JSON.parse(res.stdout);
    if (!isRecord(parsed) || !isRecord(parsed.platforms)) return null;
    return platform in parsed.platforms;
  } catch {
    return null;
  }
}

/** Who `hermes pairing approve` admitted, read from its success line. */
export interface HermesChannelApproval {
  userId?: string;
  userName?: string;
}

// "  Approved! User Ada Lovelace (U01ABC2DEF3) on slack can now use the bot~"
const APPROVED_LINE_RE = /Approved!\s+User\s+(.+?)\s+on\s+\S+\s+can now use/;
const APPROVED_DISPLAY_RE = /^(.*?)\s*\(([^()\s]+)\)$/;

export function parseHermesApproval(stdout: string): HermesChannelApproval | null {
  const match = stdout.match(APPROVED_LINE_RE);
  if (!match) return null;
  const display = match[1].trim();
  const withName = display.match(APPROVED_DISPLAY_RE);
  if (withName) return { userName: withName[1].trim() || undefined, userId: withName[2] };
  return { userId: display || undefined };
}

/**
 * Approve one pending sender on `platform`, by the code the bot DM'd them or
 * by Hermes' request id.
 *
 * The CLI exits 0 whether or not the token matched, so success is read from
 * its output, exactly as approveHermesPairing does for Telegram.
 */
export async function approveHermesChannelPairing(
  platform: string,
  token: string,
): Promise<HermesChannelApproval> {
  assertGuidedPlatform(platform);
  const normalized = normalizePairingToken(token);
  if (!PAIRING_TOKEN_RE.test(normalized)) throw new Error("Invalid pairing code format");
  const res = await runHermesCli(["pairing", "approve", platform, normalized], {
    timeoutMs: PAIRING_TIMEOUT_MS,
  });
  const parsed = parseHermesApproval(res.stdout);
  if (!parsed) {
    if (/locked out/i.test(res.stdout)) {
      throw new Error("Approvals are locked for now after too many failed attempts.");
    }
    throw new Error("Pairing request not found or expired");
  }
  return parsed;
}
