import { NextResponse } from "next/server";
import { getWifiStatus } from "@/lib/network";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const status = await getWifiStatus();
    return NextResponse.json(status);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Status check failed" },
      { status: 500 }
    );
  }
}
