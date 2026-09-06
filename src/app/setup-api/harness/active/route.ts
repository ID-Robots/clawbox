export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getActiveHarness, getEdition, getEditionSource } from "@/lib/harness";

// Just the active harness — a config read, no health probes. The desktop chat
// polls this on mount to decide how to route; the full /harness/status (with
// liveness probes) is for the Settings picker that renders health dots.
//
// `edition` is a plain env read (getEdition) and therefore free. It lets
// edition-aware UI skip /harness/status, whose per-harness liveness probes cost
// ~500 ms of retry sleep on this hardware — long enough that the AI panel used
// to paint the OpenClaw provider list before learning it was a Hermes device.
//
// `editionKnown` says whether anything on this device actually NAMED an
// edition. Both fields above collapse "nobody said" into `readEditionSource()`'s
// own "openclaw" default — the safe way to be wrong for "which SKU is this",
// since openclaw is the non-premium one, and the wrong way round for anything
// that BRANDS the box: an unreadable lock (a truncated write, a permission
// change, a partial reflash) would then dress a Hermes device as a ClawBox. A
// caller that must not guess reads this flag and shows neither brand until it
// is true; see src/lib/builtin-wallpapers.ts.
export async function GET() {
  return NextResponse.json({
    active: await getActiveHarness(),
    edition: getEdition(),
    editionKnown: !getEditionSource().defaulted,
  });
}
