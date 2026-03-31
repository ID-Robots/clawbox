import { NextResponse } from "next/server";
import { getEthernetStatus } from "@/lib/network";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const status = await getEthernetStatus();
    return NextResponse.json(status);
  } catch {
    return NextResponse.json({ connected: false, iface: null });
  }
}
