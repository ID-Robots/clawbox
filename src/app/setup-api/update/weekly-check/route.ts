// /setup-api/update/weekly-check — the owner's switch for the weekly update
// check (TASK-2260), shown in Settings → Update.
//
//   GET                       -> WeeklyUpdateCheckInfo
//   POST { enabled: boolean } -> WeeklyUpdateCheckInfo     (owner only)
//
// ON by default. Turning it off does not disarm the timer: the slot fires,
// reads the switch and records the week as skipped (update-notice-scheduler.ts
// says why). The POST is the OWNER's — not another ClawBox user's, and not the
// agent's bearer: the notice is how the owner hears that his box is behind —
// and from this box's own pages only (same-origin), never a cross-site form.

import { NextResponse } from "next/server";
import { requireSession } from "@/lib/route-auth";
import { isSameOriginRequest } from "@/lib/same-origin";
import {
  isWeeklyUpdateCheckEnabled,
  readUpdateNoticeState,
  setWeeklyUpdateCheckEnabled,
} from "@/lib/update-notice";
import { nextRunAtMs, refresh } from "@/lib/update-notice-scheduler";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

// Module-private: a route file exports handlers and route config only. The
// card (src/components/WeeklyUpdateCheckCard.tsx) restates the shape it reads.
interface WeeklyUpdateCheckInfo {
  enabled: boolean;
  /** When the box next looks, unix ms; null while off or not armed. */
  nextCheckAt: number | null;
  /** The last version the owner was told about, for people, and when and how. */
  lastNotified: { version: string; at: number; via: "telegram" | "desktop" | null } | null;
}

async function info(): Promise<WeeklyUpdateCheckInfo> {
  const [enabled, state] = await Promise.all([isWeeklyUpdateCheckEnabled(), readUpdateNoticeState()]);
  const next = nextRunAtMs();
  return {
    enabled,
    nextCheckAt: enabled && next > 0 ? next : null,
    lastNotified: state.lastNotifiedVersion && state.lastNotifiedAt
      ? { version: state.lastNotifiedVersion, at: state.lastNotifiedAt, via: state.lastNotifiedVia }
      : null,
  };
}

export async function GET(request: Request) {
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;
  try {
    return NextResponse.json(await info(), { headers: NO_STORE });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not read the weekly check" },
      { status: 500, headers: NO_STORE },
    );
  }
}

export async function POST(request: Request) {
  const refused = await requireSession(request, { ownerOnly: true });
  if (refused) return refused;
  // The owner's cookie rides along on a request from any page he visits,
  // including another app on this box's own host at a different port; a
  // text/plain POST needs no preflight. Only this ClawBox's own pages may
  // switch his notice off.
  if (!isSameOriginRequest(request)) {
    return NextResponse.json(
      { error: "The weekly update check can only be changed from this ClawBox's own pages.", code: "cross_origin" },
      { status: 403 },
    );
  }
  let enabled: unknown;
  try {
    ({ enabled } = await request.json());
  } catch {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 });
  }
  if (typeof enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be true or false" }, { status: 400 });
  }
  try {
    await setWeeklyUpdateCheckEnabled(enabled);
    await refresh().catch((err) =>
      console.warn("[update/weekly-check] could not re-arm the weekly check:", err instanceof Error ? err.message : err));
    return NextResponse.json(await info(), { headers: NO_STORE });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not save the weekly check" },
      { status: 500, headers: NO_STORE },
    );
  }
}
