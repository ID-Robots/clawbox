import { NextResponse } from "next/server";
import { requireSession } from "@/lib/route-auth";
import {
  ProfileUnavailableError,
  readDesktopMode,
  setDesktopMode,
} from "@/lib/system-profile";

export const dynamic = "force-dynamic";

/**
 * Settings → System → "Desktop environment" (TASK-455).
 *
 * GET  → the current state (see DesktopModeStatus).
 * POST { enabled: boolean } → flip the boot target; applies at the next reboot.
 *
 * Owner-only, both verbs, with NO bootstrap carve-out. The wizard never calls
 * this, so there is no first-boot window to keep open — and a device whose
 * desktop anyone in radio range of the setup AP could switch off is a device
 * anyone in radio range can take the console away from. TASK-443's rule.
 */
export async function GET(req: Request) {
  const unauthorized = await requireSession(req);
  if (unauthorized) return unauthorized;
  return NextResponse.json(await readDesktopMode());
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

  const enabled = (body as { enabled?: unknown } | null)?.enabled;
  if (typeof enabled !== "boolean") {
    return NextResponse.json(
      { error: "Invalid body. Expected { enabled: boolean }." },
      { status: 400 },
    );
  }

  try {
    return NextResponse.json(await setDesktopMode(enabled));
  } catch (err) {
    // A box whose root-owned script was never installed is a configuration
    // problem, not a server fault — say so with a 503 and the command that
    // fixes it, rather than a 500 the UI can only render as "something broke".
    if (err instanceof ProfileUnavailableError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to change desktop mode" },
      { status: 500 },
    );
  }
}
