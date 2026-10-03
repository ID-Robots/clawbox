export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { requireSession } from "@/lib/route-auth";
import { hasOwnerSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";
import { readMonitorOutputs } from "@/lib/monitors";
import { BrightnessError, readBrightness, setBrightness } from "@/lib/monitor-brightness";

/**
 * GET  /setup-api/monitors/brightness                  → { monitors: { [id]: { value, max } } }
 * POST /setup-api/monitors/brightness { monitor, value } → { value, max }
 *
 * Monitor brightness over DDC/CI (src/lib/monitor-brightness.ts), for the
 * Settings → Monitors tab only — the desktop's 5-second poll of
 * /setup-api/monitors never pays for it. A monitor that cannot be dimmed from
 * here is absent from the GET; a box with no monitor session answers an empty
 * map. The POST is the owner's own page, like every other monitor write.
 */

const NO_STORE = { "Cache-Control": "no-store" };

function refuse(error: string, code: string, status: number) {
  return NextResponse.json({ error, code }, { status, headers: NO_STORE });
}

export async function GET(req: Request) {
  const unauthorized = await requireSession(req);
  if (unauthorized) return unauthorized;
  const outputs = (await readMonitorOutputs())?.filter((o) => o.enabled) ?? [];
  const monitors = outputs.length ? await readBrightness(outputs) : {};
  return NextResponse.json({ monitors }, { headers: NO_STORE });
}

export async function POST(req: Request) {
  if (!(await hasOwnerSession(req))) {
    return refuse("Only the owner's own session may change the monitors", "owner_only", 403);
  }
  if (!isSameOriginRequest(req)) {
    return refuse("This request did not come from the ClawBox page", "cross_origin", 403);
  }
  let body: { monitor?: unknown; value?: unknown };
  try {
    body = (await req.json()) as { monitor?: unknown; value?: unknown };
  } catch {
    return refuse("Invalid JSON body", "invalid_body", 400);
  }
  if (!body || typeof body !== "object" || typeof body.monitor !== "string" || typeof body.value !== "number") {
    return refuse("Name a monitor and a brightness", "invalid_body", 400);
  }
  const outputs = await readMonitorOutputs();
  if (!outputs) return refuse("No monitor session is running", "unavailable", 503);
  const output = outputs.find((o) => o.id === body.monitor && o.enabled);
  if (!output) return refuse("That monitor is not connected", "unknown_monitor", 404);
  try {
    const result = await setBrightness(output, body.value, outputs.filter((o) => o.enabled).map((o) => o.name));
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (err) {
    if (err instanceof BrightnessError) {
      return refuse(err.message, err.code, err.code === "write_failed" ? 502 : err.code === "unsupported" ? 409 : 400);
    }
    return refuse("The brightness could not be changed", "write_failed", 500);
  }
}
