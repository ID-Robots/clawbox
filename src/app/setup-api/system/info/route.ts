import { NextResponse } from "next/server";
import { gather } from "@/lib/system-info";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const info = await gather();
    return NextResponse.json(info);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to gather info" },
      { status: 500 }
    );
  }
}
