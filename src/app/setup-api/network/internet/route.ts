import { NextResponse } from "next/server";
import { internetStatus } from "@/lib/internet-reachable";

// Read by EVERY signed-in ClawBox user, not only the owner (the tray's online
// dot; see src/lib/non-owner-scope.ts). Keep the answer a bare connectivity
// reading — nothing of the network's configuration belongs in it.

export const dynamic = "force-dynamic";

export async function GET() {
  const { online, latencyMs, checkedAt } = await internetStatus();
  return NextResponse.json({ online, latencyMs, checkedAt });
}
