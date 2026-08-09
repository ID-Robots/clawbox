import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(request?: Request) {
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
