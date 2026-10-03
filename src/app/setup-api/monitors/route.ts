export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { requireSession } from "@/lib/route-auth";
import { hasOwnerSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";
import {
  MonitorError,
  applyMonitorLayout,
  desktopViewOf,
  getMonitorStatus,
  keepMonitorLayout,
  readMonitorOutputs,
  revertMonitorLayout,
} from "@/lib/monitors";
import { readLayoutRequest } from "@/lib/monitors-layout";

/**
 * GET  /setup-api/monitors                              → MonitorStatus
 * POST /setup-api/monitors { action: "apply", layout }  → MonitorStatus, the layout ON TRIAL
 * POST /setup-api/monitors { action: "keep" }           → MonitorStatus, the trial layout saved
 * POST /setup-api/monitors { action: "revert" }         → MonitorStatus, the trial undone
 *
 * Monitor mode's Settings tab (src/lib/monitors.ts). The GET is the desktop's
 * too — it lays its shelf and windows out over the monitors it describes — and
 * answers `{ available: false }` with a 200 on a box with no monitor session,
 * which is every box without a kiosk: there it runs nothing at all. Another
 * ClawBox user signed in on the monitor-mode window gets it as well, cut down
 * to what a desktop lays itself out with (`desktopViewOf`); middleware has to
 * admit that read (src/lib/non-owner-scope.ts).
 *
 * The POSTs are the OWNER's (cookie, never the MCP bearer) and OUR PAGE's
 * (same origin): they change what the owner's screens show, and a cross-site
 * POST riding the cookie could switch every monitor off. An applied layout is
 * undone on its own unless Keep arrives — a resolution a monitor cannot show
 * must not strand the owner in front of a black screen.
 *
 * Every refusal carries a stable `code` beside its English `error`: an Apply
 * the compositor refused is `apply_failed`, a Keep that could not be saved
 * `save_failed` (the layout stays on trial and still comes undone on its own),
 * an undo the compositor did not take `revert_failed` (it is tried again, a
 * few times), and an Apply whose wlr-randr ran out of time `apply_uncertain`
 * (the layout may be on screen, on trial — the panel reads the box again).
 */

const NO_STORE = { "Cache-Control": "no-store" };
const ACTIONS = ["apply", "keep", "revert"] as const;
type Action = (typeof ACTIONS)[number];

function refuse(error: string, code: string, status: number) {
  return NextResponse.json({ error, code }, { status, headers: NO_STORE });
}

/** What a POST that failed for no reason of its own is called, per action. */
const FAILED: Record<Action, string> = { apply: "apply_failed", keep: "save_failed", revert: "revert_failed" };

export async function GET(req: Request) {
  const unauthorized = await requireSession(req, { allowNonOwner: true });
  if (unauthorized) return unauthorized;
  const status = await getMonitorStatus();
  // The owner (and the device's own bearer) get everything; anyone else only
  // the geometry of the monitors in front of them.
  const whole = (await requireSession(req)) === null;
  return NextResponse.json(whole ? status : desktopViewOf(status), { headers: NO_STORE });
}

export async function POST(req: Request) {
  if (!(await hasOwnerSession(req))) {
    return refuse("Only the owner's own session may change the monitors", "owner_only", 403);
  }
  if (!isSameOriginRequest(req)) {
    return refuse("This request did not come from the ClawBox page", "cross_origin", 403);
  }
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return refuse("Invalid JSON body", "invalid_body", 400);
  }
  if (!body || typeof body !== "object") return refuse("Invalid JSON body", "invalid_body", 400);
  const action: Action | undefined = ACTIONS.find((a) => a === body.action);
  if (!action) return refuse("Unknown action", "invalid_action", 400);

  try {
    if (action === "keep") return NextResponse.json(await keepMonitorLayout(), { headers: NO_STORE });
    if (action === "revert") return NextResponse.json(await revertMonitorLayout(), { headers: NO_STORE });

    // The request is held to the monitors connected NOW: ids, modes and the
    // rest are rebuilt from the compositor's own lists, never passed through.
    const outputs = await readMonitorOutputs();
    if (!outputs) return refuse("No monitor session is running", "unavailable", 503);
    const read = readLayoutRequest(body.layout, outputs);
    if (!read.ok) return refuse("That monitor layout cannot be applied", read.code, 400);
    return NextResponse.json(await applyMonitorLayout(read.layout), { headers: NO_STORE });
  } catch (err) {
    if (err instanceof MonitorError) {
      const status =
        err.code === "unavailable" ? 503 : err.code === "nothing_pending" ? 409 : err.code === "save_failed" ? 500 : 502;
      return refuse(err.message, err.code, status);
    }
    // Never the raw error: it can carry a path on the box.
    console.warn(`[monitors] ${action} failed:`, err instanceof Error ? err.message : err);
    return refuse("Could not change the monitors", FAILED[action], 500);
  }
}
