import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import { parseNmcliTerseLine } from "@/lib/network";

const execFileAsync = promisify(execFile);

export const dynamic = "force-dynamic";

const AP_PROFILE = "ClawBox-Setup";

export async function GET() {
  try {
    const { stdout } = await execFileAsync("nmcli", [
      "-t", "-f", "NAME,TYPE,AUTOCONNECT-PRIORITY,DEVICE",
      "connection", "show",
    ], { timeout: 5_000 });
    const profiles = stdout.split("\n").filter(Boolean).map(line => {
      const [name, type, prio, device] = parseNmcliTerseLine(line);
      return { name, type, priority: Number(prio) || 0, device: device || null };
    }).filter(p => p.type === "802-11-wireless" && p.name !== AP_PROFILE);
    return NextResponse.json({ profiles });
  } catch (err) {
    console.warn("[wifi/saved] nmcli failed:", err);
    return NextResponse.json({ error: "Failed to list saved networks" }, { status: 500 });
  }
}
