import { NextResponse } from "next/server";
import { hasPersonSession } from "@/lib/owner-session";
import { isApprovalAction, pendingPowerApproval, PowerApprovalConflict, resolvePowerApproval } from "@/lib/power-approval";
import { isSameOriginRequest } from "@/lib/same-origin";

export const dynamic = "force-dynamic";
const forbidden = () => NextResponse.json({ error: "Only the owner can confirm power requests" }, { status: 403 });

export async function GET(req: Request) {
  if (!(await hasPersonSession(req))) return forbidden();
  const prompt = pendingPowerApproval();
  return NextResponse.json({ pending: prompt ? {
    id: prompt.id, action: prompt.action, reason: prompt.reason, expiresAt: prompt.expiresAt,
  } : null }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  if (!isSameOriginRequest(req)) {
    return NextResponse.json({ error: "This can only be done from this ClawBox's own pages.", code: "cross_origin" }, { status: 403 });
  }
  if (!(await hasPersonSession(req))) return forbidden();
  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid body" }, { status: 400 }); }
  if (!body || typeof body.id !== "string" || !isApprovalAction(body.action) || typeof body.approve !== "boolean") {
    return NextResponse.json({ error: "Invalid confirmation" }, { status: 400 });
  }
  try {
    const applied = await resolvePowerApproval(body.id, body.action, body.approve);
    return NextResponse.json({ applied }, { status: applied ? 200 : 409 });
  } catch (err) {
    // An update already in flight is not a failure to retry: the 409 and the
    // sentence the update routes give it, which the desktop card shows as is.
    if (err instanceof PowerApprovalConflict) return NextResponse.json({ error: err.message }, { status: 409 });
    return NextResponse.json({ error: "Power command failed; request it again to retry" }, { status: 500 });
  }
}
