import { NextResponse } from "next/server";
import { readBattery, type BatteryStatus } from "@/lib/battery";
import { requireSession } from "@/lib/route-auth";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The desktop tray's battery indicator: GET → `BatteryStatus` from
 * `@/lib/battery`, exactly as `readBattery()` returns it.
 *
 * Owner-only, with no bootstrap carve-out and no non-owner scope: the tray
 * belongs to the owner's desktop, and nothing in the wizard asks for it.
 *
 * Every box polls this — Jetsons and battery-less desktops included — so a
 * box with no battery, and anything that goes wrong reading one, is a 200
 * `{ available: false }`, never a 500 the tray would have to explain. The
 * read is a handful of sysfs files: no child process, and no cache, so a
 * charger plugged in shows on the next poll.
 */
export async function GET(req: Request) {
  const unauthorized = await requireSession(req);
  if (unauthorized) return unauthorized;

  let status: BatteryStatus;
  try {
    status = await readBattery();
  } catch {
    status = { available: false };
  }
  return NextResponse.json(status, { headers: NO_STORE });
}
