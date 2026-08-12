export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getActiveHarness, getEdition } from "@/lib/harness";

// Just the active harness — a config read, no health probes. The desktop chat
// polls this on mount to decide how to route; the full /harness/status (with
// liveness probes) is for the Settings picker that renders health dots.
//
// `edition` is a plain env read (getEdition) and therefore free. It lets
// edition-aware UI skip /harness/status, whose per-harness liveness probes cost
// ~500 ms of retry sleep on this hardware — long enough that the AI panel used
// to paint the OpenClaw provider list before learning it was a Hermes device.
export async function GET() {
  return NextResponse.json({ active: await getActiveHarness(), edition: getEdition() });
}
