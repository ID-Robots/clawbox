export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { setMany } from "@/lib/config-store";
import { getSessionSigningSecret, createSessionCookie } from "@/lib/auth";

export async function POST() {
  try {
    const timestamp = new Date().toISOString();
    await setMany({
      setup_complete: true,
      setup_completed_at: timestamp,
      setup_progress_step: undefined,
    });

    // Auto-login after first setup so user isn't shown the login screen
    const res = NextResponse.json({ success: true });
    try {
      const secret = await getSessionSigningSecret();
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
    await setMany({
      setup_complete: undefined,
      setup_completed_at: undefined,
    }).catch(() => {});
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "Failed to complete setup",
      },
      { status: 500 }
    );
  }
}
