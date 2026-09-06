export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { dismissSettledUpdate } from "@/lib/updater";
import { requireSession } from "@/lib/route-auth";

/**
 * POST — forget the settled update run the server is still holding.
 *
 * The update state is in memory, so a failure outlives the page that started
 * it and reaches every window opened afterwards. System Update renders such a
 * failure now (it used to show "1 update available" over a dead run); this is
 * what its Dismiss button calls, so dismissing survives a reload.
 *
 * 409 while a run is going: the state belongs to that run, and the page has no
 * business clearing it under one.
 */
export async function POST(request: Request) {
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;

  const dismissed = dismissSettledUpdate();
  return NextResponse.json(
    dismissed ? { dismissed: true } : { dismissed: false, error: "An update is in progress" },
    { status: dismissed ? 200 : 409 },
  );
}
