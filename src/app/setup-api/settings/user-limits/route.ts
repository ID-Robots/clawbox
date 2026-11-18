export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

import { recordAudit } from "@/lib/audit-log";
import { listUsers, userHomeDir } from "@/lib/clawbox-users";
import { readFailureKind } from "@/lib/config-store";
import { homeUsage } from "@/lib/home-usage";
import { readOrgMode } from "@/lib/org-mode-server";
import { personSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";
import { USER_LIMIT_FIELDS, USER_LIMIT_NAMES, defaultUserLimits, mbToBytes, userLimitsPatch, type UserLimits } from "@/lib/user-limits";
import { readUserLimits, writeUserLimits } from "@/lib/user-limits-server";

/**
 * /setup-api/settings/user-limits — the owner's limits for every other user
 * on the box (src/lib/user-limits.ts says what each one holds), and how full
 * each user's home folder is.
 *
 * OWNER ONLY, both ways: the answer lists every user's usage, and the limits
 * bind everyone but the owner. GET and POST from the owner's session; POST
 * from this ClawBox's own pages as well. Never the agent's MCP bearer: lifting
 * a limit is a person's decision, not a tool call.
 *
 * GET → `{ limits, defaults, max, orgMode, users: [{ username, usedBytes,
 * truncated, quotaBytes }] }`. `usedBytes` is null for a home this box cannot
 * read (on a home box a user's home stays closed to the web server until the
 * Files app first serves it on an organisation box).
 *
 * POST `{ uploadMaxMb?, homeQuotaMb?, chatPerMinute?, chatPerHour? }`: whole
 * numbers from 0 (no limit) to each field's maximum; the fields not named keep
 * their value. Answers the same body as GET.
 */

const NO_STORE = { "Cache-Control": "no-store" };

function refuse(status: number, code: string, error: string, extra: Record<string, unknown> = {}): NextResponse {
  return NextResponse.json({ error, code, ...extra }, { status, headers: NO_STORE });
}

/** How many homes are walked at once for the usage column. */
const USAGE_PARALLEL = 2;

async function usageOf(limits: UserLimits) {
  const users = await listUsers();
  const quotaBytes = mbToBytes(limits.homeQuotaMb);
  const out: Array<{ username: string; usedBytes: number | null; truncated: boolean; quotaBytes: number | null }> = [];
  for (let i = 0; i < users.length; i += USAGE_PARALLEL) {
    const batch = await Promise.all(
      users.slice(i, i + USAGE_PARALLEL).map(async (u) => {
        const home = await userHomeDir(u.username);
        const usage = home ? await homeUsage(home).catch(() => null) : null;
        return { username: u.username, usedBytes: usage?.bytes ?? null, truncated: usage?.truncated ?? false, quotaBytes };
      }),
    );
    out.push(...batch);
  }
  return out;
}

function maxima(): Record<string, number> {
  return Object.fromEntries(USER_LIMIT_NAMES.map((name) => [name, USER_LIMIT_FIELDS[name as keyof typeof USER_LIMIT_FIELDS].max]));
}

async function body(limits: UserLimits) {
  const [users, orgMode] = await Promise.all([usageOf(limits), readOrgMode()]);
  return { limits, defaults: defaultUserLimits(), max: maxima(), orgMode, users };
}

export async function GET(req: Request) {
  const who = await personSession(req);
  if (!who?.isOwner) return refuse(403, "owner_only", "Only the box owner can see the limits for other users.");
  return NextResponse.json(await body(await readUserLimits()), { headers: NO_STORE });
}

export async function POST(req: Request) {
  const who = await personSession(req);
  if (!who?.isOwner) {
    return refuse(403, "owner_only", "Only the box owner can change the limits for other users, from their own browser.");
  }
  if (!isSameOriginRequest(req)) {
    return refuse(403, "cross_origin", "The limits can only be changed from this ClawBox's own pages.");
  }

  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return refuse(400, "bad_body", "Invalid JSON.");
  }
  const verdict = userLimitsPatch(parsed);
  if (!verdict.ok) {
    if (verdict.field) {
      const max = USER_LIMIT_FIELDS[verdict.field as keyof typeof USER_LIMIT_FIELDS].max;
      return refuse(400, "bad_limit", `${verdict.field} must be a whole number from 0 (no limit) to ${max}.`, { field: verdict.field });
    }
    return refuse(400, "bad_body", `Name at least one of ${USER_LIMIT_NAMES.join(", ")}.`);
  }

  let limits: UserLimits;
  try {
    limits = await writeUserLimits(verdict.patch);
  } catch (err) {
    console.error("[user-limits] the limits could not be saved:", readFailureKind(err));
    return refuse(500, "store_write_failed", "The limits could not be saved — the ClawBox settings file could not be written. Nothing was changed.");
  }
  console.log(`[user-limits] the owner set the limits for other users: ${JSON.stringify(limits)}`);
  await recordAudit({ event: "user_limits", actor: who.username, detail: { ...limits } }, req);
  return NextResponse.json(await body(limits), { headers: NO_STORE });
}
