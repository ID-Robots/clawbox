export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import {
  activateKioskTab,
  closeKioskTab,
  listKioskTabs,
  openKioskTab,
  type KioskAction,
} from "@/lib/kiosk-tabs";
import { hasOwnerSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";

/**
 * GET  /setup-api/kiosk/tabs                     → { available, tabs }
 * POST /setup-api/kiosk/tabs { action: "open", url }
 * POST /setup-api/kiosk/tabs { action: "activate", id }
 * POST /setup-api/kiosk/tabs { action: "close", id }
 *
 * The desktop taskbar's view of the kiosk Chrome's tabs (see
 * src/lib/kiosk-tabs.ts for why). On a box with no kiosk the GET answers
 * `{ available: false, tabs: [] }` with a 200 and the POSTs answer the same
 * shape with a 503 — not an error, and never a CDP call: a box with no
 * kiosk.env (every Jetson) does not dial the port at all.
 *
 * The POSTs are the OWNER's (cookie, never the MCP bearer) and OUR PAGE's
 * (same origin): they steer the browser on the owner's screen, and a cross-site
 * POST riding the cookie could open any page on it or close the desktop tab.
 * The GET is left to middleware's gate — it names the pages open on the
 * screen, which the agent may read as it may read the screen itself.
 *
 * Every refusal carries a stable `code` beside its English `error`.
 */

const NO_STORE = { "Cache-Control": "no-store" };
const ACTIONS = ["open", "activate", "close"] as const;
type Action = (typeof ACTIONS)[number];

function refuse(error: string, code: string, status: number) {
  return NextResponse.json({ error, code }, { status, headers: NO_STORE });
}

function answer(result: KioskAction) {
  if (!result.available) {
    return NextResponse.json({ available: false, ok: false }, { status: 503, headers: NO_STORE });
  }
  if (!result.ok) {
    const status = result.code === "not_found" ? 404 : result.code.startsWith("invalid") ? 400 : 502;
    return NextResponse.json({ available: true, ok: false, error: result.error, code: result.code }, { status, headers: NO_STORE });
  }
  return NextResponse.json({ available: true, ok: true }, { headers: NO_STORE });
}

export async function GET() {
  const list = await listKioskTabs();
  return NextResponse.json(list, { headers: NO_STORE });
}

export async function POST(req: Request) {
  if (!(await hasOwnerSession(req))) {
    return refuse("Only the owner's own session may steer the kiosk browser", "owner_only", 403);
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

  // Selected OUT OF the literal array, never the body's own string (the
  // js/log-injection barrier tts/route.ts documents).
  const action: Action | undefined = ACTIONS.find((a) => a === body.action);
  if (!action) return refuse("Unknown action", "invalid_action", 400);

  if (action === "open") {
    if (typeof body.url !== "string" || !body.url) return refuse("Missing url", "invalid_url", 400);
    return answer(await openKioskTab(body.url));
  }

  if (typeof body.id !== "string" || !body.id) return refuse("Missing tab id", "invalid_id", 400);
  return answer(action === "activate" ? await activateKioskTab(body.id) : await closeKioskTab(body.id));
}
