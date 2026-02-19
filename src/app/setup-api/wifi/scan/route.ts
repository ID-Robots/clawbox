import { NextResponse } from "next/server";
import { triggerBackgroundScan, getScanStatus } from "@/lib/network";

export const dynamic = "force-dynamic";

/** Trigger a background WiFi scan. Returns immediately before AP goes down. */
export async function POST() {
  triggerBackgroundScan();
  return NextResponse.json({ status: "scanning" });
}

/** Poll for scan results. */
export async function GET() {
  const result = getScanStatus();
  return NextResponse.json(result);
}
