export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getActiveHarnessSource, getEdition } from "@/lib/harness";

// Just the active harness — a config read, no health probes. The desktop chat
// polls this on mount to decide how to route; the full /harness/status (with
// liveness probes) is for the Settings picker that renders health dots.
//
// `edition` is a plain env read (getEdition) and therefore free. It lets
// edition-aware UI skip /harness/status, whose per-harness liveness probes cost
// ~500 ms of retry sleep on this hardware — long enough that the AI panel used
// to paint the OpenClaw provider list before learning it was a Hermes device.
//
// `activeKnown` says whether `active` is a FACT or this device's own default.
// Both fields above collapse "nobody could answer" into "openclaw" — the safe
// way to be wrong for "which SKU is this", since openclaw is the non-premium
// one, and the wrong way round for anything that BRANDS the box: an unreadable
// edition lock, or an unreadable config store on the one SKU whose harness is a
// runtime choice, would then dress a Hermes device as a ClawBox. A caller that
// must not guess reads this flag and shows neither brand until it is true; see
// src/lib/builtin-wallpapers.ts. `getActiveHarnessSource` owns the distinction,
// so no surface re-derives it.
export async function GET() {
  const { active, defaulted } = await getActiveHarnessSource();
  return NextResponse.json({ active, edition: getEdition(), activeKnown: !defaulted });
}
