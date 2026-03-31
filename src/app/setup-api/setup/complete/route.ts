import { NextResponse } from "next/server";
import { set } from "@/lib/config-store";
import { getOrCreateSecret, createSessionCookie } from "@/lib/auth";

export async function POST() {
  try {
    const timestamp = new Date().toISOString();
    await set("setup_complete", true);
    await set("setup_completed_at", timestamp);

    // Auto-login after first setup so user isn't shown the login screen
    const res = NextResponse.json({ success: true });
    try {
      const secret = await getOrCreateSecret();
      const cookie = createSessionCookie(86400, secret); // 24h session
      res.cookies.set("clawbox_session", cookie, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: 86400,
        secure: false,
      });
    } catch {
      // Non-fatal: user will just see the login screen
    }
    return res;
  } catch (err) {
    // Rollback on partial failure
    await set("setup_complete", undefined).catch(() => {});
    await set("setup_completed_at", undefined).catch(() => {});
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "Failed to complete setup",
      },
      { status: 500 }
    );
  }
}
