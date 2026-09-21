import { NextResponse } from "next/server";
import { requireSession } from "@/lib/route-auth";
import {
  ProfileUnavailableError,
  isPowerMode,
  readPowerMode,
  setPowerMode,
} from "@/lib/system-profile";
import { RESOURCE_LIMITS } from "@/lib/resource-limits";

export const dynamic = "force-dynamic";

/**
 * Settings → System → "Performance mode" (TASK-455).
 *
 * GET  → the current profile plus the memory guards in force, so the panel can
 *        state the numbers instead of the UI hardcoding a second copy of them.
 * POST { mode: "balanced" | "performance" } → applies immediately, no reboot.
 *
 * Owner-only, both verbs — same reasoning as the desktop route: pinning the
 * clocks is a thermal decision on a passively-cooled appliance, not something
 * an anonymous caller gets to make.
 */
export async function GET(req: Request) {
  const unauthorized = await requireSession(req);
  if (unauthorized) return unauthorized;
  return NextResponse.json({
    ...(await readPowerMode()),
    limits: RESOURCE_LIMITS,
  });
}

export async function POST(req: Request) {
  const unauthorized = await requireSession(req);
  if (unauthorized) return unauthorized;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const mode = (body as { mode?: unknown } | null)?.mode;
  if (!isPowerMode(mode)) {
    return NextResponse.json(
      { error: "Invalid body. Expected { mode: \"balanced\" | \"performance\" }." },
      { status: 400 },
    );
  }

  try {
    return NextResponse.json({ ...(await setPowerMode(mode)), limits: RESOURCE_LIMITS });
  } catch (err) {
    if (err instanceof ProfileUnavailableError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to change power profile" },
      { status: 500 },
    );
  }
}
