import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const GATEWAY_PORT = process.env.GATEWAY_PORT || "18789";

export async function GET() {
  try {
    const res = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/`, {
      signal: AbortSignal.timeout(3000),
    });
    await res.text(); // consume body
    return NextResponse.json({ available: res.ok, port: Number(GATEWAY_PORT) });
  } catch {
    return NextResponse.json({ available: false, port: Number(GATEWAY_PORT) });
  }
}
