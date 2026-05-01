import { NextResponse } from "next/server";
import { isPortOpen } from "@/lib/port-probe";

export const dynamic = "force-dynamic";

const GATEWAY_PORT = Number(process.env.GATEWAY_PORT || "18789");

// Probe with a TCP connect rather than HTTP — the gateway's JS event loop
// stalls for tens of seconds during agent prep, and an HTTP probe would
// inherit those stalls and trip the desktop mascot's "DO NOT DISTURB"
// alarm on every chat message.
export async function GET() {
  const available = await isPortOpen(GATEWAY_PORT, "127.0.0.1", 1000);
  return NextResponse.json({ available, port: GATEWAY_PORT });
}
