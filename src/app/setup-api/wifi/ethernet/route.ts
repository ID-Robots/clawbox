import { NextResponse } from "next/server";
import { getEthernetStatus } from "@/lib/network";
import { internetReachable } from "@/lib/internet-reachable";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const status = await getEthernetStatus();
    // `online`: this machine already reaches the internet some other way — a
    // PC on the Wi-Fi its operating system manages (install-x64.sh). The
    // network step lets such a machine continue; a box broadcasting its setup
    // hotspot has no route out and still answers false here.
    const online = status.connected || await internetReachable();
    return NextResponse.json({ ...status, online });
  } catch {
    return NextResponse.json({ connected: false, cable: false, iface: null, online: false });
  }
}
