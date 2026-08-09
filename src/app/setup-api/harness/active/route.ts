export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getActiveHarness } from "@/lib/harness";

// Just the active harness — a config read, no health probes. The desktop chat
// polls this on mount to decide how to route; the full /harness/status (with
// liveness probes) is for the Settings picker that renders health dots.
export async function GET() {
  return NextResponse.json({ active: await getActiveHarness() });
}
