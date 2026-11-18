/**
 * Limits for the people on a ClawBox who are not its owner (TASK-2446).
 *
 * The owner is the box's administrator and is never limited; neither is the
 * agent's own MCP bearer, which acts for the box. Every other signed-in
 * ClawBox user (src/lib/session-identity.ts) is held to four things the owner
 * sets in Settings → System → Users:
 *
 *   1. UPLOAD SIZE — one file uploaded to Files or attached in chat may be at
 *      most `uploadMaxMb` (default 100 MB). The chat's own 25 MB ceiling
 *      (CHAT_ATTACHMENT_MAX_BYTES) still applies to everyone; the lower of the
 *      two wins. A refused upload answers 413 `upload_too_large` and names
 *      the limit.
 *   2. HOME QUOTA — a user's own home folder may hold at most `homeQuotaMb`
 *      (default 10 GB). It is the folder an organisation box serves them as
 *      Files' Home (src/lib/files-scope.ts), so every write of theirs that
 *      lands there — an upload, a move in from Shared — is checked against
 *      what the folder already holds; past it the write answers 507
 *      `quota_exceeded`. Deleting is always allowed. The owner sees each
 *      user's usage beside the limits (src/lib/home-usage.ts).
 *   3. CHAT TURNS — at most `chatPerMinute` (default 20) and `chatPerHour`
 *      (default 300) turns a user starts, over sliding windows, on both
 *      runtimes: OpenClaw's user-chat relay (scripts/gateway-user-relay.js)
 *      and the Hermes chat route. A refused turn never reaches the model.
 *   4. THE AUDIT LOG of sign-ins and administrator actions is not a limit
 *      but rides with them: src/lib/audit-log.ts.
 *
 * 0 turns a limit off. A home box with nobody but its owner has nobody these
 * apply to, so the defaults change nothing there.
 *
 * The rules themselves are scripts/user-limits.js — one implementation that
 * production-server.js's relay requires as well — re-exported here.
 */

import {
  USER_LIMITS_KEY,
  USER_LIMIT_FIELDS,
  USER_LIMIT_NAMES,
  admitChatRequest,
  chatLimitSentence,
  defaultUserLimits,
  forgetChatRequests,
  mbToBytes,
  userLimitsFrom,
  userLimitsPatch,
} from "../../scripts/user-limits.js";
import { formatLimitBytes } from "@/lib/limit-bytes";

export { formatLimitBytes };
export {
  USER_LIMITS_KEY,
  USER_LIMIT_FIELDS,
  USER_LIMIT_NAMES,
  admitChatRequest,
  chatLimitSentence,
  defaultUserLimits,
  forgetChatRequests,
  mbToBytes,
  userLimitsFrom,
  userLimitsPatch,
};

export interface UserLimits {
  /** Largest file a user may upload or attach, in MB; 0 = no limit of ours. */
  uploadMaxMb: number;
  /** What a user's home folder may hold, in MB; 0 = no quota. */
  homeQuotaMb: number;
  /** Chat turns a user may start in any minute; 0 = no limit. */
  chatPerMinute: number;
  /** Chat turns a user may start in any hour; 0 = no limit. */
  chatPerHour: number;
}

export type ChatVerdict =
  | { ok: true }
  | { ok: false; window: "minute" | "hour"; limit: number; retryAfterSeconds: number };

/** The sentence a file over a user's upload limit is refused with. */
export function uploadTooLargeMessage(limitBytes: number): string {
  return `This file is larger than the ${formatLimitBytes(limitBytes)} upload limit for your account on this ClawBox.`;
}

/** The sentence a write past a user's home quota is refused with. */
export function quotaExceededMessage(usedBytes: number, quotaBytes: number): string {
  return `Your home folder is full: it holds ${formatLimitBytes(usedBytes)} of its ${formatLimitBytes(quotaBytes)} quota. Delete some files, or ask the owner of this ClawBox for more room.`;
}

/** The sentence a write into a home too large to measure within the walk's bounds is refused with. */
export function quotaUnmeasuredMessage(quotaBytes: number): string {
  return `Your home folder holds too many files to check against its ${formatLimitBytes(quotaBytes)} quota, so nothing more can be added to it. Delete some files, or ask the owner of this ClawBox for help.`;
}
