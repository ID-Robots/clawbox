import { NextResponse } from "next/server";
import { auditActorOf, recordAudit } from "@/lib/audit-log";

export const dynamic = "force-dynamic";

export async function POST(request?: Request) {
  // Only a sign-out of a session this box still honours is a line in the
  // audit log: anyone may ask this route to clear a cookie they do not have.
  if (request) {
    const actor = await auditActorOf(request);
    if (actor) await recordAudit({ event: "logout", actor }, request);
  }
  const res = NextResponse.json({ success: true });
  // Match the Secure attribute to how the request arrived so the clear reliably
  // removes a cookie that login set Secure over HTTPS (tunnel). On plain-HTTP
  // LAN access Secure must stay off or the browser would reject it.
  const xfp = request?.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  let isHttps = xfp === "https";
  if (!xfp && request) {
    try { isHttps = new URL(request.url).protocol === "https:"; } catch { isHttps = false; }
  }
  res.cookies.set("clawbox_session", "", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
    secure: isHttps,
  });
  return res;
}
