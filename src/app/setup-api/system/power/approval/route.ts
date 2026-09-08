import { NextResponse } from "next/server";
import { hasOwnerSession } from "@/lib/owner-session";
import { isPowerAction, pendingPowerApproval, resolvePowerApproval } from "@/lib/power-approval";

export const dynamic = "force-dynamic";
const forbidden = () => NextResponse.json({ error: "Only the owner can confirm power requests" }, { status: 403 });

export async function GET(req: Request) {
  if (!(await hasOwnerSession(req))) return forbidden();
  const prompt = pendingPowerApproval();
  return NextResponse.json({ pending: prompt ? {
    id: prompt.id, action: prompt.action, reason: prompt.reason, expiresAt: prompt.expiresAt,
  } : null }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  if (!(await hasOwnerSession(req))) return forbidden();
  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid body" }, { status: 400 }); }
  if (!body || typeof body.id !== "string" || !isPowerAction(body.action) || typeof body.approve !== "boolean") {
    return NextResponse.json({ error: "Invalid confirmation" }, { status: 400 });
  }
  try {
    const applied = await resolvePowerApproval(body.id, body.action, body.approve);
    return NextResponse.json({ applied }, { status: applied ? 200 : 409 });
  } catch {
    return NextResponse.json({ error: "Power command failed; request it again to retry" }, { status: 500 });
  }
}
