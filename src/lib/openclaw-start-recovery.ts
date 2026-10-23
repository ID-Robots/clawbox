/**
 * What the gateway pre-start did about a gateway that would not start over one
 * of OpenClaw's databases — the notice `/setup-api/gateway/health` carries to
 * the owner.
 *
 * SERVER ONLY.
 *
 * WHY. One session row the core refused in the default agent's database kept a
 * box's gateway from starting, and `Restart=always` restarted it a dozen times
 * in eight minutes with nothing ever changing in between. The pre-start now
 * answers that loop itself (`start-guard` in scripts/openclaw-db-maintenance.py):
 * the core's own repair first, then the refused database's pre-update copy,
 * the refused one set aside and never deleted. Whatever it did changed the
 * owner's data, so it is said, not done silently.
 *
 * WHO WRITES IT. That helper, into `$CLAWBOX_ROOT/data/openclaw-start-guard.json`
 * (`notice`); this module only reads it, per call, like
 * `openclaw-migration-status.ts` reads its sibling.
 *
 * CHANNELS. The failed starts before a recovery trip the core's restart-loop
 * breaker, and the recovered start then holds channel auto-start back: chat in
 * the app works while the box's Telegram or Discord stays silent. The core
 * lifts it on its own once the gateway has run through the breaker's window;
 * the same helper's `breaker-watch` follows that after the start and records it
 * in the same file (`channels.state`). `channelsSuppressed` is true while that
 * says the core still holds channels back, so the owner is told.
 *
 * WHAT IT ANSWERS. `null` for anything that is not a notice worth showing: no
 * file, an unreadable or malformed one, an outcome it does not know, one older
 * than `START_RECOVERY_NOTICE_MS`, or a box whose active harness is Hermes. An
 * unknown `reason` is dropped to `null` rather than passed on: the page words
 * the notice from the outcome, and a reason it cannot word is no reason.
 */

import fs from "fs/promises";
import path from "@/lib/runtime-path";
import { getActiveHarness, type Harness } from "@/lib/harness";

export type OpenclawStartRecoveryOutcome =
  /** The core's own repair ran (`doctor --fix`, then `doctor --session-sqlite recover`). */
  | "repaired"
  /** The repair did not help, and the refused database's pre-update copy was put back. */
  | "restored"
  /** Neither got the gateway started, or there was nothing to put back; the guard stopped. */
  | "failed";

export type OpenclawStartRecoveryReason =
  | "repair-incomplete"
  | "no-backup"
  | "insufficient-disk"
  | "no-time"
  | "backup-unreadable"
  | "set-aside-failed"
  | "database-unknown"
  | "restore-did-not-help";

export interface OpenclawStartRecovery {
  outcome: OpenclawStartRecoveryOutcome;
  reason: OpenclawStartRecoveryReason | null;
  /** When the guard acted, ISO 8601. */
  at: string;
  /** The core's restart-loop breaker still holds channel auto-start back after the recovered start. */
  channelsSuppressed: boolean;
}

/** How long a notice is shown after the guard acted. */
export const START_RECOVERY_NOTICE_MS = 3 * 24 * 60 * 60 * 1000;

const OUTCOMES: ReadonlySet<string> = new Set<OpenclawStartRecoveryOutcome>(["repaired", "restored", "failed"]);
const REASONS: ReadonlySet<string> = new Set<OpenclawStartRecoveryReason>([
  "repair-incomplete",
  "no-backup",
  "insufficient-disk",
  "no-time",
  "backup-unreadable",
  "set-aside-failed",
  "database-unknown",
  "restore-did-not-help",
]);

/** Where the helper writes it, resolved the way `openclawMigrationStatusPath()` resolves its sibling. */
export function openclawStartGuardPath(): string {
  const root = process.env.CLAWBOX_ROOT
    || (process.env.NODE_ENV === "development" ? process.cwd() : "/home/clawbox/clawbox");
  return path.join(root, "data", "openclaw-start-guard.json");
}

/** The notice when there is one to show, otherwise null. */
export async function readOpenclawStartRecovery(now: number = Date.now()): Promise<OpenclawStartRecovery | null> {
  if ((await getActiveHarness().catch(() => "openclaw" as Harness)) === "hermes") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(openclawStartGuardPath(), "utf-8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const notice = (parsed as Record<string, unknown>).notice;
  if (!notice || typeof notice !== "object" || Array.isArray(notice)) return null;
  const raw = notice as Record<string, unknown>;
  if (typeof raw.outcome !== "string" || !OUTCOMES.has(raw.outcome)) return null;
  if (typeof raw.at !== "string") return null;
  const at = Date.parse(raw.at);
  if (!Number.isFinite(at) || now - at > START_RECOVERY_NOTICE_MS) return null;
  const channels = (parsed as Record<string, unknown>).channels;
  return {
    outcome: raw.outcome as OpenclawStartRecoveryOutcome,
    reason: typeof raw.reason === "string" && REASONS.has(raw.reason) ? (raw.reason as OpenclawStartRecoveryReason) : null,
    at: raw.at,
    channelsSuppressed: !!channels && typeof channels === "object" && !Array.isArray(channels)
      && (channels as Record<string, unknown>).state === "suppressed",
  };
}
