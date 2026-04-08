import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST() {
  const res = NextResponse.json({ success: true });
  // Device serves over plain HTTP on port 80 (embedded LAN deployment); cookies
  // must not be marked Secure or browsers reject them. HTTPS is opt-in via certs.
  res.cookies.set("clawbox_session", "", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
    secure: false,
  });
  return res;
}
