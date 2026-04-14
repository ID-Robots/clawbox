import { NextResponse } from "next/server";
import { verifyLocalPassword, verifyPassword, useLocalPasswordAuth } from "@/lib/auth";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const PASSWORD_RATE_LIMIT = { windowMs: 15 * 60 * 1000, max: 5 };

export async function POST(request: Request) {
  const ip = clientIp(request);
  if (!checkRateLimit("password", ip, PASSWORD_RATE_LIMIT)) {
    return NextResponse.json({ error: "Too many attempts. Please try again later." }, { status: 429 });
  }

  let body: { password?: string };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const password = body.password ?? "";
  if (!password) return NextResponse.json({ error: "Password is required" }, { status: 400 });

  const ok = useLocalPasswordAuth()
    ? await verifyLocalPassword(password)
    : await verifyPassword(password);
  if (!ok) return NextResponse.json({ error: "Incorrect password" }, { status: 401 });
  return NextResponse.json({ ok: true });
}
