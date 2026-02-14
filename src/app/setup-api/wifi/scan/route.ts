import { NextResponse } from "next/server";
import { scanWifi } from "@/lib/network";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const networks = await scanWifi();
    return NextResponse.json({ networks });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Scan failed" },
      { status: 500 }
    );
  }
}
