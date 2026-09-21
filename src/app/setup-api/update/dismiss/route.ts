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
 * business clearing it under one. 500 when the store would not take the write:
 * the record is still on disk and the next poll will raise the same failure
 * from it, so answering 200 there would be a dismissal that did not happen.
 */
export async function POST(request: Request) {
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;

  const outcome = await dismissSettledUpdate();
  const status = outcome.dismissed ? 200 : outcome.reason === "in-progress" ? 409 : 500;
  return NextResponse.json(outcome.dismissed ? { dismissed: true } : outcome, { status });
}
